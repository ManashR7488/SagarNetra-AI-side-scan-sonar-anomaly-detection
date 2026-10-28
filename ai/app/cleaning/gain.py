"""Radiometric (gain) correction: make the same seabed look equally bright everywhere in the swath.

  range gain    residual time-varied gain, beam pattern and absorption make brightness depend on the range:
                each side's brightness-vs-range profile is measured in blocks of pings (robust median over the
                seabed, water column excluded) and divided out.
  ping gain     operator gain changes (both sides jump together), ping-to-ping jitter and roll (one side brighter
                than the other for a few pings): step changes are detected and removed, short-term jitter is
                taken out per side.
  stripes       interference / crosstalk from other acoustic systems: bright line bursts one or two pings thick.
                A 5-ping median along-track removes them while every real object (several pings long) survives.
"""

import warnings

import cv2
import numpy as np

from app.cleaning.dropouts import runs


def nanmedian(a: np.ndarray, axis: int) -> np.ndarray:
    """np.nanmedian without the all-NaN-slice warning (those slices are filled by the callers)."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        return np.nanmedian(a, axis=axis)


def outside_water(shape: tuple[int, int], nadir: float, water_px: np.ndarray | None, margin: float = 1.05) -> np.ndarray:
    """Bool mask of seabed pixels (outside the water column)."""
    h, w = shape
    if water_px is None:
        return np.ones(shape, bool)
    dist = np.abs(np.arange(w) + 0.5 - nadir)
    return dist[None, :] > (np.asarray(water_px, np.float32)[:, None] * margin + 2)


def _fill_nan(v: np.ndarray) -> np.ndarray:
    ok = np.isfinite(v)
    if ok.all() or not ok.any():
        return np.nan_to_num(v, nan=0.0)
    return np.interp(np.arange(len(v)), np.where(ok)[0], v[ok])


def _smooth_side(v: np.ndarray, sigma: float) -> np.ndarray:
    if len(v) < 3:
        return v
    k = int(3 * sigma) * 2 + 1
    return cv2.GaussianBlur(v.astype(np.float32).reshape(1, -1), (k, 1), sigma, borderType=cv2.BORDER_REPLICATE).ravel()


def range_profiles(img: np.ndarray, nadir: float, water_px: np.ndarray | None, block: int = 256,
                   valid: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray]:
    """(block centre rows, profiles[blocks, width]) of robust seabed brightness per column, smoothed per side."""
    h, w = img.shape
    f = img.astype(np.float32)
    if valid is None:
        valid = outside_water(img.shape, nadir, water_px) & (f > 2) & (f < 253)
    nb = max(1, int(round(h / block)))
    c = int(round(np.clip(nadir, 1, w - 1)))
    sigma = max(3.0, 0.012 * w)
    centres, profs = [], []
    for b in range(nb):
        r0, r1 = b * h // nb, (b + 1) * h // nb
        step = max(1, (r1 - r0) // 160)
        blk = np.where(valid[r0:r1:step], f[r0:r1:step], np.nan)
        prof = nanmedian(blk, axis=0)
        port, stbd = _fill_nan(prof[:c]), _fill_nan(prof[c:])
        profs.append(np.concatenate([_smooth_side(port, sigma), _smooth_side(stbd, sigma)]))
        centres.append((r0 + r1 - 1) / 2)
    return np.asarray(centres), np.asarray(profs, np.float32)


def range_normalize(img: np.ndarray, nadir: float, water_px: np.ndarray | None, strength: int = 70,
                    block: int = 256) -> tuple[np.ndarray, dict]:
    h, w = img.shape
    f = img.astype(np.float32)
    seabed = outside_water(img.shape, nadir, water_px)
    valid = seabed & (f > 2) & (f < 253)
    if valid.sum() < 1000:
        return img, {"applied": False, "reason": "not enough seabed pixels"}
    target = float(np.median(f[valid]))
    centres, profs = range_profiles(img, nadir, water_px, block, valid)
    gain = np.clip(target / np.maximum(profs, 1.0), 0.25, 4.0) ** (strength / 100.0)
    rows = np.arange(h, dtype=np.float32)
    if len(centres) == 1:
        gmap = np.broadcast_to(gain[0], (h, w))
    else:
        # linear interpolation of the block gains between block centres
        idx = np.clip(np.searchsorted(centres, rows) - 1, 0, len(centres) - 2)
        t = np.clip((rows - centres[idx]) / (centres[idx + 1] - centres[idx]), 0, 1)[:, None]
        gmap = gain[idx] * (1 - t) + gain[idx + 1] * t
    gmap = np.where(seabed, gmap, 1.0)
    out = np.clip(f * gmap, 0, 255).astype(np.uint8)
    before = profs.mean(axis=0)
    return out, {"applied": True, "target_level": round(target, 1), "blocks": int(len(centres)),
                 "max_gain": round(float(gain.max()), 2), "min_gain": round(float(gain.min()), 2),
                 "_profile_before": before}


def side_levels(img: np.ndarray, nadir: float, water_px: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
    """Median seabed brightness of each ping, port and starboard (outer 70 % of each side, water column excluded)."""
    h, w = img.shape
    c = int(round(np.clip(nadir, 1, w - 1)))
    f = img.astype(np.float32)
    lo_p, hi_s = max(1, int(0.7 * c)), min(w - 1, c + int(0.3 * (w - c)))
    port = f[:, :lo_p]
    stbd = f[:, hi_s:]
    if water_px is not None:   # outer parts can still reach into the water column on very high altitude lines
        dist_p = np.abs(np.arange(lo_p) + 0.5 - nadir)[None, :]
        dist_s = np.abs(np.arange(hi_s, w) + 0.5 - nadir)[None, :]
        wp = np.asarray(water_px, np.float32)[:, None] * 1.05 + 2
        port = np.where(dist_p > wp, port, np.nan)
        stbd = np.where(dist_s > wp, stbd, np.nan)
    return _fill_nan(nanmedian(port, axis=1)), _fill_nan(nanmedian(stbd, axis=1))


def running_median(v: np.ndarray, k: int) -> np.ndarray:
    k = max(3, min(k, len(v)) | 1)
    pad = np.pad(v, (k // 2, k // 2), mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)


def drop_dead_pings(lp: np.ndarray, ls: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Replace the levels of lost pings (noise floor) by their neighbours so they do not look like gain changes."""
    dead = (lp < 0.1 * max(float(np.median(lp)), 1.0)) | (ls < 0.1 * max(float(np.median(ls)), 1.0))
    if dead.any() and (~dead).sum() > 2:
        idx = np.arange(len(lp))
        lp = np.where(dead, np.interp(idx, idx[~dead], lp[~dead]), lp)
        ls = np.where(dead, np.interp(idx, idx[~dead], ls[~dead]), ls)
    return lp, ls, dead


def band_levels(img: np.ndarray, nadir: float, water_px: np.ndarray | None) -> np.ndarray:
    """(4, pings) median brightness of near and far range bands, port and starboard (water column excluded)."""
    h, w = img.shape
    f = img.astype(np.float32)
    c = float(np.clip(nadir, 1, w - 1))
    out = []
    for side, extent in ((-1, c), (1, w - c)):
        for lo, hi in ((0.3, 0.6), (0.6, 0.95)):
            a, b = sorted((int(c + side * lo * extent), int(c + side * hi * extent)))
            a, b = max(0, a), min(w, max(a + 1, b))
            band = f[:, a:b]
            if water_px is not None:
                dist = np.abs(np.arange(a, b) + 0.5 - nadir)[None, :]
                band = np.where(dist > np.asarray(water_px, np.float32)[:, None] * 1.05 + 2, band, np.nan)
            out.append(_fill_nan(nanmedian(band, axis=1)))
    return np.asarray(out)


def _window_ratio(logv: np.ndarray, idx: np.ndarray, win: int) -> np.ndarray:
    """log(mean of `win` values after idx) - log(mean of `win` values before idx), per series row."""
    cs = np.concatenate([np.zeros((logv.shape[0], 1)), np.cumsum(logv, axis=1)], axis=1)
    return (cs[:, idx + win] - cs[:, idx]) / win - (cs[:, idx] - cs[:, idx - win]) / win


def find_gain_steps(lp: np.ndarray, ls: np.ndarray, window: int = 60, min_ratio: float = 1.1,
                    bands: np.ndarray | None = None) -> list[dict]:
    """Pings where the whole swath changes brightness by the same factor at once: an electronic gain change.

    Seabed changes (reef to sand, a mud patch) also brighten or darken pings, but gradually and not equally at every
    range on both sides. A step is accepted when (1) port and starboard change by the same factor, (2) the change is
    complete within a few pings (short-window ratio = long-window ratio) and (3) with `bands`, near and far range of
    both sides agree too."""
    n = len(lp)
    if n < 3 * window:
        return []
    lp, ls, dead = drop_dead_pings(lp, ls)
    series = np.log(np.maximum(np.vstack([lp, ls]), 1.0))
    idx = np.arange(window, n - window)
    long = _window_ratio(series, idx, window)
    short = _window_ratio(series, idx, 12)
    da, db = long
    ok = (np.sign(da) == np.sign(db)) & (np.abs(da - db) < np.log(1.12))         & (np.minimum(np.abs(da), np.abs(db)) > np.log(min_ratio))         & np.all(np.abs(short - long) < np.log(1.06), axis=0)
    if bands is not None and ok.any():
        bl = np.log(np.maximum(bands, 1.0))
        bs = _window_ratio(bl, idx, 12)
        med = np.median(bs, axis=0)
        ok &= np.all(np.abs(bs - med) < np.log(1.1), axis=0) & np.all(np.sign(bs) == np.sign(med), axis=0)
    steps = []
    score = np.where(ok, np.abs(long).mean(axis=0), 0.0)
    for s0, e0 in runs(score > 0):
        k = s0 + int(np.argmax(score[s0:e0]))
        steps.append({"row": int(idx[k]), "ratio": round(float(np.exp(long[:, k].mean())), 3)})
    return steps


def ping_normalize(img: np.ndarray, nadir: float, water_px: np.ndarray | None, strength: int = 70) -> tuple[np.ndarray, dict]:
    h, w = img.shape
    if h < 20:
        return img, {"applied": False, "reason": "too few pings"}
    lp, ls = side_levels(img, nadir, water_px)
    lp, ls, dead = drop_dead_pings(lp, ls)     # lost pings are the dropout step's job, not a gain error
    log_p, log_s = np.log(np.maximum(lp, 1.0)), np.log(np.maximum(ls, 1.0))
    # 1. electronic gain steps: remove each step from every ping after it (both sides)
    steps = find_gain_steps(lp, ls, bands=band_levels(img, nadir, water_px))
    corr = np.zeros(h)
    for st in steps:
        corr[st["row"]:] -= np.log(st["ratio"])
    # 2. short-term jitter and roll flicker, per side
    k = 31
    jp = (log_p + corr) - running_median(log_p + corr, k)
    js = (log_s + corr) - running_median(log_s + corr, k)
    s = strength / 100.0
    gp = np.where(dead, 1.0, np.exp(np.clip(corr - s * jp, -1.0, 1.0)))
    gs = np.where(dead, 1.0, np.exp(np.clip(corr - s * js, -1.0, 1.0)))
    c = int(round(np.clip(nadir, 1, w - 1)))
    f = img.astype(np.float32)
    f[:, :c] *= gp[:, None].astype(np.float32)
    f[:, c:] *= gs[:, None].astype(np.float32)
    out = np.clip(f, 0, 255).astype(np.uint8)
    return out, {"applied": True, "gain_steps": steps,
                 "jitter_before": round(float(np.std(np.concatenate([jp, js]))), 4)}


def _vertical_median5(img: np.ndarray) -> np.ndarray:
    h = img.shape[0]
    pad = np.pad(img, ((2, 2), (0, 0)), mode="edge")
    stack = np.stack([pad[i:i + h] for i in range(5)])
    stack.sort(axis=0)
    return stack[2]


def _line_kernels(length: int = 61, slopes=(-0.12, -0.08, -0.04, 0.0, 0.04, 0.08, 0.12)) -> list[np.ndarray]:
    """1-pixel-thick line kernels (mean over the line) at small slants: interference bursts drift slightly in time."""
    out = []
    for m in slopes:
        half = int(np.ceil(abs(m) * length / 2))
        k = np.zeros((2 * half + 1, length), np.float32)
        for x in range(length):
            k[half + int(round(m * (x - length // 2))), x] = 1.0 / length
        out.append(k)
    return out


_KERNELS = _line_kernels()


def stripe_mask(img: np.ndarray, k: float = 2.2, min_density: float = 0.28) -> tuple[np.ndarray, np.ndarray]:
    """(mask of interference pixels, 5-ping median image).

    Candidates are thin bright ridges: much brighter than the 5-ping median at their position and brighter than the
    rows two pings above and below (an edge between bright reef and a dark shadow is bright on one side only).
    Interference lines are where candidates line up densely along a long, almost range-parallel line; speckle and
    texture do not. Pixels along those lines are then taken with a lower threshold (hysteresis) so faint ends go too."""
    med = _vertical_median5(img)
    resid = img.astype(np.int16) - med.astype(np.int16)
    noise = cv2.blur(np.abs(resid).astype(np.float32), (31, 9)) * 1.25
    cand = resid > k * noise + 6
    if cand.any():
        sm = cv2.blur(img, (5, 1)).astype(np.int16)                     # speckle-robust neighbour rows
        above, below = np.roll(sm, 2, axis=0), np.roll(sm, -2, axis=0)
        cand &= (cv2.blur(img, (3, 1)).astype(np.int16) - np.maximum(above, below)) > 0.6 * k * noise
    if not cand.any():
        return np.zeros(img.shape, bool), med
    resp = np.max([cv2.filter2D(cand.astype(np.float32), -1, kk, borderType=cv2.BORDER_CONSTANT) for kk in _KERNELS],
                  axis=0)
    centre = (resp > min_density).astype(np.uint8)
    if not centre.any():
        return np.zeros(img.shape, bool), med
    region = cv2.dilate(centre, np.ones((3, 61), np.uint8)) > 0
    return region & (resid > 1.2 * noise + 3), med


def destripe(img: np.ndarray) -> tuple[np.ndarray, dict]:
    mask, med = stripe_mask(img)
    rows = np.where(mask.any(axis=1))[0]
    out = np.where(mask, med, img).astype(np.uint8)
    row_mask = mask.any(axis=1)
    return out, {"applied": True, "pixels": int(mask.sum()), "fraction": round(float(mask.mean()), 6),
                 "rows_affected": int(len(rows)), "bursts": int(len(runs(row_mask))), "_rows": row_mask}
