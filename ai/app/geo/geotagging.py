"""Geotagging: map sonar pixel positions to latitude / longitude.

Side-scan geometry: each image row is one ping, taken at the vehicle position for that ping;
each column is a range sample. The nadir column (directly below the vehicle) splits the image into
port (left) and starboard (right). A pixel at column x lies |x - nadir| * metres-per-pixel away from
the vehicle, perpendicular to its heading (heading + 90 deg for starboard, heading - 90 deg for port).

Navigation can come from:
  * XTF ping headers (see xtf.py)
  * a navigation CSV / JSON with one fix per ping (lat, lon, [heading], [altitude], [row|ping], [slant_range_m])
  * a simple georeference: one position + heading + swath width (straight-line survey leg)
"""

import csv
import io
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone

import numpy as np

EARTH_RADIUS_M = 6371008.8


class GeoreferenceError(ValueError):
    pass


def haversine_m(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp, dl = p2 - p1, np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * np.arcsin(np.sqrt(np.clip(a, 0, 1)))


def bearing_deg(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    x = np.sin(dl) * np.cos(p2)
    y = np.cos(p1) * np.sin(p2) - np.sin(p1) * np.cos(p2) * np.cos(dl)
    return (np.degrees(np.arctan2(x, y)) + 360) % 360


def destination(lat, lon, bearing, dist_m):
    """Point reached from (lat, lon) travelling dist_m along bearing (great-circle)."""
    p1, l1, b = np.radians(lat), np.radians(lon), np.radians(bearing)
    d = np.asarray(dist_m) / EARTH_RADIUS_M
    p2 = np.arcsin(np.sin(p1) * np.cos(d) + np.cos(p1) * np.sin(d) * np.cos(b))
    l2 = l1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(p1), np.cos(d) - np.sin(p1) * np.sin(p2))
    return np.degrees(p2), (np.degrees(l2) + 540) % 360 - 180


@dataclass
class Track:
    rows: np.ndarray            # image row of each navigation fix (ascending)
    lat: np.ndarray
    lon: np.ndarray
    heading: np.ndarray         # degrees true
    across_m_per_px: float
    nadir_col: float
    altitude: np.ndarray | None = None
    slant_range: bool = False   # True -> columns are slant range; apply flat-seabed ground-range correction
    source: str = "unknown"
    assumptions: list[str] = field(default_factory=list)
    times: np.ndarray | None = None  # UTC epoch seconds of each fix

    def time_at(self, y: float) -> str | None:
        if self.times is None:
            return None
        t = float(np.interp(np.clip(y, self.rows[0], self.rows[-1]), self.rows, self.times))
        return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _interp(self, y: float):
        y = float(np.clip(y, self.rows[0], self.rows[-1]))
        lat = float(np.interp(y, self.rows, self.lat))
        lon = float(np.interp(y, self.rows, self.lon))
        hdg = float(np.degrees(np.interp(y, self.rows, np.unwrap(np.radians(self.heading)))) % 360)
        alt = float(np.interp(y, self.rows, self.altitude)) if self.altitude is not None else None
        return lat, lon, hdg, alt

    @property
    def along_m_per_px(self) -> float:
        span = self.rows[-1] - self.rows[0]
        if span <= 0:
            return self.across_m_per_px
        length = float(np.sum(haversine_m(self.lat[:-1], self.lon[:-1], self.lat[1:], self.lon[1:])))
        return length / span if length > 0 else self.across_m_per_px

    def pixel_to_geo(self, x: float, y: float) -> dict:
        lat, lon, hdg, alt = self._interp(y)
        dx = x - self.nadir_col
        side = "starboard" if dx >= 0 else "port"
        across = abs(dx) * self.across_m_per_px
        if self.slant_range and alt:
            across = float(np.sqrt(max(across ** 2 - alt ** 2, 0.0)))
        plat, plon = destination(lat, lon, (hdg + (90 if side == "starboard" else -90)) % 360, across)
        return {
            "latitude": round(float(plat), 7),
            "longitude": round(float(plon), 7),
            "side": side,
            "across_track_m": round(across, 2),
            "vehicle_latitude": round(lat, 7),
            "vehicle_longitude": round(lon, 7),
            "vehicle_heading_deg": round(hdg, 1),
            "altitude_m": round(alt, 2) if alt is not None else None,
            "timestamp": self.time_at(y),
        }

    def summary(self) -> dict:
        return {
            "source": self.source,
            "start": {"latitude": round(float(self.lat[0]), 7), "longitude": round(float(self.lon[0]), 7)},
            "end": {"latitude": round(float(self.lat[-1]), 7), "longitude": round(float(self.lon[-1]), 7)},
            "track_length_m": round(float(np.sum(haversine_m(self.lat[:-1], self.lon[:-1], self.lat[1:], self.lon[1:]))), 1),
            "mean_heading_deg": round(float(np.degrees(np.angle(np.mean(np.exp(1j * np.radians(self.heading))))) % 360), 1),
            "across_track_m_per_px": round(self.across_m_per_px, 4),
            "along_track_m_per_px": round(self.along_m_per_px, 4),
            "nadir_column": round(self.nadir_col, 1),
            "slant_range_corrected": self.slant_range,
            "navigation_fixes": int(len(self.rows)),
            "start_time": self.time_at(self.rows[0]),
            "end_time": self.time_at(self.rows[-1]),
            "assumptions": self.assumptions,
        }


# ---------- builders ----------

def from_simple(height: int, width: int, latitude: float, longitude: float, heading_deg: float = 0.0,
                swath_width_m: float | None = None, across_m_per_px: float | None = None,
                along_m_per_px: float | None = None, nadir_col: float | None = None,
                anchor: str = "center") -> Track:
    """Straight survey leg from a single position + heading. `anchor` = where (lat, lon) is: image centre or first ping."""
    assumptions = []
    if across_m_per_px is None:
        if swath_width_m is None:
            swath_width_m = 100.0
            assumptions.append("swath width not given; assumed 100 m")
        across_m_per_px = swath_width_m / width
    if along_m_per_px is None:
        along_m_per_px = across_m_per_px
        assumptions.append("square pixels assumed (along-track = across-track resolution)")
    if nadir_col is None:
        nadir_col = width / 2
        assumptions.append("nadir assumed at the image centre column")
    length = (height - 1) * along_m_per_px
    if anchor == "center":
        latitude, longitude = destination(latitude, longitude, (heading_deg + 180) % 360, length / 2)
    end_lat, end_lon = destination(latitude, longitude, heading_deg, length)
    return Track(rows=np.array([0.0, max(height - 1, 1)]), lat=np.array([float(latitude), float(end_lat)]),
                 lon=np.array([float(longitude), float(end_lon)]), heading=np.array([heading_deg, heading_deg], float),
                 across_m_per_px=float(across_m_per_px), nadir_col=float(nadir_col), source="simple", assumptions=assumptions)


_ALIASES = {
    "lat": ("lat", "latitude", "sensorycoordinate", "y"),
    "lon": ("lon", "lng", "long", "longitude", "sensorxcoordinate", "x"),
    "heading": ("heading", "heading_deg", "hdg", "course", "sensorheading"),
    "row": ("row", "pixel_row", "line", "image_row"),
    "ping": ("ping", "ping_number", "pingnumber"),
    "altitude": ("altitude", "altitude_m", "alt", "sensorprimaryaltitude"),
    "slant_range": ("slant_range", "slant_range_m", "range", "range_m", "slantrange"),
}


def _normalise(record: dict) -> dict:
    lower = {str(k).strip().lower(): v for k, v in record.items()}
    out = {}
    for key, names in _ALIASES.items():
        for n in names:
            if n in lower and lower[n] not in ("", None):
                try:
                    out[key] = float(lower[n])
                except (TypeError, ValueError):
                    pass
                break
    return out


def from_nav_records(height: int, width: int, records: list[dict], swath_width_m: float | None = None,
                     across_m_per_px: float | None = None, nadir_col: float | None = None,
                     slant_range: bool = False, source: str = "navigation") -> Track:
    recs = [r for r in (_normalise(r) for r in records) if "lat" in r and "lon" in r]
    if len(recs) < 2:
        raise GeoreferenceError("Navigation needs at least 2 fixes with lat/lon columns")
    assumptions = []
    lat = np.array([r["lat"] for r in recs])
    lon = np.array([r["lon"] for r in recs])
    if all("row" in r for r in recs):
        rows = np.array([r["row"] for r in recs])
    elif all("ping" in r for r in recs):
        pings = np.array([r["ping"] for r in recs])
        span = max(pings.max() - pings.min(), 1)
        rows = (pings - pings.min()) / span * (height - 1)
        assumptions.append("pings mapped linearly onto image rows")
    else:
        rows = np.linspace(0, height - 1, len(recs))
        assumptions.append("navigation fixes spread evenly over image rows")
    order = np.argsort(rows)
    rows, lat, lon = rows[order], lat[order], lon[order]
    if all("heading" in r for r in recs):
        heading = np.array([r["heading"] for r in recs])[order]
    else:  # course over ground from consecutive fixes
        b = bearing_deg(lat[:-1], lon[:-1], lat[1:], lon[1:])
        heading = np.append(b, b[-1])
        assumptions.append("heading derived from track (course over ground)")
    altitude = np.array([r["altitude"] for r in recs])[order] if all("altitude" in r for r in recs) else None
    if across_m_per_px is None:
        ranges = [r["slant_range"] for r in recs if "slant_range" in r]
        if ranges:
            across_m_per_px = float(np.median(ranges)) / (width / 2)
        elif swath_width_m:
            across_m_per_px = swath_width_m / width
        else:
            across_m_per_px = 100.0 / width
            assumptions.append("swath width not given; assumed 100 m")
    if nadir_col is None:
        nadir_col = width / 2
        assumptions.append("nadir assumed at the image centre column")
    return Track(rows=rows.astype(float), lat=lat, lon=lon, heading=heading.astype(float),
                 across_m_per_px=float(across_m_per_px), nadir_col=float(nadir_col), altitude=altitude,
                 slant_range=slant_range and altitude is not None, source=source, assumptions=assumptions)


def parse_metadata(data: bytes, filename: str, height: int, width: int, **overrides) -> Track:
    """Parse an uploaded navigation / georeference file (JSON or CSV)."""
    text = data.decode("utf-8-sig", errors="replace").strip()
    overrides = {k: v for k, v in overrides.items() if v is not None}
    if filename.lower().endswith(".json") or text.startswith(("{", "[")):
        try:
            obj = json.loads(text)
        except json.JSONDecodeError as e:
            raise GeoreferenceError(f"Invalid JSON metadata: {e}") from e
        if isinstance(obj, list):
            obj = {"pings": obj}
        pings = obj.get("pings") or obj.get("navigation")
        swath = overrides.get("swath_width_m", obj.get("swath_width_m"))
        res = overrides.get("across_m_per_px", obj.get("across_track_m_per_px"))
        nadir = overrides.get("nadir_col", obj.get("nadir_column"))
        if pings:
            return from_nav_records(height, width, pings, swath, res, nadir,
                                    slant_range=bool(obj.get("slant_range", False)), source="navigation_json")
        n = _normalise(obj)
        if "lat" not in n or "lon" not in n:
            raise GeoreferenceError("JSON metadata needs latitude/longitude or a 'pings' list")
        return from_simple(height, width, n["lat"], n["lon"], n.get("heading", 0.0), swath, res,
                           obj.get("along_track_m_per_px"), nadir, obj.get("anchor", "center"))
    rows = list(csv.DictReader(io.StringIO(text)))
    return from_nav_records(height, width, rows, overrides.get("swath_width_m"), overrides.get("across_m_per_px"),
                            overrides.get("nadir_col"), source="navigation_csv")
