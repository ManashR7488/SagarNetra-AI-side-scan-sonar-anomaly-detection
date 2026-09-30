"""Sonar profiles, ship / towfish navigation and per-channel acoustic rendering."""

from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d

from .world import Seabed, WorldObject, prim_height


# ------------------------------------------------------------------ sonar profiles

@dataclass
class Channel:
    freq_khz: int
    range_m: float          # slant range per side
    samples: int            # per side
    beam_h_deg: float       # horizontal (along-track) beam width
    beam_v_deg: float = 50  # vertical beam width
    tilt_deg: float = 20    # depression of the beam axis
    absorption_db_km: float = 100
    bandwidth_khz: int = 20
    looks: float = 1.3      # speckle: CHIRP / wideband systems average more looks


@dataclass
class SonarProfile:
    name: str               # stored in the XTF SonarName (<= 16 chars)
    description: str
    platform: str           # towed | auv | hull
    channels: list          # [low-frequency Channel, (high-frequency Channel)]
    speed_mps: float
    alt_frac: tuple = (0.10, 0.16)   # operator keeps altitude at 10-20 % of range
    max_file_mb: float = 9.5         # keep files under the Cloudinary free-plan 10 MB limit


PROFILES = {
    "TOW-DF400/900": SonarProfile(
        "SIM-DF400/900", "Dual-frequency towed side-scan, 400/900 kHz CHIRP class", "towed",
        [Channel(400, 75, 1000, 0.46, 50, 20, 100, 30, 1.8), Channel(900, 40, 800, 0.28, 45, 20, 250, 45, 2.0)],
        speed_mps=2.1),
    "TOW-DF100/500": SonarProfile(
        "SIM-DF100/500", "Dual-frequency towed side-scan, 100/500 kHz class (route & mine surveys)", "towed",
        [Channel(100, 100, 900, 1.0, 50, 15, 32, 10, 1.1), Channel(500, 50, 800, 0.3, 45, 15, 140, 25, 1.4)],
        speed_mps=2.3, alt_frac=(0.08, 0.14)),
    "TOW-600": SonarProfile(
        "SIM-SS600", "Single-frequency 600 kHz towed side-scan (derelict gear surveys)", "towed",
        [Channel(600, 50, 1100, 0.3, 45, 18, 170, 25, 1.5)], speed_mps=1.8),
    "AUV-900": SonarProfile(
        "SIM-AUV900", "AUV-mounted 900 kHz side-scan, INS navigation", "auv",
        [Channel(900, 40, 1100, 0.25, 45, 12, 250, 40, 1.8)], speed_mps=1.6, alt_frac=(0.12, 0.2)),
    "HULL-455": SonarProfile(
        "SIM-CHIRP455", "Hull-mounted 455 kHz CHIRP side imaging (small craft, SAR)", "hull",
        [Channel(455, 30, 900, 0.8, 55, 30, 110, 35, 2.2)], speed_mps=2.0, alt_frac=(0.2, 0.4)),
}


# ------------------------------------------------------------------ navigation

def mackenzie(T, S, D):
    """Sound speed in sea water (m/s), Mackenzie (1981)."""
    return (1448.96 + 4.591 * T - 5.304e-2 * T ** 2 + 2.374e-4 * T ** 3 + 1.340 * (S - 35) + 1.630e-2 * D
            + 1.675e-7 * D ** 2 - 1.025e-2 * T * (S - 35) - 7.139e-13 * T * D ** 3)


@dataclass
class LineSpec:
    id: str
    start_e: float
    start_n: float
    course_deg: float
    length_m: float
    start_time: datetime
    conditions: dict = field(default_factory=dict)   # gain_change, interference, surface_return, dropouts, sea_state


def smooth_noise(rng, n, sigma, scale):
    x = gaussian_filter1d(rng.standard_normal(n), sigma, mode="nearest")
    return x / (x.std() + 1e-9) * scale


def simulate_navigation(line: LineSpec, prof: SonarProfile, seabed: Seabed, rng):
    """True towfish / ship motion and the (imperfect) recorded navigation for one survey line."""
    ch0 = prof.channels[0]
    c_nominal = 1540.0
    max_rate = c_nominal / (2 * max(c.range_m for c in prof.channels))
    rate = min(12.0, 0.95 * max_rate)
    spacing = prof.speed_mps / rate
    bytes_per_ping = 256 + sum(2 * (64 + 2 * c.samples) for c in prof.channels) + 128  # + attitude/nav packets
    P = int(min(line.length_m / spacing, prof.max_file_mb * 1e6 / bytes_per_ping, 2400))
    t = np.arange(P) / rate
    course = np.radians(line.course_deg)
    fwd = np.array([np.sin(course), np.cos(course)])
    right = np.array([np.cos(course), -np.sin(course)])

    speed = prof.speed_mps * (1 + smooth_noise(rng, P, rate * 20, 0.04))
    s = np.concatenate([[0], np.cumsum(speed[:-1] / rate)])
    towed = prof.platform == "towed"
    wander = smooth_noise(rng, P, rate * 40, {"towed": 2.5, "auv": 0.6, "hull": 1.2}[prof.platform])
    E = line.start_e + s * fwd[0] + wander * right[0]
    N = line.start_n + s * fwd[1] + wander * right[1]

    crab = rng.uniform(-4, 4) if towed else rng.uniform(-1.5, 1.5)
    yaw_amp = {"towed": 2.0, "auv": 0.4, "hull": 1.5}[prof.platform]
    yaw = yaw_amp * np.sin(2 * np.pi * t / rng.uniform(15, 35) + rng.uniform(0, 6)) + smooth_noise(rng, P, rate * 3, yaw_amp * 0.3)
    heading = (line.course_deg + crab + yaw) % 360
    pitch = smooth_noise(rng, P, rate * 2, {"towed": 1.2, "auv": 0.3, "hull": 1.5}[prof.platform])
    roll = smooth_noise(rng, P, rate * 1.5, {"towed": 1.5, "auv": 0.4, "hull": 2.5}[prof.platform])
    sea = line.conditions.get("sea_state", 2)
    heave = 0.12 * sea * (0.6 * np.sin(2 * np.pi * t / 7.3 + rng.uniform(0, 6)) + 0.4 * np.sin(2 * np.pi * t / 4.1))

    tide = seabed.spec.tide_amp * np.sin(2 * np.pi * (t + rng.uniform(0, 44700)) / 44712.0)
    water_depth = seabed.depth(E, N) + tide
    target_alt = rng.uniform(*prof.alt_frac) * ch0.range_m
    if prof.platform == "hull":
        fish_depth = np.full(P, 0.4) + 0.3 * heave
    elif prof.platform == "auv":
        fish_depth = gaussian_filter1d(water_depth - target_alt, rate * 4, mode="nearest") + smooth_noise(rng, P, rate * 2, 0.08)
    else:   # towed: cable length adjusted slowly by the operator, heave transmitted down the cable
        fish_depth = gaussian_filter1d(water_depth - target_alt, rate * 25, mode="nearest") + 0.4 * heave
    fish_depth = np.clip(fish_depth, 0.3, water_depth - 1.0)
    altitude = water_depth - fish_depth

    # ship / layback and recorded positions
    if towed:
        cable = np.clip(fish_depth * rng.uniform(2.5, 4.0) + 15, 20, None)
        layback = np.sqrt(np.clip(cable ** 2 - fish_depth ** 2, 0, None))
    else:
        cable = np.zeros(P)
        layback = np.zeros(P)
    ship_heading = (line.course_deg + rng.uniform(-3, 3) + smooth_noise(rng, P, rate * 10, 1.0)) % 360
    ship_E = E + layback * fwd[0]
    ship_N = N + layback * fwd[1]
    gps_err = [smooth_noise(rng, P, rate * 30, 0.8), smooth_noise(rng, P, rate * 30, 0.8)]
    rec_ship_E, rec_ship_N = ship_E + gps_err[0], ship_N + gps_err[1]
    if towed:
        lay_est = layback * (1 + rng.uniform(-0.06, 0.06))
        hdg = np.radians(ship_heading)
        rec_E = rec_ship_E - lay_est * np.sin(hdg)
        rec_N = rec_ship_N - lay_est * np.cos(hdg)
    elif prof.platform == "auv":       # INS drift grows with distance travelled
        drift = np.cumsum(rng.standard_normal((2, P)) * 0.004, axis=1)
        rec_E, rec_N = E + drift[0] + 0.3, N + drift[1] - 0.2
        rec_ship_E, rec_ship_N = rec_E, rec_N
    else:
        rec_E, rec_N = rec_ship_E, rec_ship_N

    temp = seabed.spec.temp_c - 0.04 * fish_depth + smooth_noise(rng, P, rate * 60, 0.05)
    sal = seabed.spec.salinity + smooth_noise(rng, P, rate * 60, 0.02)
    c = mackenzie(temp, sal, fish_depth)
    times = [line.start_time + timedelta(seconds=float(x)) for x in t]
    return {
        "P": P, "rate": rate, "t": t, "times": times, "s": s, "spacing": spacing,
        "E": E, "N": N, "heading": heading, "pitch": pitch, "roll": roll, "heave": heave,
        "fish_depth": fish_depth, "altitude": altitude, "water_depth": water_depth, "tide": tide,
        "speed": speed, "cable": cable, "layback": layback,
        "ship_E": ship_E, "ship_N": ship_N, "ship_heading": ship_heading,
        "rec_E": rec_E, "rec_N": rec_N, "rec_ship_E": rec_ship_E, "rec_ship_N": rec_ship_N,
        "temp": temp, "salinity": sal, "sound_speed": c,
        "fwd": fwd, "right": right,
    }


# ------------------------------------------------------------------ rendering

def render_channel(ch: Channel, side: int, nav, seabed: Seabed, objects: list, cond: dict, rng, record: bool):
    """Simulate one side (+1 starboard, -1 port) of one frequency channel.

    Returns uint16 samples (pings x samples, near -> far) and, if `record`, footprints of the objects:
    {object_id: (ping_min, ping_max, sample_min, sample_max, n_visible)}.
    """
    P, Nn, R = nav["P"], ch.samples, ch.range_m
    r = (np.arange(Nn) + 0.5) * R / Nn
    h = nav["altitude"][:, None]
    xg = np.sqrt(np.clip(r[None, :] ** 2 - h ** 2, 0, None))
    water = r[None, :] < h
    hd = np.radians(nav["heading"])[:, None]
    along_off = r[None, :] * np.sin(np.radians(nav["pitch"]))[:, None] * 0.5
    E = nav["E"][:, None] + side * xg * np.cos(hd) + along_off * np.sin(hd)
    N = nav["N"][:, None] - side * xg * np.sin(hd) + along_off * np.cos(hd)

    z, refl = seabed.sample(E, N)
    obj_z = np.zeros((P, Nn))
    hits = {}
    s = nav["s"]
    for o in objects:
        if o.kind == "fish_school":
            continue
        # quick reject: along-track window of the object around the line
        rel_e, rel_n = o.e - nav["E"][0], o.n - nav["N"][0]
        along = rel_e * nav["fwd"][0] + rel_n * nav["fwd"][1]
        across = rel_e * nav["right"][0] + rel_n * nav["right"][1]
        rad = o.radius() + 8
        if o.kind in ("pipeline", "cable"):
            rows = np.arange(P)
        else:
            if np.sign(across) != side and abs(across) > rad:
                continue
            if abs(across) - rad > R:
                continue
            rows = np.where(np.abs(s - along) < rad)[0]
        if len(rows) == 0:
            continue
        Es, Ns = E[rows], N[rows]
        hz = np.zeros(Es.shape)
        rf = np.ones(Es.shape)
        for p in o.prims:
            ph, pr = prim_height(p, Es, Ns)
            take = ph > hz
            hz = np.where(take, ph, hz)
            rf = np.where(take, p.reflect * pr, rf)
        mask = hz > 0.02
        if not mask.any():
            continue
        sub_z = obj_z[rows]
        sub_z = np.maximum(sub_z, hz)
        obj_z[rows] = sub_z
        sub_r = refl[rows]
        sub_r[mask] = rf[mask] * 0.55
        refl[rows] = sub_r
        if record:
            rr, cc = np.nonzero(mask & ~water[rows])
            if len(rr):
                hits[o.id] = (rows[rr], cc)

    Z = z + obj_z
    with np.errstate(divide="ignore", invalid="ignore"):
        tan_dep = np.where(water | (xg <= 1e-3), np.inf, (h - Z) / xg)
    shadow = tan_dep > np.minimum.accumulate(tan_dep, axis=1) + 1e-6

    # backscatter: Lambert-like with local incidence (faces towards the sonar are brighter)
    dxg = np.maximum(np.gradient(xg, axis=1), 1e-3)
    slope = np.clip(np.gradient(Z, axis=1) / dxg, -3, 3)
    dep = np.arctan2(h - Z, np.maximum(xg, 1e-3))
    incidence = np.clip(dep + np.arctan(slope), 0.02, np.pi / 2)
    backscatter = refl * np.sin(incidence) ** 1.4

    # vertical beam pattern (roll tilts it up on one side, down on the other)
    tilt = ch.tilt_deg + side * nav["roll"][:, None]
    beam = 0.06 + np.exp(-np.log(2) * ((np.degrees(dep) - tilt) / (ch.beam_v_deg / 2)) ** 2)

    # two-way spreading + absorption, compensated by an imperfect TVG
    alpha = ch.absorption_db_km / 1000
    loss = (1 / r) * 10 ** (-alpha * 2 * r / 20)
    tvg_mismatch = cond.get("tvg_mismatch", 0.0)
    tvg = r ** (1 + tvg_mismatch) * 10 ** (alpha * (1 - 0.3 * tvg_mismatch) * 2 * r / 20)
    A = np.sqrt(backscatter) * beam * (loss * tvg)[None, :]

    first = (r[None, :] >= h) & (r[None, :] < h + 0.25 + 0.02 * r[None, :])
    A = np.where(first, A * 2.5 + 0.25, A)
    A = np.where(shadow, A * 0.03, A)
    A = np.where(water, 0.004, A)

    # surface return: echo from the sea surface above the towfish arrives at slant range ~ towfish depth,
    # modulated by the waves; visible when the fish is shallow (hull-mounted systems, rough seas)
    d = nav["fish_depth"][:, None]
    if cond.get("surface_return", False):
        wave = 1 + 0.5 * np.sin(np.arange(P) / nav["rate"] * 2 * np.pi / 6.0)[:, None]
        A = A + 0.3 * wave * np.exp(-((r[None, :] - d) / (0.3 + 0.02 * r[None, :])) ** 2)

    # fish schools in the water column (bright clusters, no shadow)
    for o in objects:
        if o.kind != "fish_school":
            continue
        rel_e, rel_n = o.e - nav["E"][0], o.n - nav["N"][0]
        along = rel_e * nav["fwd"][0] + rel_n * nav["fwd"][1]
        across = rel_e * nav["right"][0] + rel_n * nav["right"][1]
        if np.sign(across) != side:
            continue
        rows = np.where(np.abs(s - along) < o.length / 2)[0]
        if not len(rows):
            continue
        vert = np.clip(nav["altitude"][rows] - o.school_z, 0.5, None)
        rmin = np.sqrt((abs(across) - o.width / 2) ** 2 + vert ** 2)
        rmax = np.sqrt((abs(across) + o.width / 2) ** 2 + vert ** 2)
        band = (r[None, :] >= rmin[:, None]) & (r[None, :] <= rmax[:, None])
        dots = band & (rng.random(band.shape) < 0.12)
        A[rows] = A[rows] + dots * rng.uniform(0.3, 1.2, band.shape)
        if record and dots.any():
            rr, cc = np.nonzero(dots)
            hits[o.id] = (rows[rr], cc)

    # speckle (amplitude of a gamma-distributed intensity), then along-track beam smearing
    A = A * np.sqrt(rng.gamma(ch.looks, 1 / ch.looks, size=A.shape))
    sigma_pings = r * np.radians(ch.beam_h_deg) / nav["spacing"] / 2.355
    bands = np.array_split(np.arange(Nn), 6)
    for b in bands:
        sg = float(sigma_pings[b].mean())
        if sg > 0.6:
            A[:, b] = gaussian_filter1d(A[:, b], sg, axis=0, mode="nearest")

    # electronics: noise floor, gain (operator change + ping jitter), interference, dropouts
    A = A + np.abs(rng.normal(0, 0.003, A.shape))
    gain = np.ones(P) * (1 + rng.normal(0, 0.02, P))
    if cond.get("gain_change"):
        k = int(P * cond["gain_change"][0])
        gain[k:] *= cond["gain_change"][1]
    A = A * gain[:, None]
    if cond.get("interference"):     # crosstalk from another acoustic system: short slanted bursts
        period = cond["interference"]
        for p0 in range(int(rng.integers(0, period)), P, period):
            k0 = int(rng.integers(0, Nn // 2))
            k = np.arange(k0, min(Nn, k0 + int(rng.integers(Nn // 8, Nn // 3))))
            rows = np.clip(p0 + ((k - k0) * 0.04).astype(int), 0, P - 1)
            A[rows, k] += rng.uniform(0.3, 0.9) * (rng.random(len(k)) < 0.6)

    counts = np.clip(A * cond.get("calibration", 9000.0), 0, 65535)
    return counts.astype(np.uint16), shadow, hits


def apply_dropouts(channels, P, n_events, rng):
    events = []
    for _ in range(n_events):
        start = int(rng.integers(20, max(21, P - 30)))
        length = int(rng.integers(1, 8))
        for ch in channels:
            ch[start:start + length] = rng.integers(0, 30, size=(min(length, P - start), ch.shape[1]))
        events.append({"first_ping": start, "pings": length})
    return events
