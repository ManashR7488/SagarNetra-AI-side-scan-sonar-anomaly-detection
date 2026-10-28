"""Resampling to a standard pixel size.

Sonars differ in range, frequency and sample count, so the same 2 m object may be 10 or 60 pixels long. The
detector sees objects at a consistent size when every scan is resampled to one metres-per-pixel scale (needs the
across-track scale: XTF slant range, or the operator's swath width for images).
"""

import cv2
import numpy as np


def normalize(img: np.ndarray, across_m_per_px: float, along_m_per_px: float | None, target: float,
              max_side: int = 30000, max_pixels: int = 40_000_000) -> tuple[np.ndarray, float, float, dict]:
    """Returns (image, column scale, row scale, info). Scale = new pixels per old pixel."""
    h, w = img.shape
    along = along_m_per_px or across_m_per_px
    sx, sy = across_m_per_px / target, along / target
    limit = min(1.0, max_side / max(h * sy, w * sx, 1.0), float(np.sqrt(max_pixels / max(h * sy * w * sx, 1.0))))
    sx, sy = sx * limit, sy * limit
    new_w, new_h = max(8, int(round(w * sx))), max(8, int(round(h * sy)))
    sx, sy = new_w / w, new_h / h
    interp = cv2.INTER_AREA if sx * sy < 1 else cv2.INTER_CUBIC
    out = cv2.resize(img, (new_w, new_h), interpolation=interp)
    info = {"applied": True, "from_m_per_px": [round(across_m_per_px, 4), round(along, 4)],
            "to_m_per_px": round(across_m_per_px / sx, 4), "scale": [round(sx, 4), round(sy, 4)],
            "size": [new_w, new_h]}
    if limit < 1.0:
        info["note"] = f"size capped: actual scale {across_m_per_px / sx:.3f} m/px"
    return out, sx, sy, info
