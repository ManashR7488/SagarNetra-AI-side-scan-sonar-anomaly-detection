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
    const result = cannedResult(`mock${state.analysisCount}`, georef, Number(req.body.min_score ?? 50), Boolean(req.body.cleaning));
    // Like the real service: result images inline when return_images=true.
    if (req.body.return_images === 'true') result.images = { annotated: JPEG_DATA_URL, filtered: JPEG_DATA_URL };
    if (req.body.return_seabed === 'true') result.seabed = cannedSeabed(result.detections);
    res.json(result);
  });

  app.post('/v1/filter', upload.any(), (req, res) => {
    state.calls.push({ path: '/v1/filter', body: { ...req.body }, query: req.query });
    if (req.query.output === 'jpeg') return res.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    res.json({ params: req.body, quality_before: { speckle_index: 0.5 }, quality_after: { speckle_index: 0.3 } });
  });

  app.post('/v1/clean', upload.any(), (req, res) => {
    state.calls.push({ path: '/v1/clean', body: { ...req.body }, query: req.query });
    if (req.query.output === 'jpeg') return res.type('image/jpeg').send(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const params = req.body.params ? JSON.parse(req.body.params) : {};
    res.json({
      source: { filename: req.files[0]?.originalname ?? req.body.filename, width: 1728, height: 1929 },
      profile: req.body.profile ?? 'analyst',
      auto: req.body.auto !== 'false',
      decisions: [{ step: 'dropouts', enabled: false, why: 'no lost pings found' }],
      params: { repair_dropouts: true, despeckle: 'none', ...params },
      steps: [
        { id: 'raw', name: 'Raw input', applied: true, ms: 1, info: {}, notes: [], image: JPEG_DATA_URL, size: [1728, 1929] },
        { id: 'gain', name: 'Gain & interference', applied: true, ms: 5, info: {}, notes: [], image: JPEG_DATA_URL, size: [1728, 1929] },
      ],
      final_step: 'gain',
      frame: { width: 1728, height: 1929, geometry_changed: false },
      report: { before: { enl: 8 }, after: { enl: 40 }, quality_before: 65, quality_after: 84, pings: { blank: 0 } },
    });
  });

  app.post('/v1/stress-test', upload.any(), (req, res) => {
    state.calls.push({ path: '/v1/stress-test', body: { ...req.body } });
    const levels = Number(req.body.levels ?? 3);
    const r = (k) => ({ retained: 1, retention: 1, mean_confidence: 90 - 5 * k, new_false_alarms: 0, detections: 1 });
    res.json({
      disturbance: req.body.disturbance, levels, region: { x: 0, y: 0, width: 1024, height: 1024 },
      baseline: {
        detections: 1, boxes: [], thumb: JPEG_DATA_URL, mean_confidence: 95,
        pipelines: Object.fromEntries(['raw', 'auto', 'full'].map((p) => [p, { detections: 1, mean_confidence: 95, boxes: [], cleaning_steps: [] }])),
      },
      series: Array.from({ length: levels }, (_, i) => ({
        level: i + 1, label: `level ${i + 1}`, results: { raw: r(i + 1), auto: r(i), full: r(i + 2) },
        cleaning_steps: { auto: [], full: ['speckle'] }, thumbs: {}, boxes: {}, noise: {}, ms: 10,
      })),
    });
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

/** 3 x 2 heightfield: elevations -20, -19.5, -19 / -20, -19.5, -18 m. */
function cannedSeabed(detections) {
  const q = Buffer.alloc(12);
  [0, 1000, 2000, 0, 1000, 4000].forEach((v, i) => q.writeUInt16LE(v, i * 2));
  return {
    available: true,
    kind: 'measured',
    grid: { nx: 3, nz: 2, cell_x_m: 50, cell_z_m: 100, width_m: 100, length_m: 100 },
    elevation: { encoding: 'uint16le-base64', scale: 0.0005, offset: -20, min_m: -20, max_m: -18, data: q.toString('base64') },
    depth: { min_m: 19.5, max_m: 20.1 },
    relief: { rms_m: 0.1, max_abs_m: 0.4 },
    altitude: { min_m: 5, max_m: 5, assumed: false },
    slant_range_corrected: true,
    texture: JPEG_DATA_URL,
    texture_size: [3, 2],
    track: { s: [0, 100], lat: [13.08, 13.0809], lon: [80.38, 80.38], heading: [0, 0], altitude: [5, 5], depth: [20, 20] },
    targets: detections.map((d) => ({
      detection_id: d.id, class_name: d.class_name, status: d.status, s: 50, u: 20,
      height_m: d.height?.height_m ?? null, height_method: d.height?.method ?? null,
    })),
    methods: { depth: 'measured' },
    assumptions: ['flat seabed across the track for slant-range correction'],
  };
}

function cannedResult(id, georef, minScore, cleaned = false) {
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
    natural: { method: 'classifier', p_man_made: conf / 100, label: status === 'suppressed' ? 'rock' : null,
      reasons: status === 'suppressed' ? ['no dark acoustic shadow behind it'] : ['long straight edges'] },
    shadow: { found: status === 'confirmed', polygon: [[110, 20], [160, 20], [160, 220]], length_px: 50, length_ratio: 0.5,
      area_ratio: 0.4, solidity: 0.9, sharpness: 0.3, darkness: 0.7, pieces: 1 },
    ...(cleaned ? { quality: { repaired_pings: 0, time_gap: false, motion_flagged: 0.4, interference: false,
      unrepaired_dropout: 0, in_water_column: false, near_nadir: false, resolution_m: 0.087, flags: ['motion_flagged'], score: 70 } } : {}),
    ...extra,
  });
  const detections = [
    det(1, 'shipwreck', 92.5, 'confirmed', 13.081, 80.381, {
      height: { height_m: 3.4, shadow_length_m: 9.1, method: 'shadow_length', assumed_altitude: false },
    }),
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
    processing: {
      models: { detector: { name: 'sonar_detector' } }, tiled: true, tiles: 6, timings: { total_ms: 3000 }, filters: {},
      ...(cleaned ? { cleaning: { params: { gain_across: true }, frame: { geometry_changed: false }, report: { quality_after: 90 } } } : {}),
    },
    detections,
    links: {},
  };
}
