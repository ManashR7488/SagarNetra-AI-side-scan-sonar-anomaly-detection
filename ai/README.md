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
│   │   └── routes/             # system.py, analysis.py, filtering.py, reports.py
│   ├── schemas/forms.py        # AnalyzeRequest / FilterRequest (multipart bodies, validation)
│   ├── services/analysis.py    # use case: georeference -> pipeline -> render -> cache
│   ├── ml/                     # registry.py (model cards, loading), inference.py (tiling, NMS, merge, fusion)
│   ├── processing/             # filters.py, scoring.py, pipeline.py
│   ├── geo/geotagging.py       # pixel -> lat/lon, navigation CSV/JSON parsing
│   ├── readers/                # image.py (decode/encode), xtf.py (raw XTF logs)
│   ├── reporting/              # annotate.py (drawn image), csv_report.py
│   └── storage/cache.py        # in-memory LRU of recent analyses
├── models/                     # trained weights + model_card.json per model
├── tests/                      # unit/ (pure logic) and api/ (HTTP endpoints)
├── notebooks/  tools/          # training notebooks, dataset packaging
├── requirements.txt            # runtime only (onnxruntime): what Vercel installs
└── requirements-dev.txt        # + Ultralytics/PyTorch, export and test tools
```

| Package | Problem-statement component |
|---|---|
| `processing/filters.py` | Noise filtering: Lee / Frost / Kuan / median despeckling, ping-dropout detection and repair, CLAHE, shadow gamma, speckle metrics (speckle index, ENL) |
| `ml/` | Detection + segmentation: YOLO11s detector (6 classes) and YOLO11s-seg wreck segmenter, tiled inference for long strips, NMS, fragment/duplicate merging, mask fusion |
| `processing/scoring.py` | Confidence scoring & false-positive filter: calibrated 0-100 score plus acoustic evidence (shadow, edge linearity, contrast) and model agreement; suppresses marine life, speckle, dropouts |
| `geo/`, `readers/xtf.py` | Geotagging: pixel → lat/lon from XTF ping headers, navigation CSV/JSON, or a simple position + heading + swath; slant-range correction; object size in metres |
| `reporting/` | JSON / CSV reports and annotated images |

Models are loaded from `models/<name>/` (`best.pt` or `best.onnx` + `model_card.json`).

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Status, loaded models, device |
| GET | `/v1/models` | Model cards: classes, thresholds, **real test metrics**, speed |
| POST | `/v1/analyze` | Full pipeline on an image or `.xtf` log (multipart form) |
| POST | `/v1/filter` | Noise-filtration preview (`?output=jpeg` for the image only) |
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
* Scoring: `fp_filter` (default true), `min_score` (default 50), `include_suppressed`, `return_images`

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
               "contrast": 0.84, "model_agreement": true}
}
```

## Configuration (env vars or `ai/.env`)
`SONAR_MODELS_DIR`, `SONAR_DETECTOR`, `SONAR_SEGMENTER`, `SONAR_BACKEND` (`auto`|`pt`|`onnx`), `SONAR_DEVICE`
(`auto`|`cpu`|`0`), `SONAR_MAX_UPLOAD_MB`, `SONAR_CACHE_SIZE`, `SONAR_PREDICT_BATCH`,
`SONAR_CORS_ORIGINS` (default `http://localhost:3000,http://localhost:5000`), `SONAR_API_KEY`, `SONAR_FETCH_HOSTS`,
`SONAR_PREVIEW_MAX_SIDE`, `SONAR_ONNX_THREADS`. See `.env.example`.

## Deploy

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md): Vercel runs this service on onnxruntime (no PyTorch) from
`requirements.txt`; `vercel.json` and `.vercelignore` keep the bundle small.
