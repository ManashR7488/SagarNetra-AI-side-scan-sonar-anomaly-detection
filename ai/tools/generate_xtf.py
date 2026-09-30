"""Generate a synthetic side-scan sonar survey campaign as XTF files with full ground truth.

Seven survey areas off the Indian coast x 8 lawnmower lines = 56 XTF files (see sonar_sim/campaign.py).
Each file carries per-ping navigation (towfish + ship GPS, layback), depth / altitude / tide, attitude,
CTD sound speed, gain and range settings, plus MRU attitude, 1 Hz raw GPS and notes packets.

Output (default <project>/data/synthetic_xtf):
  <AREA>/<LINE>.xtf              raw log
  <AREA>/<LINE>_labels.json      objects imaged by this line: class, true lat/lon, side, range, ping/sample
                                 extents and pixel boxes in the waterfall as the AI service reads it
  <AREA>/<LINE>_labels.txt       same boxes in YOLO format (class cx cy w h, normalised)
  <AREA>/<LINE>_nav.csv          recorded navigation (2 Hz)
  <AREA>/area_groundtruth.json   every object in the area and which lines image it
  previews/<LINE>.jpg            small waterfall preview;  contact_sheet.jpg
  manifest.csv                   one row per file

Usage (from ai/):  .venv/Scripts/python tools/generate_xtf.py [--out ../data/synthetic_xtf] [--areas CHN,KOC] [--workers 4]
"""

import argparse
import csv
import json
import math
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sonar_sim.campaign import CLASSES, areas, build_area  # noqa: E402
from sonar_sim.sonar import apply_dropouts, render_channel, simulate_navigation  # noqa: E402
from sonar_sim.world import LocalFrame, Seabed  # noqa: E402
from sonar_sim.xtf_io import write_xtf  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[2]
KNOT = 0.514444


def _line_rng(line_id):
    return np.random.default_rng(sum((i + 1) * ord(c) for i, c in enumerate(line_id)) * 104729)


def generate_line(area_idx: int, line_idx: int, out_dir: str):
    from app.readers.xtf import load_xtf  # AI service reader: defines the pixel frame of the labels

    area = areas()[area_idx]
    prof, objects, lines, extent = build_area(area)
    seabed = Seabed(area["seabed"], extent, seed=sum(map(ord, area["code"])))
    frame = LocalFrame(area["lat0"], area["lon0"])
    line = lines[line_idx]
    rng = _line_rng(line.id)
    nav = simulate_navigation(line, prof, seabed, rng)
    P = nav["P"]

    channels, hits = [], {}
    for k, ch in enumerate(prof.channels):
        sides = {}
        for side in (-1, 1):
            data, _, h = render_channel(ch, side, nav, seabed, objects, line.conditions, rng, record=(k == 0))
            sides[side] = data
            for oid, (rows, cols) in h.items():
                hits.setdefault(oid, {})[side] = (rows, cols)
        channels.append((ch, sides[-1], sides[1]))
    dropouts = apply_dropouts([a for _, p, s in channels for a in (p, s)], P, line.conditions.get("dropouts", 0), rng)

    gain_codes = np.full(P, 128, dtype=int)
    if line.conditions.get("gain_change"):
        frac, factor = line.conditions["gain_change"]
        gain_codes[int(P * frac):] = int(np.clip(128 + 60 * math.log2(factor), 0, 255))

    area_dir = Path(out_dir) / area["code"]
    area_dir.mkdir(parents=True, exist_ok=True)
    xtf_path = area_dir / f"{line.id}.xtf"
    rec = frame.to_latlon(nav["rec_E"], nav["rec_N"])
    rec_ship = frame.to_latlon(nav["rec_ship_E"], nav["rec_ship_N"])
    write_xtf(xtf_path, prof, line, nav, rec, rec_ship, channels, {"name": area["name"], **area["conditions"]}, gain_codes)

    # ---- labels in the pixel frame of the waterfall the AI service builds from this file
    img, _, info = load_xtf(xtf_path.read_bytes())
    H_img, W_img = img.shape
    n = prof.channels[0].samples
    sy, sx = H_img / P, W_img / (2 * n)
    by_id = {o.id: o for o in objects}
    labels, yolo = [], []
    for oid, per_side in hits.items():
        o = by_id[oid]
        lat, lon = frame.to_latlon(o.e, o.n)
        for side, (rows, cols) in per_side.items():
            if len(rows) < 3:
                continue
            p0, p1, k0, k1 = int(rows.min()), int(rows.max()), int(cols.min()), int(cols.max())
            c0, c1 = (n - 1 - k1, n - 1 - k0) if side < 0 else (n + k0, n + k1)
            box = [max(0.0, c0 * sx - 1), max(0.0, p0 * sy - 1),
                   min(W_img - 1.0, (c1 + 1) * sx + 1), min(H_img - 1.0, (p1 + 1) * sy + 1)]
            i_mid = (p0 + p1) // 2
            hd = math.radians(nav["heading"][i_mid])
            across = (o.e - nav["E"][i_mid]) * math.cos(hd) - (o.n - nav["N"][i_mid]) * math.sin(hd)
            entry = {
                "object_id": oid, "kind": o.kind, "class": o.label, "man_made": o.man_made, "notes": o.notes,
                "latitude": round(float(lat), 7), "longitude": round(float(lon), 7),
                "water_depth_m": round(float(seabed.depth(o.e, o.n)), 2),
                "size_m": {"length": round(o.length, 2), "width": round(o.width, 2), "height": round(o.height, 2)},
                "azimuth_deg": round(o.azimuth, 1),
                "side": "starboard" if side > 0 else "port",
                "ground_range_m": round(abs(float(across)), 2),
                "pings": [p0, p1], "samples": [k0, k1], "visible_samples": int(len(rows)),
                "bbox_px": [round(v, 1) for v in box],
                "time_utc": nav["times"][i_mid].isoformat(),
            }
            if o.kind == "fish_school":
                entry["school_height_above_seabed_m"] = round(o.school_z, 1)
            labels.append(entry)
            if o.label in CLASSES:
                cx, cy = (box[0] + box[2]) / 2 / W_img, (box[1] + box[3]) / 2 / H_img
                w, h = (box[2] - box[0]) / W_img, (box[3] - box[1]) / H_img
                yolo.append(f"{CLASSES.index(o.label)} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")

    sv = nav
    meta = {
        "file": f"{area['code']}/{line.id}.xtf", "area": area["code"], "area_name": area["name"], "line": line.id,
        "synthetic": True,
        "sonar": {"name": prof.name, "description": prof.description, "platform": prof.platform,
                  "channels": [{"frequency_khz": c.freq_khz, "slant_range_m": c.range_m, "samples_per_side": c.samples,
                                "horizontal_beam_deg": c.beam_h_deg, "vertical_beam_deg": c.beam_v_deg,
                                "tilt_deg": c.tilt_deg} for c in prof.channels]},
        "survey": {
            "pings": P, "ping_rate_hz": round(sv["rate"], 2), "duration_s": round(float(sv["t"][-1]), 1),
            "start_time": sv["times"][0].isoformat(), "end_time": sv["times"][-1].isoformat(),
            "start": {"latitude": round(float(rec[0][0]), 7), "longitude": round(float(rec[1][0]), 7)},
            "end": {"latitude": round(float(rec[0][-1]), 7), "longitude": round(float(rec[1][-1]), 7)},
            "course_deg": line.course_deg, "speed_kn": round(float(np.mean(sv["speed"]) / KNOT), 2),
            "water_depth_m": [round(float(sv["water_depth"].min()), 2), round(float(sv["water_depth"].max()), 2)],
            "towfish_depth_m_mean": round(float(sv["fish_depth"].mean()), 2),
            "altitude_m_mean": round(float(sv["altitude"].mean()), 2),
            "layback_m_mean": round(float(sv["layback"].mean()), 2),
            "sound_speed_mps_mean": round(float(sv["sound_speed"].mean()), 1),
            "water_temp_c_mean": round(float(sv["temp"].mean()), 2),
            "recorded_position_error_m_mean": round(float(np.mean(np.hypot(sv["rec_E"] - sv["E"], sv["rec_N"] - sv["N"]))), 2),
        },
        "conditions": {k: v for k, v in line.conditions.items() if k != "calibration"},
        "dropouts": dropouts,
        "waterfall_px": [H_img, W_img],
        "georeferenced_by_ai_reader": info["georeferenced"],
        "objects": labels,
    }
    (area_dir / f"{line.id}_labels.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    (area_dir / f"{line.id}_labels.txt").write_text("\n".join(yolo) + ("\n" if yolo else ""), encoding="utf-8")

    with open(area_dir / f"{line.id}_nav.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["ping", "time_utc", "latitude", "longitude", "ship_latitude", "ship_longitude", "heading", "speed_kn",
                    "water_depth", "towfish_depth", "altitude", "layback", "pitch", "roll", "heave", "tide"])
        for i in range(0, P, max(1, int(round(sv["rate"] / 2)))):
            w.writerow([100000 + i, sv["times"][i].isoformat(), f"{rec[0][i]:.7f}", f"{rec[1][i]:.7f}",
                        f"{rec_ship[0][i]:.7f}", f"{rec_ship[1][i]:.7f}", f"{sv['heading'][i]:.2f}",
                        f"{sv['speed'][i] / KNOT:.2f}", f"{sv['water_depth'][i]:.2f}", f"{sv['fish_depth'][i]:.2f}",
                        f"{sv['altitude'][i]:.2f}", f"{sv['layback'][i]:.1f}", f"{sv['pitch'][i]:.2f}",
                        f"{sv['roll'][i]:.2f}", f"{sv['heave'][i]:.2f}", f"{sv['tide'][i]:.2f}"])

    prev_dir = Path(out_dir) / "previews"
    prev_dir.mkdir(exist_ok=True)
    prev = cv2.resize(img, (480, max(1, int(H_img * 480 / W_img))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(prev_dir / f"{line.id}.jpg"), prev, [cv2.IMWRITE_JPEG_QUALITY, 85])

    counts = {}
    for lab in labels:
        counts[lab["class"] or "natural"] = counts.get(lab["class"] or "natural", 0) + 1
    s = meta["survey"]
    row = {
        "file": meta["file"], "area": area["code"], "area_name": area["name"], "line": line.id,
        "sonar": prof.name, "platform": prof.platform,
        "frequencies_khz": "/".join(str(c.freq_khz) for c in prof.channels),
        "slant_range_m": "/".join(str(int(c.range_m)) for c in prof.channels),
        "pings": P, "duration_s": s["duration_s"], "start_time_utc": s["start_time"], "end_time_utc": s["end_time"],
        "start_lat": s["start"]["latitude"], "start_lon": s["start"]["longitude"],
        "end_lat": s["end"]["latitude"], "end_lon": s["end"]["longitude"], "course_deg": line.course_deg,
        "speed_kn": s["speed_kn"], "water_depth_min_m": s["water_depth_m"][0], "water_depth_max_m": s["water_depth_m"][1],
        "towfish_depth_mean_m": s["towfish_depth_m_mean"], "altitude_mean_m": s["altitude_m_mean"],
        "layback_mean_m": s["layback_m_mean"], "sound_speed_mps": s["sound_speed_mps_mean"],
        "conditions": ";".join(f"{k}={v}" for k, v in meta["conditions"].items()),
        "labelled_objects": len(labels), "by_class": json.dumps(counts),
        "size_mb": round(xtf_path.stat().st_size / 1e6, 2),
    }
    return row, [lab["object_id"] for lab in labels]


def contact_sheet(out_dir: Path, rows):
    thumbs = []
    for r in rows:
        im = cv2.imread(str(out_dir / "previews" / f"{r['line']}.jpg"), cv2.IMREAD_GRAYSCALE)
        im = cv2.cvtColor(cv2.resize(im, (160, 300), interpolation=cv2.INTER_AREA), cv2.COLOR_GRAY2BGR)
        cv2.rectangle(im, (0, 0), (160, 16), (0, 0, 0), -1)
        cv2.putText(im, r["line"], (4, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (255, 255, 255), 1, cv2.LINE_AA)
        thumbs.append(im)
    cols = 14
    while len(thumbs) % cols:
        thumbs.append(np.full_like(thumbs[0], 255))
    cv2.imwrite(str(out_dir / "contact_sheet.jpg"),
                np.vstack([np.hstack(thumbs[i:i + cols]) for i in range(0, len(thumbs), cols)]),
                [cv2.IMWRITE_JPEG_QUALITY, 85])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=PROJECT_ROOT / "data" / "synthetic_xtf")
    ap.add_argument("--areas", default="all", help="comma-separated area codes (CHN,VIZ,KOC,MUM,AND,GOA,MAN) or 'all'")
    ap.add_argument("--lines", type=int, default=0, help="limit lines per area (0 = all)")
    ap.add_argument("--workers", type=int, default=4)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    all_areas = areas()
    wanted = [i for i, a in enumerate(all_areas) if args.areas == "all" or a["code"] in args.areas.split(",")]
    jobs = [(i, j) for i in wanted for j in range(args.lines or all_areas[i]["n_lines"])]
    t0 = time.time()
    rows, imaged = [], {}
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        futs = {ex.submit(generate_line, i, j, str(args.out)): (i, j) for i, j in jobs}
        for k, fut in enumerate(as_completed(futs), 1):
            row, seen = fut.result()
            rows.append(row)
            for oid in seen:
                imaged.setdefault(oid, set()).add(row["line"])
            print(f"[{k}/{len(jobs)}] {row['file']}  {row['pings']} pings  {row['size_mb']} MB  "
                  f"labels={row['labelled_objects']}  ({time.time() - t0:.0f}s)", flush=True)

    rows.sort(key=lambda r: r["file"])
    with open(args.out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    for i in wanted:
        area = all_areas[i]
        prof, objects, lines, _ = build_area(area)
        frame = LocalFrame(area["lat0"], area["lon0"])
        objs = []
        for o in objects:
            lat, lon = frame.to_latlon(o.e, o.n)
            objs.append({"object_id": o.id, "kind": o.kind, "class": o.label, "man_made": o.man_made, "notes": o.notes,
                         "latitude": round(float(lat), 7), "longitude": round(float(lon), 7),
                         "size_m": {"length": round(o.length, 2), "width": round(o.width, 2), "height": round(o.height, 2)},
                         "azimuth_deg": round(o.azimuth, 1), "imaged_by_lines": sorted(imaged.get(o.id, []))})
        (args.out / area["code"] / "area_groundtruth.json").write_text(json.dumps({
            "area": area["code"], "name": area["name"], "origin": {"latitude": area["lat0"], "longitude": area["lon0"]},
            "sonar_profile": prof.name, "survey_lines": [l.id for l in lines], "seabed": area["seabed"].__dict__,
            "synthetic": True, "objects": objs}, indent=2, default=str), encoding="utf-8")

    contact_sheet(args.out, rows)
    print(f"done: {len(rows)} files, {sum(r['size_mb'] for r in rows):.0f} MB in {time.time() - t0:.0f}s -> {args.out}")


if __name__ == "__main__":
    main()
