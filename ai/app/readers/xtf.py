"""Read raw side-scan sonar logs in XTF (eXtended Triton Format).

Builds a waterfall image (rows = pings in time order, columns = port far->near | starboard near->far)
and a navigation Track from the per-ping headers (sensor lat/lon, heading, altitude, slant range, time).
"""

import os
import tempfile

import cv2
import numpy as np
import pyxtf

from app.geo.geotagging import Track, haversine_m
from app.readers.image import to_uint8

PORT, STBD = 1, 2  # XTFChannelType
LATLON_UNITS = 3   # XTFNavUnits.latlon


class XTFError(ValueError):
    pass


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


def load_xtf(data: bytes, max_width: int = 2048, max_height: int = 30000) -> tuple[np.ndarray, Track | None, dict]:
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
    times = np.array([p.get_time() for p in pings]).astype("datetime64[ms]").astype(np.int64) / 1000.0
    valid = (np.abs(lat) > 1e-9) | (np.abs(lon) > 1e-9)
    geo_ok = fh.NavUnits == LATLON_UNITS and valid.sum() >= 2 and across is not None

    # Resample along-track so pixels are roughly square (the models were trained on square-pixel imagery).
    sy = 1.0
    track = None
    if geo_ok:
        v = np.where(valid)[0]
        length = float(np.sum(haversine_m(lat[v][:-1], lon[v][:-1], lat[v][1:], lon[v][1:])))
        along = length / max(v[-1] - v[0], 1)
        if along > 0:
            sy = float(np.clip(along / across, 0.25, 8.0))
    sy = min(sy, max_height / n_pings)
    new_w, new_h = max(1, int(round(width * sx))), max(1, int(round(n_pings * sy)))
    img = cv2.resize(img, (new_w, new_h), interpolation=cv2.INTER_AREA if sx < 1 else cv2.INTER_LINEAR)

    if geo_ok:
        v = np.where(valid)[0]
        track = Track(rows=v * sy, lat=lat[v], lon=lon[v], heading=heading[v], across_m_per_px=across,
                      nadir_col=nadir * sx, altitude=altitude[v] if np.any(altitude[v] > 0) else None,
                      slant_range=True, source="xtf_ping_headers", times=times[v])

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
    return img, track, info

