from typing import Annotated

from fastapi import APIRouter, Form, HTTPException

from app.api.deps import load_metadata, load_sonar
from app.schemas.forms import AnalyzeRequest
from app.services.analysis import run_analysis

router = APIRouter(prefix="/v1", tags=["analysis"])


@router.post("/analyze")
def analyze(form: Annotated[AnalyzeRequest, Form()]):
    """Run the full pipeline on one sonar image / XTF log and return a structured anomaly report."""
    sonar = load_sonar(form.file, form.file_url, form.filename)
    metadata = load_metadata(form.metadata, form.metadata_url, form.metadata_filename)
    try:
        return run_analysis(sonar, form, metadata)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except RuntimeError as e:
        raise HTTPException(503, str(e))
