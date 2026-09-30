"""Score the AI pipeline on the synthetic XTF campaign (data/synthetic_xtf, made by generate_xtf.py).

Matching is done in waterfall pixels (the labels are in the frame the AI service reads), so navigation errors
do not hide a detection; the geotag error of each match is reported separately.
  * recall per class: labelled man-made objects hit by a confirmed detection (box IoU >= 0.1 or centre inside)
  * class accuracy: matched detections whose class equals the label
  * false positives: confirmed detections matching no man-made label (split: on natural rock / on bare seabed)
  * geotag error: distance between detection lat/lon and the true object position

Usage (from ai/):  .venv/Scripts/python tools/evaluate_synthetic.py [--data ../data/synthetic_xtf] [--per-area 2]
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.geo.geotagging import haversine_m  # noqa: E402
from app.ml.registry import registry  # noqa: E402
from app.processing.pipeline import AnalyzeOptions, analyze  # noqa: E402
from app.readers.xtf import load_xtf  # noqa: E402

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def hit(det_box, gt_box, pad=15):
    cx, cy = (det_box[0] + det_box[2]) / 2, (det_box[1] + det_box[3]) / 2
    inside = gt_box[0] - pad <= cx <= gt_box[2] + pad and gt_box[1] - pad <= cy <= gt_box[3] + pad
    return inside or iou(det_box, gt_box) >= 0.1


def evaluate_file(xtf: Path, labels: dict):
    gray, track, info = load_xtf(xtf.read_bytes())
    result, _ = analyze(gray, track, AnalyzeOptions(), {"filename": xtf.name, **info})
    dets = [d for d in result["detections"] if d["status"] == "confirmed"]
    boxes = [[d["bbox"]["x1"], d["bbox"]["y1"], d["bbox"]["x2"], d["bbox"]["y2"]] for d in dets]
    targets = [o for o in labels["objects"] if o["man_made"]]
    natural = [o for o in labels["objects"] if o["class"] is None]

    used, rows = set(), []
    for t in targets:
        cand = [i for i, b in enumerate(boxes) if i not in used and hit(b, t["bbox_px"])]
        if not cand:
            rows.append({"class": t["class"], "kind": t["kind"], "found": False})
            continue
        i = max(cand, key=lambda k: dets[k]["confidence"])
        used.add(i)
        loc = dets[i]["location"]
        err = float(haversine_m(t["latitude"], t["longitude"], loc["latitude"], loc["longitude"])) if loc else None
        rows.append({"class": t["class"], "kind": t["kind"], "found": True, "pred": dets[i]["class_name"], "geo_err_m": err})

    fps = [i for i in range(len(dets)) if i not in used]
    on_rock = sum(any(hit(boxes[i], n["bbox_px"]) for n in natural) for i in fps)
    return {
        "file": labels["file"], "area": labels["area"], "ms": result["processing"]["timings"]["total_ms"],
        "targets": rows, "confirmed": len(dets), "false_positives": len(fps), "fp_on_natural_rock": on_rock,
        "fp_classes": Counter(dets[i]["class_name"] for i in fps),
        "suppressed": result["summary"]["suppressed"],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=PROJECT_ROOT / "data" / "synthetic_xtf")
    ap.add_argument("--per-area", type=int, default=0, help="evaluate only the first N lines of each area (0 = all)")
    args = ap.parse_args()
    registry.load()

    files = sorted(args.data.glob("*/*_labels.json"))
    if args.per_area:
        by_area = defaultdict(list)
        for f in files:
            by_area[f.parent.name].append(f)
        # middle lines of each area image the most objects
        files = [f for fl in by_area.values() for f in fl[len(fl) // 2 - args.per_area // 2:][:args.per_area]]

    results = []
    for lf in files:
        labels = json.loads(lf.read_text(encoding="utf-8"))
        r = evaluate_file(lf.with_name(lf.name.replace("_labels.json", ".xtf")), labels)
        results.append(r)
        found = sum(t["found"] for t in r["targets"])
        print(f"{r['file']}: {found}/{len(r['targets'])} targets, {r['false_positives']} FP "
              f"({r['fp_on_natural_rock']} on rock), {r['ms'] / 1000:.1f}s", flush=True)

    per_class = defaultdict(lambda: {"targets": 0, "found": 0, "class_correct": 0})
    errs = []
    for r in results:
        for t in r["targets"]:
            pc = per_class[t["class"]]
            pc["targets"] += 1
            pc["found"] += t["found"]
            pc["class_correct"] += t.get("pred") == t["class"]
            if t.get("geo_err_m") is not None:
                errs.append(t["geo_err_m"])
    summary = {
        "files": len(results),
        "per_class": {c: {**v, "recall": round(v["found"] / v["targets"], 3) if v["targets"] else None}
                      for c, v in per_class.items()},
        "false_positives": sum(r["false_positives"] for r in results),
        "false_positives_on_natural_rock": sum(r["fp_on_natural_rock"] for r in results),
        "false_positive_classes": dict(sum((r["fp_classes"] for r in results), Counter())),
        "geotag_error_m": {"median": round(float(np.median(errs)), 2), "p90": round(float(np.percentile(errs, 90)), 2)} if errs else None,
        "mean_seconds_per_file": round(float(np.mean([r["ms"] for r in results])) / 1000, 1),
    }
    print(json.dumps(summary, indent=2))
    out = {"summary": summary, "files": [{**r, "fp_classes": dict(r["fp_classes"])} for r in results]}
    (args.data / "evaluation.json").write_text(json.dumps(out, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
