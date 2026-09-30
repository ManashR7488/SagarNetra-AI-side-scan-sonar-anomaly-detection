import json

from fastapi import APIRouter
from fastapi.responses import PlainTextResponse, Response

from app.api.deps import get_stored
from app.reporting.csv_report import to_csv

router = APIRouter(prefix="/v1/analyses", tags=["reports"])


def _attachment(analysis_id: str, ext: str) -> dict:
    return {"Content-Disposition": f'attachment; filename="sonar_report_{analysis_id}.{ext}"'}


@router.get("/{analysis_id}")
def get_analysis(analysis_id: str):
    return get_stored(analysis_id).result


@router.get("/{analysis_id}/report.json")
def report_json(analysis_id: str):
    body = json.dumps(get_stored(analysis_id).result, indent=2)
    return Response(body, media_type="application/json", headers=_attachment(analysis_id, "json"))


@router.get("/{analysis_id}/report.csv")
def report_csv(analysis_id: str):
    return PlainTextResponse(to_csv(get_stored(analysis_id).result), media_type="text/csv",
                             headers=_attachment(analysis_id, "csv"))


@router.get("/{analysis_id}/annotated.jpg")
def annotated_image(analysis_id: str):
    return Response(get_stored(analysis_id).annotated_jpeg, media_type="image/jpeg")


@router.get("/{analysis_id}/filtered.jpg")
def filtered_image(analysis_id: str):
    return Response(get_stored(analysis_id).filtered_jpeg, media_type="image/jpeg")
