"""Acoustic noise filtration: speckle filters, ping-dropout repair, contrast equalisation, quality metrics.

Side-scan images are formed ping by ping, so image rows are pings (along-track) and columns are
range samples (across-track). Vehicle heave/pitch/roll and acoustic interference show up as whole
rows with missing or near-constant data; those are detected and interpolated from neighbouring pings.
"""

from dataclasses import dataclass, field

import cv2
import numpy as np

DENOISE_METHODS = ("none", "lee", "frost", "kuan", "median")


@dataclass
class FilterParams:
    denoise: str = "none"          # none | lee | frost | kuan | median
    strength: int = 50             # 0-100 -> filter window 3..9 px
    clahe: bool = False
    clahe_strength: int = 40       # 0-100 -> clip limit 1..4
    repair_dropouts: bool = True
    shadow_gamma: float = 1.0      # >1 darkens low intensities, making acoustic shadows stand out


@dataclass
class FilterReport:
    params: dict
    dropout_rows: list[int] = field(default_factory=list)
    repaired_rows: int = 0
    before: dict = field(default_factory=dict)
    after: dict = field(default_factory=dict)


# ---------- speckle statistics ----------

def _local_stats(f: np.ndarray, k: int):
    mean = cv2.boxFilter(f, -1, (k, k), borderType=cv2.BORDER_REFLECT)
    sq = cv2.boxFilter(f * f, -1, (k, k), borderType=cv2.BORDER_REFLECT)
    return mean, np.maximum(sq - mean * mean, 0.0)


def _speckle_cu2(mean: np.ndarray, var: np.ndarray) -> float:
    """Squared coefficient of variation of the speckle, estimated from the most homogeneous areas."""
    ci2 = var / np.maximum(mean * mean, 1e-6)
    valid = mean > 10
    if not valid.any():
        return 0.05
    return float(max(np.percentile(ci2[valid], 25), 1e-4))


def quality_metrics(gray: np.ndarray) -> dict:
    f = gray.astype(np.float32)
    mean, var = _local_stats(f, 7)
    valid = mean > 10
    si = float(np.mean(np.sqrt(var[valid]) / mean[valid])) if valid.any() else 0.0
    cu2 = _speckle_cu2(mean, var)
    return {
        "speckle_index": round(si, 4),              # mean local std/mean (lower = smoother)
        "equivalent_number_of_looks": round(1.0 / cu2, 2),  # higher = less speckle
        "mean_intensity": round(float(f.mean()), 2),
    }


# ---------- speckle filters ----------

def lee_filter(f: np.ndarray, k: int) -> np.ndarray:
    mean, var = _local_stats(f, k)
    cu2 = _speckle_cu2(mean, var)
    ci2 = var / np.maximum(mean * mean, 1e-6)
    w = np.clip(1.0 - cu2 / np.maximum(ci2, 1e-6), 0.0, 1.0)
    return mean + w * (f - mean)


def kuan_filter(f: np.ndarray, k: int) -> np.ndarray:
    mean, var = _local_stats(f, k)
    cu2 = _speckle_cu2(mean, var)
    ci2 = var / np.maximum(mean * mean, 1e-6)
    w = np.clip((1.0 - cu2 / np.maximum(ci2, 1e-6)) / (1.0 + cu2), 0.0, 1.0)
    return mean + w * (f - mean)


def frost_filter(f: np.ndarray, k: int, damping: float = 2.0) -> np.ndarray:
    """Exponentially weighted filter; weights fall off faster where local variation (edges) is high."""
    mean, var = _local_stats(f, k)
    b = damping * var / np.maximum(mean * mean, 1e-6)
    r = k // 2
    h, w = f.shape
    pad = cv2.copyMakeBorder(f, r, r, r, r, cv2.BORDER_REFLECT)
    num = np.zeros_like(f)
    den = np.zeros_like(f)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            wgt = np.exp(-b * float(np.hypot(dx, dy)))
            num += wgt * pad[r + dy:r + dy + h, r + dx:r + dx + w]
            den += wgt
    return num / np.maximum(den, 1e-6)


def despeckle(gray: np.ndarray, method: str, strength: int) -> np.ndarray:
    if method == "none" or strength <= 0:
        return gray
    k = 3 + 2 * int(round(np.clip(strength, 0, 100) / 100 * 3))  # 3, 5, 7, 9
    if method == "median":
        return cv2.medianBlur(gray, k)
    f = gray.astype(np.float32)
    out = {"lee": lee_filter, "kuan": kuan_filter, "frost": frost_filter}[method](f, k)
    return np.clip(out, 0, 255).astype(np.uint8)


# ---------- ping dropouts ----------

def find_dropout_rows(gray: np.ndarray) -> np.ndarray:
    """Rows (pings) that are almost black or flat compared with the rest of the record."""
    row_mean = gray.mean(axis=1)
    row_std = gray.std(axis=1)
    ref = float(np.median(row_mean))
    if ref < 5:  # image is essentially dark; nothing reliable to compare against
        return np.zeros(0, dtype=int)
    return np.where((row_mean < 0.15 * ref) | (row_std < 1.0))[0]


def repair_rows(gray: np.ndarray, bad: np.ndarray, max_gap: int = 40) -> tuple[np.ndarray, int]:
    """Linearly interpolate short runs of bad pings from the nearest good pings above and below."""
    if len(bad) == 0:
        return gray, 0
    out = gray.astype(np.float32)
    h = gray.shape[0]
    is_bad = np.zeros(h, bool)
    is_bad[bad] = True
    repaired, y = 0, 0
    while y < h:
        if not is_bad[y]:
            y += 1
            continue
        start = y
        while y < h and is_bad[y]:
            y += 1
        end = y  # exclusive
        above, below = start - 1, end
        if end - start > max_gap or (above < 0 and below >= h):
            continue
        if above < 0:
            out[start:end] = out[below]
        elif below >= h:
            out[start:end] = out[above]
        else:
            t = (np.arange(start, end) - above) / (below - above)
            out[start:end] = (1 - t)[:, None] * out[above] + t[:, None] * out[below]
        repaired += end - start
    return np.clip(out, 0, 255).astype(np.uint8), repaired


# ---------- full pipeline ----------

def apply_filters(gray: np.ndarray, params: FilterParams) -> tuple[np.ndarray, FilterReport]:
    if params.denoise not in DENOISE_METHODS:
        raise ValueError(f"denoise must be one of {DENOISE_METHODS}")
    report = FilterReport(params=params.__dict__.copy(), before=quality_metrics(gray))
    out = gray
    if params.repair_dropouts:
        bad = find_dropout_rows(out)
        report.dropout_rows = bad.tolist()[:500]
        out, report.repaired_rows = repair_rows(out, bad)
    out = despeckle(out, params.denoise, params.strength)
    if params.shadow_gamma and abs(params.shadow_gamma - 1.0) > 1e-3:
        lut = (np.linspace(0, 1, 256) ** params.shadow_gamma * 255).astype(np.uint8)
        out = cv2.LUT(out, lut)
    if params.clahe:
        clip = 1.0 + np.clip(params.clahe_strength, 0, 100) / 100 * 3.0
        out = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(out)
    report.after = quality_metrics(out)
    return out, report
