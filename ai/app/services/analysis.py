"""Analysis use case: resolve the georeference, run the pipeline, render outputs and cache them.

HTTP-agnostic; the API layer translates the exceptions into status codes.
"""

import dataclasses
import logging
from dataclasses import dataclass

import numpy as np

from app.cleaning.params import CleanParams
from app.cleaning.pipeline import clean
from app.core.config import settings
from app.geo.geotagging import GeoreferenceError, Track, from_simple, parse_metadata
from app.processing.filters import FilterParams
from app.processing.pipeline import AnalyzeOptions, analyze
from app.readers.image import encode_jpeg, to_data_url
from app.readers.xtf import XtfLog
from app.reporting.annotate import annotate
from app.schemas.forms import AnalyzeRequest
from app.seabed import build_seabed
from app.seabed.bottom import track_bottom
from app.seabed.geometry import PingGeometry, refine_track
from app.storage.cache import StoredAnalysis, analysis_cache
from app.utils import jsonable

log = logging.getLogger("sonar.analysis")



@dataclass
class SonarInput:
    gray: np.ndarray
    track: Track | None      # from the file itself (XTF ping headers)
    source: dict
    geometry: PingGeometry | None = None   # XTF per-ping geometry (also without lat/lon)
    xtf: XtfLog | None = None              # XTF native pings + motion records (noise cleaning)


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


def _bottom(gray: np.ndarray, nadir: float | None):
    """Bottom track of the waterfall (None when there is no water column, e.g. crops). Never fails the analysis."""
    try:
        return track_bottom(gray, nadir)
    except Exception:  # noqa: BLE001
        log.exception("bottom tracking failed")
        return None


def _seabed(gray: np.ndarray, track: Track | None, result: dict, **geometry) -> dict:
    """3D seabed model; also adds a shadow-based `height` to every detection. Never fails the analysis."""
    try:
        model = build_seabed(gray, track, result["detections"], settings.seabed_max_cells, settings.seabed_texture_side,
                             **geometry)
    except Exception as e:  # noqa: BLE001 - the 2D results are still valid
        log.exception("seabed model failed")
        for d in result["detections"]:
            d.setdefault("height", {"height_m": None, "method": None, "reason": "seabed model failed"})
        return {"available": False, "reason": f"seabed model failed: {e}"}
    return model


def _clean(sonar: SonarInput, form: AnalyzeRequest):
    """Noise-filtering stage 1 before detection, when the request carries cleaning settings."""
    if not form.cleaning:
        return None
    params = CleanParams.from_json(form.cleaning)       # ValueError -> 400
    w = sonar.gray.shape[1]
    across = form.across_m_per_px or (form.swath_width_m / w if form.swath_width_m else None)
    return clean(sonar.gray, params, sonar.xtf, across, keep_steps=False, measure_noise=True)


def cleaning_summary(cleaned) -> dict:
    """What the stage-1 cleaning did, kept with the analysis (and the stored scan)."""
    report = {k: v for k, v in cleaned.report.items() if k not in ("frame", "motion")}
    for side in ("before", "after"):
        if side in report:
            report[side] = {k: v for k, v in report[side].items() if k != "series"}
    return jsonable({"params": cleaned.params.to_dict(), "frame": cleaned.frame.summary(), "report": report,
                     "steps": [{"id": s.id, "name": s.name, "applied": s.applied, "ms": s.ms} for s in cleaned.steps]})


def run_analysis(sonar: SonarInput, form: AnalyzeRequest, metadata: MetadataFile | None = None) -> dict:
    roles = form.model_roles()
    if not roles:
        raise ValueError("models must include 'detector' and/or 'segmenter'")
    cleaned = _clean(sonar, form)
    gray = cleaned.image if cleaned is not None else sonar.gray
    track, georef_error = resolve_track(sonar, form, metadata)      # in the reader's pixels
    ping = sonar.geometry
    # A navigation file without altitude on an XTF log: the ping headers still have it.
    if track is not None and track.altitude is None and ping is not None and ping.altitude is not None:
        track = dataclasses.replace(track, altitude=np.interp(track.rows, ping.rows, ping.altitude), slant_range=True)
    h = gray.shape[0]

    if cleaned is not None:
        # Navigation and the log geometry follow the image into the cleaned frame (rows re-spaced, ground range,
        # resampled); the cleaning already bottom-tracked the image.
        track = cleaned.frame.transform_track(track)
        ping = cleaned.frame.transform_ping_geometry(ping)
        bottom = cleaned.bottom
        if track is not None and track.altitude is None and cleaned.altitude_px is not None:
            alt = np.interp(track.rows, np.arange(h), cleaned.altitude_px) * track.across_m_per_px
            track = dataclasses.replace(track, altitude=alt)
    else:
        # Bottom tracking: the water column in the image gives the nadir and the altitude of every ping. It verifies
        # (or replaces) logged values and makes geotagging slant-range-correct for plain images.
        known_nadir = form.nadir_column if form.nadir_column is not None else ping.nadir_col if ping is not None else None
        if known_nadir is None and track is not None and not any("nadir assumed" in a for a in track.assumptions):
            known_nadir = track.nadir_col
        bottom = _bottom(sonar.gray, known_nadir)
    track, altitude_choice = refine_track(track, bottom, h)

    filters = FilterParams(repair_dropouts=False) if cleaned is not None else form.to_params()
    options = AnalyzeOptions(models=roles, tiling=form.tiling, include_suppressed=form.include_suppressed,
                             filters=filters, score=form.to_score_params())
    if options.score.nadir_col is None:
        if cleaned is not None and cleaned.frame.nadir_col is not None:
            options.score.nadir_col = cleaned.frame.nadir_col
        elif track is None and bottom is not None:
            options.score.nadir_col = bottom.nadir_col
    source = dict(sonar.source)
    if cleaned is not None:
        source.update(original_width=int(sonar.gray.shape[1]), original_height=int(sonar.gray.shape[0]))
    result, filtered = analyze(gray, track, options, source, georef_error,   # RuntimeError if no model
                               quality=cleaned.quality if cleaned is not None else None)
    result["processing"]["bottom_track"] = bottom.summary() if bottom else None
    if cleaned is not None:
        result["processing"]["cleaning"] = cleaning_summary(cleaned)
        result["processing"]["timings"]["cleaning_ms"] = cleaned.report["timings_ms"]["total"]
    seabed = _seabed(gray, track, result, ping=ping if track is None else None, bottom=bottom,
                     swath_width_m=form.swath_width_m, altitude_choice=altitude_choice)

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
    if form.return_seabed:
        result = {**result, "seabed": seabed}
    if form.return_images:
        return {**result, "images": {
            # Downscaled (SONAR_PREVIEW_MAX_SIDE); full resolution via the image endpoints while cached.
            "annotated": to_data_url(encode_jpeg(annotated, settings.preview_quality, settings.preview_max_side)),
            "filtered": to_data_url(encode_jpeg(filtered, settings.preview_quality, settings.preview_max_side)),
        }}
    return result
