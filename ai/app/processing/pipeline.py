"""End-to-end analysis: filter -> detect/segment -> score & filter false positives -> geotag -> report."""

import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

import cv2
import numpy as np

from app.geo.geotagging import Track
from app.ml.inference import RawDetection, fuse, run_model, should_tile, tile_origins
from app.ml.registry import registry
from app.processing.filters import FilterParams, apply_filters
from app.processing.scoring import CATEGORY, SEVERITY, ScoreParams, score_detection

SEVERITY_RANK = {"none": 0, "medium": 1, "high": 2, "critical": 3}


@dataclass
class AnalyzeOptions:
    models: tuple[str, ...] = ("detector", "segmenter")
    tiling: str = "auto"                  # auto | on | off
    filters: FilterParams = field(default_factory=FilterParams)
    score: ScoreParams = field(default_factory=ScoreParams)
    include_suppressed: bool = True
    candidate_floor: float = 0.5          # drop raw candidates below this fraction of the class threshold


def _simplify(poly: np.ndarray, max_points: int = 200) -> list[list[int]]:
    p = poly.astype(np.float32).reshape(-1, 1, 2)
    eps = 1.0
    out = cv2.approxPolyDP(p, eps, True)
    while len(out) > max_points:
        eps *= 1.6
        out = cv2.approxPolyDP(p, eps, True)
    return out.reshape(-1, 2).round().astype(int).tolist()


def _dimensions(d: RawDetection, track: Track | None) -> dict | None:
    if track is None:
        return None
    x1, y1, x2, y2 = d.box
    cy = (y1 + y2) / 2
    a, b = track.pixel_to_geo(x1, cy), track.pixel_to_geo(x2, cy)
    across = abs(a["across_track_m"] - b["across_track_m"]) if a["side"] == b["side"] \
        else a["across_track_m"] + b["across_track_m"]
    along = (y2 - y1) * track.along_m_per_px
    px_area = sum(cv2.contourArea(p.astype(np.float32)) for p in d.polygons) if d.polygons else (x2 - x1) * (y2 - y1)
    m2_per_px = (across / max(x2 - x1, 1e-6)) * track.along_m_per_px
    return {"across_track_m": round(across, 2), "along_track_m": round(along, 2),
            "area_m2": round(px_area * m2_per_px, 2), "area_from": "mask" if d.polygons else "bbox"}


def analyze(gray: np.ndarray, track: Track | None, options: AnalyzeOptions, source: dict,
            georef_error: str | None = None) -> tuple[dict, np.ndarray]:
    """Returns (result JSON, filtered image used for inference)."""
    t0 = time.perf_counter()
    timings = {}
    h, w = gray.shape

    filtered, freport = apply_filters(gray, options.filters)
    timings["filtering_ms"] = round((time.perf_counter() - t0) * 1000, 1)
    dropout_rows = set(freport.dropout_rows)

    detector = registry.get("detector") if "detector" in options.models else None
    segmenter = registry.get("segmenter") if "segmenter" in options.models else None
    if detector is None and segmenter is None:
        raise RuntimeError("No requested model is loaded")
    ref = detector or segmenter
    tiled = {"on": True, "off": False}.get(options.tiling, should_tile(h, w, ref.tile))

    raw_det, raw_seg = [], []
    if detector:
        t = time.perf_counter()
        raw_det = run_model(detector, filtered, tiled, conf=0.05)
        timings["detector_ms"] = round((time.perf_counter() - t) * 1000, 1)
    if segmenter:
        t = time.perf_counter()
        raw_seg = run_model(segmenter, filtered, tiled, conf=0.05)
        timings["segmenter_ms"] = round((time.perf_counter() - t) * 1000, 1)
    candidates = fuse(raw_det, raw_seg)

    t = time.perf_counter()
    if options.score.nadir_col is None and track is not None:
        options.score.nadir_col = track.nadir_col
    detections = []
    for d in candidates:
        model = segmenter if d.source == "segmenter" else detector
        threshold = model.threshold(d.class_name)
        if d.confidence < threshold * options.candidate_floor:
            continue
        hazard = bool(model.card.get("hazard", {}).get(d.class_name, True))
        s = score_detection(filtered, d.class_name, d.confidence, threshold, d.box, hazard, d.agreement,
                            dropout_rows, options.score)
        if s["status"] == "suppressed" and not options.include_suppressed:
            continue
        x1, y1, x2, y2 = [float(v) for v in d.box]
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        detections.append({
            "class_name": d.class_name,
            "category": CATEGORY.get(d.class_name, d.class_name),
            "severity": SEVERITY.get(d.class_name, "medium"),
            "is_hazard": hazard,
            **s,
            "source": d.source,
            "bbox": {"x1": int(round(x1)), "y1": int(round(y1)), "x2": int(round(x2)), "y2": int(round(y2)),
                     "width": int(round(x2 - x1)), "height": int(round(y2 - y1))},
            "bbox_pct": {"x": round(100 * x1 / w, 3), "y": round(100 * y1 / h, 3),
                         "width": round(100 * (x2 - x1) / w, 3), "height": round(100 * (y2 - y1) / h, 3)},
            "centroid_px": {"x": round(cx, 1), "y": round(cy, 1)},
            "polygons": [_simplify(p) for p in d.polygons],
            "location": track.pixel_to_geo(cx, cy) if track else None,
            "dimensions": _dimensions(d, track),
        })
    detections.sort(key=lambda d: (d["status"] != "confirmed", -d["confidence"]))
    for i, d in enumerate(detections, 1):
        d["id"] = f"DET-{i:03d}"
        d.update({k: d.pop(k) for k in list(d) if k != "id"})  # keep "id" first in the JSON
    timings["scoring_ms"] = round((time.perf_counter() - t) * 1000, 1)
    timings["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)

    confirmed = [d for d in detections if d["status"] == "confirmed"]
    by_class: dict[str, int] = {}
    for d in confirmed:
        by_class[d["class_name"]] = by_class.get(d["class_name"], 0) + 1
    suppressed_by_reason: dict[str, int] = {}
    for d in detections:
        for r in d["suppression_reasons"]:
            suppressed_by_reason[r] = suppressed_by_reason.get(r, 0) + 1
    max_sev = max((d["severity"] for d in confirmed if d["is_hazard"]), key=SEVERITY_RANK.get, default="none")

    tiles = 1
    if tiled:
        tiles = len(tile_origins(h, ref.tile, ref.overlap)) * len(tile_origins(w, ref.tile, ref.overlap))

    result = {
        "analysis_id": uuid.uuid4().hex[:12],
        "created_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": {**source, "width": w, "height": h},
        "georeference": ({"available": True, **track.summary()} if track else
                         {"available": False, "reason": georef_error or "No navigation metadata supplied"}),
        "summary": {
            "candidates": len(candidates),
            "confirmed": len(confirmed),
            "suppressed": len(detections) - len(confirmed),
            "hazards": sum(1 for d in confirmed if d["is_hazard"]),
            "by_class": by_class,
            "suppressed_by_reason": suppressed_by_reason,
            "max_severity": max_sev,
            "mean_confidence": round(float(np.mean([d["confidence"] for d in confirmed])), 1) if confirmed else None,
        },
        "processing": {
            "models": {role: {"name": m.name, "weights": m.weights.name, "device": m.device}
                       for role, m in (("detector", detector), ("segmenter", segmenter)) if m},
            "tiled": tiled,
            "tiles": tiles,
            "min_score": options.score.min_score,
            "fp_filter": options.score.fp_filter,
            "filters": {"params": freport.params, "dropout_rows_detected": len(freport.dropout_rows),
                        "dropout_rows_repaired": freport.repaired_rows,
                        "quality_before": freport.before, "quality_after": freport.after},
            "timings": timings,
        },
        "detections": detections,
    }
    return result, filtered
