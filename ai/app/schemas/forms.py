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
    min_score: float = Field(50.0, ge=0, le=100, description="Detections below this 0-100 score are suppressed")
    include_suppressed: bool = Field(True, description="Also return suppressed candidates (with reasons)")
    return_images: bool = Field(True, description="Embed annotated/filtered previews as data URLs")

    def model_roles(self) -> tuple[str, ...]:
        return tuple(m.strip() for m in self.models.split(",") if m.strip() in MODEL_ROLES)

    def to_score_params(self) -> ScoreParams:
        return ScoreParams(fp_filter=self.fp_filter, min_score=self.min_score, nadir_col=self.nadir_column)
