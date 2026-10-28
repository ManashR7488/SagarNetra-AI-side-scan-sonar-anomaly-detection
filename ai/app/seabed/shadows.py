"""Target height from the length of its acoustic shadow.

The sonar (altitude H) sees the top of an object of height h at ground range Rt; the ray grazing that top hits the
seabed again Ls further out, so by similar triangles  h / Ls = H / (Rt + Ls)  ->  h = H * Ls / (Rt + Ls).

Per row through the target we walk outward from the highlight to the first run of dark pixels (well below the
seabed level at the same range on nearby rows), measure where it starts and ends, and convert both to ground range.
"""

import cv2
import numpy as np

from app.seabed.geometry import SwathGeometry

DARK_RATIO = 0.6      # shadow = darker than this fraction of the local seabed level
MIN_RUN_PX = 3        # ignore speckle gaps shorter than this
MAX_ROWS = 48         # rows sampled per target
PERCENTILE = 0.9     # of the per-row shadow lengths (tallest part of the target)


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of consecutive True runs."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def measure_shadow(gray: np.ndarray, bbox: dict, geom: SwathGeometry) -> dict | None:
    """Returns {height_m, shadow_length_m, shadow_start_m, altitude_m, rows_used} or None (no usable shadow)."""
    h_img, w_img = gray.shape
    x1, y1, x2, y2 = (float(bbox[k]) for k in ("x1", "y1", "x2", "y2"))
    cx = (x1 + x2) / 2
    side = 1 if cx >= geom.nadir else -1
    bw, bh = max(x2 - x1, 2.0), max(y2 - y1, 2.0)

    # Search window along the row: from the near edge of the box outward, a few box widths past the far edge.
    near, far = (x1, x2) if side > 0 else (x2, x1)
    reach = max(3.0 * bw, 40.0, 0.6 * abs(far - geom.nadir))   # tall targets far out cast long shadows
    start, stop = ((int(near), int(min(w_img, far + reach))) if side > 0
                   else (int(max(0, far - reach)), int(min(w_img - 1, near)) + 1))
    if stop - start < 8:
        return None
    window = gray[:, start:stop].astype(np.float32)
    if side < 0:                       # walk outward = left on the port side
        window = window[:, ::-1]
    window = cv2.blur(window, (5, 1))  # suppress speckle along the row

    # Seabed level at the same ranges, from rows just above and below the target.
    ys_bg = np.r_[max(0, int(y1 - bh)):max(0, int(y1) - 1), min(h_img, int(y2) + 2):min(h_img, int(y2 + bh))]
    if len(ys_bg) >= 3:
        ref = np.median(window[ys_bg], axis=0)
    else:
        ref = np.full(window.shape[1], np.median(window), np.float32)
    ref = np.maximum(cv2.blur(ref.reshape(1, -1), (15, 1)).ravel(), 8.0)

    y_lo, y_hi = int(y1 + 0.15 * bh), int(np.ceil(y2 - 0.15 * bh))
    ys = np.unique(np.linspace(max(0, y_lo), min(h_img - 1, max(y_lo, y_hi)), MAX_ROWS).astype(int))
    box_part = max(int(abs(far - near)), 1)
    found = []
    for y in ys:
        prof = window[y]
        peak = int(np.argmax(prof[:box_part + 1]))          # target highlight
        if prof[peak] < 1.1 * ref[peak]:
            continue
        dark = prof < DARK_RATIO * ref
        dark[:peak] = False
        runs = [(a, b) for a, b in _runs(dark) if b - a >= MIN_RUN_PX]
        if not runs:
            continue
        a, b = runs[0]
        for a2, b2 in runs[1:]:                              # merge runs split by small speckle gaps
            if a2 - b > MIN_RUN_PX:
                break
            b = b2
        if a > box_part + max(0.5 * bw, 10) or b >= len(prof) - 1:
            continue                                         # not attached to the target, or truncated by the window
        x_a, x_b = (start + a, start + b) if side > 0 else (stop - 1 - a, stop - 1 - b)
        g_a, g_b = np.abs(geom.ground_u(np.array([x_a, x_b], float), y))
        found.append((g_b - g_a, g_a, float(geom.altitude_at(y))))

    if len(found) < max(2, int(0.25 * len(ys))):
        return None
    found.sort()
    ls, rt, alt = found[int(PERCENTILE * (len(found) - 1))]    # tallest part of the target, robust to outliers
    if ls < 0.3 or rt <= 0:
        return None
    height = alt * ls / (rt + ls)
    if not 0.05 <= height < 0.9 * alt:
        return None
    return {"height_m": round(float(height), 2), "shadow_length_m": round(float(ls), 2),
            "shadow_start_m": round(float(rt), 2), "altitude_m": round(alt, 2), "rows_used": len(found)}
