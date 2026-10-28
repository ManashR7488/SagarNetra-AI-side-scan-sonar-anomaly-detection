# SagarNetra (सागरनेत्र): AI eyes on the seabed

AI-powered detection, geotagging and reporting of marine debris, wrecks and hazards in side-scan sonar
surveys. Smart India Hackathon 2026, problem statement **26057** (Ministry of Earth Sciences / NIOT).

| Folder | What | Stack |
|---|---|---|
| [`client/`](client) | Dashboard (AI detection, noise filtration, geotag map, **3D seabed**) and landing page | React 19, Vite, Tailwind, three.js, Leaflet |
| [`server/`](server) | REST API: missions, scans, detections, reports | Express 5, MongoDB, Cloudinary |
| [`ai/`](ai) | Inference microservice: detection, noise filtering, scoring, geotagging, 3D seabed model | FastAPI, YOLO11 (ONNX / PyTorch) |
| [`data/`](data) | Synthetic XTF survey lines (3 demo lines; the generator rebuilds all 56) | |
| [`docs/`](docs) | [Deployment](docs/DEPLOYMENT.md), [gap analysis](docs/GAP_ANALYSIS.md) | |

```
React client ──► Express API ──► FastAPI AI service (YOLO11 detector + wreck segmenter)
                    │
                    ├──► MongoDB (missions, scans, detections)
                    └──► Cloudinary (sonar files, annotated & filtered images, 3D seabed heightfields)
```

**3D Seabed module** (`/app/seabed-3d`): every analysed scan is rebuilt as a 3D seabed. Depth along the track comes
from the navigation (XTF sensor depth + altitude), the sonar altitude and nadir from bottom tracking of the image itself
(so plain sonar images work too), relief from the sonar shading, and each target's height and least depth from its
acoustic shadow. Strips are laid on their real tracks (north up) and overlapping lines of a mission merge into one view.
Orbit, fly along the AUV track, inspect a target next to its 2D sonar crop, measure distance / depth change / slope /
bearing, show coverage gaps, check the recommended line spacing, and save a labelled snapshot for reports. Measured and
estimated parts are labelled; see [ai/README.md](ai/README.md#3d-seabed-model-seabed-in-the-analyze-response).

**Noise Filtration module** (`/app/noise-filtration`) is the PS's *Confidence Scoring & Noise Filtering Module*, in
three stages:
1. **Clean the signal.** Auto measures the noise (speckle, gain, interference, bad pings, water column, XTF motion)
   and switches on only the steps that are needed. Each step is shown with a before/after slider and a noise report.
   The detector's input uses only the steps a benchmark proved help detection: on real AI4Shipwrecks strips, F1 rose
   from 0.33 to 0.39, with 7 more wreck parts found.
2. **Reject false alarms.** Detection runs on that input. Every candidate gets its acoustic shadow segmented and a
   confidence from a classifier blended with the evidence rules. Rejected candidates get a natural label (rock,
   ripples, shadow or texture) and the reasons. The operator confirms or rejects candidates, then sends the scan to
   AI Detection.
3. **Stress test.** Speckle, dropouts and motion, lower resolution, or gain errors are added at increasing
   strength, and detections are compared with and without cleaning.

See [ai/README.md](ai/README.md#noise-filtering-module-noise-filtration-tab).

## Run locally

```bash
cd ai && uv pip install -r requirements-dev.txt && .venv/Scripts/python -m uvicorn app.main:app --port 8000
cd server && npm install && cp .env.example .env && npm run dev      # http://localhost:5000
cd client && npm install && npm run dev                              # http://localhost:3000
```

Tests: `cd ai && .venv/Scripts/python -m pytest -q` · `cd server && npm test`

## Deploy

Three Vercel projects from this repo (root directories `ai`, `server`, `client`); see
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
