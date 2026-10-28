"""Seabed micro-relief from side-scan shading (shape-from-shading).

With a Lambertian seabed, backscatter falls with the incidence angle. On flat ground the sonar at altitude H sees
ground range u at incidence theta0 = 90 deg - atan(H / u). A patch tilted towards the sonar by alpha returns
I / I0 = cos(theta0 - alpha) / cos(theta0), so the brightness ratio against the mean at that range gives the slope,
which is integrated outward from the nadir. Absolute height is not observable this way: the result is high-passed
(drift removed) and softly limited, and is reported as *estimated* relief.
"""

import cv2
import numpy as np

AMPLITUDE_GAMMA = 2.0   # display images are square-root compressed amplitude -> intensity ratio ~ (v / v0) ** 2
MAX_SLOPE_DEG = 35.0


def _smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def estimate_relief(ground: np.ndarray, valid: np.ndarray, u: np.ndarray, altitude: np.ndarray, du: float,
                    max_relief_m: float = 2.0, highpass_m: float = 10.0, along_smooth_m: float = 2.5,
                    leak_m: float = 6.0) -> np.ndarray:
    """ground: (rows, cols) ground-range intensity; valid: coverage mask; u: (cols,) signed ground range (m);
    altitude: (rows,) sonar height per row (m); du: across-track cell size (m). Returns relief in metres."""
    g = ground.astype(np.float32)
    coverage = valid.astype(np.float32)
    valid = valid.copy()
    c0 = int(np.searchsorted(u, 0.0))

    # Per-row, per-side gain (operator gain changes, source level) and dropped pings (rows far darker than usual).
    for sl in (np.s_[:, :c0], np.s_[:, c0:]):
        gs, vs = g[sl], valid[sl]
        row = np.array([np.median(r[m]) if m.sum() > 8 else 0.0 for r, m in zip(gs, vs)], np.float32)
        good = row > 0.35 * np.median(row[row > 0]) if np.any(row > 0) else row > 0
        good &= np.convolve(~good, np.ones(5), mode="same") == 0       # and the rows next to a dropout
        vs &= good[:, None]
        level = np.where(good, row, 1.0)
        level = cv2.GaussianBlur(level.reshape(-1, 1), (1, 0), 3).ravel() if len(level) > 3 else level
        gs /= np.maximum(level, 1e-3)[:, None]
        valid[sl] = vs
    g = cv2.GaussianBlur(np.where(valid, g, 1.0).astype(np.float32), (0, 0), 1.2)

    # Mean seabed level per range (column), from covered cells only.
    cnt = valid.sum(axis=0)
    mean = np.where(cnt > 0, (g * valid).sum(axis=0) / np.maximum(cnt, 1), 0.0).astype(np.float32)
    mean = cv2.blur(mean.reshape(1, -1), (9, 1)).ravel()
    ratio = np.where(valid & (mean > 0.05)[None, :], g / np.maximum(mean, 1e-3)[None, :], 1.0)
    valid &= ratio > 0.4               # acoustic shadow: the seabed there is hidden, not sloping away
    ratio = np.clip(ratio, 0.05, 4.0) ** AMPLITUDE_GAMMA

    au = np.maximum(np.abs(u), 1e-3)[None, :]
    h = np.maximum(altitude, 0.1)[:, None]
    cos0 = np.sin(np.arctan2(h, au))                         # cos(incidence) on flat ground = sin(grazing)
    theta0 = np.arccos(np.clip(cos0, 0, 1))
    alpha = theta0 - np.arccos(np.clip(ratio * cos0, -1.0, 1.0))
    slope = np.tan(np.clip(alpha, -np.radians(MAX_SLOPE_DEG), np.radians(MAX_SLOPE_DEG)))
    # Shading is unreliable under the vehicle (steep incidence) and outside the swath.
    w = (_smoothstep(0.8 * h, 2.0 * h, au) * valid).astype(np.float32)
    # Speckle makes single-row slopes noisy; real relief is continuous along the track. Normalised smoothing
    # also bridges masked cells (dropouts, shadows) from their neighbours.
    blur = lambda a: cv2.GaussianBlur(a, (0, 0), sigmaX=0.7, sigmaY=max(1.5, along_smooth_m / du))  # noqa: E731
    slope = blur((slope * w).astype(np.float32)) / np.maximum(blur(w), 0.05) * np.minimum(blur(w) * 4, 1.0)

    # Integrate outward from the nadir (+u starboard, -u port) with a leaky integrator, so an error (a bright
    # highlight, a gain step) only affects the next few metres instead of the rest of the row.
    z = np.zeros_like(slope, dtype=np.float32)
    keep = np.float32(np.exp(-du / leak_m))
    acc = np.zeros(slope.shape[0], np.float32)
    for c in range(c0, slope.shape[1]):
        acc = keep * acc + slope[:, c] * du
        z[:, c] = acc
    acc[:] = 0
    for c in range(c0 - 1, -1, -1):
        acc = keep * acc + slope[:, c] * du
        z[:, c] = acc

    z = z - cv2.GaussianBlur(z, (0, 0), max(3.0, highpass_m / du))   # remove the remaining low-frequency bias
    z = cv2.GaussianBlur(z, (0, 0), 1.0)
    z = max_relief_m * np.tanh(z / max_relief_m)              # soft limit
    return (z * coverage).astype(np.float32)
