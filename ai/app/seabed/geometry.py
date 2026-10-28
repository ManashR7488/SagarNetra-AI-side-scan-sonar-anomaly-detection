"""Side-scan swath geometry: image pixels <-> along-track / across-track metres on the seabed.

Coordinates used by the 3D seabed model:
  s  along-track distance from the first ping (m)
  u  signed across-track ground range from the nadir (m), starboard positive, port negative

Every quantity is taken from the best available source, and the source is recorded:
  across-track scale   navigation / XTF slant range > operator swath width > assumed 100 m swath
  nadir column         XTF / operator > water column found in the image > image centre
  altitude             logged (XTF / navigation file), checked against the image > bottom-tracked from the image >
                       assumed 10 % of the range
  along-track spacing  lat/lon track > projected XTF coordinates or logged speed > square pixels
  water depth          sensor depth + altitude (XTF) or navigation file; else elevations are relative
"""

import dataclasses
from dataclasses import dataclass, field

import numpy as np

from app.geo.geotagging import Track, haversine_m
from app.seabed.bottom import BottomTrack

ASSUMED_SWATH_M = 100.0       # same default as geotagging.from_simple
ASSUMED_ALTITUDE_FRAC = 0.1   # survey practice: fly at 10-20 % of the range


@dataclass
class PingGeometry:
    """What the sonar log says about every ping, independent of lat/lon (XTF files without usable navigation
    still have slant range, altitude and depth)."""
    rows: np.ndarray
    across_m_per_px: float
    nadir_col: float
    along_m_per_px: float | None = None
    along_source: str = "square pixels"
    altitude: np.ndarray | None = None
    sensor_depth: np.ndarray | None = None


@dataclass
class AltitudeChoice:
    rows: np.ndarray | None
    values: np.ndarray | None
    source: str                       # logged | logged+image | image | assumed
    note: str | None = None
    check_m: float | None = None      # median |logged - bottom-tracked| when both exist


def choose_altitude(rows: np.ndarray | None, logged: np.ndarray | None, bottom: BottomTrack | None,
                    m_per_px: float, surface: np.ndarray | None = None) -> AltitudeChoice:
    """Logged altitude, verified against (or replaced by) the first seabed return in the image. `surface`: sensor
    depth at `rows` (a towed sonar also hears the sea surface at that slant range)."""
    bt_ok = bottom is not None and bottom.confidence >= 0.6
    if logged is not None and rows is not None:
        logged = np.asarray(logged, float)
        bad = ~np.isfinite(logged) | (logged <= 0.05)
        # a constant value is a placeholder written by the logger, not a measurement
        placeholder = np.ptp(logged[~bad]) < 1e-3 if (~bad).sum() > 10 else False
        if bad.mean() <= 0.2 and not (placeholder and bt_ok):
            if not bt_ok:
                return AltitudeChoice(rows, logged, "logged")
            img_alt = np.interp(rows, np.arange(len(bottom.altitude_px)), bottom.altitude_px) * m_per_px
            seen = np.interp(rows, np.arange(len(bottom.valid)), bottom.valid.astype(float)) > 0.5
            use = seen & ~bad
            if surface is not None:   # where the surface echo reaches the sonar with the seabed, the image is ambiguous
                use &= np.abs(img_alt - surface) > 1.0
            check = float(np.median(np.abs(logged[use] - img_alt[use]))) if use.sum() >= 3 else None
            fixed = np.where(bad, img_alt, logged)          # fill the few missing / zero values from the image
            if check is None:
                note = ("image check not possible: the sea-surface echo reaches the sonar together with the seabed"
                        if surface is not None else None)
                return AltitudeChoice(rows, fixed, "logged", note)
            # The sonar's own altitude (altimeter / bottom lock) is kept even when the image disagrees: a surface
            # echo or a target under the vehicle can fool image tracking. The disagreement is reported.
            if check > max(0.5, 0.15 * float(np.median(logged[~bad]))):
                return AltitudeChoice(rows, fixed, "logged",
                                      f"logged altitude differs from the first seabed return in the image by {check:.2f} m "
                                      f"(median): kept the logged value; check the bottom lock", check)
            return AltitudeChoice(rows, fixed, "logged+image",
                                  f"logged altitude confirmed by bottom tracking (median difference {check:.2f} m)", check)
    if bt_ok:
        all_rows = np.arange(len(bottom.altitude_px), dtype=float)
        note = "altitude not logged: tracked from the first seabed return in the image"
        if logged is not None:
            note = "logged altitude missing, zero or constant: tracked from the first seabed return in the image"
        return AltitudeChoice(all_rows, bottom.altitude_px * m_per_px, "image", note)
    return AltitudeChoice(None, None, "assumed")


def refine_track(track: Track | None, bottom: BottomTrack | None, height: int) -> tuple[Track | None, AltitudeChoice | None]:
    """Improve a navigation track with what the image shows: the real nadir column (when it was only assumed)
    and a verified altitude, so geotagging applies the slant-range correction properly."""
    if track is None:
        return None, None
    assumptions = list(track.assumptions)
    nadir = track.nadir_col
    if bottom is not None and any("nadir assumed" in a for a in assumptions):
        nadir = bottom.nadir_col
        assumptions = [a for a in assumptions if "nadir assumed" not in a]
        assumptions.append(f"nadir column {nadir:.0f} found from the water column in the image")
    # A straight-leg track has only 2 fixes: densify it so the altitude can vary along the strip.
    if len(track.rows) < 64 and height > 64:
        rows = np.linspace(track.rows[0], track.rows[-1], 256)
        hdg = np.degrees(np.interp(rows, track.rows, np.unwrap(np.radians(track.heading)))) % 360
        times = None if track.times is None else np.interp(rows, track.rows, track.times)
        interp = lambda v: None if v is None else np.interp(rows, track.rows, v)  # noqa: E731
        track = dataclasses.replace(track, rows=rows, lat=interp(track.lat), lon=interp(track.lon), heading=hdg,
                                    times=times, altitude=interp(track.altitude), water_depth=interp(track.water_depth))
    surface = (track.water_depth - track.altitude) if track.water_depth is not None and track.altitude is not None else None
    choice = choose_altitude(track.rows, track.altitude, bottom, track.across_m_per_px, surface)
    water = track.water_depth
    if choice.values is not None and choice.source == "image" and track.altitude is not None and water is not None:
        water = water - track.altitude + np.interp(track.rows, choice.rows, choice.values)
    altitude = None if choice.values is None else np.interp(track.rows, choice.rows, choice.values)
    if choice.note:
        assumptions.append(choice.note)
    # Slant range when the log says so (XTF) or a water column is visible in the image.
    slant = altitude is not None and (track.slant_range or bottom is not None)
    return dataclasses.replace(track, nadir_col=float(nadir), altitude=altitude, water_depth=water,
                               slant_range=slant, assumptions=assumptions), choice


@dataclass
class SwathGeometry:
    height: int
    width: int
    nadir: float
    m_per_px: float                  # across-track metres per column (slant or ground range)
    slant: bool                      # columns are slant range (water column at the nadir)
    rows: np.ndarray                 # image rows of the along-track fixes (ascending)
    s_fix: np.ndarray                # along-track distance at each fix
    altitude_fix: np.ndarray | None  # sonar height above the seabed at `alt_rows`
    water_depth_fix: np.ndarray | None
    assumed_altitude: float | None = None
    assumptions: list[str] = field(default_factory=list)
    alt_rows: np.ndarray | None = None
    depth_rows: np.ndarray | None = None
    sources: dict = field(default_factory=dict)

    def __post_init__(self):
        if self.alt_rows is None and self.altitude_fix is not None:
            self.alt_rows = self.rows
        if self.depth_rows is None and self.water_depth_fix is not None:
            self.depth_rows = self.rows

    @classmethod
    def build(cls, height: int, width: int, track: Track | None, ping: PingGeometry | None = None,
              bottom: BottomTrack | None = None, swath_width_m: float | None = None,
              altitude_choice: AltitudeChoice | None = None) -> "SwathGeometry":
        """`track` should already be refined (refine_track); `ping` = XTF geometry when there is no lat/lon track;
        `bottom` = bottom track of the image; `swath_width_m` = operator's swath width for plain images."""
        assumptions: list[str] = []
        sources: dict = {}
        if track is not None:
            rows = np.asarray(track.rows, float)
            if len(rows) >= 2 and len(track.lat) == len(rows):
                steps = haversine_m(track.lat[:-1], track.lon[:-1], track.lat[1:], track.lon[1:])
                s_fix = np.concatenate([[0.0], np.cumsum(steps)])
            else:
                s_fix = (rows - rows[0]) * track.along_m_per_px
            if s_fix[-1] <= 0:
                s_fix = (rows - rows[0]) * track.across_m_per_px
            assumptions += list(track.assumptions)
            geom = cls(height, width, float(track.nadir_col), float(track.across_m_per_px),
                       bool(track.slant_range and track.altitude is not None), rows, s_fix,
                       None if track.altitude is None else np.asarray(track.altitude, float),
                       None if track.water_depth is None else np.asarray(track.water_depth, float),
                       alt_rows=rows, depth_rows=rows)
            sources.update(scale=track.source, along="navigation track", nadir="navigation / log")
            if altitude_choice is not None:
                sources["altitude"] = altitude_choice.source if track.altitude is not None else "assumed"
            else:
                sources["altitude"] = "logged" if track.altitude is not None else "assumed"
        else:
            if ping is not None:
                mpp, nadir = ping.across_m_per_px, ping.nadir_col
                sources.update(scale="XTF slant range", nadir="XTF channels")
                assumptions.append("no usable lat/lon in the log: positions are local (along-track / range only)")
            elif swath_width_m:
                mpp, nadir = swath_width_m / width, width / 2
                sources.update(scale=f"operator swath width {swath_width_m:g} m", nadir="image centre")
            else:
                mpp, nadir = ASSUMED_SWATH_M / width, width / 2
                sources.update(scale="assumed", nadir="image centre")
                assumptions.append(f"swath width unknown: assumed {ASSUMED_SWATH_M:.0f} m (enter the real swath "
                                   f"width to scale the model)")
            if bottom is not None and ping is None:
                nadir = bottom.nadir_col
                sources["nadir"] = "water column in the image"
            if ping is not None and ping.along_m_per_px:
                along, sources["along"] = ping.along_m_per_px, ping.along_source
            else:
                along, sources["along"] = mpp, "square pixels (assumed)"
                assumptions.append("along-track spacing unknown: square pixels assumed")
            rows = np.array([0.0, max(height - 1, 1)])
            choice = choose_altitude(ping.rows if ping else None, ping.altitude if ping else None, bottom, mpp,
                                     ping.sensor_depth if ping else None)
            if choice.note:
                assumptions.append(choice.note)
            water = None
            if ping is not None and ping.sensor_depth is not None and choice.values is not None:
                water = np.interp(ping.rows, choice.rows, choice.values) + ping.sensor_depth
            geom = cls(height, width, float(nadir), float(mpp), choice.values is not None and (ping is not None or bottom is not None),
                       rows, rows * along, choice.values, water, alt_rows=choice.rows,
                       depth_rows=None if ping is None else ping.rows)
            sources["altitude"] = choice.source
        if bottom is None and not geom.slant:
            assumptions.append("no water column in the image: treated as ground range (already slant-corrected or "
                               "cropped)")
        if geom.altitude_fix is None:
            geom.assumed_altitude = round(ASSUMED_ALTITUDE_FRAC * geom.max_range, 2)
            assumptions.append(f"sonar altitude unknown: assumed {geom.assumed_altitude} m "
                               f"({ASSUMED_ALTITUDE_FRAC:.0%} of the range) for shading and shadow heights")
            sources["altitude"] = "assumed"
        sources["depth"] = "measured" if geom.water_depth_fix is not None else "none"
        geom.assumptions = list(dict.fromkeys(assumptions))
        geom.sources = sources
        return geom

    # ---- along-track ----
    @property
    def along_m_per_px(self) -> float:
        span = self.rows[-1] - self.rows[0]
        return float((self.s_fix[-1] - self.s_fix[0]) / span) if span > 0 else self.m_per_px

    def s_at(self, y):
        """Along-track distance of image row(s) y (linear beyond the first / last fix)."""
        y = np.asarray(y, float)
        s = np.interp(y, self.rows, self.s_fix)
        k = self.along_m_per_px
        return np.where(y < self.rows[0], self.s_fix[0] + (y - self.rows[0]) * k,
                        np.where(y > self.rows[-1], self.s_fix[-1] + (y - self.rows[-1]) * k, s))

    @property
    def length_m(self) -> float:
        return float(self.s_at(self.height - 1) - self.s_at(0))

    def y_at(self, s):
        """Inverse of s_at (row for an along-track distance measured from row 0)."""
        ys = np.linspace(0, self.height - 1, min(self.height, 4096))
        ss = np.maximum.accumulate(self.s_at(ys) - self.s_at(0)) + np.arange(len(ys)) * 1e-9
        return np.interp(np.asarray(s, float), ss, ys)

    def altitude_at(self, y):
        if self.altitude_fix is None:
            return np.full(np.shape(y), self.assumed_altitude, float)
        return np.interp(np.asarray(y, float), self.alt_rows, self.altitude_fix)

    def water_depth_at(self, y):
        if self.water_depth_fix is None:
            return None
        return np.interp(np.asarray(y, float), self.depth_rows, self.water_depth_fix)

    # ---- across-track ----
    @property
    def max_range(self) -> float:
        return max(self.nadir, self.width - self.nadir) * self.m_per_px

    @property
    def max_ground(self) -> float:
        if not self.slant:
            return self.max_range
        return float(np.sqrt(max(self.max_range ** 2 - float(np.min(self.altitude_fix)) ** 2, 1.0)))

    def ground_u(self, x, y):
        """Signed ground range (m) of pixel column(s) x on row(s) y; flat-seabed slant-range correction."""
        dx = np.asarray(x, float) - self.nadir
        r = np.abs(dx) * self.m_per_px
        if self.slant:
            h = self.altitude_at(y)
            r = np.sqrt(np.maximum(r ** 2 - h ** 2, 0.0))
        return np.sign(dx) * r

    def col_at(self, u, y):
        """Pixel column for signed ground range u on row(s) y (inverse of ground_u)."""
        u = np.asarray(u, float)
        r = np.abs(u)
        if self.slant:
            r = np.sqrt(r ** 2 + self.altitude_at(y) ** 2)
        return self.nadir + np.where(u < 0, -1.0, 1.0) * r / self.m_per_px
