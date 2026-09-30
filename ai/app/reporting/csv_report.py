"""Structured anomaly reports (CSV flattening of the JSON analysis result)."""

import csv
import io

CSV_COLUMNS = [
    "analysis_id", "detection_id", "status", "class_name", "category", "severity", "is_hazard", "confidence_pct",
    "latitude", "longitude", "side", "across_track_m", "timestamp", "bbox_x1", "bbox_y1", "bbox_x2", "bbox_y2",
    "width_px", "height_px", "across_track_extent_m", "along_track_extent_m", "area_m2", "source_model",
    "model_confidence", "shadow", "linearity", "contrast", "suppression_reasons", "source_file",
]


def to_csv(result: dict) -> str:
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=CSV_COLUMNS)
    writer.writeheader()
    for d in result["detections"]:
        loc = d.get("location") or {}
        dims = d.get("dimensions") or {}
        ev = d.get("evidence") or {}
        b = d["bbox"]
        writer.writerow({
            "analysis_id": result["analysis_id"],
            "detection_id": d["id"],
            "status": d["status"],
            "class_name": d["class_name"],
            "category": d["category"],
            "severity": d["severity"],
            "is_hazard": d["is_hazard"],
            "confidence_pct": d["confidence"],
            "latitude": loc.get("latitude"),
            "longitude": loc.get("longitude"),
            "side": loc.get("side"),
            "across_track_m": loc.get("across_track_m"),
            "timestamp": loc.get("timestamp"),
            "bbox_x1": b["x1"], "bbox_y1": b["y1"], "bbox_x2": b["x2"], "bbox_y2": b["y2"],
            "width_px": b["width"], "height_px": b["height"],
            "across_track_extent_m": dims.get("across_track_m"),
            "along_track_extent_m": dims.get("along_track_m"),
            "area_m2": dims.get("area_m2"),
            "source_model": d["source"],
            "model_confidence": ev.get("model_confidence"),
            "shadow": ev.get("shadow"),
            "linearity": ev.get("linearity"),
            "contrast": ev.get("contrast"),
            "suppression_reasons": ";".join(d["suppression_reasons"]),
            "source_file": result["source"]["filename"],
        })
    return buf.getvalue()
