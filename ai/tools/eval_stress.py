"""Stress test over many real strips: how detection holds up under each disturbance, raw vs Auto vs full cleaning.

Runs the stage-3 stress test (app/cleaning/stress.py, the same code as POST /v1/stress-test) on AI4Shipwrecks test
strips with wrecks, each tested in a region centred on its largest wreck part (ground truth, so no pipeline is
favoured: the live tool centres on the strongest raw detection instead), and pools two measures per disturbance level
and pipeline:
  ground truth   wreck parts found (a detection hits a wreck mask: centre inside or IoU >= 0.1) and false alarms
                 (detections on no wreck), from the undisturbed region (level 0) to the strongest level;
  retention      the share of the pipeline's own undisturbed detections it still finds (what the live UI shows).
Writes tools/benchmark_results/stress_summary.json.

Usage (from ai/):  .venv/Scripts/python tools/eval_stress.py [--strips 24] [--max-side 1024] [--levels 4]
"""

import argparse
import json
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.cleaning.stress import DISTURBANCES, SEVERITY, stress_test  # noqa: E402
from app.ml.registry import registry  # noqa: E402
from app.readers.image import decode_gray  # noqa: E402
from app.seabed.bottom import track_bottom  # noqa: E402
from benchmark_cleaning import CACHE, ai4s_files, box_hit, mask_boxes  # noqa: E402

PIPELINES = ("raw", "auto", "full")


def score(boxes, scale, gts):
    """(wreck parts hit, false alarms) for thumbnail-scaled boxes against ground-truth boxes of the region."""
    dets = [[v / scale for v in b["bbox"]] for b in boxes]
    hit = sum(1 for g in gts if any(box_hit(d, g) for d in dets))
    fa = sum(1 for d in dets if not any(box_hit(d, g) for g in gts))
    return hit, fa


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--strips", type=int, default=24)
    ap.add_argument("--max-side", type=int, default=1024)
    ap.add_argument("--levels", type=int, default=4)
    args = ap.parse_args()
    registry.load()
    strips = ai4s_files(args.strips, 0)
    lv_range = range(0, args.levels + 1)
    acc = {k: {lv: {p: {"gt": 0, "hit": 0, "fa": 0, "base": 0, "kept": 0} for p in PIPELINES} for lv in lv_range}
           for k in DISTURBANCES}
    t0 = time.time()
    for n, (img_path, lab_path) in enumerate(strips, 1):
        gray = decode_gray(img_path.read_bytes())
        mask = cv2.imread(str(lab_path), cv2.IMREAD_GRAYSCALE)
        b = track_bottom(gray, None)
        nadir = b.nadir_col if b else gray.shape[1] / 2
        h, w = gray.shape
        x1, y1, x2, y2 = max(mask_boxes(mask), key=lambda g: (g[2] - g[0]) * (g[3] - g[1]))
        side = args.max_side
        roi = (int(np.clip((x1 + x2) / 2 - side / 2, 0, max(0, w - side))),
               int(np.clip((y1 + y2) / 2 - side / 2, 0, max(0, h - side))), side, side)
        for kind in DISTURBANCES:
            r = stress_test(gray, kind, args.levels, args.max_side, nadir, roi=roi)
            reg, sc = r["region"], r["thumb_scale"]
            gts = mask_boxes(mask[reg["y"]:reg["y"] + reg["height"], reg["x"]:reg["x"] + reg["width"]])
            for p in PIPELINES:
                own = r["baseline"]["pipelines"][p]
                hit, fa = score(own["boxes"], sc, gts)
                a = acc[kind][0][p]
                a["gt"] += len(gts)
                a["hit"] += hit
                a["fa"] += fa
                for s in r["series"]:
                    hit, fa = score(s["boxes"][p], sc, gts)
                    a = acc[kind][s["level"]][p]
                    a["gt"] += len(gts)
                    a["hit"] += hit
                    a["fa"] += fa
                    a["base"] += own["detections"]
                    a["kept"] += s["results"][p]["retained"]
        print(f"  {n}/{len(strips)} {img_path.stem}  {time.time() - t0:.0f}s", flush=True)

    summary = {"strips": [p.stem for p, _ in strips], "max_side": args.max_side, "levels": args.levels, "results": {}}
    for kind in DISTURBANCES:
        rows = []
        for lv in lv_range:
            row = {"level": lv, "label": "undisturbed" if lv == 0 else SEVERITY[kind][lv - 1][0]}
            for p in PIPELINES:
                a = acc[kind][lv][p]
                row[p] = {"wreck_recall": round(a["hit"] / a["gt"], 3) if a["gt"] else None, "wreck_parts": a["gt"],
                          "false_alarms": a["fa"],
                          "retention": round(a["kept"] / a["base"], 3) if a["base"] else None}
            rows.append(row)
        summary["results"][kind] = rows
    out = CACHE / "stress_summary.json"
    out.write_text(json.dumps(summary, indent=1))
    gt_total = acc[DISTURBANCES[0]][0]["raw"]["gt"]
    print(f"\n{len(strips)} strips, {gt_total} wreck parts in the tested regions. Wreck parts found (false alarms):")
    print("| Disturbance | Level | No cleaning | Auto (AI input) | Full cleaning |")
    print("|---|---|---|---|---|")
    for kind in DISTURBANCES:
        for row in summary["results"][kind]:
            cells = [f"{row[p]['wreck_recall']:.0%} ({row[p]['false_alarms']})" for p in PIPELINES]
            print(f"| {kind} | {row['label']} | " + " | ".join(cells) + " |")
    print("\nRetention of each pipeline's own undisturbed detections:")
    for kind in DISTURBANCES:
        print(kind, " ".join(f"{row['label']}: " + "/".join(f"{row[p]['retention']:.0%}" if row[p]['retention'] is not None
                                                            else "-" for p in PIPELINES)
                             for row in summary["results"][kind] if row["level"] > 0))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
