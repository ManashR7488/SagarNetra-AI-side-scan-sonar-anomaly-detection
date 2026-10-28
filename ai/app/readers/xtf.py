"""Read raw side-scan sonar logs in XTF (eXtended Triton Format).

Builds a waterfall image (rows = pings in time order, columns = port far->near | starboard near->far)
and a navigation Track from the per-ping headers (sensor lat/lon, heading, altitude, slant range, time).
The native-resolution waterfall and every ping's motion record (pitch, roll, heave, heading, speed) are kept
in an `XtfLog` for motion compensation and dropout checks (app/cleaning).
"""

import os
import tempfile
from dataclasses import dataclass

import cv2
import numpy as np
import pyxtf

from app.geo.geotagging import Track, haversine_m
from app.readers.image import to_uint8
from app.seabed.geometry import PingGeometry

PORT, STBD = 1, 2  # XTFChannelType
LATLON_UNITS = 3   # XTFNavUnits.latlon


class XTFError(ValueError):
    pass


@dataclass
class XtfLog:
    """One ping per row at native ping spacing (across-track already reduced to the waterfall width)."""
    raw: np.ndarray                    # uint8 (pings, columns)
    times: np.ndarray                  # UTC epoch seconds per ping
    heading: np.ndarray                # degrees true
    pitch: np.ndarray                  # degrees, bow up positive
    roll: np.ndarray                   # degrees, starboard down positive
    heave: np.ndarray                  # metres
    speed_mps: np.ndarray | None       # logged speed over ground
    altitude: np.ndarray | None        # sonar height above the seabed (m)
    sensor_depth: np.ndarray | None    # sonar depth below the surface (m)
    lat: np.ndarray | None             # per ping, only when the log has lat/lon
    lon: np.ndarray | None
    across_m_per_px: float | None      # slant range metres per column of `raw`
    nadir_col: float                   # column of the nadir in `raw`
    row_of_ping: np.ndarray            # row of every ping in the default (square-pixel) waterfall

    @property
    def n(self) -> int:
        return self.raw.shape[0]

    def has_motion(self) -> bool:
        return bool(np.ptp(self.pitch) > 1e-3 or np.ptp(self.roll) > 1e-3 or np.ptp(self.heave) > 1e-4)


def _channel_matrix(pings, idx: int, port: bool) -> np.ndarray:
    n = max(p.data[idx].shape[0] for p in pings)
    out = np.zeros((len(pings), n), np.float32)
    for i, p in enumerate(pings):
        d = p.data[idx].astype(np.float32)
        # Port samples are stored far -> near, so they are right-aligned against the nadir.
        if port:
            out[i, n - len(d):] = d
        else:
            out[i, :len(d)] = d
    return out


def _along_without_latlon(pings, fh, times: np.ndarray) -> tuple[float | None, str]:
    """Metres per ping from projected coordinates (NavUnits = metres) or the logged speed."""
    if fh.NavUnits != LATLON_UNITS:
        x = np.array([p.SensorXcoordinate for p in pings], np.float64)
        y = np.array([p.SensorYcoordinate for p in pings], np.float64)
        steps = np.hypot(np.diff(x), np.diff(y))
        if np.ptp(x) + np.ptp(y) > 1 and np.median(steps) < 50:      # metres, not garbage
            return float(np.sum(steps) / max(len(pings) - 1, 1)), "projected XTF coordinates"
    speed = np.array([p.SensorSpeed or p.SpeedLog or p.ShipSpeed for p in pings], np.float64)  # knots
    dt = np.diff(times)
    if np.median(speed) > 0.2 and len(dt) and np.median(dt) > 0:
        return float(np.median(speed) * 0.514444 * np.median(dt)), "logged speed x ping interval"
    return None, "square pixels"


def _attr(pings, name: str) -> np.ndarray:
    return np.array([float(getattr(p, name, 0.0) or 0.0) for p in pings], np.float64)


def load_xtf(data: bytes, max_width: int = 2048, max_height: int = 30000, with_geometry: bool = False,
             with_log: bool = False):
    """Returns (waterfall, track or None, info); with `with_geometry` also the per-ping PingGeometry (or None),
    with `with_log` also the XtfLog (native ping spacing + motion records)."""
    fd, path = tempfile.mkstemp(suffix=".xtf")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        try:
            fh, packets = pyxtf.xtf_read(path, types=[pyxtf.XTFHeaderType.sonar])
        except Exception as e:  # pyxtf raises RuntimeError / struct errors on corrupt files
            raise XTFError(f"Could not parse XTF file: {e}") from e
    finally:
        os.unlink(path)

    pings = [p for p in packets.get(pyxtf.XTFHeaderType.sonar, []) if p.data]
    if len(pings) < 2:
        raise XTFError("XTF file contains no side-scan sonar pings")
    pings.sort(key=lambda p: p.get_time())

    chan_types = [fh.ChanInfo[pc.ChannelNumber].TypeOfChannel if pc.ChannelNumber < 6 else -1
                  for pc in pings[0].ping_chan_headers]
    port_idx = chan_types.index(PORT) if PORT in chan_types else 0
    stbd_idx = chan_types.index(STBD) if STBD in chan_types else min(1, len(chan_types) - 1)

    port = _channel_matrix(pings, port_idx, port=True)
    stbd = _channel_matrix(pings, stbd_idx, port=False)
    raw = np.hstack([port, stbd])
    # Square-root compression: tames the amplitude dynamic range but keeps acoustic shadows and the water
    # column dark, like the display-ready imagery the models were trained on (log1p washed shadows out to grey).
    img = to_uint8(np.sqrt(raw))
    n_pings, width = img.shape
    nadir = float(port.shape[1])

    slant = np.array([p.ping_chan_headers[stbd_idx].SlantRange or p.ping_chan_headers[stbd_idx].GroundRange
                      for p in pings], np.float64)
    samples_per_side = stbd.shape[1]
    across = float(np.median(slant)) / samples_per_side if np.median(slant) > 0 else None

    # Downsample across-track to at most max_width columns.
    sx = min(1.0, max_width / width)
    if across is not None:
        across /= sx

    # Navigation from ping headers.
    lat = np.array([p.SensorYcoordinate for p in pings], np.float64)
    lon = np.array([p.SensorXcoordinate for p in pings], np.float64)
    heading = np.array([p.SensorHeading for p in pings], np.float64)
    altitude = np.array([p.SensorPrimaryAltitude for p in pings], np.float64)
    sensor_depth = np.array([p.SensorDepth for p in pings], np.float64)  # towfish / AUV depth below the surface
    if np.median(sensor_depth) < 0:                                    # some systems log depth negative-down
        sensor_depth = -sensor_depth
    has_depth = np.mean(sensor_depth > 0.05) > 0.8
    times = np.array([p.get_time() for p in pings]).astype("datetime64[ms]").astype(np.int64) / 1000.0
    valid = (np.abs(lat) > 1e-9) | (np.abs(lon) > 1e-9)
    geo_ok = fh.NavUnits == LATLON_UNITS and valid.sum() >= 2 and across is not None

    # Resample along-track so pixels are roughly square (the models were trained on square-pixel imagery).
    sy = 1.0
    track = None
    along, along_source = None, "square pixels"
    if geo_ok:
        v = np.where(valid)[0]
        length = float(np.sum(haversine_m(lat[v][:-1], lon[v][:-1], lat[v][1:], lon[v][1:])))
        along = length / max(v[-1] - v[0], 1)
        along_source = "lat/lon track"
    elif across is not None:
        along, along_source = _along_without_latlon(pings, fh, times)
    if along and across:
        sy = float(np.clip(along / across, 0.25, 8.0))
    sy = min(sy, max_height / n_pings)
    new_w, new_h = max(1, int(round(width * sx))), max(1, int(round(n_pings * sy)))
    native = img
    img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR)

    if geo_ok:
        v = np.where(valid)[0]
        has_alt = bool(np.any(altitude[v] > 0))
        # Water depth = sensor depth + altitude, when the log records a sensor depth (pressure / INS).
        water = sensor_depth[v] + altitude[v] if has_alt and has_depth else None
        track = Track(rows=v * sy, lat=lat[v], lon=lon[v], heading=heading[v], across_m_per_px=across,
                      nadir_col=nadir * sx, altitude=altitude[v] if has_alt else None,
                      slant_range=True, source="xtf_ping_headers", times=times[v], water_depth=water)

    # Per-ping geometry from the log itself, kept even without lat/lon (used by the 3D seabed model).
    geometry = None
    if across is not None:
        rows_all = np.arange(n_pings) * sy
        geometry = PingGeometry(rows=rows_all, across_m_per_px=across, nadir_col=nadir * sx,
                                along_m_per_px=along / sy if along else None, along_source=along_source,
                                altitude=altitude if np.any(altitude > 0) else None,
                                sensor_depth=sensor_depth if has_depth else None)

    info = {
        "format": "xtf",
        "sonar_name": fh.SonarName.decode(errors="ignore").strip("\x00 ") or None,
        "recording_program": fh.RecordingProgramName.decode(errors="ignore").strip("\x00 ") or None,
        "pings": n_pings,
        "samples_per_channel": {"port": int(port.shape[1]), "starboard": int(stbd.shape[1])},
        "frequency_khz": round(float(pings[0].ping_chan_headers[stbd_idx].Frequency), 1) or None,
        "slant_range_m": round(float(np.median(slant)), 2) if len(slant) else None,
        "nav_units": "latlon" if fh.NavUnits == LATLON_UNITS else "projected/unknown",
        "georeferenced": track is not None,
        "resampled_to": [new_h, new_w],
    }
    if track is None:
        info["georeference_note"] = ("Ping headers have no usable lat/lon (projected coordinates or zeros); "
                                     "supply a navigation CSV/JSON to geotag detections.")
    out = (img, track, info, geometry) if with_geometry else (img, track, info)
    if not with_log:
        return out

    speed = np.array([p.SensorSpeed or p.SpeedLog or p.ShipSpeed for p in pings], np.float64) * 0.514444
    lat_p = lon_p = None
    if fh.NavUnits == LATLON_UNITS and valid.sum() >= 2:
        v = np.where(valid)[0]
        idx = np.arange(n_pings)
        lat_p, lon_p = np.interp(idx, v, lat[v]), np.interp(idx, v, lon[v])
    log = XtfLog(
        raw=cv2.resize(native, (new_w, n_pings), interpolation=cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR),
        times=times, heading=heading, pitch=_attr(pings, "SensorPitch"), roll=_attr(pings, "SensorRoll"),
        heave=_attr(pings, "Heave"), speed_mps=speed if np.median(speed) > 0.05 else None,
        altitude=altitude if np.any(altitude > 0) else None, sensor_depth=sensor_depth if has_depth else None,
        lat=lat_p, lon=lon_p, across_m_per_px=across, nadir_col=nadir * sx,
        row_of_ping=np.arange(n_pings) * sy)                     # same convention as the track rows above
    return (*out, log)

