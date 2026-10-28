"""Run the stage-1 cleaning steps and keep track of how the image geometry changed.

Geometry: motion compensation (XTF) re-spaces rows by distance travelled, ground-range correction changes what a
column means, resolution normalisation rescales both axes. `Frame` records all of it so that navigation tracks
(rows of fixes, nadir column, metres per pixel, slant / ground range), detections and the 3D seabed are expressed
in the cleaned image's pixels.
"""

import dataclasses
import logging
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from app.cleaning import gain as gainmod
from app.cleaning import resolution as resmod
from app.cleaning import watercolumn as wc
from app.cleaning.dropouts import PingFlags, find_bad_pings, flag_log_pings, repair_pings, runs
from app.cleaning.motion import compensate, default_resample
from app.cleaning.params import CleanParams
from app.cleaning.report import measure, ping_stats, quality_score, subscores
from app.cleaning.speckle import despeckle, enhance
from app.geo.geotagging import Track
from app.readers.xtf import XtfLog
from app.seabed.bottom import BottomTrack, track_bottom
from app.seabed.geometry import PingGeometry

log = logging.getLogger("sonar.cleaning")

STEP_NAMES = {
    "raw": "Raw input",
    "dropouts": "Dropouts & bad pings",
    "motion": "Motion compensation",
    "gain": "Gain & interference",
    "seabed": "Water column & ground range",
    "speckle": "Speckle reduction",
    "resolution": "Standard resolution",
    "display": "Display enhancement",
}


@dataclass
class Step:
    id: str
    applied: bool
    ms: float
    info: dict = field(default_factory=dict)
    image: np.ndarray | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def name(self) -> str:
        return STEP_NAMES[self.id]


@dataclass
class Frame:
    """How the cleaned image relates to the reader's image (the frame navigation files and labels refer to)."""
    width: int
    height: int
    original_shape: tuple[int, int]
    nadir_col: float | None
    across_m_per_px: float | None        # metres per column of the cleaned image (ground range if not slant)
    along_m_per_px: float | None
    slant: bool                          # columns are slant range (water column in the image)
    ground_corrected: bool = False       # this pipeline resampled slant range to ground range
    row_scale: float = 1.0               # resolution step: new rows per row
    col_scale: float = 1.0               # resolution step: new columns per column
    row_of_ping: np.ndarray | None = None    # XTF: cleaned-image row of every ping (before row_scale)
    default_sy: float | None = None          # XTF: reader-waterfall rows per ping
    course: np.ndarray | None = None         # XTF motion: direction of travel per ping (beams perpendicular to it)
    notes: list[str] = field(default_factory=list)

    @property
    def geometry_changed(self) -> bool:
        return (self.width, self.height) != (self.original_shape[1], self.original_shape[0]) or self.ground_corrected \
            or self.course is not None

    def map_rows(self, rows) -> np.ndarray:
        """Rows of the reader's image -> rows of the cleaned image."""
        rows = np.asarray(rows, np.float64)
        if self.row_of_ping is not None and self.default_sy:
            ping = rows / self.default_sy
            n = len(self.row_of_ping)
            base = np.interp(ping, np.arange(n), self.row_of_ping)
            # beyond the last ping: keep the local spacing
            spacing = (self.row_of_ping[-1] - self.row_of_ping[0]) / max(n - 1, 1)
            base = np.where(ping > n - 1, self.row_of_ping[-1] + (ping - (n - 1)) * spacing, base)
            return base * self.row_scale
        return rows * self.row_scale

    def transform_track(self, track: Track | None) -> Track | None:
        if track is None:
            return None
        rows = self.map_rows(track.rows)
        heading = track.heading
        if self.course is not None and self.default_sy:
            ping = np.clip(track.rows / self.default_sy, 0, len(self.course) - 1)
            heading = np.degrees(np.interp(ping, np.arange(len(self.course)), np.unwrap(np.radians(self.course)))) % 360
        nadir = self.nadir_col if self.nadir_col is not None else track.nadir_col * self.col_scale
        notes = list(track.assumptions) + [n for n in self.notes if n not in track.assumptions]
        return dataclasses.replace(track, rows=rows, heading=heading, across_m_per_px=track.across_m_per_px / self.col_scale,
                                   nadir_col=float(nadir), slant_range=bool(track.slant_range and self.slant),
                                   assumptions=notes)

    def transform_ping_geometry(self, ping: PingGeometry | None) -> PingGeometry | None:
        if ping is None:
            return None
        along = self.along_m_per_px if self.along_m_per_px else ping.along_m_per_px
        return dataclasses.replace(ping, rows=self.map_rows(ping.rows), across_m_per_px=ping.across_m_per_px / self.col_scale,
                                   nadir_col=float(self.nadir_col if self.nadir_col is not None else ping.nadir_col),
                                   along_m_per_px=along, along_source="motion-compensated (distance travelled)"
                                   if self.course is not None else ping.along_source)

    def summary(self) -> dict:
        return {"width": self.width, "height": self.height, "original_size": [self.original_shape[1], self.original_shape[0]],
                "geometry_changed": bool(self.geometry_changed), "nadir_column": None if self.nadir_col is None else round(self.nadir_col, 1),
                "across_m_per_px": None if self.across_m_per_px is None else round(self.across_m_per_px, 4),
                "along_m_per_px": None if self.along_m_per_px is None else round(self.along_m_per_px, 4),
                "ground_range": not self.slant, "ground_corrected": self.ground_corrected,
                "motion_compensated": self.course is not None,
                "scale": [round(self.col_scale, 4), round(self.row_scale, 4)], "notes": self.notes}


@dataclass
class QualityMaps:
    """Data quality per row of the cleaned image (for flagging detections) and the water column."""
    repaired: np.ndarray
    gap: np.ndarray
    motion: np.ndarray
    stripes: np.ndarray
    unrepaired: np.ndarray               # bad pings left as they were (runs longer than the repair limit)
    nadir_col: float | None
    water_px: np.ndarray | None          # per row; None when there is no water column (ground range / crop)
    across_m_per_px: float | None

    def rows_set(self, name: str) -> set[int]:
        return set(np.where(getattr(self, name))[0].tolist())

    def at_box(self, box) -> dict:
        h = len(self.repaired)
        x1, y1, x2, y2 = (float(v) for v in box)
        a, b = int(max(0, np.floor(y1))), int(min(h, np.ceil(y2)))
        if b <= a:
            b = min(h, a + 1)
        frac = lambda m: float(m[a:b].mean()) if b > a else 0.0  # noqa: E731
        out = {
            "repaired_pings": round(frac(self.repaired), 3),
            "time_gap": bool(self.gap[a:b].any()),
            "motion_flagged": round(frac(self.motion), 3),
            "interference": bool(self.stripes[a:b].any()),
            "unrepaired_dropout": round(frac(self.unrepaired), 3),
        }
        in_water = near_nadir = False
        if self.nadir_col is not None:
            cx = (x1 + x2) / 2
            d = abs(cx - self.nadir_col)
            if self.water_px is not None:
                wp = float(np.median(self.water_px[a:b])) if b > a else 0.0
                # entirely in the water column (fish, bubbles, surface echo). A tall object near the nadir echoes
                # before the seabed does, so part of it shows in the water column: it reaches the seabed, so it
                # is not flagged.
                far = max(abs(x1 - self.nadir_col), abs(x2 - self.nadir_col))
                in_water = far < wp * 0.97
                near_nadir = d < wp * 1.5
            else:
                near_nadir = d < 0.03 * (2 * self.nadir_col)
        out["in_water_column"] = bool(in_water)
        out["near_nadir"] = bool(near_nadir)
        if self.across_m_per_px:
            out["resolution_m"] = round(self.across_m_per_px, 3)
        flags = [k for k in ("time_gap", "interference", "in_water_column") if out[k]]
        flags += [k for k in ("repaired_pings", "motion_flagged", "unrepaired_dropout") if out[k] >= 0.3]
        out["flags"] = flags
        out["score"] = max(0, 100 - 30 * len(flags) - (10 if near_nadir and not in_water else 0))
        return out


@dataclass
class CleanResult:
    image: np.ndarray
    steps: list[Step]
    frame: Frame
    quality: QualityMaps
    report: dict
    params: CleanParams
    bottom: BottomTrack | None           # bottom track of the cleaned image (None after ground correction)
    altitude_px: np.ndarray | None = None    # per row: sonar altitude in pixels of the cleaned image, also after
                                             # ground-range correction (when a water column was found)
    geometry_ops: list = field(default_factory=list)   # image-space geometric operations, in order (map_mask)

    def map_mask(self, mask: np.ndarray) -> np.ndarray:
        """Apply this cleaning's geometric changes to a label mask of the reader's image (plain images: ground-range
        correction and resampling; XTF motion compensation is matched by position instead)."""
        out = mask.astype(np.uint8)
        for op in self.geometry_ops:
            if op[0] == "ground":
                out, _ = wc.slant_to_ground(out, op[1], op[2])
            elif op[0] == "resize":
                out = cv2.resize(out, (op[1], op[2]), interpolation=cv2.INTER_NEAREST)
        return out


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 1)


def _expand_ping_flags(flags: np.ndarray, row_of_ping: np.ndarray, height: int) -> np.ndarray:
    """Per-ping flags -> per-row flags of a resampled image (each ping covers half the gap to its neighbours)."""
    out = np.zeros(height, bool)
    if not flags.any():
        return out
    n = len(row_of_ping)
    for a, b in runs(flags):
        lo = row_of_ping[a] - 0.5 * (row_of_ping[a] - row_of_ping[a - 1] if a > 0 else 1.0)
        hi = row_of_ping[b - 1] + 0.5 * (row_of_ping[b] - row_of_ping[b - 1] if b < n else 1.0)
        out[max(0, int(np.floor(lo))):min(height, int(np.ceil(hi)) + 1)] = True
    return out


def _scale_rows(v: np.ndarray, height: int) -> np.ndarray:
    """Per-row array resampled to a new number of rows (nearest)."""
    if len(v) == height:
        return v
    idx = np.clip(np.round(np.arange(height) * (len(v) / height)).astype(int), 0, len(v) - 1)
    return v[idx]


def _bottom(img: np.ndarray, nadir: float | None) -> BottomTrack | None:
    try:
        return track_bottom(img, nadir)
    except Exception:  # noqa: BLE001 - optional information
        log.exception("bottom tracking failed")
        return None


@dataclass
class Diagnosis:
    """Noise measured on the raw input (shared by Auto and the cleaning run)."""
    bottom: BottomTrack | None
    nadir: float
    metrics: dict
    pings: dict
    info: dict
    ms: float

    def to_dict(self) -> dict:
        return {"metrics": self.metrics, "pings": self.pings, **self.info}


def diagnose(gray: np.ndarray, xtf: XtfLog | None = None, across_m_per_px: float | None = None) -> Diagnosis:
    t = time.perf_counter()
    h0, w0 = gray.shape
    nadir_known = xtf.nadir_col if xtf is not None else None
    bottom0 = _bottom(gray, nadir_known)
    nadir0 = nadir_known if nadir_known is not None else (bottom0.nadir_col if bottom0 else w0 / 2)
    metrics = measure(gray, nadir0, bottom0.altitude_px if bottom0 else None)
    if xtf is not None:
        flags = find_bad_pings(xtf.raw, xtf.nadir_col)
        flag_log_pings(flags, xtf.times, xtf.pitch, xtf.roll, xtf.heading, xtf.heave)
        native = repair_pings(xtf.raw, flags, xtf.nadir_col) if flags.bad.any() else xtf.raw
        nb = _bottom(native, xtf.nadir_col)
        metrics["stripe_fraction"] = round(float(gainmod.stripe_mask(native)[0].mean()), 6)
        metrics.update(ping_stats(native, xtf.nadir_col, nb.altitude_px if nb else None))
        flags.repaired = np.zeros(len(flags.blank), bool)
    else:
        flags = find_bad_pings(gray, nadir0)
        flags.repaired = np.zeros(len(flags.blank), bool)
    pings = flags.counts()
    pings["motion_checked"] = bool(xtf is not None and xtf.has_motion())
    from app.cleaning.motion import along_track  # local: motion imports the reader
    nav = xtf is not None and along_track(xtf)[0] is not None and xtf.across_m_per_px is not None
    info = {"water_column": bottom0.summary() if bottom0 else None, "xtf": xtf is not None, "xtf_navigation": bool(nav),
            "sensor_depth": bool(xtf is not None and xtf.sensor_depth is not None),
            "across_m_per_px": xtf.across_m_per_px if xtf is not None else across_m_per_px,
            "size": [w0, h0]}
    return Diagnosis(bottom0, float(nadir0), metrics, pings, info, _ms(t))


def clean(gray: np.ndarray, params: CleanParams, xtf: XtfLog | None = None, across_m_per_px: float | None = None,
          keep_steps: bool = True, measure_noise: bool = True, diag: Diagnosis | None = None) -> CleanResult:
    """`gray`: the reader's image (XTF: its default waterfall). `across_m_per_px`: known scale for images (operator
    swath width) - XTF logs carry their own. `keep_steps`: keep every intermediate image (previews)."""
    params.validate()
    t_all = time.perf_counter()
    h0, w0 = gray.shape
    steps: list[Step] = []
    keep = (lambda im: im) if keep_steps else (lambda im: None)  # noqa: E731

    # ---- before: water column of the raw image (also gives the nadir of plain images)
    t = time.perf_counter()
    if diag is not None:
        bottom0, nadir0, before = diag.bottom, diag.nadir, dict(diag.metrics)
    else:
        nadir_known = xtf.nadir_col if xtf is not None else None
        bottom0 = _bottom(gray, nadir_known)
        nadir0 = nadir_known if nadir_known is not None else (bottom0.nadir_col if bottom0 else w0 / 2)
        before = measure(gray, nadir0, bottom0.altitude_px if bottom0 else None) if measure_noise else {}
    steps.append(Step("raw", True, _ms(t), {"size": [w0, h0], "water_column": bottom0.summary() if bottom0 else None},
                      keep(gray)))

    mpp = xtf.across_m_per_px if xtf is not None else across_m_per_px
    frame_notes: list[str] = []
    geometry_ops: list = []

    # ---- 1. dropouts & bad pings (XTF: on native pings, plus time gaps and motion limits)
    t = time.perf_counter()
    work = xtf.raw if xtf is not None else gray
    flags: PingFlags = find_bad_pings(work, nadir0 if xtf is None else xtf.nadir_col)
    motion_checked = False
    if xtf is not None:
        flag_log_pings(flags, xtf.times, xtf.pitch, xtf.roll, xtf.heading, xtf.heave)
        motion_checked = bool(xtf.has_motion())
    bad_before = flags.bad.copy()
    if params.repair_dropouts and flags.bad.any():
        work = repair_pings(work, flags, nadir0 if xtf is None else xtf.nadir_col, params.max_repair_pings)
    else:
        flags.repaired = np.zeros(len(flags.blank), bool)
    counts = flags.counts()
    counts["motion_checked"] = motion_checked
    unrepaired = bad_before & ~flags.repaired
    step_img = default_resample(work, xtf, h0) if (xtf is not None and keep_steps) else work
    notes = list(flags.notes)
    if not flags.bad.any():
        notes.append("no blank, partial or duplicated pings found")
    if unrepaired.any():
        notes.append(f"{int(unrepaired.sum())} bad pings in runs longer than {params.max_repair_pings} left unrepaired")
    steps.append(Step("dropouts", bool(params.repair_dropouts and flags.bad.any()), _ms(t), counts, keep(step_img), notes))

    # Ping-wise corrections belong to native pings: interference bursts are one or two pings thick and gain jumps
    # happen between pings, but once rows are resampled to square pixels a ping covers several rows. XTF logs get
    # destriping and ping gain here (reported with the gain step); plain images, whose rows are pings, in the gain
    # step.
    native = {}
    t_native = 0.0
    if xtf is not None and (params.destripe or params.gain_along or measure_noise):
        t = time.perf_counter()
        nb = _bottom(work, xtf.nadir_col)
        nwater = nb.altitude_px if nb else None
        if measure_noise:   # interference and ping statistics only make sense on native pings
            if diag is not None:
                native["stripes_before"] = diag.metrics.get("stripe_fraction")
                native["pings_before"] = {k: diag.metrics.get(k) for k in ("ping_jitter", "gain_steps")}
            else:
                native["stripes_before"] = round(float(gainmod.stripe_mask(work)[0].mean()), 6)
                native["pings_before"] = ping_stats(work, xtf.nadir_col, nwater)
        if params.destripe:
            work, native["stripes"] = gainmod.destripe(work)
        if params.gain_along:
            work, native["ping_gain"] = gainmod.ping_normalize(work, xtf.nadir_col, nwater, params.gain_strength)
        if measure_noise:
            native["stripes_after"] = round(float(gainmod.stripe_mask(work)[0].mean()), 6) if params.destripe                 else native["stripes_before"]
            native["pings_after"] = ping_stats(work, xtf.nadir_col, nwater) if params.gain_along or params.destripe                 else native["pings_before"]
        t_native = _ms(t)

    # ---- 2. motion compensation (XTF)
    t = time.perf_counter()
    row_of_ping = course = None
    along = None
    gap_rows = None
    if xtf is not None:
        res = compensate(work, xtf) if params.motion else None
        if res is not None:
            work, row_of_ping, course, along, gap_rows = res.image, res.row_of_ping, res.course, res.along_m_per_px, res.gap_rows
            steps.append(Step("motion", True, _ms(t), res.stats, keep(work)))
            frame_notes.append(f"rows resampled by distance travelled ({res.stats['along_track_source']}); "
                               f"yaw and pitch footprint offsets corrected")
        else:
            work = default_resample(work, xtf, h0)
            row_of_ping = xtf.row_of_ping
            reason = "switched off" if not params.motion else "no usable navigation (lat/lon or speed) in the log"
            steps.append(Step("motion", False, _ms(t), {"reason": reason}, keep(work) if params.motion else None))
    else:
        steps.append(Step("motion", False, 0.0, {"reason": "motion records exist only in XTF logs"}))

    h, w = work.shape
    nadir = xtf.nadir_col if xtf is not None else nadir0
    # water column of the working frame: bottom track, or the logged altitude
    bottom = _bottom(work, nadir) if (xtf is not None or bottom0 is not None) else None
    water_px = bottom.altitude_px if bottom is not None else None
    if water_px is None and xtf is not None and xtf.altitude is not None and mpp:
        water_px = np.interp(np.arange(h), row_of_ping, xtf.altitude) / mpp

    # per-row quality in the working frame
    if xtf is not None:
        expand = lambda m: _expand_ping_flags(m, row_of_ping, h)  # noqa: E731
        q_rep, q_mot, q_unrep = expand(flags.repaired), expand(flags.motion), expand(unrepaired)
        q_gap = gap_rows if gap_rows is not None else expand(flags.gap_before)
    else:
        q_rep, q_mot, q_unrep = flags.repaired.copy(), np.zeros(h, bool), unrepaired.copy()
        q_gap = np.zeros(h, bool)
    q_str = np.zeros(h, bool)

    # ---- 3. gain & interference
    t = time.perf_counter()
    ginfo, gapplied = {}, False
    if "stripes" in native:
        q_str = expand(native["stripes"].pop("_rows"))
        ginfo["stripes"] = {**native["stripes"], "domain": "native pings"}
        gapplied = native["stripes"]["pixels"] > 0
    elif params.destripe:
        work, ginfo["stripes"] = gainmod.destripe(work)
        q_str = ginfo["stripes"].pop("_rows")
        gapplied = gapplied or ginfo["stripes"]["pixels"] > 0
    if "ping_gain" in native:
        ginfo["ping_gain"] = {**native["ping_gain"], "domain": "native pings"}
        gapplied = gapplied or native["ping_gain"].get("applied", False)
    elif params.gain_along:
        work, ginfo["ping_gain"] = gainmod.ping_normalize(work, nadir, water_px, params.gain_strength)
        gapplied = gapplied or ginfo["ping_gain"].get("applied", False)
    if params.gain_across:
        work, ginfo["range_gain"] = gainmod.range_normalize(work, nadir, water_px, params.gain_strength)
        ginfo["range_gain"].pop("_profile_before", None)
        gapplied = gapplied or ginfo["range_gain"].get("applied", False)
    on = params.destripe or params.gain_along or params.gain_across
    steps.append(Step("gain", gapplied, round(_ms(t) + t_native, 1), ginfo if on else {"reason": "switched off"},
                      keep(work) if on else None))

    # radiometry (gain balance, ping stability, interference) is compared in the slant-range geometry of the input:
    # ground-range resampling stretches the near-nadir band into streaks that would read as interference
    pre_geometry = work

    # ---- 4. water column, surface echo, ground range
    t = time.perf_counter()
    sinfo, sapplied = {}, False
    slant = True
    on = params.mask_water_column or params.suppress_surface or params.slant_correct
    if water_px is None:
        if on:
            sinfo["reason"] = "no water column found (crop or already ground-range): nothing to correct"
        slant = bottom0 is not None or xtf is not None
    else:
        if params.suppress_surface:
            if xtf is not None and xtf.sensor_depth is not None and mpp:
                surface_px = np.interp(np.arange(h), row_of_ping, xtf.sensor_depth) / mpp
                work, sinfo["surface_echo"] = wc.suppress_surface_echo(work, nadir, water_px, surface_px)
                sapplied = sapplied or sinfo["surface_echo"].get("applied", False)
            else:
                sinfo["surface_echo"] = {"applied": False, "reason": "needs the sonar depth (XTF)"}
        if params.mask_water_column:
            work, sinfo["water_column"] = wc.mask_water_column(work, nadir, water_px)
            sapplied = sapplied or sinfo["water_column"].get("applied", False)
        if params.slant_correct:
            geometry_ops.append(("ground", float(nadir), np.asarray(water_px, np.float32).copy()))
            work, sinfo["ground_range"] = wc.slant_to_ground(work, nadir, water_px)
            sapplied = True
            slant = False
            frame_notes.append("slant range corrected to ground range (flat seabed)")
    steps.append(Step("seabed", sapplied, _ms(t), sinfo if on else {"reason": "switched off"}, keep(work) if on else None))

    # ---- 5. speckle
    t = time.perf_counter()
    if params.despeckle != "none" and params.despeckle_strength > 0:
        work = despeckle(work, params.despeckle, params.despeckle_strength)
        steps.append(Step("speckle", True, _ms(t), {"method": params.despeckle, "strength": params.despeckle_strength},
                          keep(work)))
    else:
        steps.append(Step("speckle", False, 0.0, {"reason": "switched off"}))

    # ---- 6. resolution
    t = time.perf_counter()
    sx = sy = 1.0
    along_mpp = along if along else (mpp if (xtf is not None and mpp) else None)
    if xtf is not None and along is None and mpp:
        along_mpp = mpp  # the reader's waterfall is resampled to square pixels when navigation allows
    if params.normalize_resolution:
        if mpp:
            work, sx, sy, rinfo = resmod.normalize(work, mpp, along_mpp, params.target_m_per_px)
            geometry_ops.append(("resize", int(work.shape[1]), int(work.shape[0])))
            frame_notes.append(f"resampled to {rinfo['to_m_per_px']} m/px")
            steps.append(Step("resolution", True, _ms(t), rinfo, keep(work)))
        else:
            steps.append(Step("resolution", False, 0.0, {"reason": "pixel size unknown: enter the swath width "
                                                                  "(images) to normalise the resolution"}))
    else:
        steps.append(Step("resolution", False, 0.0, {"reason": "switched off"}))

    signal = work            # the cleaned signal; display enhancement below only changes contrast for reading

    # ---- display enhancement (analyst view)
    if abs(params.shadow_gamma - 1.0) > 1e-3 or params.clahe:
        t = time.perf_counter()
        work = enhance(work, params.shadow_gamma, params.clahe, params.clahe_strength)
        steps.append(Step("display", True, _ms(t), {"shadow_gamma": params.shadow_gamma, "clahe": params.clahe,
                                                     "clahe_strength": params.clahe_strength}, keep(work)))

    hf, wf = work.shape
    nadir_f = nadir * sx
    frame = Frame(width=wf, height=hf, original_shape=(h0, w0), nadir_col=float(nadir_f),
                  across_m_per_px=(mpp / sx) if mpp else None,
                  along_m_per_px=(along_mpp / sy) if along_mpp else None, slant=slant,
                  ground_corrected=bool(params.slant_correct and water_px is not None), row_scale=sy, col_scale=sx,
                  row_of_ping=row_of_ping if xtf is not None else None,
                  default_sy=float(xtf.row_of_ping[1] - xtf.row_of_ping[0]) if xtf is not None and xtf.n > 1 else None,
                  course=course, notes=frame_notes)

    water_f = None
    alt_f = _scale_rows(water_px, hf) * sx if water_px is not None else None
    if slant and water_px is not None:
        water_f = alt_f
    quality = QualityMaps(repaired=_scale_rows(q_rep, hf), gap=_scale_rows(q_gap, hf), motion=_scale_rows(q_mot, hf),
                          stripes=_scale_rows(q_str, hf), unrepaired=_scale_rows(q_unrep, hf), nadir_col=float(nadir_f),
                          water_px=water_f, across_m_per_px=frame.across_m_per_px)
    bottom_f = None
    if slant and bottom is not None:
        bottom_f = bottom if (sx, sy) == (1.0, 1.0) else _bottom(work, nadir_f)

    report = {"pings": counts, "frame": frame.summary(), "timings_ms": {s.id: s.ms for s in steps}}
    if measure_noise:
        t = time.perf_counter()
        after = measure(signal, nadir_f, water_f)
        if pre_geometry is not signal and (not slant or (sx, sy) != (1.0, 1.0)):
            radiometric = measure(pre_geometry, nadir, water_px)
            for k in ("across_imbalance", "port_stbd_ratio", "ping_jitter", "gain_steps", "stripe_fraction"):
                after[k] = radiometric.get(k)
            after.setdefault("series", {}).update({k: v for k, v in radiometric.get("series", {}).items()
                                                   if k in ("across_profile", "nadir_bin", "ping_level_port", "ping_level_stbd")})
        if "stripes_before" in native:          # XTF: interference and ping statistics from the native pings
            before["stripe_fraction"] = native["stripes_before"]
            after["stripe_fraction"] = native["stripes_after"]
            before.update(native["pings_before"])
            after.update(native["pings_after"])
        n_p = len(flags.blank)
        sub_b = subscores(before, {**counts, "repaired": 0}, n_p)
        sub_a = subscores(after, counts, n_p)
        report.update(before=before, after=after, subscores_before=sub_b, subscores_after=sub_a,
                      quality_before=quality_score(sub_b), quality_after=quality_score(sub_a))
        report["timings_ms"]["measure"] = _ms(t)
    report["timings_ms"]["total"] = _ms(t_all)
    if xtf is not None:
        report["motion"] = _motion_series(xtf, flags)
    return CleanResult(work, steps, frame, quality, report, params, bottom_f, alt_f, geometry_ops)


def _motion_series(xtf: XtfLog, flags: PingFlags, n: int = 600) -> dict:
    """Attitude traces for the noise report charts (downsampled), with flagged ping ranges."""
    idx = np.unique(np.linspace(0, xtf.n - 1, min(n, xtf.n)).astype(int))
    t = xtf.times - xtf.times[0]
    unwrapped = np.degrees(np.unwrap(np.radians(xtf.heading)))
    series = {"t_s": np.round(t[idx], 2).tolist(), "ping": idx.tolist(),
              "pitch_deg": np.round(xtf.pitch[idx], 2).tolist(), "roll_deg": np.round(xtf.roll[idx], 2).tolist(),
              "heave_m": np.round(xtf.heave[idx], 3).tolist(),
              "heading_dev_deg": np.round((unwrapped - np.median(unwrapped))[idx], 2).tolist()}
    if xtf.speed_mps is not None:
        series["speed_mps"] = np.round(xtf.speed_mps[idx], 3).tolist()
    ranges = {k: [[int(a), int(b)] for a, b in runs(v)][:200] for k, v in flags.motion_reasons.items()}
    ranges["dropouts"] = [[int(a), int(b)] for a, b in runs(flags.bad)][:200]
    ranges["time_gaps"] = [[int(a), int(b)] for a, b in runs(flags.gap_before)][:200]
    return {"series": series, "flagged_ranges": ranges, "pings": int(xtf.n),
            "checked": bool(xtf.has_motion())}


def preview_scale(img: np.ndarray, max_side: int) -> np.ndarray:
    if max(img.shape) <= max_side:
        return img
    s = max_side / max(img.shape)
    return cv2.resize(img, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
