"""Sliced inference for the YOLO detector and segmenter: tiling, NMS, merging, detector/segmenter fusion."""

from dataclasses import dataclass, field

import numpy as np

from app.ml.onnx_yolo import batched_nms
from app.ml.registry import SonarModel


@dataclass
class RawDetection:
    class_name: str
    confidence: float
    box: np.ndarray                       # x1, y1, x2, y2 in full-image pixels
    polygons: list[np.ndarray] = field(default_factory=list)  # segmentation outlines (N x 2 pixel arrays)
    source: str = "detector"
    agreement: bool = False               # confirmed by both detector and segmenter


# ---------- tiling ----------

def tile_origins(length: int, tile: int, overlap: float) -> list[int]:
    if length <= tile:
        return [0]
    stride = int(tile * (1 - overlap))
    xs = list(range(0, length - tile + 1, stride))
    if xs[-1] != length - tile:
        xs.append(length - tile)
    return xs


def should_tile(height: int, width: int, tile: int) -> bool:
    """Tall survey strips (AI4Shipwrecks / XTF waterfalls) were trained as native-resolution tiles;
    screenshots and small images were trained whole (resized). Mirror that at inference."""
    return (height >= width and max(height, width) > 1.5 * tile) or max(height, width) > 4 * tile


def _box_iou(a: np.ndarray, b: np.ndarray) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _overlap_min(a: np.ndarray, b: np.ndarray) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    small = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ix * iy / small if small > 0 else 0.0


def merge_overlapping(dets: list[RawDetection], iou: float = 0.3, contain: float = 0.3) -> list[RawDetection]:
    """Collapse boxes that describe the same object into one.

    Handles objects split across tile borders, parts of a wreck detected separately, and the same
    object given two classes (e.g. shipwreck vs aircraft_wreck). The highest-confidence member keeps
    its class and confidence; the box becomes the union and all masks are kept.
    """
    dets = sorted(dets, key=lambda d: -d.confidence)
    changed = True
    while changed:
        changed = False
        merged: list[RawDetection] = []
        for d in dets:
            for m in merged:
                if _box_iou(m.box, d.box) > iou or _overlap_min(m.box, d.box) > contain:
                    m.box = np.array([min(m.box[0], d.box[0]), min(m.box[1], d.box[1]),
                                      max(m.box[2], d.box[2]), max(m.box[3], d.box[3])])
                    m.polygons += d.polygons
                    m.agreement = m.agreement or d.agreement
                    if d.source != m.source and "+" not in m.source:
                        m.source = "detector+segmenter"
                        m.agreement = True
                    changed = True
                    break
            else:
                merged.append(d)
        dets = merged
    return dets


def run_model(model: SonarModel, gray: np.ndarray, tiled: bool, conf: float) -> list[RawDetection]:
    h, w = gray.shape
    if tiled:
        origins = [(x, y) for y in tile_origins(h, model.tile, model.overlap)
                   for x in tile_origins(w, model.tile, model.overlap)]
    else:
        origins = [(0, 0)]
    boxes, scores, classes, polys = [], [], [], []
    bs = model.batch
    for i in range(0, len(origins), bs):
        chunk = origins[i:i + bs]
        crops = [gray[y:y + model.tile, x:x + model.tile] if tiled else gray for x, y in chunk]
        for (x, y), r in zip(chunk, model.predict(crops, conf)):
            if len(r.xyxy) == 0:
                continue
            offset = np.array([x, y, x, y], np.float32)
            boxes.append(r.xyxy + offset)
            scores.append(r.conf)
            classes.append(r.cls)
            if r.polygons is not None:
                polys += [p + np.array([x, y], np.float32) for p in r.polygons]
            else:
                polys += [None] * len(r.xyxy)
    if not boxes:
        return []
    b, s, c = np.concatenate(boxes), np.concatenate(scores), np.concatenate(classes)
    keep = batched_nms(b, s, c, model.nms_iou)
    dets = [RawDetection(class_name=model.classes[c[k]], confidence=float(s[k]), box=b[k].astype(float),
                         polygons=[polys[k]] if polys[k] is not None and len(polys[k]) >= 3 else [],
                         source="segmenter" if model.task == "segment" else "detector")
            for k in keep]
    return dets


def fuse(detector: list[RawDetection], segmenter: list[RawDetection], iou: float = 0.3) -> list[RawDetection]:
    """Attach segmentation masks to matching detector boxes; keep unmatched segmenter wrecks."""
    out = list(detector)
    for s in segmenter:
        match = max((d for d in detector if d.class_name in ("shipwreck", "aircraft_wreck")),
                    key=lambda d: _box_iou(d.box, s.box), default=None)
        if match is not None and _box_iou(match.box, s.box) >= iou:
            match.polygons += s.polygons
            match.agreement = True
            match.source = "detector+segmenter"
            match.confidence = max(match.confidence, s.confidence)
        else:
            out.append(s)
    return merge_overlapping(out)
