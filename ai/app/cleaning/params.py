"""Stage-1 cleaning settings and the two output profiles.

  ai       the image the detector sees. Defaults come from the benchmark (profile.json, written by
           tools/benchmark_cleaning.py): only steps that measurably help detection are switched on.
  analyst  the image a person reads: stronger smoothing, flattened gain, ground-range geometry, shadow emphasis.
"""

import dataclasses
import json
from dataclasses import dataclass
from pathlib import Path

DESPECKLE_METHODS = ("none", "lee", "kuan", "frost", "median", "nlm")
PROFILES = ("ai", "analyst")
PROFILE_FILE = Path(__file__).with_name("profile.json")


@dataclass
class CleanParams:
    # 1. pings
    repair_dropouts: bool = True        # interpolate blank / partial / duplicated pings
    max_repair_pings: int = 40          # longer runs are left as gaps (reported)
    # 2. motion (XTF with navigation)
    motion: bool = True                 # resample along-track by distance travelled; yaw / pitch footprint offsets
    # 3. gain
    gain_across: bool = False           # range normalisation: residual TVG, beam pattern, absorption
    gain_along: bool = False            # ping normalisation: operator gain steps, ping-to-ping jitter, roll
    gain_strength: int = 70             # 0-100: share of the measured gain error that is removed
    destripe: bool = False              # remove interference / crosstalk line bursts
    # 4. seabed geometry
    mask_water_column: bool = False     # blank the water column (fish, surface echo, noise above the seabed)
    suppress_surface: bool = False      # remove the sea-surface echo line (needs the sonar depth, XTF)
    slant_correct: bool = False         # slant range -> ground range (flat seabed)
    # 5. speckle
    despeckle: str = "none"
    despeckle_strength: int = 50        # 0-100 -> 3..9 px window (nlm: filter strength)
    # 6. resolution
    normalize_resolution: bool = False
    target_m_per_px: float = 0.1
    # display enhancements (analyst view; never used for detection unless set explicitly)
    shadow_gamma: float = 1.0
    clahe: bool = False
    clahe_strength: int = 40

    def validate(self) -> "CleanParams":
        if self.despeckle not in DESPECKLE_METHODS:
            raise ValueError(f"despeckle must be one of {DESPECKLE_METHODS}")
        if not 0.01 <= self.target_m_per_px <= 5:
            raise ValueError("target_m_per_px must be between 0.01 and 5")
        if not 0.2 <= self.shadow_gamma <= 4:
            raise ValueError("shadow_gamma must be between 0.2 and 4")
        self.gain_strength = int(min(100, max(0, self.gain_strength)))
        self.despeckle_strength = int(min(100, max(0, self.despeckle_strength)))
        self.clahe_strength = int(min(100, max(0, self.clahe_strength)))
        self.max_repair_pings = int(min(500, max(1, self.max_repair_pings)))
        return self

    @classmethod
    def from_dict(cls, data: dict | None) -> "CleanParams":
        """Unknown keys are rejected (a typo should not silently fall back to a default)."""
        data = dict(data or {})
        names = {f.name for f in dataclasses.fields(cls)}
        unknown = sorted(set(data) - names)
        if unknown:
            raise ValueError(f"unknown cleaning setting(s): {', '.join(unknown)}")
        types = {f.name: f.type for f in dataclasses.fields(cls)}
        out = {}
        for k, v in data.items():
            t = types[k]
            if t in (bool, "bool"):
                out[k] = v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "on")
            elif t in (int, "int"):
                out[k] = int(v)
            elif t in (float, "float"):
                out[k] = float(v)
            else:
                out[k] = str(v)
        return cls(**out).validate()

    @classmethod
    def from_json(cls, text: str | None) -> "CleanParams":
        if not text:
            return cls()
        try:
            data = json.loads(text)
        except json.JSONDecodeError as e:
            raise ValueError(f"cleaning settings are not valid JSON: {e}") from e
        if not isinstance(data, dict):
            raise ValueError("cleaning settings must be a JSON object")
        return cls.from_dict(data)

    def to_dict(self) -> dict:
        return dataclasses.asdict(self)

    def geometry_changing(self) -> bool:
        return self.motion or self.slant_correct or self.normalize_resolution


ANALYST = CleanParams(repair_dropouts=True, motion=True, gain_across=True, gain_along=True, gain_strength=85,
                      destripe=True, mask_water_column=True, suppress_surface=True, slant_correct=True,
                      despeckle="lee", despeckle_strength=55, shadow_gamma=1.25, clahe=True, clahe_strength=30)


def load_profile_file() -> dict:
    """Benchmark output: {"ai": {settings}, "evidence": {...}}; empty when the benchmark has not been run."""
    try:
        return json.loads(PROFILE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def profile_params(profile: str) -> CleanParams:
    if profile not in PROFILES:
        raise ValueError(f"profile must be one of {PROFILES}")
    if profile == "analyst":
        return dataclasses.replace(ANALYST)
    ai = load_profile_file().get("ai") or {}
    return CleanParams.from_dict({k: v for k, v in ai.items() if k in {f.name for f in dataclasses.fields(CleanParams)}})
