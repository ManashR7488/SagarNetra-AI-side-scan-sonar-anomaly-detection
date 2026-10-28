"""False-alarm classifier: man-made object or natural seabed, with the reasons.

Two small logistic models over the explainable features (app/processing/features.py), trained by
tools/train_fp_classifier.py on candidates from the synthetic XTF campaign (ground truth incl. the kind of seabed
under every false alarm) and real AI4Shipwrecks strips:
  binary    P(man-made), blended with the rule score (`blend.classifier_weight`, 0.5: on its own the classifier
            ranked real candidates slightly worse than the rules; the blend beats the rules on both datasets).
            The blend becomes the candidate's 0-100 % confidence
  subtype   for natural candidates: rock cluster / sand ripples / natural shadow / seabed texture
Each feature's contribution (weight x standardised value) is the explanation: the largest contributions towards
"natural" are the reasons a candidate was rejected, those towards "man-made" why it was kept. Pure numpy: runs
anywhere the service runs (edge devices included).
"""

import json
import logging
import threading
from pathlib import Path

import numpy as np

from app.core.config import settings
from app.processing.features import FEATURES, PHRASES

log = logging.getLogger("sonar.fp_classifier")

SUBTYPE_REASON = {"rock": "rock_cluster", "sand_ripple": "sand_ripple", "natural_shadow": "natural_shadow",
                  "seabed_texture": "seabed_texture"}
SUBTYPE_LABEL = {"rock": "Rock / rock cluster", "sand_ripple": "Sand ripples / sand waves",
                 "natural_shadow": "Natural acoustic shadow", "seabed_texture": "Seabed texture / speckle"}


def _softmax(z: np.ndarray) -> np.ndarray:
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


class FPClassifier:
    def __init__(self, data: dict):
        names = data["features"]
        idx = {f: i for i, f in enumerate(FEATURES)}
        self.take = np.array([idx.get(f, -1) for f in names])
        self.names = names
        self.mean = np.asarray(data["mean"], np.float64)
        self.std = np.maximum(np.asarray(data["std"], np.float64), 1e-6)
        self.coef = np.asarray(data["binary"]["coef"], np.float64)
        self.intercept = float(data["binary"]["intercept"])
        sub = data.get("subtype") or {}
        self.sub_classes = sub.get("classes", [])
        self.sub_coef = np.asarray(sub.get("coef", []), np.float64)
        self.sub_intercept = np.asarray(sub.get("intercept", []), np.float64)
        self.metrics = data.get("metrics", {})
        self.version = data.get("version", "1")
        self.weight = float(np.clip((data.get("blend") or {}).get("classifier_weight", 1.0), 0.0, 1.0))
        self.trained = data.get("trained")
        self.training = data.get("training", {})
        self.threshold = float(np.clip(data.get("decision_threshold", 0.5), 0.05, 0.95))

    def summary(self) -> dict:
        """What the report says about the classifier: its version and how it was validated."""
        keys = ("auc", "average_precision", "precision", "recall", "f1", "false_alarms_rejected_at_95pct_recall")
        pick = lambda m: {k: m.get(k) for k in keys} if m else None  # noqa: E731
        return {"version": self.version, "trained": self.trained, "decision_threshold": round(self.threshold, 3),
                "classifier_weight": self.weight,
                "validation": self.metrics.get("validation"),
                "cross_validated": pick(self.metrics.get("classifier")),
                "rules_baseline": pick(self.metrics.get("rules_baseline")),
                "by_dataset": {name: {"classifier": pick(v.get("classifier")), "rules_baseline": pick(v.get("rules_baseline"))}
                               for name, v in (self.metrics.get("by_dataset") or {}).items() if "/" not in name},
                "training": {k: self.training.get(k) for k in ("candidates", "man_made", "natural", "datasets")}}

    def score(self, p: float) -> float:
        """P(man-made) -> 0-100 score with the F1-optimal decision threshold at 50 (as for the detector)."""
        t = self.threshold
        return 50.0 * p / t if p < t else 50.0 + 50.0 * (p - t) / (1.0 - t)

    def _x(self, vec: np.ndarray) -> np.ndarray:
        raw = np.array([vec[i] if i >= 0 else m for i, m in zip(self.take, self.mean)], np.float64)
        return (raw - self.mean) / self.std

    def predict(self, vec: np.ndarray, rule_score: float | None = None) -> dict:
        """`rule_score`: the hand-set rule score (0-100) of the same candidate, blended in when the model says so."""
        z = self._x(vec)
        contrib = self.coef * z
        logit = float(contrib.sum() + self.intercept)
        p_clf = float(1.0 / (1.0 + np.exp(-np.clip(logit, -30, 30))))
        p = p_clf
        if rule_score is not None and self.weight < 1.0:
            p = self.weight * p_clf + (1.0 - self.weight) * float(np.clip(rule_score, 0.0, 100.0)) / 100.0
        out = {"p_man_made": p, "p_classifier": p_clf, "contributions": contrib}
        if len(self.sub_classes):
            probs = _softmax(self.sub_coef @ z + self.sub_intercept)
            k = int(np.argmax(probs))
            out["subtype"] = self.sub_classes[k]
            out["subtype_probs"] = {c: round(float(v), 3) for c, v in zip(self.sub_classes, probs)}
        return out

    def reasons(self, contrib: np.ndarray, towards_natural: bool, n: int = 3) -> list[str]:
        order = np.argsort(contrib) if towards_natural else np.argsort(-contrib)
        out = []
        for i in order:
            c = contrib[i]
            if (towards_natural and c >= -0.05) or (not towards_natural and c <= 0.05):
                break
            phrase = PHRASES.get(self.names[i], ("", ""))[0 if towards_natural else 1]
            if phrase and phrase not in out:
                out.append(phrase)
            if len(out) >= n:
                break
        return out


_lock = threading.Lock()
_cache: dict = {}


def model_path() -> Path:
    return settings.models_dir / "fp_classifier" / "model.json"


def get_classifier() -> FPClassifier | None:
    """The trained classifier, or None (rule-based scoring is used then). Loaded once per process."""
    path = model_path()
    with _lock:
        key = (str(path), path.stat().st_mtime if path.exists() else None)
        if _cache.get("key") != key:
            clf = None
            if path.exists():
                try:
                    clf = FPClassifier(json.loads(path.read_text(encoding="utf-8")))
                except Exception:  # noqa: BLE001 - a broken file must not take the service down
                    log.exception("could not load %s", path)
            _cache.update(key=key, clf=clf)
        return _cache["clf"]


def rule_subtype(v: dict) -> str:
    """Natural subtype without a trained model, from the same evidence (used for rejected candidates)."""
    if v["periodicity"] > 4.2 or v["orientation_coherence"] > 0.55:
        return "sand_ripple"
    if v["blob_density"] > 1.6 or v["shadow_pieces"] > 1.6:
        return "rock"
    if v["dark_box"] > 0.5:
        return "natural_shadow"
    return "seabed_texture"
