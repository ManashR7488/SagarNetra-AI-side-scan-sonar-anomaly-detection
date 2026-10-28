"""Live robustness test: disturb a real scan step by step and check the detections hold.

The PS asks for robustness to speckle, varying resolution and data dropouts from vehicle motion. For a region of the
scan this module injects one disturbance at increasing levels and runs the full pipeline on each version three ways:
  raw      straight into detection + false-alarm scoring
  auto     Auto clean with the AI profile (what production does: only steps the measured noise calls for AND the
           benchmark showed help detection)
  full     every step the measured noise calls for (the analyst view's cleaning): looks cleanest, but the detector
           was trained on raw sonar, so this shows why Auto is selective
(no geometry changes, so detections stay comparable). Every pipeline is compared with its OWN result on the
undisturbed region: cleaning changes what the detector finds even without a disturbance, so comparing Auto with
the raw detections would mix "cleaning changed the detections" with "the disturbance broke them". Reported per
level: how many of the pipeline's baseline detections survive, their confidence, and new detections (false alarms).

Disturbances (deterministic, seeded):
  speckle     multiplicative gamma speckle, fewer looks per level (single-look = strongest)
  dropouts    lost / partial pings in short runs, heave jitter (pings shifted in range), roll gain wobble per side
  resolution  coarser sonar: downsampled by 1.5-4x and enlarged back
  gain        range-dependent gain error (TVG mismatch), along-track gain drift and steps, interference bursts
"""

import dataclasses
import time

import cv2
import numpy as np

from app.cleaning.auto import auto_params
from app.cleaning.pipeline import clean, diagnose
from app.processing.filters import FilterParams
from app.processing.pipeline import AnalyzeOptions, analyze

DISTURBANCES = ("speckle", "dropouts", "resolution", "gain")
SEVERITY = {
    "speckle": [("8 looks", 8.0), ("3 looks", 3.0), ("1.5 looks", 1.5), ("single look", 1.0), ("single look x1.5", 0.6)],
    "dropouts": [("1 % pings lost", 0.01), ("3 % lost", 0.03), ("6 % lost", 0.06), ("10 % lost", 0.10), ("15 % lost", 0.15)],
    "resolution": [("1.5x coarser", 1.5), ("2x coarser", 2.0), ("3x coarser", 3.0), ("4x coarser", 4.0), ("6x coarser", 6.0)],
    "gain": [("mild", 1.0), ("moderate", 2.0), ("strong", 3.0), ("severe", 4.0), ("extreme", 5.0)],
}


def disturb(img: np.ndarray, kind: str, level: int, nadir: float, seed: int = 0) -> np.ndarray:
    """`level` 1.. (index into SEVERITY)."""
    rng = np.random.default_rng(seed * 1000 + DISTURBANCES.index(kind) * 100 + level)
    h, w = img.shape
    f = img.astype(np.float32)
    _, k = SEVERITY[kind][level - 1]
    if kind == "speckle":
        out = f * np.sqrt(rng.gamma(k, 1.0 / k, size=f.shape)).astype(np.float32)
    elif kind == "dropouts":
        out = f.copy()
        n_lost = int(k * h)
        lost = 0
        c = int(np.clip(nadir, 1, w - 1))
        while lost < n_lost:
            start, length = int(rng.integers(0, h)), int(rng.integers(1, 9))
            sl = slice(start, min(h, start + length))
            noise = rng.integers(0, 4, size=out[sl].shape).astype(np.float32)
            part = rng.random()
            if part < 0.6:
                out[sl] = noise
            elif part < 0.8:
                out[sl, :c] = noise[:, :c]
            else:
                out[sl, c:] = noise[:, c:]
            lost += length
        # heave: pings shifted in range by a few samples (both sides away from / towards the nadir)
        shift = np.round(rng.normal(0, 0.6 * k * 30, h)).astype(int)
        shift = np.clip(cv2.GaussianBlur(shift.astype(np.float32).reshape(-1, 1), (1, 9), 2).ravel(), -15, 15).astype(int)
        for r in np.where(shift != 0)[0]:
            out[r] = np.roll(out[r], shift[r])
        # roll: one side brighter, the other darker, oscillating along-track
        wob = 1 + 2.5 * k * np.sin(np.arange(h) / max(h / 12, 1) * 2 * np.pi + rng.uniform(0, 6))[:, None]
        out[:, c:] *= wob.astype(np.float32)
        out[:, :c] /= wob.astype(np.float32)
    elif kind == "resolution":
        small = cv2.resize(f, (max(8, int(w / k)), max(8, int(h / k))), interpolation=cv2.INTER_AREA)
        out = cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR)
    elif kind == "gain":
        cols = np.abs(np.arange(w) + 0.5 - nadir) / max(nadir, w - nadir, 1)
        ramp = (1.0 / (1.0 + 0.35 * k * cols))[None, :]                      # far range too dark (TVG error)
        drift = 1 + 0.12 * k * np.sin(np.arange(h) / max(h / 3, 1) * 2 * np.pi + rng.uniform(0, 6))
        step = np.ones(h)
        step[int(rng.uniform(0.3, 0.7) * h):] *= 1 + 0.15 * k                # operator gain change
        out = f * ramp * (drift * step)[:, None].astype(np.float32)
        for _ in range(int(2 * k)):                                            # interference bursts
            r0, c0 = int(rng.integers(0, h)), int(rng.integers(0, w // 2))
            cs = np.arange(c0, min(w, c0 + int(rng.integers(w // 8, w // 3))))
            rows = np.clip(r0 + ((cs - c0) * 0.05).astype(int), 0, h - 1)
            out[rows, cs] += rng.uniform(80, 160) * (rng.random(len(cs)) < 0.6)
    else:
        raise ValueError(kind)
    return np.clip(out, 0, 255).astype(np.uint8)


def _detect(img: np.ndarray, nadir: float, models: tuple[str, ...]) -> list[dict]:
    opts = AnalyzeOptions(models=models, filters=FilterParams(repair_dropouts=False))
    opts.score.nadir_col = nadir
    result, _ = analyze(img, None, opts, {"filename": "stress"})
    return [d for d in result["detections"] if d["status"] == "confirmed"]


def _iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _box(d):
    b = d["bbox"]
    return [b["x1"], b["y1"], b["x2"], b["y2"]]


def _compare(base: list[dict], test: list[dict]) -> dict:
    used, kept, conf = set(), 0, []
    for b in base:
        bb = _box(b)
        best, best_iou = None, 0.0
        for i, t in enumerate(test):
            if i in used:
                continue
            tb = _box(t)
            cx, cy = (tb[0] + tb[2]) / 2, (tb[1] + tb[3]) / 2
            v = _iou(bb, tb)
            inside = bb[0] - 10 <= cx <= bb[2] + 10 and bb[1] - 10 <= cy <= bb[3] + 10
            if (v >= 0.3 or inside) and max(v, 0.3 if inside else 0) > best_iou:
                best, best_iou = i, max(v, 0.3 if inside else 0)
        if best is not None:
            used.add(best)
            kept += 1
            conf.append(test[best]["confidence"])
    return {"retained": kept, "retention": round(kept / len(base), 3) if base else None,
            "mean_confidence": round(float(np.mean(conf)), 1) if conf else None,
            "new_false_alarms": len(test) - len(used), "detections": len(test)}


def _mean_conf(dets: list[dict]) -> float | None:
    return round(float(np.mean([d["confidence"] for d in dets])), 1) if dets else None


def choose_region(gray: np.ndarray, max_side: int, nadir: float, models: tuple[str, ...],
                  roi: tuple[int, int, int, int] | None = None) -> tuple[tuple[int, int, int, int], list[dict] | None]:
    """Region (x, y, w, h) of at most max_side, centred on the strongest detection (or the given roi)."""
    h, w = gray.shape
    if roi is not None:
        x, y, rw, rh = roi
        x, y = max(0, x), max(0, y)
        return (x, y, min(rw, w - x, max_side), min(rh, h - y, max_side)), None
    if max(h, w) <= max_side:
        return (0, 0, w, h), None
    dets = _detect(gray, nadir, models)
    cw, ch = min(w, max_side), min(h, max_side)
    if dets:
        top = max(dets, key=lambda d: d["confidence"])
        cx, cy = top["centroid_px"]["x"], top["centroid_px"]["y"]
    else:
        cx, cy = w / 2, h / 2
    x = int(np.clip(cx - cw / 2, 0, w - cw))
    y = int(np.clip(cy - ch / 2, 0, h - ch))
    return (x, y, cw, ch), dets


_NO_GEOMETRY = {"slant_correct": False, "normalize_resolution": False, "shadow_gamma": 1.0, "clahe": False,
                "mask_water_column": False, "motion": False}


def variant_params(img: np.ndarray):
    """Cleaning settings of the disturbed image for the 'auto' (AI profile) and 'full' pipelines."""
    diag = diagnose(img)
    auto, auto_dec = auto_params(diag.to_dict(), "ai")
    full, full_dec = auto_params(diag.to_dict(), "analyst")
    auto = dataclasses.replace(auto, **_NO_GEOMETRY)
    full = dataclasses.replace(full, **_NO_GEOMETRY)
    steps = lambda dec, skip=("motion", "water_column", "display", "surface", "ground_range", "resolution"): [  # noqa: E731
        d["step"] for d in dec if d["enabled"] and d["step"] not in skip]
    return {"auto": (auto, steps(auto_dec)), "full": (full, steps(full_dec))}, diag


def stress_test(gray: np.ndarray, kind: str, levels: int, max_side: int, nadir: float,
                models: tuple[str, ...] = ("detector", "segmenter"), roi=None, thumb_side: int = 360) -> dict:
    from app.readers.image import encode_jpeg, to_data_url

    if kind not in DISTURBANCES:
        raise ValueError(f"disturbance must be one of {DISTURBANCES}")
    levels = int(np.clip(levels, 1, len(SEVERITY[kind])))
    t0 = time.perf_counter()
    (x, y, cw, ch), _ = choose_region(gray, max_side, nadir, models, roi)
    crop = np.ascontiguousarray(gray[y:y + ch, x:x + cw])
    cnadir = nadir - x
    base = _detect(crop, cnadir, models)
    scale = thumb_side / max(crop.shape)
    # each pipeline's own detections on the undisturbed region
    bases, base_steps = {"raw": base}, {}
    for name, (params, used) in variant_params(crop)[0].items():
        base_steps[name] = used
        bases[name] = _detect(clean(crop, params, keep_steps=False, measure_noise=False).image, cnadir, models) \
            if used else base

    def thumb(im):
        return to_data_url(encode_jpeg(cv2.resize(im, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA), 75))

    def boxes(dets):
        return [{"bbox": [round(v * scale, 1) for v in _box(d)], "confidence": d["confidence"],
                 "class_name": d["class_name"]} for d in dets]

    series = []
    for lv in range(1, levels + 1):
        t = time.perf_counter()
        dist = disturb(crop, kind, lv, cnadir)
        raw = _detect(dist, cnadir, models)
        variants, diag = variant_params(dist)
        results = {"raw": _compare(bases["raw"], raw)}
        box_sets = {"raw": boxes(raw)}
        thumbs = {"disturbed": thumb(dist)}
        steps = {}
        for name, (params, used) in variants.items():
            steps[name] = used
            if not used:                       # nothing to clean: the raw detections of the disturbed image
                results[name], box_sets[name] = _compare(bases[name], raw), box_sets["raw"]
                thumbs[name] = thumbs["disturbed"]
                continue
            img = clean(dist, params, keep_steps=False, measure_noise=False).image
            dets = _detect(img, cnadir, models)
            results[name], box_sets[name], thumbs[name] = _compare(bases[name], dets), boxes(dets), thumb(img)
        series.append({
            "level": lv, "label": SEVERITY[kind][lv - 1][0], "results": results,
            "noise": {k: diag.metrics.get(k) for k in ("enl", "speckle_index", "across_imbalance", "ping_jitter",
                                                       "stripe_fraction")},
            "cleaning_steps": steps, "thumbs": thumbs, "boxes": box_sets,
            "ms": round((time.perf_counter() - t) * 1000),
        })
    return {"disturbance": kind, "levels": levels, "region": {"x": x, "y": y, "width": cw, "height": ch},
            "baseline": {"detections": len(base), "boxes": boxes(base), "thumb": thumb(crop),
                         "mean_confidence": _mean_conf(base),
                         "pipelines": {name: {"detections": len(b), "mean_confidence": _mean_conf(b), "boxes": boxes(b),
                                              "cleaning_steps": base_steps.get(name, [])} for name, b in bases.items()}},
            "thumb_scale": round(scale, 5), "series": series, "models": list(models),
            "ms": round((time.perf_counter() - t0) * 1000)}
