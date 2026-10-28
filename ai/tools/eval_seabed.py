"""Score the 3D seabed model on the synthetic XTF campaign (data/synthetic_xtf, made by generate_xtf.py).

Uses the labelled object boxes (not detector output), so it measures the geometry alone:
  * target height: shadow-length height vs the true object height (size_m.height) of every labelled object
  * water depth: model depth along the track vs the recorded water depth in <line>_nav.csv
  * altitude: bottom-tracked altitude (from the image alone) vs the logged altitude
  * relief: RMS / max of the estimated shading relief
Each line is scored twice: as the XTF log (navigation + altitude, checked against the image) and as a plain image
(no navigation, no altitude: only the swath width is known), the situation of most real sonar images.

Usage (from ai/):  .venv/Scripts/python tools/eval_seabed.py [--data ../data/synthetic_xtf] [--per-area 2] [--out FILE]
"""

import argparse
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.readers.xtf import load_xtf  # noqa: E402
from app.seabed.bottom import track_bottom  # noqa: E402
from app.seabed.geometry import SwathGeometry, refine_track  # noqa: E402
from app.seabed.model import build_seabed  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[2]
SKIP_KINDS = {"fish_school"}          # in the water column: no seabed shadow


def evaluate_file(path: Path, image_only: bool = False) -> dict:
    img, track, _, ping = load_xtf(path.read_bytes(), with_geometry=True)
    swath = 2 * track.nadir_col * track.across_m_per_px
    log_alt = np.interp(np.arange(img.shape[0]), track.rows, track.altitude)
    bottom = track_bottom(img, None if image_only else track.nadir_col)
    labels = json.loads(path.with_name(path.stem + "_labels.json").read_text())
    dets = []
    for i, o in enumerate(labels["objects"]):
        if o["kind"] in SKIP_KINDS or not o.get("bbox_px"):
            continue
        x1, y1, x2, y2 = o["bbox_px"]
        dets.append({"id": f"GT-{i:03d}", "class_name": o["class"], "status": "confirmed",
                     "bbox": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}, "polygons": [],
                     "centroid_px": {"x": (x1 + x2) / 2, "y": (y1 + y2) / 2},
                     "_true": o["size_m"]["height"], "_kind": o["kind"], "_range": o.get("ground_range_m")})
    if image_only:   # what a plain image upload gives the service: pixels + the swath width
        sb = build_seabed(img, None, dets, bottom=bottom, swath_width_m=swath)
    else:
        refined, choice = refine_track(track, bottom, img.shape[0])
        sb = build_seabed(img, refined, dets, bottom=bottom, altitude_choice=choice)
    alt_err = None if bottom is None else float(np.median(np.abs(bottom.altitude_px * track.across_m_per_px - log_alt)))

    depth_err = None
    nav = path.with_name(path.stem + "_nav.csv")
    if sb["kind"] == "measured" and nav.exists() and track is not None:
        geom = SwathGeometry.build(*img.shape, track)
        rows = list(csv.DictReader(nav.open()))
        true = np.array([float(r["water_depth"]) for r in rows])
        model = geom.water_depth_at(np.linspace(0, img.shape[0] - 1, len(true)))  # nav CSV spans the whole line
        depth_err = np.abs(model - true)

    targets = [{"kind": d["_kind"], "true_m": d["_true"], "est_m": d["height"]["height_m"], "range_m": d["_range"]}
               for d in dets]
    return {"file": str(path.relative_to(path.parents[1])).replace("\\", "/"), "kind": sb["kind"],
            "altitude_source": sb["altitude"]["source"],
            "bottom_track_altitude_err_m": None if alt_err is None else round(alt_err, 3),
            "relief_rms_m": sb["relief"]["rms_m"],
            "depth_abs_err_m": None if depth_err is None else round(float(np.median(depth_err)), 3),
            "targets": targets}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=str(PROJECT_ROOT / "data" / "synthetic_xtf"))
    ap.add_argument("--per-area", type=int, default=2)
    ap.add_argument("--out", default=None, help="write the JSON report here")
    args = ap.parse_args()

    files = []
    for area in sorted(p for p in Path(args.data).iterdir() if p.is_dir() and p.name != "previews"):
        files += sorted(area.glob("*.xtf"))[: args.per_area]

    report = {}
    for mode in ("xtf", "image_only"):
        results, rel_err, abs_err, by_kind = [], [], [], defaultdict(list)
        measured = missing = 0
        for f in files:
            r = evaluate_file(f, image_only=mode == "image_only")
            results.append(r)
            for t in r["targets"]:
                if t["est_m"] is None:
                    missing += 1
                    continue
                measured += 1
                abs_err.append(abs(t["est_m"] - t["true_m"]))
                if t["true_m"] >= 0.2:
                    rel_err.append((t["est_m"] - t["true_m"]) / t["true_m"])
                by_kind[t["kind"]].append((t["est_m"], t["true_m"]))
            print(f'[{mode}] {r["file"]:22s} altitude {r["altitude_source"]:12s} (bottom-track err '
                  f'{r["bottom_track_altitude_err_m"]} m), depth err {r["depth_abs_err_m"]} m, '
                  f'heights {sum(t["est_m"] is not None for t in r["targets"])}/{len(r["targets"])}', flush=True)
        alt_errs = [r["bottom_track_altitude_err_m"] for r in results if r["bottom_track_altitude_err_m"] is not None]
        depth_errs = [r["depth_abs_err_m"] for r in results if r["depth_abs_err_m"] is not None]
        report[mode] = {
            "files": len(results),
            "targets": measured + missing,
            "height_measured": measured,
            "height_coverage": round(measured / max(measured + missing, 1), 3),
            "height_abs_error_m": {"median": round(float(np.median(abs_err)), 3),
                                   "p90": round(float(np.percentile(abs_err, 90)), 3)} if abs_err else None,
            "height_rel_error": {"median": round(float(np.median(rel_err)), 3),
                                 "median_abs": round(float(np.median(np.abs(rel_err))), 3)} if rel_err else None,
            "bottom_track_altitude_error_m_median": round(float(np.median(alt_errs)), 3) if alt_errs else None,
            "bottom_track_found": f"{len(alt_errs)}/{len(results)}",
            "depth_abs_error_m_median": round(float(np.median(depth_errs)), 3) if depth_errs else None,
            "by_kind": {k: {"n": len(v), "median_est_m": round(float(np.median([e for e, _ in v])), 2),
                            "median_true_m": round(float(np.median([t for _, t in v])), 2)}
                        for k, v in sorted(by_kind.items())},
        }
        report[mode + "_files"] = results
    summary = {k: v for k, v in report.items() if not k.endswith("_files")}
    print(json.dumps(summary, indent=2))
    if args.out:
        Path(args.out).write_text(json.dumps({"summary": summary, "files": {m: report[m + "_files"] for m in summary}},
                                             indent=1))


if __name__ == "__main__":
    main()
