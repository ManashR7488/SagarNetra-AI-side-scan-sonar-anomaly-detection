"""Service settings, overridable with environment variables (or an `ai/.env` file)."""

import os
from dataclasses import dataclass, field
from pathlib import Path

AI_DIR = Path(__file__).resolve().parents[2]  # ai/

try:  # optional .env support
    from dotenv import load_dotenv

    load_dotenv(AI_DIR / ".env")
except ImportError:
    pass


def _list(value: str) -> list[str]:
    return [v.strip() for v in value.split(",") if v.strip()]


@dataclass(frozen=True)
class Settings:
    models_dir: Path = Path(os.getenv("SONAR_MODELS_DIR", AI_DIR / "models"))
    detector_name: str = os.getenv("SONAR_DETECTOR", "sonar_detector")
    segmenter_name: str = os.getenv("SONAR_SEGMENTER", "shipwreck_segmenter")
    # "auto" = PyTorch if Ultralytics is installed, else onnxruntime; or force "pt" / "onnx"
    backend: str = os.getenv("SONAR_BACKEND", "auto")
    onnx_threads: int = int(os.getenv("SONAR_ONNX_THREADS", "0"))  # 0 = onnxruntime default
    device: str = os.getenv("SONAR_DEVICE", "auto")        # "auto", "cpu", "0" (first CUDA GPU)
    max_upload_mb: int = int(os.getenv("SONAR_MAX_UPLOAD_MB", "300"))
    cache_size: int = int(os.getenv("SONAR_CACHE_SIZE", "50"))  # analyses kept in memory
    predict_batch: int = int(os.getenv("SONAR_PREDICT_BATCH", "4"))
    # Inputs can also be fetched by URL (large files uploaded straight to Cloudinary by the browser).
    # Only https URLs on these hosts are fetched, so the service cannot be used to reach arbitrary URLs.
    fetch_hosts: list[str] = field(default_factory=lambda: _list(os.getenv("SONAR_FETCH_HOSTS", "res.cloudinary.com")))
    fetch_timeout_s: float = float(os.getenv("SONAR_FETCH_TIMEOUT_S", "60"))
    # Longest side of the annotated / filtered JPEGs embedded in responses. Keep responses under the
    # 4.5 MB serverless limit on Vercel (e.g. 2560); locally the full-resolution endpoints exist too.
    preview_max_side: int = int(os.getenv("SONAR_PREVIEW_MAX_SIDE", "4096"))
    preview_quality: int = int(os.getenv("SONAR_PREVIEW_QUALITY", "85"))
    # Optional shared secret: when set, /v1/* requires the header X-API-Key (sent by the Express backend).
    api_key: str = os.getenv("SONAR_API_KEY", "")
    cors_origins: list[str] = field(
        default_factory=lambda: _list(os.getenv("SONAR_CORS_ORIGINS", "http://localhost:3000,http://localhost:5000"))
    )


settings = Settings()
