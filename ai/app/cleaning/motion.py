"""Motion compensation for XTF logs: place every ping sample where it really was on the seabed (along-track).

A waterfall assumes the vehicle moved forward by the same distance between pings and pointed along its track.
Real platforms do not:
  * speed changes and stops stretch or squash objects along-track
    -> rows are resampled by distance travelled (from the navigation), not by ping count;
  * yaw / crab (heading differs from the direction of travel by psi) rotates the beam: a sample at ground range u
    lies u*sin(psi) behind (starboard) or ahead of (port) the vehicle;
  * pitch (theta, bow up) tilts the fan forward: the footprint moves H*tan(theta) ahead (H = altitude);
  * heave changes the altitude; the per-ping altitude is what the slant-to-ground correction uses later.
The along-track position of sample k of ping i is  s_i + H_i*tan(theta_i) - side_k * u_k,i * sin(psi_i);  each output
row (uniform along-track spacing) takes, per column, the ping that imaged that position.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from app.geo.geotagging import EARTH_RADIUS_M
from app.readers.xtf import XtfLog


@dataclass
class MotionResult:
    image: np.ndarray
    row_of_ping: np.ndarray          # output row of every ping (vehicle position)
    course: np.ndarray               # direction of travel per ping (deg): beams are perpendicular to it now
    along_m_per_px: float
    gap_rows: np.ndarray             # bool per output row: interpolated across a time gap
    stats: dict


def _gauss1d(v: np.ndarray, sigma: float) -> np.ndarray:
    if sigma < 0.5 or len(v) < 3:
        return v.astype(np.float64)
    k = int(3 * sigma) * 2 + 1
    return cv2.GaussianBlur(v.astype(np.float64).reshape(-1, 1), (1, k), sigma, borderType=cv2.BORDER_REPLICATE).ravel()


def _windowed_slope(t: np.ndarray, v: np.ndarray, half_window: float) -> np.ndarray:
    """Slope of a least-squares line through (t, v) within +-half_window of every sample (local linear fit: no
    bias at the ends of a line, unlike a smoothing kernel with padding)."""
    lo = np.searchsorted(t, t - half_window, side="left")
    hi = np.searchsorted(t, t + half_window, side="right")
    c1 = np.concatenate([[0.0], np.cumsum(t)])
    c2 = np.concatenate([[0.0], np.cumsum(t * t)])
    cv = np.concatenate([[0.0], np.cumsum(v)])
    ctv = np.concatenate([[0.0], np.cumsum(t * v)])
    n = (hi - lo).astype(np.float64)
    st, stt, sv, stv = c1[hi] - c1[lo], c2[hi] - c2[lo], cv[hi] - cv[lo], ctv[hi] - ctv[lo]
    den = n * stt - st * st
    return np.where(den > 1e-12, (n * stv - st * sv) / np.where(den > 1e-12, den, 1.0), 0.0)


def along_track(log: XtfLog) -> tuple[np.ndarray | None, np.ndarray | None, str]:
    """(s, course) per ping: along-track distance (m, monotonic) and direction of travel (deg), with the source.

    Logged positions jitter by a metre or more (GPS, layback estimate) while consecutive pings are centimetres apart:
      * the course is taken from positions smoothed over ~20 s (a vehicle's direction of travel changes slowly; over
        a 2 s window a 1 m position wiggle would already swing it by >10 degrees);
      * the distance travelled follows the logged speed when there is one (smooth, measured), scaled to the length
        of the smoothed position track; otherwise the smoothed positions themselves."""
    n = log.n
    rate = 1.0 / max(float(np.median(np.diff(log.times))), 1e-3) if n > 2 else 1.0
    dt = np.diff(log.times, prepend=log.times[0])
    dt[0] = 0.0
    dt = np.maximum(dt, 0.0)
    s_speed = None
    if log.speed_mps is not None and np.median(log.speed_mps) > 0.05:
        s_speed = np.cumsum(np.maximum(_gauss1d(log.speed_mps, 2.0 * rate), 0.0) * dt)
    if log.lat is not None and np.ptp(log.lat) + np.ptp(log.lon) > 1e-9:
        lat0 = float(np.radians(np.mean(log.lat)))
        x = np.radians(log.lon - log.lon[0]) * EARTH_RADIUS_M * np.cos(lat0)
        y = np.radians(log.lat - log.lat[0]) * EARTH_RADIUS_M
        tt = log.times - log.times[0]
        # speed over ground from short local line fits (+-2.5 s; unbiased at the ends of the line, unlike a
        # smoothing kernel with padded edges, which flattens the track there and shortens it)
        speed_pos = np.hypot(_windowed_slope(tt, x, 2.5), _windowed_slope(tt, y, 2.5))
        s_pos = np.cumsum(speed_pos * dt)
        vx, vy = _windowed_slope(tt, x, 15.0), _windowed_slope(tt, y, 15.0)
        # near the ends of the line the window is one-sided and drifts: hold the last full-window estimate
        full = (tt >= 15.0) & (tt <= tt[-1] - 15.0)
        if full.sum() > 2:
            first, last = np.argmax(full), len(full) - 1 - np.argmax(full[::-1])
            vx[:first], vy[:first] = vx[first], vy[first]
            vx[last + 1:], vy[last + 1:] = vx[last], vy[last]
        course = (np.degrees(np.arctan2(vx, vy)) + 360) % 360
        moving = np.hypot(vx, vy) > 1e-4
        if not moving.all() and moving.any():  # stationary pings: keep the last direction of travel
            idx = np.where(moving)[0]
            course = np.interp(np.arange(n), idx, np.degrees(np.unwrap(np.radians(course[idx])))) % 360
        if s_pos[-1] > 1.0:
            if s_speed is not None and s_speed[-1] > 1.0 and 0.75 < s_pos[-1] / s_speed[-1] < 1.33:
                return s_speed * (s_pos[-1] / s_speed[-1]), course, "logged speed, scaled to the lat/lon track length"
            return s_pos, course, "smoothed lat/lon track"
    if s_speed is not None and s_speed[-1] > 1.0:
        hdg = np.degrees(np.unwrap(np.radians(log.heading)))
        return s_speed, _gauss1d(hdg, max(5.0, 20.0 * rate)) % 360, "logged speed x ping time"
    return None, None, "unknown"


def compensate(raw: np.ndarray, log: XtfLog, along_m_per_px: float | None = None,
               max_rows: int = 30000) -> MotionResult | None:
    """Resample `raw` (pings x columns, slant range) onto a uniform along-track grid with yaw/pitch offsets."""
    s, course, source = along_track(log)
    if s is None or log.across_m_per_px is None:
        return None
    n, w = raw.shape
    mpp = float(log.across_m_per_px)
    dy = float(along_m_per_px or mpp)                  # square pixels by default
    length = float(s[-1] - s[0])
    rows = int(np.clip(round(length / dy) + 1, 2, max_rows))
    dy = length / max(rows - 1, 1)

    psi = np.radians(np.clip(((log.heading - course + 540) % 360) - 180, -20, 20))   # yaw / crab angle per ping
    theta = np.radians(np.clip(log.pitch, -30, 30))
    alt = log.altitude if log.altitude is not None else np.zeros(n)
    cols = np.arange(w, dtype=np.float64)
    side = np.where(cols >= log.nadir_col, 1.0, -1.0)
    r = np.abs(cols + 0.5 - log.nadir_col) * mpp                       # slant range of each column

    s_out = s[0] + np.arange(rows) * dy
    map_y = np.empty((rows, w), np.float32)
    ping_idx = np.arange(n, dtype=np.float64)
    pitch_off = alt * np.tan(theta)                                     # (n,)
    sin_psi = np.sin(psi)
    for k0 in range(0, w, 256):                                         # columns in chunks (memory)
        k1 = min(w, k0 + 256)
        u = np.sqrt(np.maximum(r[None, k0:k1] ** 2 - alt[:, None] ** 2, 0.0))        # ground range (n, c)
        pos = s[:, None] + pitch_off[:, None] - side[None, k0:k1] * u * sin_psi[:, None]
        pos = np.maximum.accumulate(pos, axis=0) + ping_idx[:, None] * 1e-9          # keep it monotonic
        for j in range(k1 - k0):
            map_y[:, k0 + j] = np.interp(s_out, pos[:, j], ping_idx)
    map_x = np.broadcast_to(cols.astype(np.float32), (rows, w)).copy()
    img = cv2.remap(raw, map_x, map_y, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

    row_of_ping = (s - s[0]) / dy
    gap_rows = np.zeros(rows, bool)
    if n > 2:
        dt = np.diff(log.times)
        med = float(np.median(dt[dt > 0])) if np.any(dt > 0) else 0.0
        if med > 0:
            for i in np.where(dt > 1.8 * med)[0]:
                a, b = int(np.floor(row_of_ping[i])), int(np.ceil(row_of_ping[i + 1]))
                gap_rows[max(0, a):min(rows, b + 1)] = True
    speed = np.gradient(s, log.times) if n > 2 else np.zeros(n)
    yaw = np.degrees(psi)
    stats = {
        "along_track_source": source,
        "track_length_m": round(length, 1),
        "along_m_per_px": round(dy, 4),
        "speed_mps": {"mean": round(float(np.mean(speed)), 3), "min": round(float(np.percentile(speed, 1)), 3),
                      "max": round(float(np.percentile(speed, 99)), 3),
                      "cv": round(float(np.std(speed) / max(np.mean(speed), 1e-6)), 3)},
        "yaw_deg": {"rms": round(float(np.sqrt(np.mean(yaw ** 2))), 2), "max_abs": round(float(np.max(np.abs(yaw))), 2)},
        "pitch_deg": {"rms": round(float(np.sqrt(np.mean(log.pitch ** 2))), 2),
                      "max_abs": round(float(np.max(np.abs(log.pitch))), 2)},
        "roll_deg": {"rms": round(float(np.sqrt(np.mean((log.roll - np.median(log.roll)) ** 2))), 2),
                     "max_abs": round(float(np.max(np.abs(log.roll))), 2)},
        "heave_m": {"range": round(float(np.ptp(log.heave)), 3)},
        # largest along-track displacement the correction applied at the swath edge (what an uncorrected
        # waterfall would have got wrong)
        "max_offset_m": round(float(np.max(np.abs(pitch_off)) + np.max(r) * float(np.max(np.abs(sin_psi)))), 2),
        "gap_rows": int(gap_rows.sum()),
    }
    return MotionResult(img, row_of_ping, course, dy, gap_rows, stats)


def default_resample(raw: np.ndarray, log: XtfLog, height: int) -> np.ndarray:
    """The reader's waterfall (one average along-track factor): used when motion compensation is off."""
    return cv2.resize(raw, (raw.shape[1], height), interpolation=cv2.INTER_LINEAR)
