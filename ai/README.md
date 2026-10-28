# SonarScan AI Service

FastAPI microservice for **PS 26057 (MoES / NIOT)**: side-scan sonar anomaly detection, noise filtration,
confidence scoring, geotagging and reporting. It is stateless; the Express backend stores results.

## Run

```bash
cd ai
uv pip install -r requirements-dev.txt      # into ai/.venv (runtime + PyTorch backend + tests)
.venv/Scripts/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
```

API docs: http://localhost:8000/docs · Tests: `.venv/Scripts/python -m pytest -q`

## Project layout

```
ai/
├── app/
│   ├── main.py                 # app factory: CORS, lifespan (loads models), routers
│   ├── core/                   # config.py (env settings), logging.py
│   ├── api/
│   │   ├── router.py           # mounts all route modules
│   │   ├── deps.py             # upload reading, sonar decoding, cached-analysis lookup
│   │   └── routes/             # system.py, analysis.py, cleaning.py, filtering.py, reports.py
│   ├── schemas/forms.py        # AnalyzeRequest / CleanRequest / StressRequest / FilterRequest (multipart bodies)
│   ├── services/analysis.py    # use case: georeference -> pipeline -> render -> cache
│   ├── ml/                     # registry.py (model cards, loading), inference.py (tiling, NMS, merge, fusion)
│   ├── cleaning/               # noise-filtering stage 1 + stress test (see "Noise-filtering module")
│   ├── processing/             # filters.py, scoring.py, features.py, shadows.py, fp_classifier.py, pipeline.py
│   ├── geo/geotagging.py       # pixel -> lat/lon, navigation CSV/JSON parsing
│   ├── seabed/                 # 3D seabed model: geometry, shading relief, shadow heights
│   ├── readers/                # image.py (decode/encode), xtf.py (raw XTF logs)
│   ├── reporting/              # annotate.py (drawn image), csv_report.py
│   └── storage/cache.py        # in-memory LRU of recent analyses
├── models/                     # trained weights + model_card.json per model
├── tests/                      # unit/ (pure logic) and api/ (HTTP endpoints)
├── notebooks/  tools/          # training notebooks; tools: synthetic XTF generator, cleaning benchmark, classifier training
├── requirements.txt            # runtime only (onnxruntime): what Vercel installs
└── requirements-dev.txt        # + Ultralytics/PyTorch, export and test tools
```

| Package | Problem-statement component |
|---|---|
| `cleaning/` | Noise filtering, stage 1: dropout / duplicate / gap / motion-limit checks and repair, XTF motion compensation (distance travelled, yaw, pitch), range and ping gain correction, interference removal, water-column masking, surface-echo removal, slant-to-ground range, despeckling, resolution normalisation; noise report and Auto; stress test |
| `processing/filters.py` | Legacy single-call filters (Lee / Frost / Kuan / median, CLAHE, gamma) used by `/v1/filter` and the `denoise` fields |
| `ml/` | Detection + segmentation: YOLO11s detector (6 classes) and YOLO11s-seg wreck segmenter, tiled inference for long strips, NMS, fragment/duplicate merging, mask fusion |
| `processing/scoring.py`, `features.py`, `shadows.py`, `fp_classifier.py` | Confidence scoring & false-positive filter (stage 2): explainable evidence (attached acoustic shadow, edges, contrast, isolation, ripple periodicity, rock clustering, data quality) -> trained classifier -> 0-100 % confidence, natural label (rock / ripples / shadow / texture) and reasons; suppresses marine life, speckle, dropouts, water column |
| `geo/`, `readers/xtf.py` | Geotagging: pixel → lat/lon from XTF ping headers, navigation CSV/JSON, or a simple position + heading + swath; slant-range correction; object size in metres |
| `reporting/` | JSON / CSV reports and annotated images |
| `seabed/` | 3D seabed reconstruction (see below): depth along the track, shading relief, target heights from shadows |

Models are loaded from `models/<name>/` (`best.pt` or `best.onnx` + `model_card.json`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Status, loaded models, device |
| GET | `/v1/models` | Model cards: classes, thresholds, **real test metrics**, speed |
| POST | `/v1/analyze` | Full pipeline on an image or `.xtf` log (multipart form) |
| POST | `/v1/clean` | Noise filtering stage 1: every cleaning step as an image + noise report + Auto decisions (`?output=jpeg&step=…` for one step at full resolution) |
| POST | `/v1/stress-test` | Noise filtering stage 3: one disturbance at increasing levels, detection raw / Auto / full cleaning |
| POST | `/v1/filter` | Legacy filter preview (`?output=jpeg` for the image only) |
| GET | `/v1/analyses/{id}` | Cached result |
| GET | `/v1/analyses/{id}/report.json` · `/report.csv` | Downloadable reports |
| GET | `/v1/analyses/{id}/annotated.jpg` · `/filtered.jpg` | Full-resolution images |

### `POST /v1/analyze` form fields
* `file` (required): png/jpg/tif/bmp/webp image or raw `.xtf` sonar log
* Georeference (optional, in priority order):
  1. `metadata`: navigation CSV/JSON file (one fix per ping)
  2. `latitude`, `longitude`, `heading_deg`, `swath_width_m` (or `across_m_per_px`), `anchor` = `center`|`start`
  3. XTF ping headers (automatic for `.xtf` files)
* `nadir_column`, `along_m_per_px`: geometry overrides
* `models` = `detector,segmenter` · `tiling` = `auto`|`on`|`off`
* Filters: `denoise` = `none`|`lee`|`frost`|`kuan`|`median`, `denoise_strength` 0-100, `clahe`, `clahe_strength`, `repair_dropouts`, `shadow_gamma`
* Scoring: `fp_filter` (default true), `fp_method` = `auto`|`rules`|`classifier`, `min_score` (default 50), `include_suppressed`, `return_images`
* `cleaning`: JSON stage-1 settings (see `/v1/clean`); the image is cleaned before detection, navigation and the 3D
  seabed follow any geometry change, and every detection gets `quality` (data quality at its location)
* `return_seabed` (default true): embed the 3D seabed model

Navigation CSV example (column names are flexible: `lat/latitude`, `lon/longitude`, `heading/hdg`, `row` or `ping`, `altitude`, `slant_range_m`):
```csv
ping,latitude,longitude,heading,altitude
1532,13.08420,80.38240,142.5,6.1
1533,13.08419,80.38241,142.6,6.0
```

### Detection object (abridged)
```json
{
  "id": "DET-001", "class_name": "shipwreck", "category": "Shipwreck", "severity": "high",
  "is_hazard": true, "confidence": 92.8, "status": "confirmed", "suppression_reasons": [],
  "source": "detector+segmenter",
  "bbox": {"x1": 152, "y1": 608, "x2": 658, "y2": 1537, "width": 506, "height": 929},
  "bbox_pct": {"x": 8.8, "y": 31.5, "width": 29.3, "height": 48.2},
  "polygons": [[[x, y], ...]],
  "location": {"latitude": 13.0843, "longitude": 80.3825, "side": "port", "across_track_m": 26.2, "timestamp": null},
  "dimensions": {"across_track_m": 43.9, "along_track_m": 80.7, "area_m2": 6634.2, "area_from": "mask"},
  "evidence": {"model_confidence": 0.79, "calibrated_threshold": 0.179, "shadow": 0.19, "linearity": 0.41,
               "contrast": 0.84, "model_agreement": true, "isolation": 1.3, "periodicity": 2.9, ...},
  "natural": {"method": "classifier", "p_man_made": 0.93, "p_classifier": 0.9, "rule_score": 96.0, "label": null,
              "reasons": ["shadow attached to it", ...]},
  "shadow": {"found": true, "polygon": [[x, y], ...], "length_ratio": 0.8, "solidity": 0.91, ...},
  "quality": {"score": 100, "flags": [], "repaired_pings": 0.0, "motion_flagged": 0.0, "in_water_column": false, ...}
}
```

## Noise-filtering module (Noise Filtration tab)

The PS's *Confidence Scoring & Noise Filtering Module* has three stages. Every number below is measured, and the
scripts that measure it are in `tools/`.

### Stage 1: clean the signal (`app/cleaning/`, `POST /v1/clean`)

`diagnose()` measures the noise first. It looks at:
- speckle: equivalent number of looks and speckle index;
- across-track imbalance (P90/P10) and the port/starboard ratio;
- ping-to-ping jitter and gain steps;
- the interference fraction;
- bad pings;
- the water column.

**Auto** then switches on only the steps those measurements call for. Every decision carries the measured value
that triggered it.

| Step | What it fixes | How |
|---|---|---|
| Bad pings | Lost, half-lost and repeated pings; time gaps; pings beyond attitude limits | Per-row statistics: blank below 8 % of the median row level, one side below 5 %, exact repeats. Letterbox padding and enlarged images are recognised. XTF only: time gaps over 1.8× the ping interval, pitch over 5°, roll over 6° from the median, yaw rate over 4°/s, heave rate over 0.6 m/s. Gaps of up to 40 pings are interpolated from the neighbouring pings |
| Motion (XTF) | Speed changes stretch or squash objects along the track; yaw (crab) and pitch shift the footprint | Distance travelled per ping from the navigation, using windowed slopes over ±2.5 s; a logged speed is scaled to the track length. Course from a ±15 s fit. Rows are resampled to equal along-track spacing. Pitch θ and yaw ψ = heading − course (clipped to ±20°) shift each sample along the track by H·tanθ − side·u·sinψ |
| Interference | Thin bright lines, often slanted, from other acoustic systems | Ridge test against a 5-ping median, 61-px oriented line filters (slopes ±0.12) and hysteresis. Affected pixels are replaced by the 5-ping median, on native pings for XTF |
| Ping gain | Operator gain changes, AGC jumps, ping-to-ping level jitter | A gain step must appear on both sides, be sharp, and be consistent in near and far range (9 of 11 true steps found, 0 false on 56 lines). Per-side jitter is removed |
| Range gain | Residual TVG or beam pattern: dark far range, bright near range | The median level per range bin and side is normalised (strength 0–100) |
| Water column | Fish, bubbles and suspended matter above the seabed | Bottom tracking (see the 3D seabed section), then the water column is masked |
| Surface echo | Sea-surface return of towed sonars | XTF sonar depth gives the surface range. A continuous bright ridge there (at least 20 pings) is replaced by the level beside it |
| Ground range | Slant-range compression near the nadir | u = √(r² − H²) per ping, using the bottom-tracked or logged altitude |
| Despeckle | Speckle | Lee, Frost, Kuan, median or non-local means |
| Resolution | Pixel sizes that differ between sonars, ranges and files | Both axes are resampled to a standard pixel size (default 0.10 m) when the scale is known |
| Display (Analyst view only) | Dark shadows, flat contrast | Shadow gamma and CLAHE |

There are two profiles:
* **AI input** is what the detector sees. A step is used only when its noise is present **and** the benchmark
  below showed that it improves detection (`app/cleaning/profile.json`). The detector was trained on raw,
  speckled sonar, so a step that makes the picture look cleaner can still cost detections.
* **Analyst view** is what a person sees: every step whose noise is present, including ground range,
  despeckling and contrast enhancement.

Every geometric change is recorded in the `Frame`: row map, column scale, nadir and pixel size. Geotags, masks,
the 3D seabed and the navigation therefore follow the cleaned image. The pipeline also builds a per-row
data-quality map: repaired, time gap, motion, interference, unrepaired and water column. The noise report holds
the before/after metrics, the sub-scores and a 0–100 quality score, plus across-track and per-ping profiles and
(for XTF) the motion series.

**Benchmark** (`tools/benchmark_cleaning.py`). Every configuration runs the full production detection and
scoring on two datasets:
- 21 synthetic XTF lines with 88 man-made targets, where a hit must geotag onto the object;
- 46 real AI4Shipwrecks strips with 159 wreck parts.

Each step is compared with the cleaning pass with every step off ("none", data-quality rules active). A step
**helps** when the mean F1 rises by more than 0.005 and recall does not fall by more than 0.02 on either dataset.
The proven steps are then validated together. Scoring is the rule-based filter throughout; the classifier is
evaluated separately below.

| Step | Synthetic XTF: ΔF1 · Δrecall · Δfalse alarms | AI4Shipwrecks: ΔF1 · Δrecall · Δfalse alarms | Verdict | AI input |
|---|---|---|---|---|
| Bad-ping repair | +0.001 · −0.011 · −6 | 0 · 0 · 0 (no dropouts) | no gain | ✓ (repairs a data fault) |
| Motion compensation | **+0.011** · +0.011 · 0; geotag p90 13.5 → 12.4 m | – (images have no motion records) | **helps** | ✓ |
| Interference removal | **+0.006** · 0 · −3 | **+0.021** · +0.019 · +1 | **helps** | ✓ |
| Range gain | **+0.007** · +0.011 · +2 | **+0.048** · +0.038 · −2 | **helps** | ✓ |
| Ping gain | −0.021 · −0.023 · −1 | +0.041 · +0.032 · −2 | no gain (costs synthetic recall) | – |
| Water-column mask | +0.002 · 0 · −1 | 0 · 0 · 0 | no gain | – |
| Ground range | −0.047 · 0 · +29 | −0.017 · −0.018 · −3 | no gain | – |
| Despeckle (Lee, strength 30) | −0.040 · −0.045 · −3 | +0.006 · −0.006 · −9 | no gain | – |
| Resolution (0.10 m) | −0.047 · −0.045 · +1 | – (pixel size unknown) | no gain | – |
| **The four AI-input steps, always on** | −0.002 · 0 · +1 | **+0.054** · **+0.044** · −1 | **validated** | |
| **Auto as it runs** (each step only where its noise is measured) | **+0.030** · +0.034 · +1 | **+0.057** · **+0.044** · −3 | **validated** | |

Against the service before this module (no cleaning pass), Auto as it runs:
- **AI4Shipwrecks:** F1 0.330 → **0.387**; 7 more wreck parts found (recall 0.226 → 0.270); false alarms 23 → 20.
- **Synthetic XTF:** F1 0.299 → **0.329**; one more target found (recall 0.284 → 0.295); false alarms 54 → 44;
  median geotag error 4.4 → 3.0 m.

For XTF the cleaning pass renders the waterfall from the native pings (linear interpolation along the track). Even
"none" therefore differs slightly from the reader's image. The synthetic raw → "none" change (2 fewer targets, 11
fewer false alarms) comes from that rendering, not from the data-quality rules; on the image strips "none" and raw
are identical.

What the benchmark says:
- **Despeckling, ground range and resampling make the image look cleaner but cost detections.** The detector learned
  on raw, speckled, slant-range sonar. These steps are in the Analyst view only.
- **Removing artefacts without touching the texture helps most on real data.** That covers interference lines and
  the across-track gain imbalance.
- **Ping gain is a judgement call.** It finds 5 more wreck parts in the real strips but loses 2 of the 88 synthetic
  targets. The rule leaves it out of the AI input; an analyst can switch it on.
- **Measuring first pays off.** Applying each step only where its noise is measured (Auto) beats applying the same
  steps to every file: synthetic F1 +0.030 instead of −0.002.

### Stage 2: false alarms (`processing/shadows.py`, `features.py`, `fp_classifier.py`, `scoring.py`)

Detection runs on the AI-input image. Every candidate then gets the evidence of a standing man-made object:
* **Acoustic shadow, segmented.** The dark region behind the object on the far-range side. Its outline, length,
  area, solidity, edge sharpness and darkness are recorded, along with whether it is attached to the object. The
  shadow length gives the object height (see the 3D seabed section).
* **Shape and texture.** Straight edges, contrast, aspect ratio, inside/outside texture ratio.
* **Surroundings.** Isolation (does the same texture continue around it?), ripple periodicity, orientation
  coherence, and the density and similarity of neighbouring blobs (rock clusters).
* **Data quality at its location.** Repaired pings, time gaps, motion-flagged pings, interference, water column,
  nearness to the nadir.

A small logistic classifier over these 38 features (`models/fp_classifier/model.json`, pure numpy at run time)
gives P(man-made). Averaged 50/50 with the rule score (see below), it becomes the 0–100 % confidence, with the
F1-optimal decision threshold mapped to 50 (as for the detector calibration). A second model labels rejected candidates as **rock cluster**, **sand
ripples**, **natural acoustic shadow** or **seabed texture**. The largest feature contributions become the
plain-language reasons. Without `model.json` the hand-set rules are used (`fp_method=rules`). The response says
which filter was used, with its validation (`processing.false_alarm_filter`).

Training (`tools/train_fp_classifier.py`) uses every candidate above half its class threshold:
- **Synthetic XTF**, raw and AI-cleaned. Ground truth is the simulated world itself: man-made when the candidate
  geotags onto a man-made object; otherwise the kind of seabed under it.
- **Real AI4Shipwrecks**: the test split plus wreck-free terrain. The detector and segmenter never saw these
  strips, so their candidates look like deployment candidates.

Validation is grouped 5-fold cross-validation, where the groups are survey areas and wreck sites, so every score
comes from places the model never saw. There are 1,115 candidates: 418 man-made and 697 natural.

| Candidates | Score | AUC | Average precision | F1 | False alarms rejected at 95 % recall |
|---|---|---|---|---|---|
| Real AI4Shipwrecks (429; 205 man-made) | Rules (before) | 0.722 | 0.712 | 0.660 | 8 % |
| | Classifier alone | 0.686 | 0.698 | 0.669 | 21 % |
| | **Blend (used)** | **0.730** | **0.729** | **0.665** | **14 %** |
| Synthetic XTF (686; 213 man-made) | Rules (before) | 0.522 | 0.315 | 0.483 | 14 % |
| | Classifier alone | 0.734 | 0.519 | 0.554 | 16 % |
| | **Blend (used)** | **0.665** | **0.461** | **0.539** | 13 % |

On its own, the classifier ranks real candidates slightly worse than the rules, because it also learns cues of the
simulator. The confidence is therefore a 50/50 blend of the classifier and the rule score. The blend is at least as
good as the rules on both datasets. The gain on real data is small: the filter can only re-rank what the detector
proposes.

The strongest evidence:
- **Towards man-made:** model confidence, and a dark acoustic shadow with sharp edges.
- **Towards natural:** a candidate cut by the image edge, ripple periodicity, and dense fields of similar blobs.

The natural-subtype model is right 79 % of the time on survey lines it never saw (the majority class alone is 46 %):

| Subtype | Correct |
|---|---|
| Rock | 84 % |
| Sand ripples | 74 % |
| Natural shadow | 93 % |
| Seabed texture | 56 % |

The classifier learns from the AI4Shipwrecks test strips. End-to-end scores on that split therefore now include a
component trained on it; the honest numbers for the classifier are the cross-validated ones above. The detector's
own test metrics (`/v1/models`) are unaffected.

The operator can still confirm or reject any candidate. The live threshold slider re-decides kept/rejected without
re-running the AI, and the scan is published to AI Detection with these decisions. The JSON and CSV reports carry
the following per detection: natural label, P(man-made), reasons, shadow, data-quality score and flags, and the
AI's original verdict.

### Stage 3: stress test (`cleaning/stress.py`, `POST /v1/stress-test`)

One disturbance is added to a region of the scan at increasing strength:
- **Speckle:** multiplicative gamma speckle;
- **Ping dropouts and motion:** lost and half-lost pings, heave (pings shifted in range), and roll (one side
  brighter, the other darker);
- **Lower resolution:** down- and up-sampling;
- **Gain and stripes:** a far-range TVG error, gain drift, an operator gain step and interference bursts.

Three pipelines run on every level: **raw**, **Auto** (the AI-input profile chosen for the disturbed image) and
**full cleaning** (the analyst steps without the geometric ones). Each pipeline is compared with its own detections
on the undisturbed region, because cleaning changes what the detector finds even without a disturbance. For each,
the module reports:
- how many of those detections are still found (IoU ≥ 0.3, or the same centre);
- their confidence;
- detections that were not there before (likely false alarms).

The disturbances are seeded, so a run is repeatable.

**Measured** with `tools/eval_stress.py` on 24 real AI4Shipwrecks strips. Each strip is tested in a 1,024-px region
centred on its largest wreck part, so no pipeline is favoured; there are 70 wreck parts in all. Cells give the wreck
parts found, with false alarms in brackets:

| Disturbance | Level | No cleaning | Auto (AI input) | Full cleaning |
|---|---|---|---|---|
| none | undisturbed | 40 % (7) | **46 % (5)** | 37 % (2) |
| Speckle | 8 / 3 / 1.5 / 1 looks | 39 · 34 · 34 · 33 % | **44 · 44 · 37** · 30 % | 39 · 37 · 34 · 31 % |
| Lost pings + heave + roll | 1 / 3 / 6 / 10 % | 40 · 40 · 30 · 36 % | **47 · 44 · 44 · 40 %** | 39 · 37 · 39 · 33 % |
| Coarser resolution | 1.5 / 2 / 3 / 4× | 36 · 31 · 29 · 26 % | 37 · 31 · 31 · 21 % | 34 · 31 · 27 · 24 % |
| Gain errors + interference | mild → severe | 40 · 40 · 36 · 34 % | **43 · 44** · 34 · 31 % | 39 · 37 · 33 · 31 % |

What the stress test says:
- **Auto keeps its lead under moderate disturbance.** With 6 % of the pings lost it finds 44 % of the wreck parts
  against 30 % without cleaning; under 3-look speckle, 44 % against 34 %.
- **At the extremes cleaning cannot restore lost information.** That means single-look speckle, 4× coarser pixels and
  severe gain errors. There the three pipelines converge, and Auto can fall a little behind raw.
- **Coarser resolution hurts most.** At 4× coarser pixels only 21–26 % of the wreck parts are found, whatever the
  cleaning. The fix is to retrain the detector at several scales.
- **Full cleaning gives the fewest false alarms at almost every level** (1–4 over all 24 regions) and is the most
  stable, keeping 82–96 % of its own detections at most levels. It still finds the fewest wreck parts. Stability is
  not accuracy.

The sample is small (70 wreck parts), so differences of one or two parts are noise. The results are in
`tools/benchmark_results/stress_summary.json`.

### Deployment

Everything is numpy, SciPy and OpenCV, and the classifier is a JSON file. The same code runs on an edge computer
and on Vercel. On Vercel, set smaller previews and a smaller stress test (`SONAR_STRESS_MAX_SIDE=1024`,
`SONAR_STRESS_LEVELS=3`, see [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md)).

```bash
.venv/Scripts/python tools/benchmark_cleaning.py       # about 2 h on a laptop CPU; writes app/cleaning/profile.json
.venv/Scripts/python tools/train_fp_classifier.py      # about 1 h; writes models/fp_classifier/model.json
.venv/Scripts/python tools/eval_stress.py              # about 25 min; writes tools/benchmark_results/stress_summary.json
```

## 3D seabed model (`seabed` in the analyze response)
Side-scan sonar records echo strength, not depth, so the model combines several sources and says which is which:

| Part | How | Status |
|---|---|---|
| Depth along the track | sensor depth + altitude from the XTF ping headers or a navigation file (`towfish_depth` / `water_depth` columns) | **measured** (`kind: "measured"`); otherwise elevations are relative (`kind: "relative"`) |
| Sonar altitude, nadir | logged altitude, **checked against the image**; or **bottom-tracked** from the first seabed return when the data has none (plain images) | measured (`altitude.source`: `logged`, `logged+image`, `image`, `assumed`) |
| Seabed relief | shape-from-shading of the slant-range-corrected backscatter (Lambertian incidence model, leaky integration outward from the nadir, high-passed, ≤ 2 m) | estimated |
| Target heights | acoustic shadow length: `h = H · Ls / (Rt + Ls)` (altitude H, shadow length Ls, range to shadow Rt) | measured from the image; `null` when there is no clear shadow |
| Least depth over a target | shallowest point of the raised target (depth − height) | measured when depth is measured |

**Bottom tracking** (`app/seabed/bottom.py`) finds the water column and the first seabed return in every ping. It skips the
transmit ring-down at the nadir and the sea-surface echo of towed sonars, rejects fish / targets under the vehicle and
dropped pings, and refuses images that are not side-scan waterfalls (crops, forward-looking sonar). It gives plain
images a real nadir, altitude and slant-range correction (also used for geotagging), and verifies the logged altitude of
XTF files (the logged value is kept, and a disagreement is reported).

**Real-data checks** (no ground truth, success rate of the geometry): water column and bottom found in **92.7 %** of
286 real AI4Shipwrecks AUV strips and **97.9 %** of 1,170 real side-scan field tiles (2010-2021).

**Accuracy on the synthetic campaign** (`tools/eval_seabed.py`, labelled boxes, 14 lines, each scored twice):

| | XTF log (navigation + altitude) | Plain image (pixels + swath width only) |
|---|---|---|
| Bottom-tracked altitude vs logged | median 2.5 cm (14/14 lines) | median 2.5 cm (14/14 lines) |
| Target height | median 6.5 cm, p90 0.55 m | median 6.0 cm, p90 0.56 m |
| Targets with a measurable shadow | 46/72 | 46/72 |
| Water depth | median 1.7 cm | relative only |

Response block: `grid` (rows = along-track distance, columns = ground range, port negative), `elevation` (uint16
little-endian, base64, `metres = value · scale + offset`), `texture` (ground-range sonar JPEG), `track` (≤ 400 samples
of lat/lon/heading/altitude/depth), `targets` (position, size, height, least depth), `altitude` (range, source, check),
`geometry` (where each quantity came from), `coverage` (covered / dropout fractions, near-nadir zone), `methods`,
`assumptions`. Each detection also gets `height` (`height_m`, `shadow_length_m`, `least_depth_m`, `method`).
For plain images send `swath_width_m` to scale the model (without it a 100 m swath is assumed and flagged).
About 0.5–1 s per survey line.

## Configuration (env vars or `ai/.env`)
`SONAR_MODELS_DIR`, `SONAR_DETECTOR`, `SONAR_SEGMENTER`, `SONAR_BACKEND` (`auto`|`pt`|`onnx`), `SONAR_DEVICE`
(`auto`|`cpu`|`0`), `SONAR_MAX_UPLOAD_MB`, `SONAR_CACHE_SIZE`, `SONAR_PREDICT_BATCH`,
`SONAR_CORS_ORIGINS` (default `http://localhost:3000,http://localhost:5000`), `SONAR_API_KEY`, `SONAR_FETCH_HOSTS`,
`SONAR_PREVIEW_MAX_SIDE`, `SONAR_ONNX_THREADS`, `SONAR_SEABED_MAX_CELLS` (default 262144),
`SONAR_SEABED_TEXTURE_SIDE` (default 1024), `SONAR_CLEAN_PREVIEW_SIDE` (default 1600), `SONAR_CLEAN_PREVIEW_QUALITY`
(80), `SONAR_CLEAN_RESPONSE_BUDGET_MB` (3.6: step previews shrink to fit), `SONAR_STRESS_MAX_SIDE` (1600),
`SONAR_STRESS_LEVELS` (4). See `.env.example`.

## Deploy

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md): Vercel runs this service on onnxruntime (no PyTorch) from
`requirements.txt`; `vercel.json` and `.vercelignore` keep the bundle small.
