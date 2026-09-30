"""Synthetic side-scan sonar survey generator -> XTF files + ground truth.

Physically motivated simulation (not just noise):
  * towfish at altitude h (with heave) over a flat seabed; samples are in SLANT range r, ground range = sqrt(r^2 - h^2)
  * water column before the first bottom return, bright first-return line, grazing-angle intensity falloff with
    imperfect TVG compensation
  * procedural seabed: sediment patches, sand ripples, fine grain texture
  * objects as height fields (wreck, cylinders, containers, debris, pipeline) plus NATURAL rocks / ridges
  * acoustic shadows by ray casting from the towfish over the height field; faces towards the sonar are brighter
  * multiplicative Rayleigh-like speckle, ping dropouts from heave events
  * per-ping navigation in the XTF ping headers: lat/lon, heading, altitude, speed, time

Outputs per scenario (in --out, default <project>/data):
  <name>.xtf                 raw log (2 channels: port / starboard, uint16)
  <name>_groundtruth.json    every placed object with class, lat/lon, ping, side, ground range, size
  <name>_nav.csv             per-ping navigation (for testing the navigation-CSV path with images)
  <name>_preview.png         waterfall as the AI service reads it (port | starboard), for a quick look

Usage (from ai/):  .venv/Scripts/python tools/generate_xtf.py [--out ../data] [--scenario all]
"""

import argparse
import csv
import ctypes
import json
import math
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

import cv2
import numpy as np
import pyxtf
from scipy.ndimage import gaussian_filter, map_coordinates

EARTH_R = 6371008.8
PROJECT_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------- scene description

@dataclass
class SceneObject:
    kind: str            # shipwreck | cylinder | container | debris | pipeline | rock | ridge
    y: float             # along-track centre (m from start of line)
    x: float             # across-track centre (m, + starboard, - port)
    length: float        # m (along its own axis)
    width: float         # m
    height: float        # m above seabed
    angle: float = 0.0   # deg, object axis relative to the track direction
    reflect: float = 2.0 # backscatter strength relative to sand (~0.6)
    label: str = ""      # detector class this corresponds to ('' for natural features)
    seed: int = 0


@dataclass
class Scenario:
    name: str
    description: str
    pings: int = 2000
    ping_rate_hz: float = 10.0
    speed_mps: float = 1.5
    slant_range_m: float = 60.0
    samples: int = 1000               # per side
    altitude_m: float = 12.0
    heave_amp_m: float = 0.25
    heading_deg: float = 60.0
    turn_deg: float = 0.0             # total heading change over the line (curved track)
    start_lat: float = 13.0800
    start_lon: float = 80.3300
    start_time: datetime = datetime(2026, 9, 29, 6, 0, 0, tzinfo=timezone.utc)
    ripple_strength: float = 0.10
    dropouts: int = 3
    frequency_khz: int = 450
    objects: list = field(default_factory=list)
    seed: int = 0


# ---------------------------------------------------------------- geometry helpers

def destination(lat, lon, bearing_deg, dist_m):
    p1, l1, b = np.radians(lat), np.radians(lon), np.radians(bearing_deg)
    d = np.asarray(dist_m) / EARTH_R
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), np.degrees(l2)


def navigation(sc: Scenario):
    """Per-ping vehicle track: position, heading, along-track distance, altitude, time."""
    n = sc.pings
    dt = 1.0 / sc.ping_rate_hz
    t = np.arange(n) * dt
    heading = sc.heading_deg + sc.turn_deg * (t / t[-1]) ** 1.5
    step = sc.speed_mps * dt
    lat = np.empty(n)
    lon = np.empty(n)
    lat[0], lon[0] = sc.start_lat, sc.start_lon
    for i in range(1, n):
        lat[i], lon[i] = destination(lat[i - 1], lon[i - 1], heading[i - 1], step)
    y = np.arange(n) * step
    rng = np.random.default_rng(sc.seed + 1)
    heave = (sc.heave_amp_m * (0.6 * np.sin(2 * np.pi * t / 7.5) + 0.4 * np.sin(2 * np.pi * t / 3.1 + 1.3))
             + gaussian_filter(rng.standard_normal(n), 15) * 2.0)
    altitude = sc.altitude_m + heave
    times = [sc.start_time + timedelta(seconds=float(s)) for s in t]
    return {"lat": lat, "lon": lon, "heading": heading % 360, "y": y, "altitude": altitude, "heave": heave, "time": times}


# ---------------------------------------------------------------- seabed & objects

def seabed_field(sc: Scenario, y_max: float):
    """Reflectivity of bare seabed on a regular (along, across) grid, 0.25 m cells."""
    rng = np.random.default_rng(sc.seed)
    cell = 0.25
    ny, nx = int(y_max / cell) + 8, int(2 * sc.slant_range_m / cell) + 8
    patches = gaussian_filter(rng.standard_normal((ny, nx)), 40)
    patches /= patches.std() + 1e-9
    grain = gaussian_filter(rng.standard_normal((ny, nx)), 1.2)
    grain /= grain.std() + 1e-9
    yy, xx = np.meshgrid(np.arange(ny) * cell, np.arange(nx) * cell - sc.slant_range_m, indexing="ij")
    ripple_dir = np.radians(rng.uniform(0, 180))
    wavelength = rng.uniform(1.6, 2.6)
    ripples = np.sin(2 * np.pi * (yy * np.cos(ripple_dir) + xx * np.sin(ripple_dir)) / wavelength)
    ripple_mask = np.clip(gaussian_filter(rng.standard_normal((ny, nx)), 50) * 12 + 0.3, 0, 1)
    field_ = 0.6 + 0.2 * patches + 0.06 * grain + sc.ripple_strength * ripples * ripple_mask
    return np.clip(field_, 0.15, 1.2), cell


_NOISE = gaussian_filter(np.random.default_rng(7).standard_normal((512, 512)), 2.5)
_NOISE /= np.abs(_NOISE).max()


def _texture(u, v, seed, scale=5.0):
    """Smooth pseudo-random texture in [-1, 1] sampled from a tiling noise image (object-local coordinates)."""
    off = np.random.default_rng(seed).uniform(0, 512, 2)
    return map_coordinates(_NOISE, [(u * scale + off[0]).ravel(), (v * scale + off[1]).ravel()],
                           order=1, mode="grid-wrap").reshape(np.shape(u))


def object_height(o: SceneObject, Y, X):
    """Height (m) and reflectivity multiplier of object `o` at along/across coordinates (Y, X)."""
    a = np.radians(o.angle)
    dy, dx = Y - o.y, X - o.x
    u = dy * np.cos(a) + dx * np.sin(a)      # along the object's axis
    v = -dy * np.sin(a) + dx * np.cos(a)     # across it
    tex = _texture(u, v, o.seed)
    L, W, H = o.length / 2, o.width / 2, o.height

    if o.kind == "shipwreck":
        # hull tapering to a bow, broken deck, superstructure, collapsed stern
        bow = np.clip((L - u) / (0.28 * o.length), 0.25, 1.0)
        stern = np.clip((u + L) / (0.08 * o.length), 0.6, 1.0)
        inside = (np.abs(u) <= L) & (np.abs(v) <= W * bow * stern)
        deck = H * (0.75 + 0.2 * tex) * np.sqrt(np.clip(1 - (v / (W * bow + 1e-6)) ** 2, 0, 1))
        house = ((u > -0.15 * L) & (u < 0.2 * L) & (np.abs(v) < 0.45 * W)) * 0.45 * H
        frames = 0.15 * (np.sin(u * 2 * np.pi / 2.2) > 0.85) * (0.5 + 0.5 * tex)   # hull frames / ribs
        h = np.where(inside, deck + house, 0.0)
        refl = np.where(inside, o.reflect * (1 + frames + 0.25 * tex), 1.0)
    elif o.kind == "cylinder":
        inside = (np.abs(u) <= L) & (np.abs(v) <= W)
        h = np.where(inside, 2 * np.sqrt(np.clip(W ** 2 - v ** 2, 0, None)) * (H / o.width), 0.0)
        refl = np.where(inside, o.reflect, 1.0)
    elif o.kind in ("container", "debris"):
        inside = (np.abs(u) <= L) & (np.abs(v) <= W)
        h = np.where(inside, H * (0.9 + 0.1 * tex), 0.0)
        refl = np.where(inside, o.reflect * (1 + 0.2 * tex), 1.0)
    elif o.kind == "pipeline":
        inside = np.abs(v) <= W
        h = np.where(inside, H * np.sqrt(np.clip(1 - (v / W) ** 2, 0, 1)), 0.0)
        refl = np.where(inside, o.reflect, 1.0)
    elif o.kind in ("rock", "ridge"):
        wobble = 1 + 0.35 * _texture(u, v, o.seed + 7, scale=0.8)
        r = np.sqrt((u / L) ** 2 + (v / W) ** 2) / wobble
        inside = r < 1
        h = np.where(inside, H * np.clip(1 - r ** 2, 0, None) ** 0.6 * (0.8 + 0.35 * tex), 0.0)
        refl = np.where(inside, o.reflect * (0.85 + 0.3 * tex), 1.0)
    else:
        raise ValueError(o.kind)
    return np.clip(h, 0, None), refl


def extent(o: SceneObject) -> float:
    return math.hypot(o.length, o.width) / 2 + 1.0 if o.kind != "pipeline" else float("inf")


# ---------------------------------------------------------------- one side of the swath

def simulate_side(sc: Scenario, nav, side: int, seabed, cell, rng):
    """Return uint16 samples (pings x samples) ordered near -> far range for one side (+1 stbd, -1 port)."""
    P, N, R = sc.pings, sc.samples, sc.slant_range_m
    r = (np.arange(N) + 0.5) * R / N                                # slant range of each sample
    h = nav["altitude"][:, None]                                    # (P, 1)
    xg = np.sqrt(np.clip(r[None, :] ** 2 - h ** 2, 0, None))        # ground range (P, N)
    water = r[None, :] < h
    Y = np.broadcast_to(nav["y"][:, None], (P, N))
    X = side * xg

    # bare seabed reflectivity
    gi = Y / cell
    gj = (X + sc.slant_range_m) / cell
    refl = map_coordinates(seabed, [gi.ravel(), gj.ravel()], order=1, mode="nearest").reshape(P, N)
    Z = np.zeros((P, N))

    for o in sc.objects:
        if o.kind != "pipeline" and np.sign(o.x) != side:
            continue
        ext = extent(o)
        rows = np.where(np.abs(nav["y"] - o.y) < ext)[0] if np.isfinite(ext) else np.arange(P)
        if len(rows) == 0:
            continue
        hz, rf = object_height(o, Y[rows], X[rows])
        mask = hz > 0
        Z[rows] = np.maximum(Z[rows], hz)
        sub = refl[rows]
        sub[mask] = rf[mask] * 0.6
        refl[rows] = sub

    # acoustic shadows: a point is hidden when a nearer point has a smaller depression angle
    with np.errstate(divide="ignore", invalid="ignore"):
        tan_dep = np.where(water | (xg <= 0), np.inf, (h - Z) / xg)
    shadow = tan_dep > np.minimum.accumulate(tan_dep, axis=1) + 1e-6

    # intensity: grazing-angle falloff, faces towards the sonar brighter, lee faces darker
    grazing = np.arctan2(h, np.maximum(xg, 1e-3))
    slope = np.gradient(Z, axis=1) / np.maximum(np.gradient(xg, axis=1), 1e-3)
    facing = 1 + 2.5 * np.clip(slope, 0, 1.5) - 0.5 * np.clip(-slope, 0, 1)
    intensity = refl * np.sin(grazing) ** 0.8 * facing
    intensity *= (r[None, :] / h) ** 0.3                              # imperfect TVG: far range stays darker
    intensity = np.where(shadow, 0.04 * intensity + 0.01, intensity)

    first = (r[None, :] >= h) & (r[None, :] < h + 0.35)               # first bottom return
    intensity = np.where(first, intensity * 2.2 + 0.4, intensity)
    intensity = np.where(water, 0.002 * rng.random((P, N)), intensity)   # water column: almost no return

    intensity *= rng.gamma(1.6, 1 / 1.6, size=(P, N))                 # speckle
    return np.clip(intensity * 9000, 0, 65535).astype(np.uint16)


def add_dropouts(port, stbd, sc: Scenario, rng):
    events = []
    for _ in range(sc.dropouts):
        start = int(rng.integers(50, sc.pings - 60))
        length = int(rng.integers(1, 7))
        for ch in (port, stbd):
            ch[start:start + length] = rng.integers(0, 40, size=(length, ch.shape[1]))
        events.append({"first_ping": start, "pings": length})
    return events


# ---------------------------------------------------------------- XTF writing

def write_xtf(path: Path, sc: Scenario, nav, port_near_far, stbd_near_far):
    fh = pyxtf.XTFFileHeader()
    fh.SonarName = b"SynthSSS-450"
    fh.NoteString = f"Synthetic survey: {sc.name}".encode()[:63]
    fh.ThisFileName = path.name.encode()[:63]
    fh.NavUnits = 3                               # latitude / longitude
    fh.NumberOfSonarChannels = 2
    for i, chan_type in enumerate((1, 2)):        # port, starboard
        ci = fh.ChanInfo[i]
        ci.TypeOfChannel = chan_type
        ci.SubChannelNumber = i
        ci.BytesPerSample = 2
        ci.SampleFormat = 0
        ci.Frequency = float(sc.frequency_khz)
        ci.ChannelName = (b"Port" if i == 0 else b"Starboard")
        ci.BeamWidth = 0.4
        ci.TiltAngle = 20.0
    port = port_near_far[:, ::-1]                 # port samples are stored far -> near
    n_samples = port.shape[1]
    chan_size = ctypes.sizeof(pyxtf.XTFPingChanHeader)
    record = ctypes.sizeof(pyxtf.XTFPingHeader) + 2 * (chan_size + n_samples * 2)

    with open(path, "wb") as f:
        f.write(bytes(fh))
        for i in range(sc.pings):
            t = nav["time"][i]
            p = pyxtf.XTFPingHeader()
            p.Year, p.Month, p.Day = t.year, t.month, t.day
            p.Hour, p.Minute, p.Second = t.hour, t.minute, t.second
            p.HSeconds = t.microsecond // 10000
            p.JulianDay = t.timetuple().tm_yday
            p.PingNumber = 100000 + i
            p.SoundVelocity = 750.0               # XTF stores one-way sound speed / 2
            p.SensorYcoordinate = float(nav["lat"][i])
            p.SensorXcoordinate = float(nav["lon"][i])
            p.ShipYcoordinate = float(nav["lat"][i])
            p.ShipXcoordinate = float(nav["lon"][i])
            p.SensorHeading = float(nav["heading"][i])
            p.ShipGyro = float(nav["heading"][i])
            p.SensorPrimaryAltitude = float(nav["altitude"][i])
            p.SensorDepth = 25.0 - float(nav["altitude"][i])
            p.SensorSpeed = float(sc.speed_mps / 0.514444)   # knots
            p.Heave = float(nav["heave"][i])
            p.NumChansToFollow = 2
            p.NumBytesThisRecord = record
            p.ping_chan_headers, p.data = [], []
            for ch, samples in enumerate((port[i], stbd_near_far[i])):
                pc = pyxtf.XTFPingChanHeader()
                pc.ChannelNumber = ch
                pc.NumSamples = n_samples
                pc.SlantRange = float(sc.slant_range_m)
                pc.GroundRange = float(math.sqrt(max(sc.slant_range_m ** 2 - nav["altitude"][i] ** 2, 0)))
                pc.TimeDuration = float(2 * sc.slant_range_m / 1500.0)
                pc.SecondsPerPing = float(1 / sc.ping_rate_hz)
                pc.Frequency = sc.frequency_khz
                p.ping_chan_headers.append(pc)
                p.data.append(np.ascontiguousarray(samples, dtype=np.uint16))
            f.write(p.to_bytes())


# ---------------------------------------------------------------- ground truth

def ground_truth(sc: Scenario, nav):
    items = []
    for idx, o in enumerate(sc.objects):
        if o.kind == "pipeline":
            continue
        i = int(np.clip(np.searchsorted(nav["y"], o.y), 0, sc.pings - 1))
        bearing = (nav["heading"][i] + (90 if o.x > 0 else -90)) % 360
        lat, lon = destination(nav["lat"][i], nav["lon"][i], bearing, abs(o.x))
        slant = math.hypot(abs(o.x), nav["altitude"][i])
        items.append({
            "id": f"GT-{idx + 1:02d}",
            "kind": o.kind,
            "expected_class": o.label or None,
            "man_made": bool(o.label),
            "latitude": round(float(lat), 7),
            "longitude": round(float(lon), 7),
            "ping_index": i,
            "side": "starboard" if o.x > 0 else "port",
            "ground_range_m": round(abs(o.x), 2),
            "slant_sample": int(slant / sc.slant_range_m * sc.samples),
            "length_m": o.length,
            "width_m": o.width,
            "height_m": o.height,
            "orientation_deg": o.angle,
        })
    pipes = [asdict(o) | {"id": f"GT-{i + 1:02d}"} for i, o in enumerate(sc.objects) if o.kind == "pipeline"]
    return items, pipes


# ---------------------------------------------------------------- scenarios

def scenarios():
    rng = np.random.default_rng(2026)
    out = []

    wreck = Scenario(
        name="synthetic_wreck_site",
        description="Shipwreck with scattered debris field, a mine-like cylinder and natural rock outcrops (false-positive bait).",
        heading_deg=58.0, slant_range_m=60.0, seed=11,
    )
    wreck.objects = [
        SceneObject("shipwreck", y=150, x=26, length=46, width=9, height=4.0, angle=18, reflect=2.2, label="shipwreck", seed=1),
        SceneObject("cylinder", y=236, x=-28, length=2.6, width=0.9, height=0.9, angle=60, reflect=3.0, label="mine_like_object", seed=2),
    ]
    for k in range(9):   # debris around the wreck
        wreck.objects.append(SceneObject("debris", y=float(150 + rng.uniform(-35, 35)), x=float(24 + rng.uniform(-18, 22)),
                                         length=float(rng.uniform(0.8, 2.5)), width=float(rng.uniform(0.5, 1.5)),
                                         height=float(rng.uniform(0.3, 0.9)), angle=float(rng.uniform(0, 180)),
                                         reflect=2.4, label="debris", seed=10 + k))
    for k in range(6):   # natural rocks on the port side
        wreck.objects.append(SceneObject("rock", y=float(rng.uniform(30, 280)), x=float(-rng.uniform(12, 50)),
                                         length=float(rng.uniform(3, 8)), width=float(rng.uniform(2, 6)),
                                         height=float(rng.uniform(0.8, 2.2)), angle=float(rng.uniform(0, 180)),
                                         reflect=1.3, seed=30 + k))
    out.append(wreck)

    mines = Scenario(
        name="synthetic_mine_like_objects",
        description="Sandy seabed with ripples: six cylinders (mine-like / pipe sections), two containers, a pipeline, curved track, heave dropouts.",
        heading_deg=95.0, turn_deg=-25.0, slant_range_m=50.0, ripple_strength=0.16, dropouts=6, seed=22,
        start_lat=13.0620, start_lon=80.3450,
    )
    mines.objects = [
        SceneObject("pipeline", y=120, x=0, length=1e9, width=0.35, height=0.45, angle=70, reflect=2.2, label="mine_like_object", seed=40),
        SceneObject("container", y=75, x=-26, length=6.1, width=2.4, height=2.6, angle=35, reflect=2.6, label="debris", seed=41),
        SceneObject("container", y=260, x=31, length=6.1, width=2.4, height=2.6, angle=-20, reflect=2.6, label="debris", seed=42),
    ]
    for k, (y, x, ang) in enumerate([(40, 18, 10), (110, -35, 80), (165, 12, 45), (200, -16, 120), (235, 38, 150), (285, -30, 5)]):
        mines.objects.append(SceneObject("cylinder", y=y, x=x, length=float(rng.uniform(1.8, 3.0)), width=float(rng.uniform(0.5, 0.9)),
                                         height=0.8, angle=ang, reflect=3.0, label="mine_like_object", seed=50 + k))
    out.append(mines)

    rocks = Scenario(
        name="synthetic_rocky_seabed_negatives",
        description="Natural terrain only (rock outcrops, ridges, strong ripples): no man-made objects. Every detection here is a false positive.",
        heading_deg=210.0, slant_range_m=60.0, ripple_strength=0.2, dropouts=2, seed=33,
        start_lat=13.1050, start_lon=80.3700,
    )
    for k in range(14):
        rocks.objects.append(SceneObject("rock", y=float(rng.uniform(15, 290)), x=float(rng.choice([-1, 1]) * rng.uniform(10, 55)),
                                         length=float(rng.uniform(2, 10)), width=float(rng.uniform(1.5, 7)),
                                         height=float(rng.uniform(0.6, 3.0)), angle=float(rng.uniform(0, 180)),
                                         reflect=float(rng.uniform(1.1, 1.6)), seed=60 + k))
    for k in range(3):
        rocks.objects.append(SceneObject("ridge", y=float(rng.uniform(40, 260)), x=float(rng.choice([-1, 1]) * rng.uniform(15, 45)),
                                         length=float(rng.uniform(25, 45)), width=float(rng.uniform(2, 4)),
                                         height=float(rng.uniform(1.0, 2.0)), angle=float(rng.uniform(-40, 40)),
                                         reflect=1.3, seed=80 + k))
    out.append(rocks)
    return out


# ---------------------------------------------------------------- main

def generate(sc: Scenario, out_dir: Path):
    rng = np.random.default_rng(sc.seed + 100)
    nav = navigation(sc)
    seabed, cell = seabed_field(sc, nav["y"][-1] + 10)
    stbd = simulate_side(sc, nav, +1, seabed, cell, rng)
    port = simulate_side(sc, nav, -1, seabed, cell, rng)
    dropouts = add_dropouts(port, stbd, sc, rng)

    xtf_path = out_dir / f"{sc.name}.xtf"
    write_xtf(xtf_path, sc, nav, port, stbd)

    objects, pipelines = ground_truth(sc, nav)
    track_len = float(nav["y"][-1])
    (out_dir / f"{sc.name}_groundtruth.json").write_text(json.dumps({
        "scenario": sc.name,
        "description": sc.description,
        "synthetic": True,
        "sonar": {"frequency_khz": sc.frequency_khz, "slant_range_m": sc.slant_range_m, "samples_per_side": sc.samples,
                  "ping_rate_hz": sc.ping_rate_hz},
        "survey": {"pings": sc.pings, "speed_mps": sc.speed_mps, "track_length_m": round(track_len, 1),
                   "start": {"latitude": sc.start_lat, "longitude": sc.start_lon, "time": sc.start_time.isoformat()},
                   "heading_deg": sc.heading_deg, "turn_deg": sc.turn_deg, "altitude_m": sc.altitude_m},
        "objects": objects,
        "pipelines": pipelines,
        "dropouts": dropouts,
    }, indent=2), encoding="utf-8")

    with open(out_dir / f"{sc.name}_nav.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ping", "time_utc", "latitude", "longitude", "heading", "altitude"])
        for i in range(sc.pings):
            w.writerow([100000 + i, nav["time"][i].isoformat(), f"{nav['lat'][i]:.7f}", f"{nav['lon'][i]:.7f}",
                        f"{nav['heading'][i]:.2f}", f"{nav['altitude'][i]:.2f}"])

    # Preview exactly as the AI service reads it (round-trip check of the XTF).
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.readers.xtf import load_xtf
    img, track, info = load_xtf(xtf_path.read_bytes())
    preview = cv2.resize(img, (img.shape[1] // 2, img.shape[0] // 2), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(out_dir / f"{sc.name}_preview.png"), preview)
    return {"file": xtf_path.name, "size_mb": round(xtf_path.stat().st_size / 1e6, 2), "pings": info["pings"],
            "waterfall": info["resampled_to"], "georeferenced": info["georeferenced"],
            "objects": len(objects), "man_made": sum(o["man_made"] for o in objects), "dropouts": len(dropouts)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=PROJECT_ROOT / "data")
    ap.add_argument("--scenario", default="all", help="scenario name or 'all'")
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for sc in scenarios():
        if args.scenario in ("all", sc.name):
            print(json.dumps(generate(sc, args.out)))


if __name__ == "__main__":
    main()
