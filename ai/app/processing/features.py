"""Explainable evidence for one detection candidate: is it a man-made object or natural seabed?

Every feature is something a sonar analyst looks at, so the classifier's decision can be explained in plain words:
  model           detector / segmenter confidence and agreement
  highlight       contrast with the seabed, long straight edges, size and shape
  shadow          an attached, compact, sharp-edged shadow pointing away from the sonar (standing objects)
  context         does the texture continue outside the box (part of the seabed), periodic pattern (sand ripples),
                  many similar bright blobs nearby (rock cluster)
  data quality    water column, nadir, repaired pings, motion-flagged pings, interference
"""

import cv2
import numpy as np

from app.processing.scoring import _clip_box, _ring, contrast_evidence, linearity_evidence, shadow_evidence
from app.processing.shadows import segment_shadow

CLASSES = ("shipwreck", "aircraft_wreck", "mine_like_object", "debris", "human_body", "marine_life")

FEATURES = (
    "model_conf", "calibrated", "agreement", "from_segmenter",
    *(f"class_{c}" for c in CLASSES),
    "log_width", "log_height", "aspect", "range_pos", "at_edge",
    "contrast", "linearity", "shadow_evidence", "texture_ratio", "brightness_ratio", "dark_box",
    "shadow_found", "shadow_length_ratio", "shadow_area_ratio", "shadow_solidity", "shadow_sharpness", "shadow_darkness",
    "shadow_pieces",
    "isolation", "periodicity", "orientation_coherence", "blob_density", "blob_similarity",
    "in_water_column", "near_nadir", "repaired_pings", "motion_flagged", "interference",
)

# plain-language reasons: feature -> (pushes towards natural, pushes towards man-made)
PHRASES = {
    "model_conf": ("weak detector response", "strong detector response"),
    "calibrated": ("below the detector's calibrated threshold", "well above the detector's calibrated threshold"),
    "agreement": ("only one model found it", "detector and segmenter agree"),
    "from_segmenter": ("", "outlined by the wreck segmenter"),
    "log_width": ("very narrow", "large across-track extent"),
    "log_height": ("very short along-track", "long along-track"),
    "aspect": ("compact blob", "elongated shape"),
    "range_pos": ("near the nadir", "at far range"),
    "at_edge": ("cut by the image edge", ""),
    "contrast": ("barely stands out from the seabed", "stands out clearly from the seabed"),
    "linearity": ("no straight edges", "long straight edges"),
    "shadow_evidence": ("no dark acoustic shadow behind it", "dark acoustic shadow behind it"),
    "texture_ratio": ("same texture as the surrounding seabed", "texture unlike the surrounding seabed"),
    "brightness_ratio": ("no brighter than the seabed", "bright echo"),
    "dark_box": ("a dark patch, not an echo", ""),
    "shadow_found": ("no shadow attached to it", "shadow attached to it"),
    "shadow_length_ratio": ("short or no shadow", "long shadow: stands well above the seabed"),
    "shadow_area_ratio": ("small shadow", "substantial shadow"),
    "shadow_solidity": ("ragged, irregular shadow", "compact, regular shadow"),
    "shadow_sharpness": ("blurred shadow edges", "sharp shadow edges"),
    "shadow_darkness": ("shadow not dark", "deep shadow"),
    "shadow_pieces": ("many separate shadows around (rocky ground)", ""),
    "isolation": ("the pattern continues outside the box (part of the seabed)", "isolated object on plain seabed"),
    "periodicity": ("periodic ripple pattern", ""),
    "orientation_coherence": ("uniformly oriented texture (bedforms)", ""),
    "blob_density": ("many similar bright blobs nearby (rock cluster)", ""),
    "blob_similarity": ("looks like its neighbours (natural cluster)", "unlike anything around it"),
    "in_water_column": ("in the water column (above the seabed)", ""),
    "near_nadir": ("near the nadir, where geometry is poor", ""),
    "repaired_pings": ("on interpolated (repaired) pings", ""),
    "motion_flagged": ("on pings with excessive vehicle motion", ""),
    "interference": ("on pings hit by interference", ""),
}


def _patch(gray: np.ndarray, box, scale: float) -> np.ndarray:
    h, w = gray.shape
    x1, y1, x2, y2 = (float(v) for v in box)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    hw, hh = max(x2 - x1, 8) * scale / 2, max(y2 - y1, 8) * scale / 2
    a, b = int(max(0, cx - hw)), int(min(w, cx + hw))
    c, d = int(max(0, cy - hh)), int(min(h, cy + hh))
    return gray[c:d, a:b]


def _periodicity(patch: np.ndarray) -> tuple[float, float]:
    """(spectral peak prominence, orientation coherence) of a seabed patch: sand ripples are periodic and
    uniformly oriented; rocks and debris are neither."""
    if patch.shape[0] < 12 or patch.shape[1] < 12:
        return 0.0, 0.0
    p = cv2.resize(patch.astype(np.float32), (64, 64), interpolation=cv2.INTER_AREA)
    p = p - p.mean()
    p *= np.outer(np.hanning(64), np.hanning(64)).astype(np.float32)
    spec = np.abs(np.fft.fftshift(np.fft.fft2(p))) ** 2
    spec[30:35, 30:35] = 0                     # drop DC and the lowest frequencies (overall shading)
    peak = float(spec.max() / (spec.mean() + 1e-6))
    gx = cv2.Sobel(p, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(p, cv2.CV_32F, 0, 1, ksize=3)
    jxx, jyy, jxy = float((gx * gx).sum()), float((gy * gy).sum()), float((gx * gy).sum())
    coh = float(np.sqrt((jxx - jyy) ** 2 + 4 * jxy ** 2) / (jxx + jyy + 1e-6))
    return float(np.log1p(peak)), coh


def _blobs(gray: np.ndarray, box) -> tuple[float, float]:
    """(density of bright blobs around the candidate, similarity of the candidate's brightness to those blobs)."""
    region = _patch(gray, box, 4.0).astype(np.float32)
    if region.size < 400:
        return 0.0, 0.0
    sm = cv2.GaussianBlur(region, (0, 0), 2.0)
    thr = float(np.percentile(sm, 97))
    peaks = (sm >= cv2.dilate(sm, np.ones((9, 9), np.uint8))) & (sm > thr) & (sm > np.median(sm) * 1.3 + 5)
    n = int(peaks.sum())
    density = n / (region.size / 1e4)                   # blobs per 100 x 100 px
    inside = _patch(gray, box, 1.0).astype(np.float32)
    if n == 0 or inside.size == 0:
        return float(density), 0.0
    peak_vals = sm[peaks]
    sim = 1.0 - min(1.0, abs(float(np.percentile(inside, 95)) - float(np.median(peak_vals))) / (np.median(peak_vals) + 1.0))
    return float(density), float(sim)


def candidate_features(gray: np.ndarray, box, nadir: float, class_name: str, conf: float, threshold: float,
                       agreement: bool, source: str, quality: dict | None = None) -> tuple[np.ndarray, dict]:
    """(feature vector in FEATURES order, extras: the shadow outline and raw evidence for the report)."""
    from app.processing.scoring import calibrated_score

    h, w = gray.shape
    x1, y1, x2, y2 = _clip_box(box, h, w)
    bw, bh = max(x2 - x1, 1), max(y2 - y1, 1)
    inside = gray[y1:y2, x1:x2].astype(np.float32)
    ring = _ring(gray, box, int(max(8, 0.5 * max(bw, bh))))
    ring_wide = _ring(gray, (x1 - bw, y1 - bh, x2 + bw, y2 + bh), int(max(8, 0.5 * max(bw, bh))))
    r_mean, r_std = (float(ring.mean()), float(ring.std())) if ring.size else (float(gray.mean()), float(gray.std()))
    i_mean, i_std = (float(inside.mean()), float(inside.std())) if inside.size else (r_mean, r_std)
    contrast = contrast_evidence(gray, box)
    shadow_ev = shadow_evidence(gray, box, nadir)
    linear = linearity_evidence(gray, box)
    sh = segment_shadow(gray, box, nadir)
    period, coh = _periodicity(_patch(gray, box, 3.0))
    dens, sim = _blobs(gray, box)
    # isolation: the candidate differs from its ring more than the ring differs from the wider surroundings
    wide_std = float(ring_wide.std()) if ring_wide.size else r_std
    isolation = float(np.clip((abs(i_mean - r_mean) / (r_std + 1.0)) - (abs(r_mean - float(ring_wide.mean() if ring_wide.size else r_mean)) / (wide_std + 1.0)), -2, 4))
    half = max(nadir, w - nadir, 1.0)
    q = quality or {}
    vals = {
        "model_conf": conf,
        "calibrated": calibrated_score(conf, threshold) / 100.0,
        "agreement": float(agreement),
        "from_segmenter": float("segmenter" in source),
        **{f"class_{c}": float(class_name == c) for c in CLASSES},
        "log_width": float(np.log1p(bw)),
        "log_height": float(np.log1p(bh)),
        "aspect": float(np.log(max(bw, bh) / max(min(bw, bh), 1))),
        "range_pos": float(min(1.0, abs((x1 + x2) / 2 - nadir) / half)),
        "at_edge": float(x1 <= 1 or y1 <= 1 or x2 >= w - 1 or y2 >= h - 1),
        "contrast": contrast,
        "linearity": linear,
        "shadow_evidence": shadow_ev,
        "texture_ratio": float(np.clip(np.log((i_std + 1.0) / (r_std + 1.0)), -2, 2)),
        "brightness_ratio": float(np.clip(np.log((i_mean + 1.0) / (r_mean + 1.0)), -2, 2)),
        "dark_box": float(i_mean < 0.7 * r_mean),
        "shadow_found": float(sh["found"]),
        "shadow_length_ratio": float(min(sh["length_ratio"], 6.0)),
        "shadow_area_ratio": float(min(sh["area_ratio"], 6.0)),
        "shadow_solidity": sh["solidity"],
        "shadow_sharpness": float(min(sh["sharpness"], 2.0)),
        "shadow_darkness": sh["darkness"],
        "shadow_pieces": float(np.log1p(sh["pieces"])),
        "isolation": isolation,
        "periodicity": period,
        "orientation_coherence": coh,
        "blob_density": float(np.log1p(dens)),
        "blob_similarity": sim,
        "in_water_column": float(bool(q.get("in_water_column"))),
        "near_nadir": float(bool(q.get("near_nadir"))),
        "repaired_pings": float(q.get("repaired_pings", 0.0)),
        "motion_flagged": float(q.get("motion_flagged", 0.0)),
        "interference": float(bool(q.get("interference"))),
    }
    vec = np.array([vals[f] for f in FEATURES], np.float64)
    extras = {"shadow": {k: v for k, v in sh.items() if k != "cols"}, "evidence": {
        "shadow": round(shadow_ev, 3), "linearity": round(linear, 3), "contrast": round(contrast, 3),
        "isolation": round(isolation, 3), "periodicity": round(period, 3), "orientation_coherence": round(coh, 3),
        "blob_density": round(dens, 3)}}
    return vec, extras
