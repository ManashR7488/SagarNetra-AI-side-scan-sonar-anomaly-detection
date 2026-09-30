import express from 'express';
import multer from 'multer';

/** Minimal stand-in for the FastAPI service: records requests, returns canned results. */
export async function startMockAi() {
  const state = { calls: [], mode: 'ok', analysisCount: 0 };
  const app = express();
  const upload = multer({ storage: multer.memoryStorage() });

  app.get('/health', (_req, res) => res.json({ status: 'ok', models_loaded: ['detector', 'segmenter'], device: 'cpu', backend: 'pt' }));
  app.get('/v1/models', (_req, res) => res.json({ detector: { name: 'sonar_detector', classes: ['shipwreck'] } }));

  app.post('/v1/analyze', upload.any(), (req, res) => {
    state.calls.push({ path: '/v1/analyze', body: { ...req.body }, files: req.files.map((f) => ({ field: f.fieldname, name: f.originalname, size: f.size })) });
    if (state.mode === 'bad_input') return res.status(422).json({ detail: 'Unsupported or corrupted image file' });
    if (state.mode === 'crash') return res.status(500).json({ detail: 'boom' });
    state.analysisCount += 1;
    const georef = req.body.latitude !== undefined;
    const result = cannedResult(`mock${state.analysisCount}`, georef, Number(req.body.min_score ?? 50));
    // Like the real service: result images inline when return_images=true.
    if (req.body.return_images === 'true') result.images = { annotated: JPEG_DATA_URL, filtered: JPEG_DATA_URL };
    res.json(result);
  });

  app.post('/v1/filter', upload.any(), (req, res) => {
    state.calls.push({ path: '/v1/filter', body: { ...req.body }, query: req.query });
    if (req.query.output === 'jpeg') return res.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    res.json({ params: req.body, quality_before: { speckle_index: 0.5 }, quality_after: { speckle_index: 0.3 } });
  });

  app.get('/v1/analyses/:id/:kind', (req, res) => {
    state.calls.push({ path: req.path });
    res.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  });

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => server.close(r)) };
}

const JPEG_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;

function cannedResult(id, georef, minScore) {
  const loc = (lat, lon) => (georef ? {
    latitude: lat, longitude: lon, side: 'starboard', across_track_m: 21.5, vehicle_latitude: 13.08,
    vehicle_longitude: 80.38, vehicle_heading_deg: 0, altitude_m: 5, timestamp: '2026-09-29T10:00:21.000Z',
  } : null);
  const det = (n, cls, conf, status, lat, lon, extra = {}) => ({
    id: `DET-00${n}`, class_name: cls, category: cls, severity: cls === 'marine_life' ? 'none' : 'high',
    is_hazard: cls !== 'marine_life', confidence: conf, status, suppression_reasons: status === 'suppressed' ? ['natural_feature'] : [],
    source: 'detector', evidence: { model_confidence: conf / 100, calibrated_threshold: 0.2, shadow: 0.3, linearity: 0.5, contrast: 0.4 },
    bbox: { x1: 10, y1: 20, x2: 110, y2: 220, width: 100, height: 200 }, bbox_pct: { x: 1, y: 1, width: 10, height: 20 },
    centroid_px: { x: 60, y: 120 }, polygons: [[[10, 20], [110, 20], [110, 220]]], location: loc(lat, lon),
    dimensions: georef ? { across_track_m: 8.7, along_track_m: 17.4, area_m2: 120.5, area_from: 'mask' } : null,
    ...extra,
  });
  const detections = [
    det(1, 'shipwreck', 92.5, 'confirmed', 13.081, 80.381),
    det(2, 'mine_like_object', minScore > 60 ? 55 : 71.2, minScore > 60 ? 'suppressed' : 'confirmed', 13.2, 80.5),
    det(3, 'marine_life', 40.1, 'suppressed', 13.0811, 80.3811),
  ];
  const confirmed = detections.filter((d) => d.status === 'confirmed');
  return {
    analysis_id: id,
    source: { filename: 'x.png', format: 'png', width: 1728, height: 1929 },
    georeference: georef
      ? {
        available: true, source: 'simple', start: { latitude: 13.08, longitude: 80.38 }, end: { latitude: 13.0815, longitude: 80.38 },
        track_length_m: 167.4, mean_heading_deg: 0, across_track_m_per_px: 0.0868, along_track_m_per_px: 0.0868,
        nadir_column: 864, slant_range_corrected: false, start_time: null, end_time: null, assumptions: ['square pixels assumed'],
      }
      : { available: false, reason: 'No navigation metadata supplied' },
    summary: {
      candidates: 3, confirmed: confirmed.length, suppressed: 3 - confirmed.length, hazards: confirmed.length,
      by_class: Object.fromEntries(confirmed.map((d) => [d.class_name, 1])), suppressed_by_reason: { natural_feature: 1 },
      max_severity: 'high', mean_confidence: 81.9,
    },
    processing: { models: { detector: { name: 'sonar_detector' } }, tiled: true, tiles: 6, timings: { total_ms: 3000 }, filters: {} },
    detections,
    links: {},
  };
}
