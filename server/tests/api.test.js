import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import mongoose from 'mongoose';
import request from 'supertest';
import { startMockAi } from './helpers/mockAi.js';

process.env.NODE_ENV = 'test';
const mockAi = await startMockAi();
process.env.AI_SERVICE_URL = mockAi.url; // must be set before the config module loads

const { createApp } = await import('../src/app.js');
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { config } = await import('../src/config/env.js');
const { Detection, Mission, Scan } = await import('../src/models/index.js');

const SAMPLE = path.resolve(import.meta.dirname, '../../client/src/images_sonar/EB_Allen_06.png');
const api = request(createApp());

before(async () => {
  await connectDB(process.env.MONGODB_URI);
  await mongoose.connection.dropDatabase();
  await Promise.all([Mission.init(), Scan.init(), Detection.init()]); // build indexes (2dsphere, unique)
  fs.rmSync(config.storage.localDir, { recursive: true, force: true });
});

after(async () => {
  await mongoose.connection.dropDatabase();
  await disconnectDB();
  await mockAi.close();
  fs.rmSync(config.storage.localDir, { recursive: true, force: true });
});

const uploadScan = (fields = {}) => {
  const req = api.post('/api/scans').attach('file', SAMPLE);
  for (const [k, v] of Object.entries(fields)) req.field(k, String(v));
  return req;
};

describe('system', () => {
  test('health reports database, AI service and storage', async () => {
    const res = await api.get('/api/health').expect(200);
    assert.equal(res.body.data.database, 'connected');
    assert.equal(res.body.data.aiService.status, 'ok');
    assert.equal(res.body.data.storage.provider, 'local');
  });

  test('models are proxied from the AI service', async () => {
    const res = await api.get('/api/models').expect(200);
    assert.equal(res.body.data.detector.name, 'sonar_detector');
  });

  test('unknown route -> 404 envelope', async () => {
    const res = await api.get('/api/nope').expect(404);
    assert.deepEqual(Object.keys(res.body), ['success', 'error']);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

describe('missions', () => {
  let missionId;

  test('create, list, get, update', async () => {
    const res = await api.post('/api/missions')
      .send({ name: 'Chennai Coast Oct-26', region: 'Bay of Bengal', platform: { name: 'NIOT AUV-1', type: 'auv' }, defaults: { swathWidthM: 150 } })
      .expect(201);
    missionId = res.body.data.id;
    assert.equal(res.body.data.stats.scans, 0);
    assert.equal(res.body.data._id, undefined);

    const list = await api.get('/api/missions?search=chennai').expect(200);
    assert.equal(list.body.meta.total, 1);
    await api.get(`/api/missions/${missionId}`).expect(200);
    const upd = await api.patch(`/api/missions/${missionId}`).send({ status: 'completed' }).expect(200);
    assert.equal(upd.body.data.status, 'completed');
  });

  test('validation and duplicates', async () => {
    const bad = await api.post('/api/missions').send({ name: '', foo: 1 }).expect(400);
    assert.ok(bad.body.error.details.length >= 1);
    await api.post('/api/missions').send({ name: 'Chennai Coast Oct-26' }).expect(409);
    await api.get('/api/missions/not-an-id').expect(400);
    await api.get(`/api/missions/${new mongoose.Types.ObjectId()}`).expect(404);
  });

  describe('scans & detections', () => {
    let scanId;

    test('upload -> AI analysis -> scan + detections stored', async () => {
      const res = await uploadScan({
        missionId, latitude: 13.08, longitude: 80.38, headingDeg: 0, denoise: 'lee', clahe: 'false', minScore: 50,
      }).expect(201);
      const scan = res.body.data;
      scanId = scan.id;
      assert.equal(scan.status, 'completed');
      assert.equal(scan.detections.length, 3);
      assert.equal(scan.summary.confirmed, 2);
      assert.equal(scan.georeference.available, true);
      assert.deepEqual(scan.georeference.start.coordinates, [80.38, 13.08]);
      assert.equal(scan.images.annotated.provider, 'local');
      assert.ok(scan.source.file.url.includes(`/uploads/missions/${missionId}/scans/${scanId}/`));

      // options forwarded to the AI service in its field names; "false" stays false; mission default swath applied
      const call = mockAi.state.calls.findLast((c) => c.path === '/v1/analyze');
      assert.equal(call.body.denoise, 'lee');
      assert.equal(call.body.clahe, 'false');
      assert.equal(call.body.swath_width_m, '150');
      assert.equal(call.body.return_images, 'true');
      // result images arrive inline, so no second request to the (possibly serverless) AI service
      assert.ok(!mockAi.state.calls.some((c) => c.path?.endsWith('.jpg')));
      assert.equal(call.files[0].name, 'EB_Allen_06.png');

      // detection document shape
      const det = scan.detections.find((d) => d.code === 'DET-001');
      assert.deepEqual(det.location, { type: 'Point', coordinates: [80.381, 13.081] });
      assert.equal(det.review.status, 'unreviewed');
      assert.equal(det.dimensions.areaFrom, 'mask');

      // stored file is served
      const rel = new URL(scan.images.annotated.url).pathname;
      await api.get(rel).expect(200).expect('content-type', /image\/jpeg/);

      const mission = (await api.get(`/api/missions/${missionId}`)).body.data;
      assert.equal(mission.stats.scans, 1);
      assert.equal(mission.stats.confirmed, 2);
      assert.equal(mission.stats.maxSeverity, 'high');
    });

    test('scan without georeference goes to the default mission', async () => {
      const res = await uploadScan().expect(201);
      assert.equal(res.body.data.georeference.available, false);
      assert.equal(res.body.data.mission.name, 'General Survey');
      assert.equal(res.body.data.detections[0].location, undefined);
    });

    test('list and get scans', async () => {
      const list = await api.get(`/api/scans?missionId=${missionId}`).expect(200);
      assert.equal(list.body.meta.total, 1);
      const one = await api.get(`/api/scans/${scanId}?includeSuppressed=false`).expect(200);
      assert.ok(one.body.data.detections.every((d) => d.status === 'confirmed'));
    });

    test('detection queries: filters, geo, geojson, stats, csv', async () => {
      const cls = await api.get('/api/detections?className=shipwreck,mine_like_object&status=confirmed').expect(200);
      assert.equal(cls.body.meta.total, 4); // shipwreck + mine-like object from each of the 2 scans
      const conf = await api.get(`/api/detections?missionId=${missionId}&minConfidence=90`).expect(200);
      assert.equal(conf.body.data.length, 1);
      assert.equal(conf.body.data[0].scan.name, 'EB_Allen_06.png');

      const near = await api.get('/api/detections?near=80.381,13.081&radiusM=100').expect(200);
      assert.deepEqual(near.body.data.map((d) => d.code).sort(), ['DET-001', 'DET-003']);
      const box = await api.get('/api/detections?bbox=80.4,13.1,80.6,13.3').expect(200);
      assert.deepEqual(box.body.data.map((d) => d.code), ['DET-002']);
      await api.get('/api/detections?bbox=1,2,3').expect(400);

      const geo = await api.get(`/api/detections/geojson?missionId=${missionId}&status=confirmed`).expect(200);
      assert.equal(geo.body.type, 'FeatureCollection');
      assert.equal(geo.body.features.length, 2);

      const stats = await api.get(`/api/detections/stats?missionId=${missionId}`).expect(200);
      assert.equal(stats.body.data.totals.detections, 3);
      assert.equal(stats.body.data.totals.geotagged, 3);
      assert.ok(stats.body.data.byClass.some((c) => c.className === 'shipwreck'));
      assert.equal(stats.body.data.suppressedByReason[0].key, 'natural_feature');

      const csv = await api.get(`/api/detections/export.csv?missionId=${missionId}`).expect(200);
      assert.match(csv.headers['content-disposition'], /attachment/);
      assert.equal(csv.text.trim().split('\n').length, 4);
      const scanCsv = await api.get(`/api/scans/${scanId}/report.csv`).expect(200);
      assert.match(scanCsv.text, /latitude/);
      await api.get(`/api/missions/${missionId}/report.csv`).expect(200);
    });

    test('operator review', async () => {
      const det = (await api.get(`/api/detections?scanId=${scanId}&className=shipwreck`)).body.data[0];
      const res = await api.patch(`/api/detections/${det.id}/review`)
        .send({ status: 'verified', notes: 'Confirmed by diver', reviewedBy: 'Manash' }).expect(200);
      assert.equal(res.body.data.review.status, 'verified');
      assert.ok(res.body.data.review.reviewedAt);
      await api.patch(`/api/detections/${det.id}/review`).send({ status: 'maybe' }).expect(400);
      const q = await api.get('/api/detections?reviewStatus=verified').expect(200);
      assert.equal(q.body.meta.total, 1);
    });

    test('re-analysis replaces detections with new options', async () => {
      const res = await api.post(`/api/scans/${scanId}/reanalyze`).send({ minScore: 70 }).expect(200);
      assert.equal(res.body.data.summary.confirmed, 1);
      assert.equal(res.body.data.options.minScore, 70);
      assert.equal(res.body.data.options.georef.latitude, 13.08); // previous georeference kept
      assert.equal(await Detection.countDocuments({ scan: scanId }), 3);
      const call = mockAi.state.calls.findLast((c) => c.path === '/v1/analyze');
      assert.equal(call.body.min_score, '70');
      assert.equal(call.body.latitude, '13.08');
    });

    test('AI errors: bad input -> 422, failure -> 502, scan marked failed', async () => {
      mockAi.state.mode = 'bad_input';
      const r1 = await uploadScan({ missionId }).expect(422);
      assert.equal(r1.body.error.code, 'AI_SERVICE_ERROR');
      const failed = await Scan.findById(r1.body.error.details.scanId);
      assert.equal(failed.status, 'failed');
      assert.ok(failed.source.file, 'original kept so the scan can be re-analysed');

      mockAi.state.mode = 'crash';
      await uploadScan({ missionId }).expect(502);
      mockAi.state.mode = 'ok';
      const again = await api.post(`/api/scans/${failed.id}/reanalyze`).send({}).expect(200);
      assert.equal(again.body.data.status, 'completed');
    });

    test('upload validation', async () => {
      await api.post('/api/scans').field('missionId', missionId).expect(400);
      await api.post('/api/scans').attach('file', Buffer.from('x'), 'notes.pdf').expect(415);
      await uploadScan({ latitude: 13 }).expect(400);
      await uploadScan({ denoise: 'wavelet' }).expect(400);
      await uploadScan({ missionId: new mongoose.Types.ObjectId().toString() }).expect(404);
    });

    test('noise-filtration preview is proxied, not stored', async () => {
      const before = await Scan.countDocuments();
      const res = await api.post('/api/filter').attach('file', SAMPLE).field('denoise', 'frost').field('denoiseStrength', '70').expect(200);
      assert.equal(res.body.data.params.denoise, 'frost');
      assert.equal(res.body.data.params.denoise_strength, '70');
      const img = await api.post('/api/filter?output=jpeg').attach('file', SAMPLE).expect(200);
      assert.match(img.headers['content-type'], /image\/jpeg/);
      assert.equal(await Scan.countDocuments(), before);
    });

    test('delete scan removes detections and files, refreshes stats', async () => {
      const scan = await Scan.findById(scanId);
      const annotatedPath = path.join(config.storage.localDir, scan.images.annotated.publicId);
      assert.ok(fs.existsSync(annotatedPath));
      await api.delete(`/api/scans/${scanId}`).expect(204);
      assert.equal(await Detection.countDocuments({ scan: scanId }), 0);
      assert.ok(!fs.existsSync(annotatedPath));
      await api.get(`/api/scans/${scanId}`).expect(404);
    });

    test('delete mission cascades', async () => {
      await api.delete(`/api/missions/${missionId}`).expect(204);
      assert.equal(await Scan.countDocuments({ mission: missionId }), 0);
      assert.equal(await Detection.countDocuments({ mission: missionId }), 0);
    });
  });
});

describe('AI service down', () => {
  test('analysis -> 503 and health degraded', async () => {
    const original = config.ai.url;
    config.ai.url = 'http://127.0.0.1:1';
    try {
      const res = await uploadScan().expect(503);
      assert.equal(res.body.error.code, 'SERVICE_UNAVAILABLE');
      const h = await api.get('/api/health').expect(503);
      assert.equal(h.body.data.aiService.status, 'unreachable');
    } finally {
      config.ai.url = original;
    }
  });
});

describe('direct uploads (browser -> Cloudinary)', () => {
  test('signing is refused while storage is local', async () => {
    const res = await api.post('/api/uploads/sign').send({ filename: 'line01.xtf' }).expect(409);
    assert.equal(res.body.error.code, 'DIRECT_UPLOAD_DISABLED');
    await api.post('/api/uploads/sign').send({ filename: 'notes.pdf' }).expect(400);
  });

  test('fileRef instead of a file: validated, and refused while storage is local', async () => {
    const ref = (o) => api.post('/api/scans').field('fileRef', JSON.stringify(o));
    await ref({ publicId: 'sonarscan/incoming/x_line01', filename: 'line01.pdf' }).expect(415);
    await api.post('/api/scans').field('fileRef', '{not json').expect(400);
    const res = await ref({ publicId: 'sonarscan/incoming/x_line01.xtf', resourceType: 'raw', filename: 'line01.xtf' }).expect(409);
    assert.equal(res.body.error.code, 'DIRECT_UPLOAD_DISABLED');
    const h = await api.get('/api/health');
    assert.equal(h.body.data.storage.directUploads, false);
  });
});
