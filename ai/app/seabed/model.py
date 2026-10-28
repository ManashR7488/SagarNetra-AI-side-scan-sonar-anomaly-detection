"""3D seabed model of one survey line: a heightfield + ground-range sonar texture + target heights.

Elevation = -(water depth along the track, measured)          XTF / navigation with sensor depth + altitude
            + relief from side-scan shading (estimated)
            + detected targets raised by their shadow height  (measured from the acoustic shadow)

The grid is in track coordinates: rows = along-track distance s from the first ping, columns = signed ground range
u (port negative). The straightened strip is what the 3D viewer draws; lat/lon of any (s, u) comes from `track`.
"""

import base64
import math

import cv2
import numpy as np

from app.geo.geotagging import Track
from app.readers.image import encode_jpeg, to_data_url
from app.seabed.bottom import BottomTrack
from app.seabed.geometry import AltitudeChoice, PingGeometry, SwathGeometry
from app.seabed.relief import estimate_relief
from app.seabed.shadows import measure_shadow

TRACK_SAMPLES = 400


def _encode_u16(a: np.ndarray) -> dict:
    lo, hi = float(a.min()), float(a.max())
    scale = (hi - lo) / 65535 if hi > lo else 1e-6
    q = np.round((a - lo) / scale).clip(0, 65535).astype("<u2")
    return {"encoding": "uint16le-base64", "scale": scale, "offset": lo,
            "min_m": round(lo, 3), "max_m": round(hi, 3), "data": base64.b64encode(q.tobytes()).decode("ascii")}


def _smooth_1d(v: np.ndarray, window: int) -> np.ndarray:
    if window < 2 or len(v) < 3:
        return v
    k = min(window, len(v))
    pad = np.pad(v, (k // 2, k - 1 - k // 2), mode="edge")
    return np.convolve(pad, np.ones(k) / k, mode="valid")


def measure_heights(gray: np.ndarray, detections: list[dict], geom: SwathGeometry) -> None:
    """Adds `height` to every detection (in place)."""
    assumed = geom.altitude_fix is None
    for d in detections:
        m = measure_shadow(gray, d["bbox"], geom)
        if m is None:
            d["height"] = {"height_m": None, "method": None, "reason": "no measurable acoustic shadow"}
        else:
            d["height"] = {**m, "method": "shadow_length", "assumed_altitude": assumed}


def build_seabed(gray: np.ndarray, track: Track | None, detections: list[dict], max_cells: int = 262144,
                 texture_side: int = 1024, texture_quality: int = 72, ping: PingGeometry | None = None,
                 bottom: BottomTrack | None = None, swath_width_m: float | None = None,
                 altitude_choice: AltitudeChoice | None = None) -> dict:
    """`track`: refined navigation track (or None); `ping`: XTF geometry without lat/lon; `bottom`: bottom track of
    the waterfall; `swath_width_m`: operator's swath width for images without navigation."""
    h, w = gray.shape
    geom = SwathGeometry.build(h, w, track, ping=ping, bottom=bottom, swath_width_m=swath_width_m,
                               altitude_choice=altitude_choice)
    measure_heights(gray, detections, geom)

    U, L = geom.max_ground, max(geom.length_m, 1.0)
    s0 = float(geom.s_at(0))

    # ---- ground-range texture (square texels) ----
    tx = int(min(texture_side, max(64, w)))
    du_t = 2 * U / (tx - 1)
    tz = int(np.clip(round(L / du_t) + 1, 2, 2 * texture_side))
    u_t = np.linspace(-U, U, tx)
    y_t = geom.y_at(np.linspace(0, L, tz))
    map_x, map_y = (np.ascontiguousarray(a, dtype=np.float32) for a in
                    np.broadcast_arrays(geom.col_at(u_t[None, :], y_t[:, None]), y_t[:, None]))
    valid = (map_x >= 0) & (map_x <= w - 1)
    ground = cv2.remap(gray, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    # Dropped pings (black rows) are gaps in the coverage, not dark seabed.
    row_level = np.array([np.median(r[m]) if m.any() else 0.0 for r, m in zip(ground, valid)])
    dropout = row_level < 0.25 * max(float(np.median(row_level[row_level > 0])) if np.any(row_level > 0) else 1.0, 1.0)
    covered = valid & ~dropout[:, None]
    alt_t = geom.altitude_at(y_t)
    relief_t = estimate_relief(ground, covered, u_t, alt_t, du_t)

    # ---- height grid ----
    cell = max(2 * U / 255, L / 1023, math.sqrt(2 * U * L / max_cells), 0.05)
    nx, nz = int(round(2 * U / cell)) + 1, int(round(L / cell)) + 1
    cell_x, cell_z = 2 * U / (nx - 1), L / (nz - 1)
    relief = cv2.resize(relief_t, (nx, nz), interpolation=cv2.INTER_AREA)
    y_g = geom.y_at(np.linspace(0, L, nz))

    depth = geom.water_depth_at(y_g)
    kind = "measured" if depth is not None else "relative"
    if depth is not None:
        depth = _smooth_1d(depth, max(1, int(round(5.0 / cell_z))))   # ~5 m running mean (heave, noise)
        base = -depth[:, None]
    else:
        base = np.zeros((nz, 1))
    elev = (base + relief).astype(np.float32)

    # ---- targets: local position, raised by their measured height ----
    # The raised body is the target's acoustic highlight (the object), not its whole box: the box also holds the
    # shadow, which is seabed hidden behind the object.
    tex_g = cv2.resize(ground.astype(np.float32), (nx, nz), interpolation=cv2.INTER_AREA)
    cov_g = cv2.resize(covered.astype(np.float32), (nx, nz), interpolation=cv2.INTER_AREA) > 0.5
    targets = []
    bumps = np.zeros((nz, nx), np.float32)
    masks: dict[str, np.ndarray] = {}
    for d in detections:
        cx, cy = d["centroid_px"]["x"], d["centroid_px"]["y"]
        s = float(geom.s_at(cy)) - s0
        u = float(geom.ground_u(cx, cy))
        hm = d["height"]["height_m"]
        b = d["bbox"]
        pts = np.array(d["polygons"][0] if d["polygons"] else
                       [[b["x1"], b["y1"]], [b["x2"], b["y1"]], [b["x2"], b["y2"]], [b["x1"], b["y2"]]], float)
        gi = (geom.ground_u(pts[:, 0], pts[:, 1]) + U) / cell_x
        gj = (geom.s_at(pts[:, 1]) - s0) / cell_z
        size = float(max(np.ptp(gi) * cell_x, np.ptp(gj) * cell_z))
        targets.append({"detection_id": d["id"], "class_name": d["class_name"], "status": d["status"],
                        "s": round(s, 2), "u": round(u, 2), "size_m": round(size, 2),
                        "height_m": hm, "height_method": d["height"]["method"]})
        if hm is None or d["status"] != "confirmed":
            continue
        mask = np.zeros((nz, nx), np.uint8)
        cv2.fillPoly(mask, [np.stack([gi, gj], 1).round().astype(np.int32)], 1)
        if mask.sum() < 4:
            cv2.circle(mask, (int(round((u + U) / cell_x)), int(round(s / cell_z))), 1, 1, -1)
        inside = mask.astype(bool) & cov_g
        body = mask.astype(bool)
        if inside.sum() >= 6:
            ring = cv2.dilate(mask, np.ones((9, 9), np.uint8)).astype(bool) & ~mask.astype(bool) & cov_g
            level = float(np.median(tex_g[ring])) if ring.sum() >= 6 else float(np.median(tex_g[inside]))
            bright = inside & (tex_g > 1.15 * level)
            bright = cv2.morphologyEx(bright.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
            # the object is the outline of its highlights, interior included (a deck or hold returns less)
            contours, _ = cv2.findContours(bright, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            filled = np.zeros_like(bright)
            cv2.drawContours(filled, [c for c in contours if cv2.contourArea(c) >= 3], -1, 1, -1)
            filled = filled.astype(bool) & mask.astype(bool)
            if filled.sum() >= max(4, 0.12 * inside.sum()):
                body = filled
        extent = max(1.0, min(np.ptp(gi), np.ptp(gj)))
        # flat-topped body with steep sides (a hull or a block), not a smooth hill
        soft = cv2.GaussianBlur(body.astype(np.float32), (0, 0), max(0.8, 0.1 * extent))
        if soft.max() > 0:
            plateau = np.clip(soft / (0.75 * soft.max()), 0, 1)
            bumps = np.maximum(bumps, plateau * hm)
            masks[d["id"]] = plateau > 0.5
    elev += bumps

    # Least depth over each target (hydrographic: the shallowest point a vessel or cable must clear).
    for t, d in zip(targets, detections):
        j = int(np.clip(round(t["s"] / cell_z), 0, nz - 1))
        i = int(np.clip(round((t["u"] + U) / cell_x), 0, nx - 1))
        t["seabed_depth_m"] = round(float(-base[j, 0] - relief[j, i]), 2) if kind == "measured" else None
        top = float(elev[masks[t["detection_id"]]].max()) if t["detection_id"] in masks else None
        t["least_depth_m"] = round(-top, 2) if kind == "measured" and top is not None else None
        d["height"]["least_depth_m"] = t["least_depth_m"]
        d["height"]["seabed_depth_m"] = t["seabed_depth_m"]

    # ---- navigation samples for lat/lon readouts and the 3D track line ----
    ys = np.linspace(0, h - 1, min(TRACK_SAMPLES, h))
    nav = {"s": np.round(geom.s_at(ys) - s0, 2).tolist(),
           "altitude": np.round(geom.altitude_at(ys), 2).tolist(),
           "depth": None if geom.water_depth_fix is None else np.round(geom.water_depth_at(ys), 2).tolist()}
    if track is not None:
        fixes = [track._interp(y) for y in ys]
        nav.update(lat=[round(f[0], 7) for f in fixes], lon=[round(f[1], 7) for f in fixes],
                   heading=[round(f[2], 1) for f in fixes])

    tex = ground.copy()
    tex[~covered] = 0
    alt_source = geom.sources.get("altitude", "assumed")
    depth_note = {"measured": "sensor depth + altitude from the log / navigation (measured); depths are below the sea "
                              "surface at survey time, not reduced to chart datum",
                  "relative": "no sensor depth in the data: elevations are relative to the mean seabed"}[kind]
    return {
        "available": True,
        "kind": kind,
        "grid": {"nx": nx, "nz": nz, "cell_x_m": round(cell_x, 4), "cell_z_m": round(cell_z, 4),
                 "width_m": round(2 * U, 2), "length_m": round(L, 2),
                 "frame": "rows = along-track s from the first ping, columns = ground range u from -width/2 (port) "
                          "to +width/2 (starboard)"},
        "elevation": _encode_u16(elev),
        "depth": None if depth is None else {"min_m": round(float(depth.min()), 2), "max_m": round(float(depth.max()), 2)},
        "relief": {"rms_m": round(float(np.sqrt(np.mean(relief ** 2))), 3), "max_abs_m": round(float(np.abs(relief).max()), 3)},
        "altitude": {"min_m": round(float(alt_t.min()), 2), "max_m": round(float(alt_t.max()), 2),
                     "assumed": geom.altitude_fix is None, "source": alt_source,
                     "check_m": None if altitude_choice is None or altitude_choice.check_m is None
                     else round(altitude_choice.check_m, 2)},
        "slant_range_corrected": geom.slant,
        "geometry": {"sources": geom.sources, "nadir_column": round(geom.nadir, 1),
                     "swath_m": round(geom.width * geom.m_per_px, 2),
                     "bottom_track": bottom.summary() if bottom else None},
        "coverage": {"covered_fraction": round(float(covered.mean()), 3),
                     "dropout_fraction": round(float(dropout.mean()), 3),
                     "outside_swath_fraction": round(float(1 - valid.mean()), 3),
                     # within about one altitude of the track the sonar looks almost straight down: poor imagery
                     "nadir_zone_m": round(2 * float(np.median(alt_t)), 1)},
        "texture": to_data_url(encode_jpeg(tex, texture_quality)),
        "texture_size": [tx, tz],
        "track": nav,
        "targets": targets,
        "methods": {
            "depth": depth_note,
            "altitude": {"logged": "logged by the sonar / navigation", "logged+image": "logged, checked against "
                         "the first seabed return in the image", "image": "bottom-tracked from the first seabed return "
                         "in the image", "assumed": "assumed (no altitude in the data and no water column in the image)"
                         }.get(alt_source, alt_source),
            "relief": "shape-from-shading of the slant-range-corrected backscatter (estimated, high-passed, <= 2 m)",
            "targets": "height = altitude x shadow length / (range to shadow + shadow length)",
        },
        "assumptions": geom.assumptions + ["flat seabed across the track for slant-range correction",
                                           "track drawn straightened (along-track distance)"],
    }
