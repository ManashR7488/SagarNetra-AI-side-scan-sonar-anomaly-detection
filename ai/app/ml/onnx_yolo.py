"""Torch-free YOLO11 inference with onnxruntime (detect + segment exports from Ultralytics).

Mirrors Ultralytics' predictor closely enough to give the same boxes: letterbox to the export size,
BGR->RGB, /255, class-aware NMS, and mask prototypes -> polygons for the segmenter. Used for serverless
deployments (e.g. Vercel), where PyTorch is far too large.
"""

from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Prediction:
    """Detections for one image crop, in that crop's pixel coordinates."""
    xyxy: np.ndarray                    # (N, 4) float32
    conf: np.ndarray                    # (N,) float32
    cls: np.ndarray                     # (N,) int
    polygons: list[np.ndarray] | None = field(default=None)  # one (K, 2) outline per detection (segment only)


def nms(boxes: np.ndarray, scores: np.ndarray, iou: float) -> np.ndarray:
    """Greedy non-maximum suppression; returns kept indices, best first."""
    x1, y1, x2, y2 = boxes.T
    areas = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        rest = order[1:]
        w = np.clip(np.minimum(x2[i], x2[rest]) - np.maximum(x1[i], x1[rest]), 0, None)
        h = np.clip(np.minimum(y2[i], y2[rest]) - np.maximum(y1[i], y1[rest]), 0, None)
        inter = w * h
        ovr = inter / np.maximum(areas[i] + areas[rest] - inter, 1e-9)
        order = rest[ovr <= iou]
    return np.asarray(keep, dtype=int)


def batched_nms(boxes: np.ndarray, scores: np.ndarray, classes: np.ndarray, iou: float) -> np.ndarray:
    """Class-aware NMS: boxes of different classes never suppress each other."""
    if len(boxes) == 0:
        return np.zeros(0, dtype=int)
    offset = classes.astype(np.float32)[:, None] * (float(boxes.max()) + 1.0)
    return nms(boxes + offset, scores, iou)


class OnnxYolo:
    def __init__(self, path: str, task: str, imgsz: int, num_classes: int, threads: int = 0):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        if threads:
            opts.intra_op_num_threads = threads
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.task = task
        self.imgsz = imgsz
        self.nc = num_classes

    def _letterbox(self, bgr: np.ndarray):
        h, w = bgr.shape[:2]
        s = self.imgsz
        r = min(s / h, s / w)
        nw, nh = int(round(w * r)), int(round(h * r))
        img = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_LINEAR) if (nw, nh) != (w, h) else bgr
        dw, dh = (s - nw) / 2, (s - nh) / 2
        top, bottom = int(round(dh - 0.1)), int(round(dh + 0.1))
        left, right = int(round(dw - 0.1)), int(round(dw + 0.1))
        img = cv2.copyMakeBorder(img, top, bottom, left, right, cv2.BORDER_CONSTANT, value=(114, 114, 114))
        blob = np.ascontiguousarray(img[:, :, ::-1].transpose(2, 0, 1))[None].astype(np.float32) / 255.0
        return blob, r, (left, top), (nw, nh)

    def __call__(self, bgr: np.ndarray, conf: float, iou: float = 0.6, max_det: int = 300) -> Prediction:
        h, w = bgr.shape[:2]
        blob, r, (left, top), (nw, nh) = self._letterbox(bgr)
        outputs = self.session.run(None, {self.input_name: blob})
        pred = outputs[0][0].T                                   # (anchors, 4 + nc [+ 32])
        scores = pred[:, 4:4 + self.nc]
        cls = scores.argmax(1)
        confs = scores[np.arange(len(cls)), cls]
        mask = confs > conf
        if not mask.any():
            return Prediction(np.zeros((0, 4), np.float32), np.zeros(0, np.float32), np.zeros(0, int),
                              [] if self.task == "segment" else None)
        pred, cls, confs = pred[mask], cls[mask], confs[mask]
        cx, cy, bw, bh = pred[:, 0], pred[:, 1], pred[:, 2], pred[:, 3]
        boxes = np.stack([cx - bw / 2, cy - bh / 2, cx + bw / 2, cy + bh / 2], 1)   # letterboxed pixels
        keep = batched_nms(boxes, confs, cls, iou)[:max_det]
        boxes, cls, confs, pred = boxes[keep], cls[keep], confs[keep], pred[keep]

        polygons = None
        if self.task == "segment":
            polygons = self._polygons(pred[:, 4 + self.nc:], outputs[1][0], boxes, r, left, top, nw, nh)

        out = (boxes - np.array([left, top, left, top], np.float32)) / r
        out[:, [0, 2]] = out[:, [0, 2]].clip(0, w)
        out[:, [1, 3]] = out[:, [1, 3]].clip(0, h)
        return Prediction(out.astype(np.float32), confs.astype(np.float32), cls.astype(int), polygons)

    def _polygons(self, coeffs, protos, boxes, r, left, top, nw, nh) -> list[np.ndarray]:
        """Mask prototypes -> binary mask per box (cropped to the box) -> largest outline in crop pixels."""
        c, ph, pw = protos.shape
        masks = 1.0 / (1.0 + np.exp(-np.clip(coeffs @ protos.reshape(c, -1), -50, 50)))
        masks = masks.reshape(-1, ph, pw)
        sx, sy = self.imgsz / pw, self.imgsz / ph
        polygons = []
        for m, (x1, y1, x2, y2) in zip(masks, boxes):
            crop = np.zeros_like(m)
            a, b = int(max(0, np.floor(y1 / sy))), int(min(ph, np.ceil(y2 / sy)))
            c0, c1 = int(max(0, np.floor(x1 / sx))), int(min(pw, np.ceil(x2 / sx)))
            crop[a:b, c0:c1] = m[a:b, c0:c1]
            up = cv2.resize(crop, (self.imgsz, self.imgsz), interpolation=cv2.INTER_LINEAR)
            binary = (up[top:top + nh, left:left + nw] > 0.5).astype(np.uint8)
            contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if not contours:
                polygons.append(np.zeros((0, 2), np.float32))
                continue
            outline = max(contours, key=cv2.contourArea).reshape(-1, 2).astype(np.float32)
            polygons.append(outline / r)
        return polygons
