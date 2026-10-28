"""Multipart request bodies (uploads + form fields) for the analysis and filtering endpoints."""

from typing import Literal

from fastapi import UploadFile
from pydantic import BaseModel, Field

from app.processing.filters import FilterParams
from app.processing.scoring import ScoreParams

Denoise = Literal["none", "lee", "frost", "kuan", "median"]
MODEL_ROLES = ("detector", "segmenter")


class FilterRequest(BaseModel):
    file: UploadFile | None = Field(None, description="Sonar image (png/jpg/tif/bmp/webp) or raw XTF log")
    file_url: str | None = Field(None, description="Instead of `file`: https URL of the sonar file "
                                                   "(allowed hosts only, e.g. a Cloudinary upload)")
    filename: str | None = Field(None, description="Original file name when using file_url (sets the format)")
    denoise: Denoise = Field("lee", description="Speckle filter")
    denoise_strength: int = Field(50, ge=0, le=100, description="0-100, maps to a 3-9 px filter window")
    clahe: bool = Field(True, description="Contrast-limited adaptive histogram equalisation")
    clahe_strength: int = Field(40, ge=0, le=100)
    repair_dropouts: bool = Field(True, description="Interpolate pings lost to vehicle motion / interference")
    shadow_gamma: float = Field(1.0, gt=0, le=4, description=">1 darkens acoustic shadows")

    def to_params(self) -> FilterParams:
        return FilterParams(self.denoise, self.denoise_strength, self.clahe, self.clahe_strength,
                            self.repair_dropouts, self.shadow_gamma)


class CleanRequest(BaseModel):
    """Stage 1 of the noise-filtering module: clean the signal and report the noise (nothing is stored)."""
    file: UploadFile | None = Field(None, description="Sonar image or raw XTF log")
    file_url: str | None = Field(None, description="Instead of `file`: https URL of the sonar file (allowed hosts only)")
    filename: str | None = Field(None, description="Original file name when using file_url")
    profile: Literal["ai", "analyst"] = Field("analyst", description="ai = the image the detector sees; "
                                                                     "analyst = the image a person reads")
    auto: bool = Field(True, description="Measure the noise and choose the steps automatically")
    params: str | None = Field(None, description="JSON cleaning settings. With auto=true the given keys override "
                                                 "Auto's choices; with auto=false they are used as they are")
    swath_width_m: float | None = Field(None, gt=0, description="Images: total swath width (sets the pixel size)")
    across_m_per_px: float | None = Field(None, gt=0, description="Images: across-track pixel size")
    preview_side: int | None = Field(None, ge=256, le=4096, description="Longest side of the step previews")


class StressRequest(BaseModel):
    """Stage 3: disturb a region of the scan at increasing levels and compare detection with / without cleaning."""
    file: UploadFile | None = Field(None, description="Sonar image or raw XTF log")
    file_url: str | None = Field(None, description="Instead of `file`: https URL of the sonar file (allowed hosts only)")
    filename: str | None = Field(None, description="Original file name when using file_url")
    disturbance: Literal["speckle", "dropouts", "resolution", "gain"]
    levels: int | None = Field(None, ge=1, le=5, description="Number of increasing levels (default from settings)")
    roi: str | None = Field(None, description="Region 'x,y,width,height' in image pixels (default: around the "
                                              "strongest detection)")
    max_side: int | None = Field(None, ge=256, le=4096, description="Longest side of the tested region")
    models: str = Field("detector,segmenter", description="Comma-separated: detector, segmenter")

    def model_roles(self) -> tuple[str, ...]:
        return tuple(m.strip() for m in self.models.split(",") if m.strip() in MODEL_ROLES)

    def roi_box(self) -> tuple[int, int, int, int] | None:
        if not self.roi:
            return None
        try:
            x, y, w, h = (int(float(v)) for v in self.roi.split(","))
        except ValueError as e:
            raise ValueError("roi must be 'x,y,width,height'") from e
        if w < 64 or h < 64:
            raise ValueError("roi must be at least 64 x 64 pixels")
        return x, y, w, h


class AnalyzeRequest(FilterRequest):
    metadata: UploadFile | None = Field(None, description="Optional navigation CSV/JSON (one fix per ping) "
                                                           "or georeference JSON")
    metadata_url: str | None = Field(None, description="Instead of `metadata`: https URL of the navigation file")
    metadata_filename: str | None = Field(None, description="Original metadata file name when using metadata_url")

    # Filtering defaults differ from the preview endpoint: the models were trained on unfiltered (speckled) data.
    denoise: Denoise = Field("none", description="Speckle filter applied before inference")
    clahe: bool = Field(False)

    # Simple georeference (ignored when a metadata file is uploaded)
    latitude: float | None = Field(None, ge=-90, le=90, description="Survey position (image centre by default)")
    longitude: float | None = Field(None, ge=-180, le=180)
    heading_deg: float = Field(0.0, description="Vehicle heading, degrees true")
    swath_width_m: float | None = Field(None, gt=0, description="Total swath width (port + starboard) in metres")
    across_m_per_px: float | None = Field(None, gt=0, description="Across-track resolution (overrides swath width)")
    along_m_per_px: float | None = Field(None, gt=0, description="Along-track resolution (default: square pixels)")
    nadir_column: float | None = Field(None, ge=0, description="Nadir pixel column (default: image centre)")
    anchor: Literal["center", "start"] = Field("center", description="lat/lon is the image centre or the first ping")

    # Models & scoring
    models: str = Field("detector,segmenter", description="Comma-separated: detector, segmenter")
    tiling: Literal["auto", "on", "off"] = "auto"
    fp_filter: bool = Field(True, description="Acoustic-evidence false-positive filter")
    fp_method: Literal["auto", "rules", "classifier"] = Field("auto", description="auto = trained false-alarm "
                                                                                  "classifier when installed, else rules")
    min_score: float = Field(50.0, ge=0, le=100, description="Detections below this 0-100 score are suppressed")
    cleaning: str | None = Field(None, description="JSON stage-1 cleaning settings (see /v1/clean). When given, the "
                                                   "image is cleaned before detection and denoise / clahe / "
                                                   "repair_dropouts / shadow_gamma are ignored")
    include_suppressed: bool = Field(True, description="Also return suppressed candidates (with reasons)")
    return_images: bool = Field(True, description="Embed annotated/filtered previews as data URLs")
    return_seabed: bool = Field(True, description="Embed the 3D seabed model (heightfield, ground-range texture, "
                                                  "target heights)")

    def model_roles(self) -> tuple[str, ...]:
        return tuple(m.strip() for m in self.models.split(",") if m.strip() in MODEL_ROLES)

    def to_score_params(self) -> ScoreParams:
        return ScoreParams(fp_filter=self.fp_filter, min_score=self.min_score, nadir_col=self.nadir_column,
                           fp_method=self.fp_method)
