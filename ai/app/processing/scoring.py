"""Confidence scoring & false-positive filtering.

Every candidate gets a 0-100 score:

  1. Calibrated model confidence: the per-class threshold that maximised F1 on the validation set
     maps to 50, so 50 means "exactly at the model's best decision point".
  2. Acoustic evidence (hand-crafted, explainable):
       * shadow   - protruding man-made objects cast a dark acoustic shadow on the far-range side
       * linearity - man-made objects have long straight edges; rocks and sand ripples do not
       * contrast - the object must stand out from the local seabed; weak blobs are usually speckle
  3. Agreement bonus when the independent segmentation model finds the same object.

With a trained false-alarm classifier (models/fp_classifier, app/processing/fp_classifier.py) the score instead
blends the classifier's probability that the candidate is man-made (model confidence + a wider set of explainable
evidence: shadow shape, isolation from the surrounding texture, ripple periodicity, rock clustering, data quality)
with the rule score above; rejected candidates are labelled rock cluster / sand ripples / natural shadow / seabed
texture with the reasons.

Candidates are then suppressed (kept in the report, marked with a reason) when they are natural
features (marine life), low-contrast speckle, inside a sonar data dropout, in the water column, too small,
or below the minimum score.
"""

SUPPRESSION_REASONS = ("natural_feature", "low_contrast_speckle", "sonar_data_dropout", "too_small", "below_min_score",
                       "water_column", "rock_cluster", "sand_ripple", "natural_shadow", "seabed_texture")

from dataclasses import dataclass

import cv2
import numpy as np

CATEGORY = {
    "shipwreck": "Shipwreck",
    "aircraft_wreck": "Aircraft Wreck",
    "mine_like_object": "Pipe / Cylinder / Mine-like Object",
    "debris": "Debris / Discarded Gear",
    "human_body": "Human Body (Search & Rescue)",
    "marine_life": "Marine Life (natural)",
}
SEVERITY = {
    "mine_like_object": "critical",
    "human_body": "critical",
    "shipwreck": "high",
    "aircraft_wreck": "high",
    "debris": "medium",
    "marine_life": "none",
}


@dataclass
class ScoreParams:
    fp_filter: bool = True
    min_score: float = 50.0
    nadir_col: float | None = None
    fp_method: str = "auto"          # auto (classifier when trained, else rules) | rules | classifier


def calibrated_score(conf: float, threshold: float) -> float:
    threshold = float(np.clip(threshold, 0.01, 0.99))
    if conf >= threshold:
        return 50.0 + 50.0 * (conf - threshold) / (1.0 - threshold)
    return 50.0 * conf / threshold


def _clip_box(box, h, w):
    x1, y1, x2, y2 = box
    return int(max(0, np.floor(x1))), int(max(0, np.floor(y1))), int(min(w, np.ceil(x2))), int(min(h, np.ceil(y2)))


def _ring(gray, box, pad):
    h, w = gray.shape
    x1, y1, x2, y2 = _clip_box(box, h, w)
    X1, Y1, X2, Y2 = max(0, x1 - pad), max(0, y1 - pad), min(w, x2 + pad), min(h, y2 + pad)
    outer = gray[Y1:Y2, X1:X2].astype(np.float32)
    mask = np.ones(outer.shape, bool)
    mask[y1 - Y1:y2 - Y1, x1 - X1:x2 - X1] = False
    return outer[mask] if mask.any() else outer.ravel()


def contrast_evidence(gray: np.ndarray, box) -> float:
    h, w = gray.shape
    x1, y1, x2, y2 = _clip_box(box, h, w)
    inside = gray[y1:y2, x1:x2].astype(np.float32)
    if inside.size == 0:
        return 0.0
    pad = int(max(8, 0.5 * max(x2 - x1, y2 - y1)))
    ring = _ring(gray, box, pad)
    if ring.size == 0:
        return 0.0
    z = abs(float(inside.mean()) - float(ring.mean())) / (float(ring.std()) + 1.0)
    texture = max(0.0, float(inside.std()) / (float(ring.std()) + 1e-3) - 1.0)
    return float(np.clip((z + texture) / 2.0, 0.0, 1.0))


def shadow_evidence(gray: np.ndarray, box, nadir_col: float) -> float:
    """Darkness of the strip just beyond the object on the side away from the nadir."""
    h, w = gray.shape
    x1, y1, x2, y2 = _clip_box(box, h, w)
    bw = x2 - x1
    sw = int(max(6, 0.6 * bw))
    if (x1 + x2) / 2 >= nadir_col:          # starboard -> shadow to the right
        sx1, sx2 = x2, min(w, x2 + sw)
    else:                                    # port -> shadow to the left
        sx1, sx2 = max(0, x1 - sw), x1
    if sx2 - sx1 < 2 or y2 - y1 < 2:
        return 0.0
    shadow = gray[y1:y2, sx1:sx2].astype(np.float32)
    ring = _ring(gray, box, int(max(8, 0.5 * max(bw, y2 - y1))))
    ref = float(np.median(ring)) if ring.size else float(gray.mean())
    return float(np.clip(1.5 * (ref - float(shadow.mean())) / (ref + 1.0), 0.0, 1.0))


def linearity_evidence(gray: np.ndarray, box) -> float:
    """Fraction of the box perimeter explained by long straight edges (Canny + probabilistic Hough)."""
    h, w = gray.shape
    x1, y1, x2, y2 = _clip_box(box, h, w)
    crop = gray[y1:y2, x1:x2]
    if crop.shape[0] < 8 or crop.shape[1] < 8:
        return 0.0
    scale = min(1.0, 256 / max(crop.shape))
    if scale < 1.0:
        crop = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    crop = cv2.GaussianBlur(crop, (3, 3), 0)
    med = float(np.median(crop))
    edges = cv2.Canny(crop, int(max(0, 0.66 * med)), int(min(255, 1.33 * med + 20)))
    min_len = max(8, int(0.25 * min(crop.shape)))
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=15, minLineLength=min_len, maxLineGap=3)
    if lines is None:
        return 0.0
    seg = np.asarray(lines).reshape(-1, 4)  # OpenCV 4 returns (N,1,4), OpenCV 5 (N,4)
    total = float(np.sum(np.hypot(seg[:, 2] - seg[:, 0], seg[:, 3] - seg[:, 1])))
    return float(np.clip(total / (2.0 * sum(crop.shape)), 0.0, 1.0))


def rule_score(base: float, shadow: float, linear: float, contrast: float, agreement: bool) -> float:
    """The hand-set rules: calibrated model confidence + acoustic evidence + agreement bonus, 0-100."""
    combined = 0.4 * shadow + 0.3 * linear + 0.3 * contrast
    return float(np.clip(base + (combined - 0.35) * 30.0 + (10.0 if agreement else 0.0), 0.0, 100.0))


def _rule_reasons(shadow: float, linear: float, contrast: float, agreement: bool, kept: bool) -> list[str]:
    if kept:
        out = [p for ok, p in ((shadow > 0.35, "dark acoustic shadow behind it"), (linear > 0.3, "long straight edges"),
                               (contrast > 0.4, "stands out clearly from the seabed"),
                               (agreement, "detector and segmenter agree")) if ok]
    else:
        out = [p for ok, p in ((shadow < 0.15, "no dark acoustic shadow behind it"), (linear < 0.1, "no straight edges"),
                               (contrast < 0.15, "barely stands out from the seabed")) if ok]
    return out[:3]


def fp_filter_info(params: ScoreParams) -> dict:
    """Which false-alarm filter scored the candidates (for the report), with the classifier's validation."""
    from app.processing.fp_classifier import get_classifier

    if not params.fp_filter:
        return {"method": "off"}
    clf = get_classifier() if params.fp_method != "rules" else None
    return {"method": "classifier", **clf.summary()} if clf is not None else {"method": "rules"}


def score_detection(gray: np.ndarray, class_name: str, conf: float, threshold: float, box, hazard: bool,
                    agreement: bool, dropout_rows: set[int], params: ScoreParams, quality: dict | None = None,
                    source: str = "detector") -> dict:
    from app.processing.features import FEATURES, candidate_features
    from app.processing.fp_classifier import SUBTYPE_REASON, get_classifier, rule_subtype

    h, w = gray.shape
    base = calibrated_score(conf, threshold)
    x1, y1, x2, y2 = _clip_box(box, h, w)
    evidence = {"calibrated_threshold": round(threshold, 3), "model_confidence": round(conf, 4)}
    reasons: list[str] = []
    score = base
    natural = shadow_outline = None
    if params.fp_filter:
        nadir = params.nadir_col if params.nadir_col is not None else w / 2
        vec, extras = candidate_features(gray, box, nadir, class_name, conf, threshold, agreement, source, quality)
        vals = dict(zip(FEATURES, vec))
        ev = extras["evidence"]
        shadow_outline = extras["shadow"]
        shadow, linear, contrast = ev["shadow"], ev["linearity"], ev["contrast"]
        clf = get_classifier() if params.fp_method != "rules" else None
        if params.fp_method == "classifier" and clf is None:
            raise RuntimeError("fp_method=classifier but no trained classifier is installed (models/fp_classifier)")
        rules = rule_score(base, shadow, linear, contrast, agreement)
        if clf is not None:
            pred = clf.predict(vec, rules)
            p = pred["p_man_made"]
            score = clf.score(p)
            nat = p < clf.threshold
            natural = {"method": "classifier", "p_man_made": round(p, 3),
                       "p_classifier": round(pred["p_classifier"], 3), "rule_score": round(rules, 1),
                       "label": pred.get("subtype") if nat else None,
                       "subtype_probabilities": pred.get("subtype_probs"),
                       "reasons": clf.reasons(pred["contributions"], towards_natural=nat)}
            combined = p
        else:
            combined = 0.4 * shadow + 0.3 * linear + 0.3 * contrast
            score = rules
            kept = score >= params.min_score
            natural = {"method": "rules", "p_man_made": None, "label": None if kept else rule_subtype(vals),
                       "subtype_probabilities": None,
                       "reasons": _rule_reasons(shadow, linear, contrast, agreement, kept)}
        evidence.update(shadow=round(shadow, 3), linearity=round(linear, 3), contrast=round(contrast, 3),
                        acoustic_evidence=round(float(combined), 3), model_agreement=agreement,
                        isolation=ev["isolation"], periodicity=ev["periodicity"],
                        orientation_coherence=ev["orientation_coherence"], blob_density=ev["blob_density"])
        if not hazard:
            reasons.append("natural_feature")
        if contrast < 0.08:
            reasons.append("low_contrast_speckle")
        rows = y2 - y1
        if rows > 0 and dropout_rows and sum(1 for r in range(y1, y2) if r in dropout_rows) / rows > 0.5:
            reasons.append("sonar_data_dropout")
        if x2 - x1 < 4 or y2 - y1 < 4:
            reasons.append("too_small")
        if quality is not None and quality.get("in_water_column"):
            reasons.append("water_column")     # fish, bubbles, surface echo: above the seabed
    score = float(np.clip(score, 0.0, 100.0))
    if score < params.min_score:
        reasons.append("below_min_score")
        if natural is not None and natural.get("label"):
            reasons.append(SUBTYPE_REASON[natural["label"]])
    out = {
        "confidence": round(score, 1),
        "status": "suppressed" if reasons else "confirmed",
        "suppression_reasons": reasons,
        "evidence": evidence,
    }
    if natural is not None:
        out["natural"] = natural
    if shadow_outline is not None:
        out["shadow"] = shadow_outline
    return out
