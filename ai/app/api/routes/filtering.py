from typing import Annotated, Literal

from fastapi import APIRouter, Form, Query
from fastapi.responses import Response

from app.api.deps import load_sonar
from app.core.config import settings
from app.processing.filters import DENOISE_METHODS, apply_filters
from app.readers.image import encode_jpeg, to_data_url
from app.schemas.forms import FilterRequest

router = APIRouter(prefix="/v1", tags=["noise filtration"])


@router.post("/filter")
def filter_preview(
    form: Annotated[FilterRequest, Form()],
    output: Literal["json", "jpeg"] = Query("json", description="json = metrics + data URLs, jpeg = filtered image only"),
):
    """Noise-filtration preview: despeckle, repair ping dropouts, equalise contrast, report speckle metrics."""
    sonar = load_sonar(form.file, form.file_url, form.filename)
    filtered, report = apply_filters(sonar.gray, form.to_params())
    if output == "jpeg":
        return Response(encode_jpeg(filtered, 90), media_type="image/jpeg")
    return {
        "source": {**sonar.source, "width": sonar.gray.shape[1], "height": sonar.gray.shape[0]},
        "params": report.params,
        "dropout_rows_detected": len(report.dropout_rows),
        "dropout_rows_repaired": report.repaired_rows,
        "dropout_rows": report.dropout_rows[:200],
        "quality_before": report.before,
        "quality_after": report.after,
        "images": {
            "original": to_data_url(encode_jpeg(sonar.gray, settings.preview_quality, settings.preview_max_side)),
            "filtered": to_data_url(encode_jpeg(filtered, settings.preview_quality, settings.preview_max_side)),
        },
        "available_methods": list(DENOISE_METHODS),
    }
