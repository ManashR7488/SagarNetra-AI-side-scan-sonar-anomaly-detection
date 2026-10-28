"""Speckle reduction and display enhancement.

Speckle is the granular interference pattern of coherent acoustic returns (multiplicative noise). The adaptive
filters (Lee, Kuan, Frost) smooth homogeneous seabed and leave edges alone; non-local means averages similar
patches from the neighbourhood (strongest, slowest; analyst view). Display enhancements (shadow gamma, CLAHE)
change contrast for human reading only.
"""

import cv2
import numpy as np

from app.processing.filters import despeckle as adaptive_despeckle


def despeckle(img: np.ndarray, method: str, strength: int) -> np.ndarray:
    if method == "none" or strength <= 0:
        return img
    if method == "nlm":
        h = 3.0 + 12.0 * float(np.clip(strength, 0, 100)) / 100.0
        return cv2.fastNlMeansDenoising(img, None, h=h, templateWindowSize=7, searchWindowSize=21)
    return adaptive_despeckle(img, method, strength)


def enhance(img: np.ndarray, shadow_gamma: float = 1.0, clahe: bool = False, clahe_strength: int = 40) -> np.ndarray:
    out = img
    if abs(shadow_gamma - 1.0) > 1e-3:
        lut = (np.linspace(0, 1, 256) ** shadow_gamma * 255).astype(np.uint8)
        out = cv2.LUT(out, lut)
    if clahe:
        clip = 1.0 + float(np.clip(clahe_strength, 0, 100)) / 100 * 3.0
        out = cv2.createCLAHE(clipLimit=clip, tileGridSize=(8, 8)).apply(out)
    return out
