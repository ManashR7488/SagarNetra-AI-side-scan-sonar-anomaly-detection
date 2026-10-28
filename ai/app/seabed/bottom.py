"""Bottom tracking: find the water column and the first seabed return in a side-scan waterfall.

In a slant-range waterfall the sound needs time to reach the seabed, so each ping starts with a dark band (the water
column) either side of the nadir, ending at a sharp first-bottom return. Its width is the sonar altitude in pixels.
Detecting it gives, from the image alone:
  * the nadir column (images often are not centred, or carry a drawn nadir line),
  * the altitude for every ping (when the log has none, or to check the logged altitude),
  * whether the image is slant range at all (crops and already-corrected mosaics have no water column).
"""

from dataclasses import dataclass

import cv2
import numpy as np

MAX_ROWS = 2500          # rows analysed (longer strips are subsampled, then interpolated back)
MIN_CONTRAST = 4.0       # seabed level / water-column level for a credible water column


@dataclass
class BottomTrack:
    nadir_col: float
    altitude_px: np.ndarray       # per image row, cleaned and gap-filled
    valid: np.ndarray             # rows where the bottom edge was actually seen
    confidence: float             # fraction of rows with a detected edge
    contrast: float               # seabed / water-column brightness

    def summary(self) -> dict:
        return {"nadir_column": round(self.nadir_col, 1), "confidence": round(self.confidence, 3),
                "contrast": round(self.contrast, 2), "altitude_px_median": round(float(np.median(self.altitude_px)), 1)}


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))


def find_water_column(gray: np.ndarray) -> tuple[float, int, int, float] | None:
    """(nadir column, left edge, right edge, contrast) of the dark band in the middle of the image, or None."""
    h, w = gray.shape
    rows = gray[:: max(1, h // 1500)].astype(np.float32)
    prof = np.median(rows, axis=0)
    prof = cv2.blur(prof.reshape(1, -1), (max(3, w // 200) | 1, 1)).ravel()
    seabed = float(np.percentile(prof, 75))
    if seabed < 10:
        return None
    dark = prof < 0.4 * seabed
    # A drawn nadir line or a few bright columns can split the band: bridge short gaps.
    gap = max(2, int(0.04 * w))
    runs = _runs(dark)
    merged: list[list[int]] = []
    for a, b in runs:
        if merged and a - merged[-1][1] <= gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    best = None
    for a, b in merged:
        width = b - a
        centre = (a + b) / 2
        # The water column is interior (not at the image edge), reasonably central and not most of the image.
        if a == 0 or b >= w or width < max(4, 0.005 * w) or width > 0.6 * w or not 0.2 * w < centre < 0.8 * w:
            continue
        if best is None or width > best[1] - best[0]:
            best = (a, b)
    if best is None:
        return None
    a, b = best
    water = float(np.median(prof[a:b]))
    contrast = seabed / max(water, 1.0)
    if contrast < MIN_CONTRAST:
        return None
    return (a + b) / 2, a, b, contrast


def _first_edge(profiles: np.ndarray, start: int) -> np.ndarray:
    """profiles: (rows, L) intensities walking outward from the nadir. Index of the first-bottom return per row.

    The edge is the first sample that (a) follows a stretch of dark water (so the transmit pulse / ring-down right at
    the nadir is skipped), (b) starts a bright run (a real seabed, not a fish or speckle) and (c) stays mostly bright
    for a long stretch after it: the sea-surface echo of a towed sonar is a narrow bright band with dark water behind
    it, the seabed is not."""
    n, length = profiles.shape
    run = max(4, int(0.03 * length))
    min_dark = max(3, int(0.01 * length))
    if length <= start + run:
        return np.full(n, np.nan)
    water = np.percentile(profiles, 10, axis=1)
    seabed = np.percentile(profiles, 70, axis=1)
    thr = water + 0.4 * (seabed - water)
    above = profiles > thr[:, None]
    window = lambda a, k: cv2.filter2D(a.astype(np.float32), -1, np.ones((1, k), np.float32), anchor=(0, 0),  # noqa: E731
                                       borderType=cv2.BORDER_CONSTANT)
    edge_run = window(above, 4) >= 3.5                      # crisp edge: 4 bright samples in a row
    seabed_after = window(profiles, run) / run > thr[:, None]  # and bright on average beyond it
    long = max(3 * run, int(0.12 * length))
    stays_bright = window(above, long) >= 0.6 * np.minimum(long, length - np.arange(length))[None, :]
    dark_before = np.cumsum(~above, axis=1)
    candidate = edge_run & seabed_after & stays_bright & (dark_before >= min_dark)
    candidate[:, :start] = False
    idx = np.argmax(candidate, axis=1)
    ok = candidate[np.arange(n), idx] & (seabed > 1.8 * np.maximum(water, 1.0))
    out = idx.astype(float)
    out[~ok] = np.nan
    return out


def _running_median(v: np.ndarray, k: int) -> np.ndarray:
    k = max(3, min(k, len(v)) | 1)
    pad = np.pad(v, (k // 2, k // 2), mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)


def _fill(v: np.ndarray, ok: np.ndarray) -> np.ndarray:
    return np.interp(np.arange(len(v)), np.where(ok)[0], v[ok])


def _combine(e_s: np.ndarray, e_p: np.ndarray, usable: np.ndarray, window: int = 151) -> tuple[np.ndarray, np.ndarray]:
    """Fuse port / starboard edges into one altitude per row, rejecting spikes (fish, targets near the nadir,
    dropouts) against a wide running median. Returns (altitude, rows where it was measured)."""
    n = len(e_s)
    both = np.isfinite(e_s) & np.isfinite(e_p)
    raw = np.where(both, np.minimum(e_s, e_p), np.where(np.isfinite(e_s), e_s, e_p))
    raw[~usable] = np.nan
    ok = np.isfinite(raw)
    if ok.sum() < max(5, 0.1 * n):
        return raw, ok
    ref = _running_median(_fill(raw, ok), window)
    for _ in range(2):                                      # pick, per row, the side that agrees with the trend
        tol = np.maximum(3.0, 0.08 * ref)
        ds, dp = np.abs(e_s - ref), np.abs(e_p - ref)
        pick = np.where(np.nan_to_num(ds, nan=np.inf) <= np.nan_to_num(dp, nan=np.inf), e_s, e_p)
        agree = both & (np.abs(e_s - e_p) <= tol)
        alt = np.where(agree, (e_s + e_p) / 2, pick)
        ok = usable & np.isfinite(alt) & (np.abs(alt - ref) <= tol)
        if ok.sum() < max(5, 0.1 * n):
            return alt, ok
        ref = _running_median(_fill(alt, ok), window)
    out = _fill(alt, ok)
    out = cv2.GaussianBlur(out.astype(np.float32).reshape(-1, 1), (1, 0), 2.0).ravel().astype(np.float64)
    return out, ok


def track_bottom(gray: np.ndarray, nadir_col: float | None = None) -> BottomTrack | None:
    """Bottom-track a waterfall. `nadir_col` known (XTF) or None to detect the water column in the image."""
    h, w = gray.shape
    contrast = None
    if nadir_col is None:
        found = find_water_column(gray)
        if found is None:
            return None
        nadir_col, a, b, contrast = found
        start = max(1, int(0.5 * min(nadir_col - a, b - nadir_col)))
    else:
        start = 2
    step = max(1, h // MAX_ROWS)
    rows = np.arange(0, h, step)
    img = cv2.blur(gray.astype(np.float32), (3, 5))[rows]
    c = int(round(nadir_col))
    span = int(min(c, w - c) * 0.8)
    if span < 10:
        return None
    stbd = img[:, c: c + span]
    port = img[:, c - span: c][:, ::-1]
    e_s = _first_edge(stbd, start)
    e_p = _first_edge(port, start)
    level = np.median(img, axis=1)
    usable = level > 0.3 * np.median(level)                 # dropped pings (black rows) carry no bottom
    alt_clean, good = _combine(e_s, e_p, usable)
    confidence = float(good.mean())
    if confidence < 0.5:
        return None
    # A real altitude trace is smooth: reject images where it jumps around (not a side-scan waterfall).
    jitter = np.median(np.abs(np.diff(alt_clean[good]))) / max(np.median(alt_clean[good]), 1.0) if good.sum() > 3 else 1.0
    if jitter > 0.05:
        return None
    full = np.interp(np.arange(h), rows, alt_clean)
    valid = np.interp(np.arange(h), rows, good.astype(float)) > 0.5
    if contrast is None:
        water = np.nanmedian(np.concatenate([stbd[:, :3].ravel(), port[:, :3].ravel()]))
        contrast = float(np.median(img) / max(water, 1.0))
    return BottomTrack(float(nadir_col), full, valid, confidence, float(contrast))
