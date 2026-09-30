from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app import __version__
from app.ml.registry import registry
from app.storage.cache import analysis_cache

router = APIRouter(tags=["service"])


@router.get("/", include_in_schema=False)
def root():
    return {"service": "SonarScan AI", "version": __version__, "docs": "/docs", "health": "/health"}


@router.get("/health")
def health():
    ok = "detector" in registry.models
    return JSONResponse(status_code=200 if ok else 503, content={
        "status": "ok" if ok else "degraded",
        "version": __version__,
        "device": registry.device,
        "backend": registry.backend,
        "models_loaded": sorted(registry.models),
        "model_errors": registry.errors,
        "cached_analyses": len(analysis_cache),
    })


@router.get("/v1/models")
def models():
    """Model cards: classes, hazard flags, calibrated thresholds, test metrics, speed. Use these for the dashboard."""
    return {role: m.info() for role, m in registry.models.items()}
