"""Acoustic-shadow segmentation behind a detection candidate.

An object standing on the seabed blocks the sound: right behind it (on the side away from the sonar) the seabed gets
no echo and stays dark. Standing man-made objects cast compact, sharp-edged shadows that start right at the object
and point straight away from the sonar; flat features (sand ripples, scars, sediment patches) cast none, and rock
clusters cast many irregular ones. This module outlines the shadow region attached to a candidate and describes it.
"""

import cv2
import numpy as np

DARK_RATIO = 0.6          # shadow pixels are darker than this share of the seabed level at the same range


def segment_shadow(gray: np.ndarray, box, nadir: float) -> dict:
    """Returns the shadow outline (image pixels) and shape descriptors; `found` is False when none is attached."""
    h, w = gray.shape
    x1, y1, x2, y2 = (float(v) for v in box)
    bw, bh = max(x2 - x1, 2.0), max(y2 - y1, 2.0)
    side = 1 if (x1 + x2) / 2 >= nadir else -1
    far = x2 if side > 0 else x1
    reach = max(3.0 * bw, 40.0, 0.6 * abs(far - nadir))
    if side > 0:
        c0, c1 = int(max(0, x1)), int(min(w, far + reach))
    else:
        c0, c1 = int(max(0, far - reach)), int(min(w, x2))
    r0, r1 = int(max(0, y1 - 0.25 * bh)), int(min(h, y2 + 0.25 * bh))
    empty = {"found": False, "polygon": None, "length_px": 0.0, "length_ratio": 0.0, "area_ratio": 0.0,
             "solidity": 0.0, "sharpness": 0.0, "darkness": 0.0, "attached": False, "pieces": 0}
    if c1 - c0 < 8 or r1 - r0 < 3:
        return empty
    win = cv2.blur(gray[r0:r1, c0:c1].astype(np.float32), (5, 3))

    # seabed level at the same ranges, from rows just above and below the candidate
    ys = np.r_[max(0, int(y1 - 1.5 * bh)):max(0, int(y1) - 1), min(h, int(y2) + 2):min(h, int(y2 + 1.5 * bh))]
    if len(ys) >= 3:
        ref = np.median(cv2.blur(gray[ys][:, c0:c1].astype(np.float32), (5, 1)), axis=0)
    else:
        ref = np.full(c1 - c0, float(np.median(win)), np.float32)
    ref = np.maximum(cv2.blur(ref.reshape(1, -1), (15, 1)).ravel(), 8.0)

    dark = (win < DARK_RATIO * ref[None, :]).astype(np.uint8)
    dark = cv2.morphologyEx(dark, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(dark)
    if n <= 1:
        return empty

    # attached = touches the far edge of the box (within half a box width) and overlaps its rows
    far_col = (far - c0)
    band = (max(0, int(far_col - (0.5 * bw + 6 if side > 0 else 6))), int(far_col + (6 if side > 0 else 0.5 * bw + 6)))
    rows_box = (int(y1 - r0), int(y2 - r0))
    best, best_area = None, 0
    pieces = 0
    for k in range(1, n):
        x, y, ww, hh, area = stats[k]
        if area < 12:
            continue
        pieces += 1
        touches = x <= band[1] and x + ww >= band[0]
        overlaps = y <= rows_box[1] and y + hh >= rows_box[0]
        if touches and overlaps and area > best_area:
            best, best_area = k, area
    if best is None:
        out = dict(empty)
        out["pieces"] = pieces
        return out
    m = (lab == best).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    cnt = max(cnts, key=cv2.contourArea)
    hull_area = max(cv2.contourArea(cv2.convexHull(cnt)), 1.0)
    # length along the range direction (per row: how far the shadow reaches), robust 90th percentile
    cols = np.where(m.any(axis=0))[0]
    lengths = []
    for r in range(m.shape[0]):
        row = np.where(m[r])[0]
        if len(row):
            lengths.append(row.max() - row.min() + 1)
    length = float(np.percentile(lengths, 90)) if lengths else 0.0
    # edge sharpness: brightness jump across the shadow boundary relative to the seabed level
    edge = cv2.morphologyEx(m, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)).astype(bool)
    gx = cv2.Sobel(win, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(win, cv2.CV_32F, 0, 1, ksize=3)
    grad = np.hypot(gx, gy)
    level = float(np.median(ref))
    sharp = float(np.clip(np.mean(grad[edge]) / (4.0 * level + 1e-3), 0, 2)) if edge.any() else 0.0
    inside = win[m.astype(bool)]
    darkness = float(np.clip(1.0 - np.mean(inside) / level, 0, 1)) if inside.size else 0.0
    poly = (cnt.reshape(-1, 2) + np.array([c0, r0])).astype(int)
    if len(poly) > 60:
        poly = cv2.approxPolyDP(poly.reshape(-1, 1, 2).astype(np.float32), 1.5, True).reshape(-1, 2).astype(int)
    return {
        "found": True,
        "polygon": poly.tolist(),
        "length_px": round(length, 1),
        "length_ratio": round(length / bw, 3),
        "area_ratio": round(float(best_area) / (bw * bh), 3),
        "solidity": round(float(cv2.contourArea(cnt)) / hull_area, 3),
        "sharpness": round(sharp, 3),
        "darkness": round(darkness, 3),
        "attached": True,
        "pieces": pieces,
        "cols": int(len(cols)),
    }
