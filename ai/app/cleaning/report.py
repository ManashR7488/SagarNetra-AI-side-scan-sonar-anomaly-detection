"""Noise measurements: what is wrong with a sonar image, in numbers, before and after cleaning.

  speckle      speckle index (local std / mean, lower = smoother) and equivalent number of looks
               (ENL = 1 / (std/mean)^2 in the most homogeneous areas; raw single-look sonar is ~1-3)
  gain         across-track imbalance (P90 / P10 of the seabed brightness-vs-range profile; 1 = uniform),
               port / starboard ratio, ping-to-ping jitter, electronic gain steps
  stripes      share of pixels hit by interference line bursts
  pings        blank / partial / duplicated pings, time gaps, motion-flagged pings
Each aspect also gets a 0-100 sub-score; the quality score is their mean.
"""

import math

import cv2
import numpy as np

from app.cleaning.gain import band_levels, drop_dead_pings, find_gain_steps, nanmedian, outside_water, running_median, side_levels, stripe_mask


def _blocks(h: int, max_rows: int = 1536, block: int = 64) -> list[tuple[int, int]]:
    """Evenly spread contiguous row blocks (local statistics need neighbourhoods; full images are big)."""
    if h <= max_rows:
        return [(0, h)]
    n = max(1, max_rows // block)
    starts = np.linspace(0, h - block, n).astype(int)
    return [(int(s), int(s) + block) for s in starts]


def speckle_stats(img: np.ndarray, valid: np.ndarray) -> dict:
    ci_all, ci2_all = [], []
    for r0, r1 in _blocks(img.shape[0]):
        f = img[r0:r1].astype(np.float32)
        mean = cv2.boxFilter(f, -1, (7, 7), borderType=cv2.BORDER_REFLECT)
        sq = cv2.boxFilter(f * f, -1, (7, 7), borderType=cv2.BORDER_REFLECT)
        var = np.maximum(sq - mean * mean, 0.0)
        ok = valid[r0:r1] & (mean > 10)
        if ok.any():
            m = mean[ok]
            ci_all.append(np.sqrt(var[ok]) / m)
            ci2_all.append(var[ok] / (m * m))
    if not ci_all:
        return {"speckle_index": None, "enl": None}
    ci, ci2 = np.concatenate(ci_all), np.concatenate(ci2_all)
    return {"speckle_index": round(float(ci.mean()), 4), "enl": round(float(1.0 / max(np.percentile(ci2, 25), 1e-4)), 2)}


def across_profile(img: np.ndarray, nadir: float, water_px: np.ndarray | None) -> np.ndarray:
    h, w = img.shape
    rows = np.unique(np.linspace(0, h - 1, min(h, 800)).astype(int))
    f = img[rows].astype(np.float32)
    valid = outside_water(img.shape, nadir, water_px)[rows] & (f > 2) & (f < 253)
    return nanmedian(np.where(valid, f, np.nan), axis=0)


def _downsample(v: np.ndarray, n: int) -> list:
    v = np.asarray(v, np.float64)
    if len(v) <= n:
        return [None if not np.isfinite(x) else round(float(x), 2) for x in v]
    edges = np.linspace(0, len(v), n + 1).astype(int)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        seg = v[a:b]
        seg = seg[np.isfinite(seg)]
        out.append(round(float(seg.mean()), 2) if len(seg) else None)
    return out


def measure(img: np.ndarray, nadir: float, water_px: np.ndarray | None, series: bool = True) -> dict:
    h, w = img.shape
    f = img.astype(np.float32)
    seabed = outside_water(img.shape, nadir, water_px)
    valid = seabed & (f > 2)
    out = {"mean_intensity": round(float(f[seabed].mean()) if seabed.any() else float(f.mean()), 2)}
    out.update(speckle_stats(img, valid))

    prof = across_profile(img, nadir, water_px)
    c = int(round(np.clip(nadir, 1, w - 1)))
    good = np.isfinite(prof) & (prof > 2)
    if good.sum() > 20:
        k = max(3, int(0.012 * w)) * 2 + 1
        sm = cv2.GaussianBlur(np.nan_to_num(prof, nan=0).astype(np.float32).reshape(1, -1), (k, 1), 0).ravel()
        vals = sm[good]
        out["across_imbalance"] = round(float(np.percentile(vals, 90) / max(np.percentile(vals, 10), 1.0)), 3)
        pv, sv = sm[:c][good[:c]], sm[c:][good[c:]]
        out["port_stbd_ratio"] = round(float(np.median(pv) / max(np.median(sv), 1.0)), 3) if len(pv) and len(sv) else None
    else:
        out["across_imbalance"] = out["port_stbd_ratio"] = None

    lp, ls = side_levels(img, nadir, water_px)
    out.update(ping_stats(img, nadir, water_px, lp, ls))

    stripe_px, total = 0, 0
    for r0, r1 in _blocks(h, max_rows=3072, block=256):
        m, _ = stripe_mask(img[r0:r1])
        stripe_px += int(m.sum())
        total += m.size
    out["stripe_fraction"] = round(stripe_px / max(total, 1), 6)

    if series:
        out["series"] = {"across_profile": _downsample(prof, 256), "nadir_bin": round(nadir / w * 256, 1),
                         "ping_level_port": _downsample(lp, 600), "ping_level_stbd": _downsample(ls, 600)}
    return out


def ping_stats(img: np.ndarray, nadir: float, water_px: np.ndarray | None, lp=None, ls=None) -> dict:
    """Ping-to-ping jitter (std of log brightness around a 31-ping running median) and electronic gain steps.
    Meaningful on rows that are pings (XTF: the native log, not the square-pixel waterfall)."""
    if img.shape[0] < 40:
        return {"ping_jitter": None, "gain_steps": 0}
    if lp is None:
        lp, ls = side_levels(img, nadir, water_px)
    bands = band_levels(img, nadir, water_px)
    lp, ls, _ = drop_dead_pings(lp, ls)   # lost pings are counted as dropouts, not as gain noise
    lgp, lgs = np.log(np.maximum(lp, 1.0)), np.log(np.maximum(ls, 1.0))
    jit = np.concatenate([lgp - running_median(lgp, 31), lgs - running_median(lgs, 31)])
    return {"ping_jitter": round(float(np.std(jit)), 4), "gain_steps": len(find_gain_steps(lp, ls, bands=bands))}


def subscores(m: dict, pings: dict | None = None, n_pings: int | None = None) -> dict:
    s = {}
    if m.get("enl"):
        s["speckle"] = round(100 * min(1.0, max(0.0, math.log(max(m["enl"], 1.0)) / math.log(30))))
    if m.get("across_imbalance"):
        s["gain_uniformity"] = round(100 * float(np.clip(1 - (m["across_imbalance"] - 1.2) / 1.8, 0, 1)))
    if m.get("ping_jitter") is not None:
        s["ping_stability"] = round(max(0.0, 100 * float(np.clip(1 - m["ping_jitter"] / 0.15, 0, 1)) - 15 * m.get("gain_steps", 0)))
    s["interference"] = round(100 * float(np.clip(1 - m.get("stripe_fraction", 0) / 0.01, 0, 1)))
    if pings and n_pings:
        bad = pings.get("blank", 0) + pings.get("partial", 0) + pings.get("duplicate", 0) + pings.get("time_gaps", 0)
        s["completeness"] = round(100 * float(np.clip(1 - (bad - pings.get("repaired", 0)) / (0.05 * n_pings), 0, 1)))
        if "motion_flagged" in pings and pings.get("motion_checked"):
            s["motion"] = round(100 * float(np.clip(1 - pings["motion_flagged"] / (0.2 * n_pings), 0, 1)))
    return s


def quality_score(sub: dict) -> int | None:
    return round(float(np.mean(list(sub.values())))) if sub else None
