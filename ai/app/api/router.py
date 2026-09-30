import hmac

from fastapi import APIRouter, Depends, Header, HTTPException

from app.api.routes import analysis, filtering, reports, system
from app.core.config import settings


def require_api_key(x_api_key: str | None = Header(None)):
    """Inference is expensive: when SONAR_API_KEY is set, only callers with the key (the backend) may use it."""
    if settings.api_key and not hmac.compare_digest(x_api_key or "", settings.api_key):
        raise HTTPException(401, "Missing or invalid X-API-Key")


api_router = APIRouter()
api_router.include_router(system.router)  # /, /health and /v1/models stay open
for module in (analysis, filtering, reports):
    api_router.include_router(module.router, dependencies=[Depends(require_api_key)])
