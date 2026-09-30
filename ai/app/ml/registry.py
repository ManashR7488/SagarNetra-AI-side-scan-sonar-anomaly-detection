"""Model loading: each trained model is a folder with best.pt / best.onnx and a model_card.json."""

import json
import logging
import threading
import time
from pathlib import Path

import numpy as np

from app.core.config import settings
from app.ml.onnx_yolo import OnnxYolo, Prediction
from app.readers.image import gray_to_bgr

log = logging.getLogger("sonar.models")


class SonarModel:
    """One trained model plus its model card (classes, calibrated thresholds, tiling, metrics)."""

    def __init__(self, model_dir: Path, backend: str, device: str):
        self.dir = model_dir
        self.card = json.loads((model_dir / "model_card.json").read_text(encoding="utf-8"))
        self.name = self.card["name"]
        self.task = self.card["task"]
        self.classes: list[str] = self.card["classes"]
        self.imgsz = int(self.card["input"]["imgsz"])
        self.tile = int(self.card["tiling"]["tile"])
        self.overlap = float(self.card["tiling"]["overlap"])
        self.nms_iou = float(self.card["tiling"].get("nms_iou", 0.5))
        self.default_conf = float(self.card.get("default_conf", 0.25))
        weights = model_dir / ("best.onnx" if backend == "onnx" else "best.pt")
        if not weights.exists():
            raise FileNotFoundError(f"{weights} not found")
        self.weights = weights
        self.backend = backend
        self.device = "cpu" if backend == "onnx" else device
        # The ONNX exports have a fixed batch size of 1; PyTorch weights can take several tiles at once.
        self.batch = 1 if backend == "onnx" else max(1, settings.predict_batch)
        if backend == "onnx":
            # Pure onnxruntime: no PyTorch / Ultralytics needed (serverless deployments).
            self.model = OnnxYolo(str(weights), self.task, self.imgsz, len(self.classes), settings.onnx_threads)
        else:
            from ultralytics import YOLO

            self.model = YOLO(str(weights), task=self.task)
        self.lock = threading.Lock()  # Ultralytics predictors are not thread-safe

    def threshold(self, class_name: str) -> float:
        t = self.card.get("thresholds", {}).get(class_name) or {}
        return float(t.get("conf") or self.default_conf)

    def warmup(self):
        self.predict([np.zeros((self.imgsz, self.imgsz), np.uint8)], conf=0.5)

    def predict(self, crops: list[np.ndarray], conf: float) -> list[Prediction]:
        with self.lock:
            if self.backend == "onnx":
                return [self.model(gray_to_bgr(c), conf=conf, iou=0.6) for c in crops]
            results = self.model.predict([gray_to_bgr(c) for c in crops], imgsz=self.imgsz, conf=conf, iou=0.6,
                                         device=self.device, verbose=False, retina_masks=False)
        return [_from_ultralytics(r) for r in results]

    def info(self) -> dict:
        card = {k: v for k, v in self.card.items() if k != "datasets"}
        card["weights"] = self.weights.name
        card["device"] = self.device
        return card


def _from_ultralytics(r) -> Prediction:
    if r.boxes is None or len(r.boxes) == 0:
        return Prediction(np.zeros((0, 4), np.float32), np.zeros(0, np.float32), np.zeros(0, int))
    return Prediction(r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy(), r.boxes.cls.cpu().numpy().astype(int),
                      list(r.masks.xy) if r.masks is not None else None)


def resolve_backend() -> str:
    """"auto" uses PyTorch when Ultralytics is installed (local GPU/CPU dev), otherwise onnxruntime."""
    if settings.backend != "auto":
        return settings.backend
    try:
        import ultralytics  # noqa: F401
    except ImportError:
        return "onnx"
    return "pt"


class ModelRegistry:
    def __init__(self):
        self.models: dict[str, SonarModel] = {}
        self.errors: dict[str, str] = {}
        self.device = "cpu"
        self.backend = "onnx"

    def load(self):
        self.backend = backend = resolve_backend()
        dev = settings.device if backend == "pt" else "cpu"
        if dev == "auto":
            import torch

            dev = "0" if torch.cuda.is_available() else "cpu"
        self.device = dev
        for role, name in (("detector", settings.detector_name), ("segmenter", settings.segmenter_name)):
            t = time.time()
            try:
                m = SonarModel(settings.models_dir / name, backend, dev)
                m.warmup()
                self.models[role] = m
                log.info("Loaded %s (%s, %s) in %.1fs", name, m.weights.name, m.device, time.time() - t)
            except Exception as e:  # keep serving with whatever loaded
                self.errors[role] = f"{type(e).__name__}: {e}"
                log.exception("Failed to load %s", name)

    def get(self, role: str) -> SonarModel | None:
        return self.models.get(role)


registry = ModelRegistry()
