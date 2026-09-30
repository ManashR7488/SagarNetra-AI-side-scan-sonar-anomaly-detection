"""Analysis use case: resolve the georeference, run the pipeline, render outputs and cache them.

HTTP-agnostic; the API layer translates the exceptions into status codes.
"""

import logging
from dataclasses import dataclass

import numpy as np

from app.core.config import settings
from app.geo.geotagging import GeoreferenceError, Track, from_simple, parse_metadata
from app.processing.pipeline import AnalyzeOptions, analyze
from app.readers.image import encode_jpeg, to_data_url
from app.reporting.annotate import annotate
from app.schemas.forms import AnalyzeRequest
from app.storage.cache import StoredAnalysis, analysis_cache

log = logging.getLogger("sonar.analysis")



@dataclass
class SonarInput:
    gray: np.ndarray
    track: Track | None      # from the file itself (XTF ping headers)
    source: dict


@dataclass
class MetadataFile:
    data: bytes
    filename: str


def resolve_track(sonar: SonarInput, form: AnalyzeRequest, metadata: MetadataFile | None) -> tuple[Track | None, str | None]:
    """Priority: uploaded navigation file > simple lat/lon form fields > XTF ping headers."""
    h, w = sonar.gray.shape
    try:
        if metadata is not None:
            sonar.source["metadata_file"] = metadata.filename
            return parse_metadata(metadata.data, metadata.filename, h, w, swath_width_m=form.swath_width_m,
                                  across_m_per_px=form.across_m_per_px, nadir_col=form.nadir_column), None
        if form.latitude is not None and form.longitude is not None:
            return from_simple(h, w, form.latitude, form.longitude, form.heading_deg, form.swath_width_m,
                               form.across_m_per_px, form.along_m_per_px, form.nadir_column, form.anchor), None
    except GeoreferenceError as e:
        return sonar.track, str(e)
    return sonar.track, None


def run_analysis(sonar: SonarInput, form: AnalyzeRequest, metadata: MetadataFile | None = None) -> dict:
    roles = form.model_roles()
    if not roles:
        raise ValueError("models must include 'detector' and/or 'segmenter'")
    track, georef_error = resolve_track(sonar, form, metadata)
    options = AnalyzeOptions(models=roles, tiling=form.tiling, include_suppressed=form.include_suppressed,
                             filters=form.to_params(), score=form.to_score_params())
    result, filtered = analyze(sonar.gray, track, options, sonar.source, georef_error)  # RuntimeError if no model

    annotated = annotate(filtered, result["detections"])
    aid = result["analysis_id"]
    result["links"] = {
        "self": f"/v1/analyses/{aid}",
        "annotated_image": f"/v1/analyses/{aid}/annotated.jpg",
        "filtered_image": f"/v1/analyses/{aid}/filtered.jpg",
        "report_json": f"/v1/analyses/{aid}/report.json",
        "report_csv": f"/v1/analyses/{aid}/report.csv",
    }
    analysis_cache.put(aid, StoredAnalysis(result=result, annotated_jpeg=encode_jpeg(annotated),
                                           filtered_jpeg=encode_jpeg(filtered)))
    h, w = sonar.gray.shape
    log.info("analysis %s: %s %dx%d -> %d confirmed / %d suppressed in %.0f ms", aid, sonar.source["filename"], w, h,
             result["summary"]["confirmed"], result["summary"]["suppressed"],
             result["processing"]["timings"]["total_ms"])
    if form.return_images:
        return {**result, "images": {
            # Downscaled (SONAR_PREVIEW_MAX_SIDE); full resolution via the image endpoints while cached.
            "annotated": to_data_url(encode_jpeg(annotated, settings.preview_quality, settings.preview_max_side)),
            "filtered": to_data_url(encode_jpeg(filtered, settings.preview_quality, settings.preview_max_side)),
        }}
    return result
