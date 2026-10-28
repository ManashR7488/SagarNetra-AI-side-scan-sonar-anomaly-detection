"""Benchmark: does each noise-cleaning step help the detector? Writes app/cleaning/profile.json (the AI profile).

The detector was trained on raw, speckled sonar, so a step that makes images look cleaner can still hurt detection.
Every candidate configuration runs the full detection + scoring pipeline (detector and segmenter, like production)
on two datasets and is compared with the raw baseline:

  synthetic XTF   data/synthetic_xtf: simulated survey lines with ground truth (true lat/lon of every object).
                  A confirmed detection is a hit when it geotags within 10 m + half the object size of a man-made
                  object; confirmed detections near natural rocks / boulders or on bare seabed are false alarms.
                  Geotag error of the hits is reported (motion compensation should lower it).
  AI4Shipwrecks   real side-scan strips (Thunder Bay) with wreck masks: hit = box IoU >= 0.1 or centre inside a
                  wreck part (masks follow ground-range / resampling changes); everything else is a false alarm.

A step is "proven" when, on both datasets together, it raises the mean F1 by more than 0.005 without lowering recall
on either dataset by more than 0.02. The AI profile = proven steps (validated together in a final run).

Usage (from ai/):
    .venv/Scripts/python tools/benchmark_cleaning.py                      # all configurations, ~2 h on a CPU
    .venv/Scripts/python tools/benchmark_cleaning.py --configs raw,lee30   # a subset (results are cached per config)
    .venv/Scripts/python tools/benchmark_cleaning.py --write-only          # rebuild profile.json from the cache
"""

import argparse
import glob
import json
import sys
import time
from datetime import date
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.cleaning.auto import auto_params  # noqa: E402
from app.cleaning.params import PROFILE_FILE, CleanParams  # noqa: E402
from app.cleaning.pipeline import clean, diagnose  # noqa: E402
from app.geo.geotagging import haversine_m  # noqa: E402
from app.ml.registry import registry  # noqa: E402
from app.processing.filters import FilterParams  # noqa: E402
from app.processing.pipeline import AnalyzeOptions, analyze  # noqa: E402
from app.readers.image import decode_gray  # noqa: E402
from app.readers.xtf import load_xtf  # noqa: E402
from app.seabed.geometry import refine_track  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
SYN = ROOT / "data" / "synthetic_xtf"
AI4S = Path("D:/Downloads/Data Sets/AI4Shipwrecks")
CACHE = Path(__file__).resolve().parent / "benchmark_results"

BASE = {"repair_dropouts": False, "motion": False}
CONFIGS = {
    # name: (settings, evidence key, xtf only)
    "raw": ({}, None, False),              # no cleaning pass at all (production before the noise module)
    # cleaning pass with every step off: same image as raw, but the data-quality maps (water column, repaired
    # pings) feed the scoring rules like in every other configuration -> the fair baseline for the steps
    "none": ({}, None, False),
    "dropouts": ({"repair_dropouts": True}, "dropouts", False),
    "motion": ({"repair_dropouts": True, "motion": True}, "motion", True),
    "destripe": ({"destripe": True}, "stripes", False),
    "ping_gain": ({"gain_along": True}, "ping_gain", False),
    "range_gain": ({"gain_across": True}, "range_gain", False),
    "water_mask": ({"mask_water_column": True}, "water_column", False),
    "ground": ({"slant_correct": True}, "ground_range", False),
    "lee30": ({"despeckle": "lee", "despeckle_strength": 30}, "speckle", False),
    "res010": ({"normalize_resolution": True, "target_m_per_px": 0.1}, "resolution", True),
    # the proven steps together (settings filled in from the single-step results): validates the combination
    "profile": ({}, None, False),
    # what production runs: Auto with the AI profile, i.e. each proven step only where its noise is measured
    "auto": ({}, None, False),
}
MAX_ROWS = 3500          # tall AI4Shipwrecks strips are cropped around the wreck (detection time grows with rows)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--configs", default=",".join(CONFIGS))
    ap.add_argument("--per-area", type=int, default=3, help="synthetic lines per area (of 8)")
    ap.add_argument("--ai4s-wrecks", type=int, default=40, help="AI4Shipwrecks test strips with wrecks")
    ap.add_argument("--ai4s-terrain", type=int, default=6, help="AI4Shipwrecks terrain strips (no wrecks)")
    ap.add_argument("--write-only", action="store_true")
    ap.add_argument("--force", action="store_true", help="re-run configurations already cached")
    ap.add_argument("--cache", default=str(CACHE), help="folder for per-configuration results")
    ap.add_argument("--no-profile", action="store_true", help="do not write app/cleaning/profile.json")
    return ap.parse_args()


# ---------------------------------------------------------------- datasets

def synthetic_files(per_area: int) -> list[Path]:
    out = []
    for area in sorted(p for p in SYN.iterdir() if p.is_dir() and p.name != "previews"):
        lines = sorted(area.glob("*.xtf"))
        step = max(1, len(lines) // per_area)
        out += lines[::step][:per_area]
    return out


def ai4s_files(n_wrecks: int, n_terrain: int) -> list[tuple[Path, Path | None]]:
    wrecks = []
    for img in sorted((AI4S / "test" / "images").glob("*.png")):
        lab = AI4S / "test" / "labels" / img.name
        if lab.exists() and np.any(cv2.imread(str(lab), cv2.IMREAD_GRAYSCALE)):
            wrecks.append((img, lab))
    terrain = [(p, None) for p in sorted((AI4S / "extras" / "terrain" / "images").glob("*.png"))]
    # spread the picks over the sites
    pick = lambda items, n: [items[i] for i in np.unique(np.linspace(0, len(items) - 1, min(n, len(items))).astype(int))]  # noqa: E731
    return pick(wrecks, n_wrecks) + pick(terrain, n_terrain)


def mask_boxes(mask: np.ndarray, min_area: int = 100) -> list[list[float]]:
    n, _, stats, _ = cv2.connectedComponentsWithStats((mask > 0).astype(np.uint8))
    return [[float(x), float(y), float(x + w), float(y + h)] for x, y, w, h, a in stats[1:] if a >= min_area]


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def box_hit(det, gt, pad=15):
    cx, cy = (det[0] + det[2]) / 2, (det[1] + det[3]) / 2
    return (gt[0] - pad <= cx <= gt[2] + pad and gt[1] - pad <= cy <= gt[3] + pad) or iou(det, gt) >= 0.1


# ---------------------------------------------------------------- one configuration

def run_detection(gray, track, quality, nadir):
    opts = AnalyzeOptions(models=("detector", "segmenter"), filters=FilterParams(repair_dropouts=False))
    if nadir is not None:
        opts.score.nadir_col = nadir
    result, _ = analyze(gray, track, opts, {"filename": "bench"}, quality=quality)
    return [d for d in result["detections"] if d["status"] == "confirmed"]


LINEAR = {"pipeline", "cable"}      # hundreds of metres long: matched against their line, not their centre


def obj_distance(loc: dict, o: dict) -> float:
    """Metres from a detection to an object: to the centre, or to the line segment of a pipeline / cable."""
    if o["kind"] not in LINEAR:
        return float(haversine_m(loc["latitude"], loc["longitude"], o["latitude"], o["longitude"]))
    lat_c = np.radians(o["latitude"])
    dx = np.radians(loc["longitude"] - o["longitude"]) * 6371008.8 * np.cos(lat_c)
    dy = np.radians(loc["latitude"] - o["latitude"]) * 6371008.8
    az = np.radians(o.get("azimuth_deg", 0.0))
    ux, uy = np.sin(az), np.cos(az)
    along = dx * ux + dy * uy
    half = o["size_m"]["length"] / 2
    along_c = float(np.clip(along, -half, half))
    return float(np.hypot(dx - along_c * ux, dy - along_c * uy))


def obj_radius(o: dict) -> float:
    return 15.0 if o["kind"] in LINEAR else 10.0 + 0.5 * max(o["size_m"]["length"], o["size_m"]["width"])


def resolve(params, gray, log=None):
    """'auto' = the production decision for this file: AI-profile steps whose noise the diagnosis measures."""
    if params != "auto":
        return params
    return auto_params(diagnose(gray, log).to_dict(), "ai")[0]


def eval_synthetic(path: Path, params: CleanParams | None) -> dict:
    labels = json.loads(path.with_name(path.stem + "_labels.json").read_text())
    gray, track, info, geom, log = load_xtf(path.read_bytes(), with_geometry=True, with_log=True)
    quality, nadir = None, None
    params = resolve(params, gray, log)
    if params is not None:
        res = clean(gray, params, log, keep_steps=False, measure_noise=False)
        gray, quality, nadir = res.image, res.quality, res.frame.nadir_col
        track = res.frame.transform_track(track)
        bottom = res.bottom
    else:
        from app.seabed.bottom import track_bottom
        bottom = track_bottom(gray, track.nadir_col if track else None)
    track, _ = refine_track(track, bottom, gray.shape[0])
    dets = run_detection(gray, track, quality, nadir)
    targets = [o for o in labels["objects"] if o["man_made"]]
    natural = [o for o in labels["objects"] if o["class"] is None]
    used, hits, errs = set(), 0, []
    for t in targets:
        radius = obj_radius(t)
        best, best_d = None, None
        for i, d in enumerate(dets):
            if i in used or not d["location"]:
                continue
            dist = obj_distance(d["location"], t)
            if dist <= radius and (best_d is None or dist < best_d):
                best, best_d = i, dist
        if best is not None:
            used.add(best)
            hits += 1
            if t["kind"] not in LINEAR:      # position error is only meaningful for compact objects
                errs.append(best_d)
    # the same object may also produce a second, overlapping detection: not a false alarm of the cleaning
    fp_rock = fp_seabed = 0
    for i, d in enumerate(dets):
        if i in used or not d["location"]:
            continue
        loc = d["location"]
        if any(obj_distance(loc, t) <= obj_radius(t) for t in targets):
            continue
        near_rock = any(obj_distance(loc, o) <= obj_radius(o) for o in natural)
        fp_rock += near_rock
        fp_seabed += not near_rock
    return {"targets": len(targets), "tp": hits, "fp_rock": fp_rock, "fp_seabed": fp_seabed,
            "geo_err": errs, "conf_tp": [dets[i]["confidence"] for i in used]}


def eval_ai4s(img_path: Path, lab_path: Path | None, params: CleanParams | None) -> dict:
    gray = decode_gray(img_path.read_bytes())
    mask = cv2.imread(str(lab_path), cv2.IMREAD_GRAYSCALE) if lab_path else np.zeros(gray.shape, np.uint8)
    if gray.shape[0] > MAX_ROWS:
        rows = np.where(mask.any(axis=1))[0]
        c = int(rows.mean()) if len(rows) else gray.shape[0] // 2
        r0 = int(np.clip(c - MAX_ROWS // 2, 0, gray.shape[0] - MAX_ROWS))
        gray, mask = np.ascontiguousarray(gray[r0:r0 + MAX_ROWS]), np.ascontiguousarray(mask[r0:r0 + MAX_ROWS])
    quality, nadir = None, None
    params = resolve(params, gray)
    if params is not None:
        res = clean(gray, params, keep_steps=False, measure_noise=False)
        gray, quality, nadir = res.image, res.quality, res.frame.nadir_col
        mask = res.map_mask(mask)
    dets = run_detection(gray, None, quality, nadir)
    gts = mask_boxes(mask)
    boxes = [[d["bbox"]["x1"], d["bbox"]["y1"], d["bbox"]["x2"], d["bbox"]["y2"]] for d in dets]
    hit_gt = [any(box_hit(b, g) for b in boxes) for g in gts]
    fp = sum(1 for b in boxes if not any(box_hit(b, g) for g in gts))
    conf = [d["confidence"] for d, b in zip(dets, boxes) if any(box_hit(b, g) for g in gts)]
    return {"targets": len(gts), "tp": int(sum(hit_gt)), "fp": fp, "conf_tp": conf}


def summarise(rows: list[dict], synthetic: bool) -> dict:
    t = sum(r["targets"] for r in rows)
    tp = sum(r["tp"] for r in rows)
    fp = sum(r["fp_rock"] + r["fp_seabed"] for r in rows) if synthetic else sum(r["fp"] for r in rows)
    rec = tp / t if t else 0.0
    prec = tp / (tp + fp) if tp + fp else 0.0
    f1 = 2 * rec * prec / (rec + prec) if rec + prec else 0.0
    conf = [c for r in rows for c in r["conf_tp"]]
    out = {"files": len(rows), "targets": t, "tp": tp, "fp": fp, "recall": round(rec, 4), "precision": round(prec, 4),
           "f1": round(f1, 4), "mean_conf_tp": round(float(np.mean(conf)), 1) if conf else None}
    if synthetic:
        errs = [e for r in rows for e in r["geo_err"]]
        out.update(fp_rock=sum(r["fp_rock"] for r in rows), fp_seabed=sum(r["fp_seabed"] for r in rows),
                   geo_err_median_m=round(float(np.median(errs)), 2) if errs else None,
                   geo_err_p90_m=round(float(np.percentile(errs, 90)), 2) if errs else None)
    return out


def run_config(name: str, settings: dict, xtf_only: bool, syn: list[Path], ai4s: list) -> dict:
    params = None if name == "raw" else "auto" if name == "auto" else CleanParams.from_dict({**BASE, **settings})
    t0 = time.time()
    srows, arows = [], []
    for k, f in enumerate(syn):
        try:
            srows.append(eval_synthetic(f, params))
        except Exception as e:  # noqa: BLE001
            print(f"  {name}: {f.name} failed: {e}", flush=True)
        print(f"  {name}: synthetic {k + 1}/{len(syn)}  {time.time() - t0:.0f}s", flush=True)
    if not xtf_only:
        for k, (img, lab) in enumerate(ai4s):
            try:
                arows.append(eval_ai4s(img, lab, params))
            except Exception as e:  # noqa: BLE001
                print(f"  {name}: {img.name} failed: {e}", flush=True)
            if k % 10 == 9:
                print(f"  {name}: ai4shipwrecks {k + 1}/{len(ai4s)}  {time.time() - t0:.0f}s", flush=True)
    out = {"name": name, "settings": settings, "synthetic": summarise(srows, True),
           "ai4shipwrecks": summarise(arows, False) if arows else None, "seconds": round(time.time() - t0, 1)}
    return out


# ---------------------------------------------------------------- decision

def decide(results: dict) -> dict:
    base = results.get("none") or results["raw"]
    evidence, proven = {}, {}

    def delta(r):
        d = {}
        for ds in ("synthetic", "ai4shipwrecks"):
            if r.get(ds) and base.get(ds):
                d[ds] = {k: round(r[ds][k] - base[ds][k], 4) for k in ("f1", "recall", "precision")}
                d[ds]["fp"] = r[ds]["fp"] - base[ds]["fp"]
        return d

    for name in ("profile", "auto"):
        if results.get(name) is not None:
            results[name]["delta"] = delta(results[name])
    for name, r in results.items():
        if name in ("raw", "none", "profile", "auto") or r is None:
            continue
        d = delta(r)
        f1s = [v["f1"] for v in d.values()]
        mean_df1 = float(np.mean(f1s)) if f1s else 0.0
        worst_rec = min(v["recall"] for v in d.values()) if d else 0.0
        helps = mean_df1 > 0.005 and worst_rec >= -0.02
        r["delta"] = d
        r["helps"] = helps
        key = CONFIGS[name][1]
        parts = []
        for ds, v in d.items():
            label = "synthetic" if ds == "synthetic" else "AI4Shipwrecks"
            parts.append(f"{label}: F1 {v['f1']:+.3f}, recall {v['recall']:+.3f}, false alarms {v['fp']:+d}")
        geo = ""
        if r.get("synthetic", {}).get("geo_err_median_m") is not None and base["synthetic"].get("geo_err_median_m"):
            geo = f"; geotag error {base['synthetic']['geo_err_median_m']} -> {r['synthetic']['geo_err_median_m']} m"
        summary = f"benchmark ({'helps' if helps else 'no gain'} vs no cleaning): " + "; ".join(parts) + geo
        prev = evidence.get(key)
        if prev is None or (helps and not prev["helps"]) or (helps == prev["helps"] and mean_df1 > prev["mean_df1"]):
            evidence[key] = {"helps": helps, "config": name, "mean_df1": round(mean_df1, 4), "summary": summary}
            if helps:
                proven[key] = CONFIGS[name][0]
    return {"evidence": evidence, "proven": proven}


def build_profile(results: dict, proven: dict) -> dict:
    settings = {"repair_dropouts": True, "motion": False}
    for key, s in proven.items():
        settings.update(s)
    # dropout repair and motion compensation fix real data faults (and motion improves geotags): kept on unless
    # the benchmark shows they hurt detection
    for key, cfg in (("dropouts", "dropouts"), ("motion", "motion")):
        r = results.get(cfg)
        if r is not None and "delta" in r and r["helps"] is False:
            worst = min(v["recall"] for v in r["delta"].values()) if r["delta"] else 0.0
            if worst < -0.02:
                settings["repair_dropouts" if key == "dropouts" else "motion"] = False
                continue
        settings["repair_dropouts" if key == "dropouts" else "motion"] = True
    return settings


def main():
    args = parse_args()
    cache = Path(args.cache)
    cache.mkdir(exist_ok=True, parents=True)
    names = [n for n in args.configs.split(",") if n in CONFIGS]
    syn = synthetic_files(args.per_area)
    ai4s = ai4s_files(args.ai4s_wrecks, args.ai4s_terrain)
    if not args.write_only:
        registry.load()
        print(f"datasets: {len(syn)} synthetic lines, {len(ai4s)} AI4Shipwrecks strips; configs: {names}", flush=True)
        for name in names:
            out = cache / f"{name}.json"
            if out.exists() and not args.force:
                print(f"{name}: cached", flush=True)
                continue
            settings, _, xtf_only = CONFIGS[name]
            if name == "profile":       # the combination of the steps the single runs proved
                singles = {n: json.loads((cache / f"{n}.json").read_text()) for n in CONFIGS
                           if n != "profile" and (cache / f"{n}.json").exists()}
                if "none" not in singles and "raw" not in singles:
                    print("profile: run the baseline and the single steps first", flush=True)
                    continue
                settings = build_profile(singles, decide(singles)["proven"])
            r = run_config(name, settings, xtf_only, syn, ai4s)
            out.write_text(json.dumps(r, indent=1))
            print(f"{name}: {json.dumps({k: r[k] for k in ('synthetic', 'ai4shipwrecks', 'seconds')})}", flush=True)
    results = {n: json.loads((cache / f"{n}.json").read_text()) for n in CONFIGS if (cache / f"{n}.json").exists()}
    if "raw" not in results:
        print("no raw baseline yet")
        return
    dec = decide(results)
    ai = build_profile(results, dec["proven"])
    combined = results.get("profile")
    if combined is not None and combined.get("settings") == ai:
        f1s = [v["f1"] for v in combined.get("delta", {}).values()]
        combined["mean_df1"] = round(float(np.mean(f1s)), 4) if f1s else 0.0
        parts = "; ".join(f"{'synthetic' if ds == 'synthetic' else 'AI4Shipwrecks'}: F1 {v['f1']:+.3f}, recall "
                          f"{v['recall']:+.3f}, false alarms {v['fp']:+d}" for ds, v in combined.get("delta", {}).items())
        helps = combined["mean_df1"] > 0
        combined["helps"] = helps
        if not helps:       # the steps do not add up: keep only the data-fault repairs
            print(f"combination did not beat the baseline (mean dF1 {combined['mean_df1']}): keeping repairs only")
            ai = {"repair_dropouts": ai.get("repair_dropouts", True), "motion": ai.get("motion", False)}
        dec["evidence"]["combination"] = {
            "helps": helps, "config": "profile", "mean_df1": combined["mean_df1"],
            "summary": f"the proven steps together ({'used' if helps else 'not used together'}): {parts}"}
    elif combined is not None:
        print("the 'profile' run used other settings than the current proven steps: re-run it (--configs profile --force)")
    as_run = results.get("auto")
    if as_run is not None and as_run.get("delta"):
        f1s = [v["f1"] for v in as_run["delta"].values()]
        parts = "; ".join(f"{'synthetic' if ds == 'synthetic' else 'AI4Shipwrecks'}: F1 {v['f1']:+.3f}, recall "
                          f"{v['recall']:+.3f}, false alarms {v['fp']:+d}" for ds, v in as_run["delta"].items())
        as_run["helps"] = float(np.mean(f1s)) > 0
        dec["evidence"]["auto"] = {
            "helps": as_run["helps"], "config": "auto", "mean_df1": round(float(np.mean(f1s)), 4),
            "summary": f"Auto as it runs (each AI-input step only where its noise is measured): {parts}"}
    base = results["raw"]
    none = results.get("none")
    profile = {
        "generated": date.today().isoformat(),
        "summary": (f"Measured on {base['synthetic']['files']} synthetic XTF lines ({base['synthetic']['targets']} "
                    f"man-made targets) and {base['ai4shipwrecks']['files'] if base.get('ai4shipwrecks') else 0} real "
                    f"AI4Shipwrecks strips ({base['ai4shipwrecks']['targets'] if base.get('ai4shipwrecks') else 0} wreck "
                    f"parts): a step is used for detection only when it raises F1 without costing recall."),
        "datasets": {"synthetic_xtf": {"files": base["synthetic"]["files"], "targets": base["synthetic"]["targets"]},
                     "ai4shipwrecks": {"files": (base.get("ai4shipwrecks") or {}).get("files", 0),
                                       "targets": (base.get("ai4shipwrecks") or {}).get("targets", 0)}},
        "baseline": {"config": "none" if none else "raw",
                     **{k: (none or base).get(k) for k in ("synthetic", "ai4shipwrecks")}},
        "raw": {k: base.get(k) for k in ("synthetic", "ai4shipwrecks")},
        "results": {n: {k: r.get(k) for k in ("settings", "synthetic", "ai4shipwrecks", "delta", "helps", "seconds")}
                    for n, r in results.items()},
        "evidence": dec["evidence"],
        "ai": ai,
    }
    target = cache / "_profile_preview.json" if args.no_profile else PROFILE_FILE
    target.write_text(json.dumps(profile, indent=1))
    print(f"wrote {target}: ai = {ai}")
    for k, v in dec["evidence"].items():
        print(f"  {k:13s} {'HELPS' if v['helps'] else 'no gain':8s} {v['summary']}")


if __name__ == "__main__":
    main()
