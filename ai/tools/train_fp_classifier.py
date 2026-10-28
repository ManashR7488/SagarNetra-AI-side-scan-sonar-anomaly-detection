"""Train the false-alarm classifier (man-made vs natural seabed, + natural subtype) -> models/fp_classifier/model.json

Candidates: every raw detector / segmenter candidate above half its class threshold, on
  * the synthetic XTF campaign (data/synthetic_xtf), raw and cleaned with the AI profile. Ground truth: a candidate
    is man-made when it geotags onto a man-made object (pipelines / cables: within 15 m of their line). Natural
    candidates get the kind of seabed under them from the simulated world itself (rebuilt from the generator's
    seeds): rock / reef, sand ripples or waves, a dark patch (natural shadow) or plain sediment texture;
  * real AI4Shipwrecks strips (test split + wreck-free terrain): man-made = on a wreck mask, natural otherwise.
The features are the explainable evidence of app/processing/features.py (identical at run time).

Model: logistic regression, with both datasets (and both classes in each) weighted equally so the larger
synthetic set does not dominate. Its probability is blended with the hand-set rule score (--blend, default 0.5): on
its own the classifier ranked real AI4Shipwrecks candidates slightly worse than the rules (it learns synthetic
cues), while the 50/50 blend beat the rules on both datasets.

Evaluation: grouped 5-fold cross-validation (groups = survey areas / wreck sites, so a model is always tested on
places it never saw), per dataset, against the rule-based score. The decision threshold that maximises F1 maps to
a score of 50 (like the detector calibration), so "50 = best decision point" holds for the final score.

Needs scikit-learn (training only):  uv pip install scikit-learn
Usage (from ai/):  .venv/Scripts/python tools/train_fp_classifier.py [--per-area 8] [--skip-collect]
                   (--work-dir / --out-dir: somewhere else, e.g. for a quick trial with --per-area 1)
"""

import argparse
import json
import sys
import time
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.cleaning.params import profile_params  # noqa: E402
from app.cleaning.pipeline import clean  # noqa: E402
from app.ml.inference import fuse, run_model, should_tile  # noqa: E402
from app.ml.registry import registry  # noqa: E402
from app.processing.features import FEATURES, PHRASES, candidate_features  # noqa: E402
from app.processing.scoring import calibrated_score, rule_score  # noqa: E402
from app.readers.image import decode_gray  # noqa: E402
from app.readers.xtf import load_xtf  # noqa: E402
from app.seabed.bottom import track_bottom  # noqa: E402
from app.seabed.geometry import refine_track  # noqa: E402
from benchmark_cleaning import AI4S, MAX_ROWS, SYN, ai4s_files, box_hit, mask_boxes, obj_distance, obj_radius  # noqa: E402

OUT_DIR = Path(__file__).resolve().parents[1] / "models" / "fp_classifier"
WORK = Path(__file__).resolve().parent / "fp_training"
SUBTYPES = ("rock", "sand_ripple", "natural_shadow", "seabed_texture")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-area", type=int, default=8)
    ap.add_argument("--ai4s-wrecks", type=int, default=120)
    ap.add_argument("--ai4s-terrain", type=int, default=25)
    ap.add_argument("--skip-collect", action="store_true", help="reuse fp_training/candidates.json")
    ap.add_argument("--work-dir", default=str(WORK), help="candidate cache folder")
    ap.add_argument("--out-dir", default=str(OUT_DIR), help="where model.json is written")
    ap.add_argument("--blend", type=float, default=0.5, help="classifier share of the final score (rest: rule score)")
    return ap.parse_args()


# ---------------------------------------------------------------- simulated world (ground truth of the seabed)

class World:
    """The synthetic area's seabed, rebuilt exactly as tools/generate_xtf.py made it."""

    def __init__(self):
        from sonar_sim.campaign import areas, build_area
        from sonar_sim.world import LocalFrame, Seabed

        self.areas = {}
        for a in areas():
            prof, objects, lines, extent = build_area(a)
            self.areas[a["code"]] = (Seabed(a["seabed"], extent, seed=sum(map(ord, a["code"]))),
                                     LocalFrame(a["lat0"], a["lon0"]))

    def seabed_kind(self, area: str, lat: float, lon: float, half_m: float) -> dict:
        from sonar_sim.world import smoothstep

        seabed, frame = self.areas[area]
        e0, n0 = frame.to_en(lat, lon)
        g = np.linspace(-half_m, half_m, 5)
        E, N = np.meshgrid(e0 + g, n0 + g)
        sp = seabed.spec
        rockf = seabed._g(seabed.rockf, E, N)
        rock = float(np.max(smoothstep(rockf, seabed.th_rock, seabed.th_rock + 0.35))) if sp.rock > 0 else 0.0
        reef = float(np.max(smoothstep(-rockf, seabed.th_reef, seabed.th_reef + 0.3))) if sp.reef > 0 else 0.0
        sed = seabed._g(seabed.sed, E, N)
        mud_w = 1 - smoothstep(sed, seabed.th_mud - 0.3, seabed.th_mud + 0.3)
        grav_w = smoothstep(sed, seabed.th_gravel - 0.3, seabed.th_gravel + 0.3)
        sand_w = np.clip(1 - mud_w - grav_w, 0, 1)
        mod = np.clip(0.6 + 0.5 * seabed._g(seabed.modf, E, N), 0, 1.2)
        ripple = float(np.max(sp.ripple_amp * sand_w * mod))
        sandwave = float(np.max(sp.sandwave_amp * mod))
        return {"rock": max(rock, reef), "ripple_m": ripple, "sandwave_m": sandwave}


# ---------------------------------------------------------------- candidates

def candidates_for(gray, track, quality, nadir):
    det, seg = registry.get("detector"), registry.get("segmenter")
    h, w = gray.shape
    tiled = should_tile(h, w, det.tile)
    cands = fuse(run_model(det, gray, tiled, conf=0.05), run_model(seg, gray, tiled, conf=0.05))
    out = []
    for d in cands:
        model = seg if d.source == "segmenter" else det
        thr = model.threshold(d.class_name)
        if d.confidence < 0.5 * thr:
            continue
        q = quality.at_box(d.box) if quality is not None else None
        vec, extras = candidate_features(gray, d.box, nadir, d.class_name, d.confidence, thr, d.agreement, d.source, q)
        x1, y1, x2, y2 = d.box
        loc = track.pixel_to_geo((x1 + x2) / 2, (y1 + y2) / 2) if track is not None else None
        ev = extras["evidence"]
        rule = rule_score(calibrated_score(d.confidence, thr), ev["shadow"], ev["linearity"], ev["contrast"], d.agreement)
        out.append({"vec": vec, "box": [float(v) for v in d.box], "loc": loc, "rule": rule,
                    "class": d.class_name, "in_water": bool(q and q.get("in_water_column")),
                    "dark_box": float(vec[FEATURES.index("dark_box")])})
    return out


def collect_synthetic(per_area: int, world: World) -> list[dict]:
    rows = []
    variants = {"raw": None, "ai": profile_params("ai")}
    areas = sorted(p for p in SYN.iterdir() if p.is_dir() and p.name != "previews")
    for area in areas:
        lines = sorted(area.glob("*.xtf"))[:per_area]
        for line in lines:
            labels = json.loads(line.with_name(line.stem + "_labels.json").read_text())
            man = [o for o in labels["objects"] if o["man_made"]]
            rocks = [o for o in labels["objects"] if o["class"] is None]
            fish = [o for o in labels["objects"] if o["class"] == "marine_life"]
            for vname, params in variants.items():
                t0 = time.time()
                gray, track, info, geom, log = load_xtf(line.read_bytes(), with_geometry=True, with_log=True)
                quality, nadir = None, track.nadir_col if track is not None else gray.shape[1] / 2
                if params is not None:
                    res = clean(gray, params, log, keep_steps=False, measure_noise=False)
                    gray, quality, nadir = res.image, res.quality, res.frame.nadir_col
                    track = res.frame.transform_track(track)
                    bottom = res.bottom
                else:
                    bottom = track_bottom(gray, nadir)
                track, _ = refine_track(track, bottom, gray.shape[0])
                for c in candidates_for(gray, track, quality, nadir):
                    if c["loc"] is None:
                        continue
                    if any(obj_distance(c["loc"], o) <= obj_radius(o) for o in man):
                        label, sub = 1, None
                    else:
                        label = 0
                        mpp = track.across_m_per_px
                        half = max(2.0, 0.5 * max(c["box"][2] - c["box"][0], c["box"][3] - c["box"][1]) * mpp)
                        kind = world.seabed_kind(area.name, c["loc"]["latitude"], c["loc"]["longitude"], half)
                        if c["in_water"] or any(obj_distance(c["loc"], o) <= obj_radius(o) for o in fish):
                            sub = None                     # water column / fish: handled by their own rules
                        elif any(obj_distance(c["loc"], o) <= obj_radius(o) for o in rocks):
                            sub = "rock"
                        elif c["dark_box"] > 0.5:
                            sub = "natural_shadow"
                        elif kind["rock"] > 0.3:
                            sub = "rock"
                        elif kind["sandwave_m"] > 0.2 or kind["ripple_m"] > 0.025:
                            sub = "sand_ripple"
                        else:
                            sub = "seabed_texture"
                    rows.append({"x": c["vec"], "y": label, "sub": sub, "rule": c["rule"], "group": area.name,
                                 "line": line.stem, "source": f"synthetic/{vname}"})
                print(f"  {line.stem} [{vname}]: {sum(1 for r in rows if r['source'].endswith(vname) and r['group'] == area.name)} "
                      f"candidates so far in {area.name}  {time.time() - t0:.0f}s", flush=True)
    return rows


def collect_ai4s(n_wrecks: int, n_terrain: int) -> list[dict]:
    import cv2

    rows = []
    variants = {"raw": None, "ai": profile_params("ai")}
    for k, (img, lab) in enumerate(ai4s_files(n_wrecks, n_terrain)):
        site = "_".join(img.stem.split("_")[:-1]) or img.stem
        for vname, params in variants.items():
            gray = decode_gray(img.read_bytes())
            mask = cv2.imread(str(lab), cv2.IMREAD_GRAYSCALE) if lab else np.zeros(gray.shape, np.uint8)
            if gray.shape[0] > MAX_ROWS:          # tall strips: a window around the wreck (as in the benchmark)
                wreck_rows = np.where(mask.any(axis=1))[0]
                c = int(wreck_rows.mean()) if len(wreck_rows) else gray.shape[0] // 2
                r0 = int(np.clip(c - MAX_ROWS // 2, 0, gray.shape[0] - MAX_ROWS))
                gray, mask = np.ascontiguousarray(gray[r0:r0 + MAX_ROWS]), np.ascontiguousarray(mask[r0:r0 + MAX_ROWS])
            quality, nadir = None, None
            if params is not None:
                res = clean(gray, params, keep_steps=False, measure_noise=False)
                gray, quality, nadir = res.image, res.quality, res.frame.nadir_col
                mask = res.map_mask(mask)
            if nadir is None:
                b = track_bottom(gray, None)
                nadir = b.nadir_col if b else gray.shape[1] / 2
            gts = mask_boxes(mask)
            for c in candidates_for(gray, None, quality, nadir):
                label = int(any(box_hit(c["box"], g) for g in gts))
                rows.append({"x": c["vec"], "y": label, "sub": None, "rule": c["rule"], "group": f"ai4s/{site}",
                             "line": img.stem, "source": f"ai4shipwrecks/{vname}"})
        if k % 10 == 9:
            print(f"  AI4Shipwrecks {k + 1} strips, {len(rows)} candidates", flush=True)
    return rows


# ---------------------------------------------------------------- training

def metrics(y, p, thr=0.5):
    from sklearn.metrics import average_precision_score, roc_auc_score

    pred = p >= thr
    tp, fp, fn = int(np.sum(pred & (y == 1))), int(np.sum(pred & (y == 0))), int(np.sum(~pred & (y == 1)))
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    # false alarms rejected while keeping 95 % of the real objects
    pos = np.sort(p[y == 1])
    keep95 = pos[int(0.05 * len(pos))] if len(pos) else 1.0
    rejected = float(np.mean(p[y == 0] < keep95)) if np.any(y == 0) else 0.0
    return {"auc": round(float(roc_auc_score(y, p)), 4), "average_precision": round(float(average_precision_score(y, p)), 4),
            "precision": round(prec, 4), "recall": round(rec, 4),
            "f1": round(2 * prec * rec / (prec + rec), 4) if prec + rec else 0.0,
            "false_alarms_rejected_at_95pct_recall": round(rejected, 4)}


def best_threshold(y, p):
    best, best_f1 = 0.5, -1
    for t in np.linspace(0.05, 0.95, 91):
        pred = p >= t
        tp, fp, fn = np.sum(pred & (y == 1)), np.sum(pred & (y == 0)), np.sum(~pred & (y == 1))
        f1 = 2 * tp / (2 * tp + fp + fn) if tp else 0.0
        if f1 > best_f1:
            best, best_f1 = float(t), f1
    return best


def balanced_weights(y, dataset):
    """Every (dataset, class) cell gets the same total weight."""
    w = np.ones(len(y))
    cells = [(d, c) for d in np.unique(dataset) for c in (0, 1) if np.any((dataset == d) & (y == c))]
    for d, c in cells:
        m = (dataset == d) & (y == c)
        w[m] = len(y) / (len(cells) * m.sum())
    return w


def grouped_oof(X, y, groups, dataset, C, n_splits=5):
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import GroupKFold
    from sklearn.preprocessing import StandardScaler

    oof = np.zeros(len(y))
    for tr, te in GroupKFold(n_splits=n_splits).split(X, y, groups):
        sc = StandardScaler().fit(X[tr])
        m = LogisticRegression(C=C, max_iter=5000).fit(sc.transform(X[tr]), y[tr],
                                                        sample_weight=balanced_weights(y[tr], dataset[tr]))
        oof[te] = m.predict_proba(sc.transform(X[te]))[:, 1]
    return oof


def main():
    args = parse_args()
    work, out_dir = Path(args.work_dir), Path(args.out_dir)
    work.mkdir(exist_ok=True, parents=True)
    cache = work / "candidates.json"
    if not args.skip_collect or not cache.exists():
        registry.load()
        t0 = time.time()
        world = World()
        rows = collect_synthetic(args.per_area, world)
        rows += collect_ai4s(args.ai4s_wrecks, args.ai4s_terrain)
        cache.write_text(json.dumps([{**r, "x": [float(v) for v in r["x"]]} for r in rows]))
        print(f"collected {len(rows)} candidates in {time.time() - t0:.0f}s", flush=True)
    rows = json.loads(cache.read_text())

    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import average_precision_score
    from sklearn.model_selection import GroupKFold
    from sklearn.preprocessing import StandardScaler

    X = np.array([r["x"] for r in rows], np.float64)
    y = np.array([r["y"] for r in rows], int)
    groups = np.array([r["group"] for r in rows])
    rule = np.array([r["rule"] for r in rows]) / 100.0
    print(f"{len(y)} candidates: {int(y.sum())} man-made, {int((y == 0).sum())} natural; groups: {len(set(groups))}")

    # grouped cross-validation (a model is always tested on survey areas / wreck sites it never saw); the
    # regularisation strength is picked by the same grouped CV: mean average precision over the datasets
    dataset = np.array([r["source"].split("/")[0] for r in rows])
    w = float(np.clip(args.blend, 0.0, 1.0))

    def per_dataset_ap(p):
        return float(np.mean([average_precision_score(y[dataset == d], p[dataset == d]) for d in np.unique(dataset)]))

    oofs = {C: grouped_oof(X, y, groups, dataset, C) for C in (0.003, 0.01, 0.03, 0.1, 0.3, 1.0)}
    ap_by_c = {C: per_dataset_ap(w * o + (1 - w) * rule) for C, o in oofs.items()}
    C = max(ap_by_c, key=ap_by_c.get)
    alone = oofs[C]
    oof = w * alone + (1 - w) * rule          # what the service scores with
    thr = best_threshold(y, oof)
    cv = {"classifier": metrics(y, oof, thr), "classifier_alone": metrics(y, alone, best_threshold(y, alone)),
          "rules_baseline": metrics(y, rule, 0.5), "decision_threshold": round(thr, 3), "classifier_weight": w,
          "regularisation_C": C, "mean_dataset_ap_by_C": {str(k): round(v, 4) for k, v in ap_by_c.items()},
          "validation": "grouped 5-fold cross-validation (groups: synthetic survey areas, AI4Shipwrecks wreck sites)"}
    by_source = {}
    for src in sorted({r["source"] for r in rows} | {r["source"].split("/")[0] for r in rows}):
        sel = np.array([r["source"] == src or r["source"].startswith(src + "/") for r in rows])
        if len(set(y[sel])) == 2:
            by_source[src] = {"classifier": metrics(y[sel], oof[sel], thr),
                              "classifier_alone": metrics(y[sel], alone[sel], best_threshold(y, alone)),
                              "rules_baseline": metrics(y[sel], rule[sel], 0.5),
                              "candidates": int(sel.sum()), "man_made": int(y[sel].sum())}
    cv["by_dataset"] = by_source
    print(json.dumps(cv, indent=1))

    # final binary model on everything
    sc = StandardScaler().fit(X)
    model = LogisticRegression(C=C, max_iter=5000).fit(sc.transform(X), y, sample_weight=balanced_weights(y, dataset))

    # natural subtype model (synthetic natural candidates with a known seabed kind)
    sub_rows = [(r["x"], r["sub"], r.get("line", r["group"])) for r in rows if r["y"] == 0 and r["sub"] in SUBTYPES]
    subtype = None
    if sub_rows:
        Xs = np.array([x for x, _, _ in sub_rows])
        ys = np.array([s for _, s, _ in sub_rows])
        gs = np.array([g for _, _, g in sub_rows])
        classes = [c for c in SUBTYPES if np.sum(ys == c) >= 10]
        keep = np.isin(ys, classes)
        if len(classes) >= 2:
            Xk, yk, gk = sc.transform(Xs[keep]), ys[keep], gs[keep]
            ms = LogisticRegression(C=0.5, max_iter=5000).fit(Xk, yk)
            coef, icpt = ms.coef_, ms.intercept_
            if len(ms.classes_) == 2:       # binary fit: one row for classes_[1]; as softmax rows (0, w)
                coef = np.vstack([np.zeros_like(coef[0]), coef[0]])
                icpt = np.array([0.0, icpt[0]])
            order = [list(ms.classes_).index(c) for c in classes]
            subtype = {"classes": classes, "coef": coef[order].tolist(), "intercept": icpt[order].tolist(),
                       "counts": {c: int(np.sum(ys == c)) for c in classes}}
            # grouped by survey line: the raw and cleaned copies of a candidate never sit on both sides
            pred = np.empty(len(yk), dtype=object)
            for tr, te in GroupKFold(n_splits=min(5, len(set(gk)))).split(Xk, yk, gk):
                if len(set(yk[tr])) < 2:
                    pred[te] = yk[tr][0]
                    continue
                pred[te] = LogisticRegression(C=0.5, max_iter=5000).fit(Xk[tr], yk[tr]).predict(Xk[te])
            subtype["cv_accuracy"] = round(float(np.mean(pred == yk)), 4)
            subtype["cv_recall"] = {c: round(float(np.mean(pred[yk == c] == c)), 4) for c in classes}
            subtype["majority_baseline"] = round(max(float(np.mean(yk == c)) for c in classes), 4)
            print("subtype classes", subtype["counts"], "grouped cv accuracy", subtype["cv_accuracy"],
                  "(majority class", subtype["majority_baseline"], ")", subtype["cv_recall"])

    out_dir.mkdir(parents=True, exist_ok=True)
    data = {
        "version": "1",
        "trained": date.today().isoformat(),
        "features": list(FEATURES),
        "mean": sc.mean_.tolist(),
        "std": sc.scale_.tolist(),
        "binary": {"coef": model.coef_[0].tolist(), "intercept": float(model.intercept_[0])},
        "blend": {"classifier_weight": w, "rule_score": "app/processing/scoring.py rule_score (0-100)"},
        "subtype": subtype,
        "decision_threshold": round(thr, 3),
        "metrics": cv,
        "training": {"candidates": int(len(y)), "man_made": int(y.sum()), "natural": int((y == 0).sum()),
                     "groups": sorted(set(groups.tolist())),
                     "datasets": "synthetic XTF campaign (raw + AI-profile cleaned) and AI4Shipwrecks test + terrain"},
        "phrases": PHRASES,
    }
    (out_dir / "model.json").write_text(json.dumps(data, indent=1))
    top = sorted(zip(FEATURES, model.coef_[0]), key=lambda kv: -abs(kv[1]))[:10]
    print("strongest evidence:", ", ".join(f"{k} {v:+.2f}" for k, v in top))
    print(f"wrote {out_dir / 'model.json'}")


if __name__ == "__main__":
    main()
