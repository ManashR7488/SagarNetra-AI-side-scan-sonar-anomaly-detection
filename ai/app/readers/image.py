"""Image decoding / encoding helpers. All processing happens on single-channel uint8 images."""

import base64

import cv2
import numpy as np

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp"}


class ImageDecodeError(ValueError):
    pass


def to_uint8(img: np.ndarray) -> np.ndarray:
    """Stretch 16-bit / float sonar intensities to uint8 using robust percentiles."""
    if img.dtype == np.uint8:
        return img
    f = img.astype(np.float32)
    lo, hi = np.percentile(f, [0.5, 99.5])
    if hi <= lo:
        hi = lo + 1.0
    return np.clip((f - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)


def decode_gray(data: bytes) -> np.ndarray:
    """Decode an uploaded image to grayscale uint8.

    Sonar intensity is single-channel; colour palettes (gold, brown, ...) are display artefacts,
    and the models were trained on grayscale, so every input is converted.
    """
    buf = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageDecodeError("Unsupported or corrupted image file")
    if img.ndim == 3:
        if img.shape[2] == 4:
            img = img[:, :, :3]
        img = to_uint8(img)
        img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return to_uint8(img)


def gray_to_bgr(gray: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)


def encode_jpeg(img: np.ndarray, quality: int = 88, max_side: int | None = None) -> bytes:
    if max_side and max(img.shape[:2]) > max_side:
        scale = max_side / max(img.shape[:2])
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ok, out = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encoding failed")
    return out.tobytes()


def to_data_url(jpeg: bytes) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(jpeg).decode("ascii")
