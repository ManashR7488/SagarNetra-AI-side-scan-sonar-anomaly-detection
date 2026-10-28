"""Stage 1 of the noise-filtering module: clean the side-scan signal before detection.

Steps, in order (each one measured and reported):
  dropouts    blank / partial / duplicated pings and (XTF) time gaps and motion-limit violations; repair
  motion      XTF only: along-track resampling by distance travelled, yaw (crab) and pitch footprint offsets
  gain        range (across-track) and ping (along-track) gain normalisation, interference-line removal
  seabed      water-column masking, sea-surface echo suppression, optional slant-to-ground-range correction
  speckle     despeckling (Lee / Kuan / Frost / median / non-local means)
  resolution  resampling to a standard metres-per-pixel scale

`clean()` returns the cleaned image, every intermediate step, the noise report and how the image geometry changed
(so navigation, detections and the 3D seabed stay in the right place).
"""

from app.cleaning.params import CleanParams, profile_params
from app.cleaning.pipeline import CleanResult, clean

__all__ = ["CleanParams", "CleanResult", "clean", "profile_params"]
