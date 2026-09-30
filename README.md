# SagarNetra (सागरनेत्र): AI eyes on the seabed

AI-powered detection, geotagging and reporting of marine debris, wrecks and hazards in side-scan sonar
surveys. Smart India Hackathon 2026, problem statement **26057** (Ministry of Earth Sciences / NIOT).

| Folder | What | Stack |
|---|---|---|
| [`client/`](client) | Dashboard and landing page (3D survey story) | React 19, Vite, Tailwind, three.js, Leaflet |
| [`server/`](server) | REST API: missions, scans, detections, reports | Express 5, MongoDB, Cloudinary |
| [`ai/`](ai) | Inference microservice: detection, noise filtering, scoring, geotagging | FastAPI, YOLO11 (ONNX / PyTorch) |
| [`data/`](data) | Synthetic XTF survey lines (3 demo lines; the generator rebuilds all 56) | |
| [`docs/`](docs) | [Deployment](docs/DEPLOYMENT.md), [gap analysis](docs/GAP_ANALYSIS.md) | |

```
React client ──► Express API ──► FastAPI AI service (YOLO11 detector + wreck segmenter)
                    │
                    ├──► MongoDB (missions, scans, detections)
                    └──► Cloudinary (sonar files, annotated & filtered images)
```

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
