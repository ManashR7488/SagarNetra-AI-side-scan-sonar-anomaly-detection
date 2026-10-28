"""Seabed geometry: water column, sea-surface echo and slant-range distortion.

In a slant-range waterfall the first samples of every ping travel through water only (the water column): fish,
bubbles, the sea-surface echo of a shallow sonar and electronic noise there are not seabed and fool detectors.
  * water column  everything nearer than the first seabed return (bottom track) is set to the dark water level;
  * surface echo  a sonar at depth d hears the sea surface at slant range d. When d exceeds the altitude the echo
                  lands on the seabed image as a bright line parallel to the track; it is replaced by the
                  brightness on either side of it;
  * ground range  columns are slant range r; the seabed distance is u = sqrt(r^2 - H^2) (flat seabed), so objects
                  near the nadir look compressed. Resampling to ground range removes the water column and gives
                  true shapes (pixel scale unchanged).
"""

import cv2
import numpy as np

from app.cleaning.dropouts import runs


def water_mask(shape: tuple[int, int], nadir: float, water_px: np.ndarray, inset: float = 0.97) -> np.ndarray:
    h, w = shape
    dist = np.abs(np.arange(w) + 0.5 - nadir)
    return dist[None, :] < np.asarray(water_px, np.float32)[:, None] * inset


def mask_water_column(img: np.ndarray, nadir: float, water_px: np.ndarray) -> tuple[np.ndarray, dict]:
    mask = water_mask(img.shape, nadir, water_px)
    if not mask.any():
        return img, {"applied": False, "reason": "no water column"}
    vals = img[mask]
    level = float(np.percentile(vals, 30))
    bright = int(np.sum(vals > 3 * level + 12))      # fish schools, bubbles, surface echo, noise
    out = img.copy()
    out[mask] = np.uint8(round(level))
    return out, {"applied": True, "fraction": round(float(mask.mean()), 4), "water_level": round(level, 1),
                 "bright_pixels_removed": bright}


def suppress_surface_echo(img: np.ndarray, nadir: float, water_px: np.ndarray, surface_px: np.ndarray,
                          half_width: int = 2) -> tuple[np.ndarray, dict]:
    """`surface_px`: per-row slant distance (px) of the sea surface = sonar depth / metres per column."""
    h, w = img.shape
    f = img.astype(np.float32)
    out = f.copy()
    on_seabed = surface_px > np.asarray(water_px) * 1.05 + 3
    if not on_seabed.any():
        return img, {"applied": False, "reason": "surface echo falls inside the water column (masked there)"}
    found_rows = 0
    hw = half_width
    for side in (-1, 1):
        x = nadir + side * surface_px
        xi = np.round(x).astype(int)
        ok = on_seabed & (xi - hw - 12 >= 0) & (xi + hw + 12 < w)
        rows = np.where(ok)[0]
        if not len(rows):
            continue
        band = np.stack([f[rows, xi[rows] + d] for d in range(-hw, hw + 1)]).mean(axis=0)
        flank = np.stack([f[rows, xi[rows] + d] for d in list(range(-12, -hw - 3)) + list(range(hw + 4, 13))]).mean(axis=0)
        ridge = band > 1.3 * flank + 4
        # a real surface echo is continuous along the track: keep runs of at least 20 pings
        keep = np.zeros(len(rows), bool)
        for a, b in runs(ridge):
            if b - a >= 20:
                keep[a:b] = True
        if keep.sum() < 0.2 * len(rows):
            continue
        for i, r in zip(np.where(keep)[0], rows[keep]):
            out[r, xi[r] - hw - 1: xi[r] + hw + 2] = flank[i]
        found_rows += int(keep.sum())
    if not found_rows:
        return img, {"applied": False, "reason": "no surface echo line found"}
    return np.clip(out, 0, 255).astype(np.uint8), {"applied": True, "rows": found_rows}


def slant_to_ground(img: np.ndarray, nadir: float, water_px: np.ndarray) -> tuple[np.ndarray, dict]:
    """Same width and nadir; column x now means ground range |x - nadir| (same metres per pixel)."""
    h, w = img.shape
    cols = np.arange(w, dtype=np.float32) + 0.5
    g = np.abs(cols - nadir)
    sign = np.where(cols >= nadir, 1.0, -1.0).astype(np.float32)
    alt = np.asarray(water_px, np.float32)[:, None]
    map_x = (nadir + sign[None, :] * np.sqrt(g[None, :] ** 2 + alt ** 2) - 0.5).astype(np.float32)
    map_y = np.broadcast_to(np.arange(h, dtype=np.float32)[:, None], (h, w)).copy()
    out = cv2.remap(img, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    lost = float(np.mean((map_x < 0) | (map_x > w - 1)))
    return out, {"applied": True, "outside_swath_fraction": round(lost, 4),
                 "max_compression_px": round(float(np.max(water_px)), 1)}
