"""SonarScan AI inference microservice.

Run from the `ai/` folder:
    .venv\\Scripts\\python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Interactive API docs: http://localhost:8000/docs
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import __version__
from app.api.router import api_router
from app.core.config import settings
from app.core.logging import setup_logging
from app.ml.registry import registry


@asynccontextmanager
async def lifespan(app: FastAPI):
    registry.load()
    yield


def create_app() -> FastAPI:
    setup_logging()
    app = FastAPI(
        title="SonarScan AI Service",
        version=__version__,
        description="Side-scan sonar anomaly detection, noise filtration, confidence scoring and geotagging "
                    "(PS 26057, MoES / NIOT).",
        lifespan=lifespan,
    )
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
    app.include_router(api_router)
    return app


app = create_app()
