# SonarScan API (Express backend)

Connects the React client, MongoDB and the FastAPI AI service (`ai/`). Every client request goes to this
backend; it validates, calls the AI microservice, stores files in Cloudinary and results in MongoDB.

```
React client ──► Express API (:5000) ──► FastAPI AI service (:8000)
                      │
                      ├──► MongoDB (missions, scans, detections)
                      └──► Cloudinary (originals, annotated & filtered images)
```

## Run

```bash
cd server
npm install
cp .env.example .env        # then fill in the Cloudinary keys
npm run dev                 # or: npm start
```
Also start MongoDB (local Windows service) and the AI service (`cd ai && .venv/Scripts/python -m uvicorn app.main:app --port 8000`).
Without Cloudinary keys the server stores files in `server/uploads/` and serves them at `/uploads`.

Tests (MongoDB test database + mock AI service): `npm test`

## Layout

```
src/
├── server.js            # connect DB, start HTTP server, graceful shutdown
├── app.js               # middleware stack, routes, error handling
├── config/              # env.js (validated env), db.js (Mongoose), cloudinary.js
├── models/              # Mission, Scan, Detection (+ shared GeoJSON / stored-file sub-schemas)
├── routes/              # URL -> middleware -> controller wiring
├── controllers/         # thin HTTP handlers
├── services/            # ai.service (FastAPI client), storage.service (Cloudinary/local),
│                        # scan.service (upload -> analyse -> store), detection.service (queries, stats, CSV),
│                        # mission.service (CRUD, stats)
├── middlewares/         # upload (multer), validate (zod), errorHandler, rateLimiter
├── validators/          # zod schemas for bodies / queries / params
└── utils/               # ApiError, constants, mappers (AI -> Mongo), csv, pagination, response, logger
```

## Data model

**Mission** (survey campaign) → many **Scans** (one uploaded file each) → many **Detections**.

| Collection | Key fields |
|---|---|
| `missions` | name (unique), region, status, platform {name, type}, sonar {model, frequencyKhz}, defaults {swathWidthM, headingDeg}, stats {scans, detections, confirmed, hazards, maxSeverity, lastScanAt} |
| `scans` | mission, status (processing/completed/failed), error, warnings, source {filename, format, size, width, height, file, metadataFile, sonar}, options (analysis params + georef), georeference {available, source, start/end GeoJSON Points, track LineString, resolutions, times, assumptions}, summary, processing {aiAnalysisId, models, tiled, timings, filters, durationMs}, images {annotated, filtered} |
| `detections` | scan, mission, code, className, category, severity, isHazard, sourceModel, confidence (0-100), status (confirmed/suppressed), suppressionReasons, evidence {modelConfidence, threshold, shadow, linearity, contrast, modelAgreement}, bbox, bboxPct, centroidPx, polygons, **location (GeoJSON Point, 2dsphere)**, geo {side, acrossTrackM, vehicleLocation, heading, altitude, timestamp}, dimensions {acrossTrackM, alongTrackM, areaM2}, review {status, notes, reviewedBy, reviewedAt} |

Detections are their own collection (not embedded) so they can be queried across scans/missions: map
queries (`near`, `bbox`), dashboard aggregations and the review queue. Review statuses:
`unreviewed → verified | false_positive → cleanup_scheduled → cleared`.

## API

All JSON responses: `{ success: true, data, meta? }` or `{ success: false, error: { code, message, details? } }`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Backend, MongoDB, AI service and storage status |
| GET | `/api/models` | AI model cards (classes, thresholds, **real test metrics**) for the dashboard |
| GET/POST | `/api/missions` | List (`?status&search&page&limit`) / create |
| GET/PATCH/DELETE | `/api/missions/:id` | Get / update / delete (cascades to scans, detections, files) |
| GET | `/api/missions/:id/report.csv` | All detections of a mission |
| GET | `/api/scans` | List (`?missionId&status&page&limit`) |
| POST | `/api/scans` | **Upload + analyse** (multipart, see below). Returns the scan with its detections |
| GET/DELETE | `/api/scans/:id` | Scan + detections (`?includeSuppressed=false`) / delete |
| POST | `/api/scans/:id/reanalyze` | Re-run the AI on the stored original with new options (JSON body, same fields) |
| GET | `/api/scans/:id/report.json` · `/report.csv` | Downloadable reports |
| GET | `/api/detections` | Query detections (filters below), paginated |
| GET | `/api/detections/geojson` | GeoJSON FeatureCollection for the map |
| GET | `/api/detections/stats` | Dashboard aggregations: totals, byClass, bySeverity, byReview, suppressedByReason, confidenceHistogram, timeline |
| GET | `/api/detections/export.csv` | CSV export of any filtered set |
| GET | `/api/detections/:id` | One detection (with scan + mission) |
| PATCH | `/api/detections/:id/review` | `{ status, notes?, reviewedBy? }` |
| POST | `/api/filter` | Noise-filtration preview (multipart `file` + filter fields; `?output=jpeg` for the image only). Not stored |

### `POST /api/scans` (multipart/form-data)
* `file` (required): sonar image (png/jpg/tif/bmp/webp) or `.xtf` log · `metadata` (optional): navigation CSV/JSON
* `missionId` (optional; defaults to the auto-created "General Survey"), `name`
* Georeference: `latitude`, `longitude`, `headingDeg`, `swathWidthM`, `acrossMPerPx`, `alongMPerPx`, `nadirColumn`, `anchor` (`center`|`start`). Missing swath/heading fall back to the mission defaults.
* Analysis: `models` (`detector,segmenter`), `tiling`, `denoise` (`none|lee|frost|kuan|median`), `denoiseStrength`, `clahe`, `claheStrength`, `repairDropouts`, `shadowGamma`, `fpFilter`, `minScore`

### Detection filters (`/api/detections`, `/geojson`, `/stats`, `/export.csv`)
`missionId, scanId, className (comma list), severity (list), status, reviewStatus (list), hazardOnly, hasLocation,
minConfidence, maxConfidence, bbox=minLon,minLat,maxLon,maxLat, near=lon,lat & radiusM, from, to, sortBy
(confidence|createdAt|className|code), order, page, limit`

## Deploy

See [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md). On Vercel the default export of `src/app.js` is served as one
function (lazy MongoDB connection); Cloudinary is required and large files are uploaded by the browser directly.
