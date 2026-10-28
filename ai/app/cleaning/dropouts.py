"""Bad pings: data dropouts, duplicated pings, time gaps and motion-limit violations.

Side-scan images are built ping by ping (rows = pings). Vehicle heave / pitch / roll, cable snatch and acoustic
interference produce:
  blank      the whole ping lost (near-black or flat row)
  partial    one channel (port or starboard) lost while the other is fine
  duplicate  the logger repeated the previous ping (identical row: impossible with real speckle)
  gap        (XTF) missing pings: a ping interval much longer than usual
  motion     (XTF) attitude outside survey limits: the ping is valid but geometrically / radiometrically distorted
Blank, partial and duplicate pings are repaired by interpolating the nearest good pings (per side for partial ones);
gaps and motion-flagged pings are kept and reported, and detections on them are flagged (data quality).
"""

from dataclasses import dataclass, field

import numpy as np


@dataclass
class MotionLimits:
    pitch_deg: float = 5.0
    roll_deg: float = 6.0            # deviation from the line's median roll
    yaw_rate_dps: float = 4.0        # heading change rate
    heave_rate_mps: float = 0.6      # vertical velocity of the sonar
    gap_factor: float = 1.8          # ping interval > factor x median interval -> gap


@dataclass
class PingFlags:
    """Per-ping flags (rows of the image the step was run on)."""
    blank: np.ndarray
    partial_port: np.ndarray
    partial_stbd: np.ndarray
    duplicate: np.ndarray
    gap_before: np.ndarray                      # a time gap precedes this ping (XTF)
    motion: np.ndarray                          # any motion limit exceeded (XTF)
    motion_reasons: dict = field(default_factory=dict)   # name -> bool array
    repaired: np.ndarray | None = None
    border: np.ndarray | None = None            # black padding rows at the top / bottom edge (not dropouts)
    notes: list = field(default_factory=list)

    @property
    def bad(self) -> np.ndarray:
        return self.blank | self.partial_port | self.partial_stbd | self.duplicate

    def counts(self) -> dict:
        out = {
            "blank": int(self.blank.sum()),
            "partial": int((self.partial_port | self.partial_stbd).sum()),
            "duplicate": int(self.duplicate.sum()),
            "time_gaps": int(self.gap_before.sum()),
            "motion_flagged": int(self.motion.sum()),
            "repaired": int(self.repaired.sum()) if self.repaired is not None else 0,
            "border_rows": int(self.border.sum()) if self.border is not None else 0,
        }
        if self.notes:
            out["notes"] = list(self.notes)
        out["motion_by_reason"] = {k: int(v.sum()) for k, v in self.motion_reasons.items()}
        return out


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """[start, end) of consecutive True runs."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0].tolist(), np.where(d == -1)[0].tolist()))


def _side_levels(gray: np.ndarray, nadir: float) -> tuple[np.ndarray, np.ndarray]:
    """Mean of the outer 70 % of each side per row (the inner part holds the dark water column)."""
    h, w = gray.shape
    c = int(round(np.clip(nadir, 1, w - 1)))
    port = gray[:, : max(1, int(0.7 * c))]
    stbd = gray[:, min(w - 1, c + int(0.3 * (w - c))):]
    return port.mean(axis=1), stbd.mean(axis=1)


def find_bad_pings(gray: np.ndarray, nadir: float | None = None) -> PingFlags:
    h, w = gray.shape
    f = gray.astype(np.float32)
    row_mean = f.mean(axis=1)
    row_std = f.std(axis=1)
    ref = float(np.median(row_mean))
    zeros = np.zeros(h, bool)
    if ref < 5:  # essentially dark image: nothing reliable to compare against
        return PingFlags(zeros.copy(), zeros.copy(), zeros.copy(), zeros.copy(), zeros.copy(), zeros.copy(),
                         border=zeros.copy())
    # Lost data sits at the noise floor (a few grey levels); large acoustic shadows and mud are dark but textured
    # (tens of grey levels), so the thresholds are well below any real seabed.
    blank = (row_mean < 0.08 * ref) | (row_std < 1.0)

    nadir = w / 2 if nadir is None else nadir
    lp, ls = _side_levels(f, nadir)
    rp, rs = float(np.median(lp)), float(np.median(ls))
    partial_port = (lp < 0.05 * max(rp, 1.0)) & (ls >= 0.4 * rs) & ~blank if rp > 5 else zeros.copy()
    partial_stbd = (ls < 0.05 * max(rs, 1.0)) & (lp >= 0.4 * rp) & ~blank if rs > 5 else zeros.copy()

    # Black runs touching the top / bottom edge are padding (letterboxed screenshots), not lost pings.
    border = zeros.copy()
    for a, b in runs(blank):
        if a == 0 or b == h:
            border[a:b] = True
    blank &= ~border
    notes = []

    # Identical consecutive rows (mean absolute difference below half a grey level) are repeated pings. When many
    # rows repeat, the image was enlarged along-track (rows duplicated by resizing): that is not a logging fault.
    diff = np.zeros(h, np.float32)
    diff[1:] = np.abs(f[1:] - f[:-1]).mean(axis=1)
    duplicate = np.zeros(h, bool)
    duplicate[1:] = (diff[1:] < 0.5) & ~blank[1:] & ~blank[:-1] & ~border[1:] & ~border[:-1]
    if duplicate.mean() > 0.02:
        notes.append(f"{int(duplicate.sum())} repeated rows: the image was enlarged along-track (not logging faults)")
        duplicate[:] = False
    if border.any():
        notes.append(f"{int(border.sum())} black padding rows at the image edge ignored")
    return PingFlags(blank, partial_port, partial_stbd, duplicate, zeros.copy(), zeros.copy(), border=border, notes=notes)


def flag_log_pings(flags: PingFlags, times: np.ndarray | None, pitch=None, roll=None, heading=None, heave=None,
                   limits: MotionLimits | None = None) -> PingFlags:
    """Add XTF time gaps and motion-limit violations to `flags` (in place, same rows as the log)."""
    limits = limits or MotionLimits()
    n = len(flags.blank)
    rate = 1.0                                    # pings per second
    if times is not None and len(times) == n and n > 2:
        dt = np.diff(times)
        med = float(np.median(dt[dt > 0])) if np.any(dt > 0) else 0.0
        if med > 0:
            flags.gap_before[1:] = dt > limits.gap_factor * med
            rate = 1.0 / med
    reasons = {}
    if pitch is not None and np.ptp(pitch) > 1e-6:
        reasons["pitch"] = np.abs(pitch) > limits.pitch_deg
    if roll is not None and np.ptp(roll) > 1e-6:
        reasons["roll"] = np.abs(roll - np.median(roll)) > limits.roll_deg
    if heading is not None and np.ptp(heading) > 1e-6 and n > 2:
        unwrapped = np.degrees(np.unwrap(np.radians(heading)))
        yaw_rate = np.abs(np.gradient(unwrapped)) * rate
        reasons["yaw_rate"] = yaw_rate > limits.yaw_rate_dps
    if heave is not None and np.ptp(heave) > 1e-6 and n > 2:
        reasons["heave_rate"] = np.abs(np.gradient(heave)) * rate > limits.heave_rate_mps
    flags.motion_reasons = reasons
    motion = np.zeros(n, bool)
    for v in reasons.values():
        motion |= v
    flags.motion = motion
    return flags


def repair_pings(gray: np.ndarray, flags: PingFlags, nadir: float | None, max_gap: int = 40) -> np.ndarray:
    """Interpolate bad pings from the nearest good pings above and below (partial pings: only the lost side)."""
    h, w = gray.shape
    out = gray.astype(np.float32)
    repaired = np.zeros(h, bool)
    c = int(round(np.clip(w / 2 if nadir is None else nadir, 1, w - 1)))
    whole = flags.blank | flags.duplicate
    for cols, bad, good in (
        (slice(0, w), whole, ~(whole | flags.partial_port | flags.partial_stbd)),
        (slice(0, c), flags.partial_port & ~whole, ~(whole | flags.partial_port)),
        (slice(c, w), flags.partial_stbd & ~whole, ~(whole | flags.partial_stbd)),
    ):
        for start, end in runs(bad):
            if end - start > max_gap:
                continue
            above, below = start - 1, end
            while above >= 0 and not good[above]:
                above -= 1
            while below < h and not good[below]:
                below += 1
            if above < 0 and below >= h:
                continue
            if above < 0:
                out[start:end, cols] = out[below, cols]
            elif below >= h:
                out[start:end, cols] = out[above, cols]
            else:
                t = ((np.arange(start, end) - above) / (below - above))[:, None]
                out[start:end, cols] = (1 - t) * out[above, cols] + t * out[below, cols]
            repaired[start:end] = True
    flags.repaired = repaired
    return np.clip(out, 0, 255).astype(np.uint8)
