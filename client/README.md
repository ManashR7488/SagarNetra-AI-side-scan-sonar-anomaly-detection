# SonarScan Client (React + Vite)

Operator console for PS 26057: upload side-scan sonar images / XTF logs, run the AI, review detections on a map,
plan the cleanup route and export reports. All data comes from the Express backend (`server/`), which calls the
FastAPI AI service (`ai/`) and stores results in MongoDB.

## Run

```bash
cd client
npm install
npm run dev          # http://localhost:3000
```
The dev server proxies `/api` and `/uploads` to the backend (`VITE_BACKEND_URL`, default `http://localhost:5000`),
so the backend, MongoDB and the AI service must be running too. See `.env.example`.

## Structure

```
src/
├── config/axios.js      # axios instance, error normalisation (ApiError), envelope helpers
├── api/index.js         # systemApi, missionsApi, scansApi, detectionsApi, filterApi
├── store/               # zustand stores
│   ├── useMissionStore      active mission (persisted), mission list, create
│   ├── useSystemStore       backend / AI / DB health polling, AI model cards
│   ├── useWorkspaceStore    AI Detection workspace: local files + saved scans, analyse / batch / re-analyse
│   ├── useGeoStore          Geo Tag: geotagged detections, filters, route start, operator review
│   ├── useDashboardStore    aggregated stats + latest detections
│   ├── useFilterStore       Noise Filtration: source image, parameters, result
│   └── useToastStore        notifications
├── components/          # DetectionViewer (boxes + masks over the image), SonarMap (Leaflet + cleanup route),
│                        # MissionPanel, SystemStatus, GeoreferenceDialog, Modal, Toaster
├── pages/               # HomePage, ApplicationPage (sidebar), tabs/ (AI Detection, Noise Filtration, Geo Tag, Dashboard)
├── data/sonarData.js    # bundled sample images + clearly-labelled demo positions
└── utils/               # formatting, class/severity metadata, downloads
```

## Tabs
* **AI Detection**: load images / XTF logs or samples, set the georeference, Predict (single / batch, 2 at a time),
  view detections (boxes, masks, suppressed candidates) or the server-rendered image, map of geotagged detections, JSON/CSV report.
* **Noise Filtration**: server-side Lee / Frost / Kuan / median despeckling, ping-dropout repair, CLAHE, shadow gamma, with real speckle metrics.
* **Geo Tag**: mission map of stored detections with filters, optimal cleanup route (nearest neighbour + 2-opt), review workflow
  (verify / schedule cleanup / cleared / false positive), CSV / GeoJSON / cleanup-plan export.
* **Dashboard**: detection statistics from MongoDB and the detector's real test-set metrics from its model card.
