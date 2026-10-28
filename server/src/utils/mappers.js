/** Convert AI-service (snake_case, lat/lon objects) payloads into Mongo documents (camelCase, GeoJSON). */

const point = (lat, lon) =>
  Number.isFinite(lat) && Number.isFinite(lon) ? { type: 'Point', coordinates: [lon, lat] } : undefined;

const date = (s) => (s ? new Date(s) : undefined);

export function georeferenceFromAi(g = {}) {
  if (!g.available) return { available: false, reason: g.reason };
  const start = point(g.start?.latitude, g.start?.longitude);
  const end = point(g.end?.latitude, g.end?.longitude);
  return {
    available: true,
    source: g.source,
    start,
    end,
    track: start && end ? { type: 'LineString', coordinates: [start.coordinates, end.coordinates] } : undefined,
    trackLengthM: g.track_length_m,
    meanHeadingDeg: g.mean_heading_deg,
    acrossTrackMPerPx: g.across_track_m_per_px,
    alongTrackMPerPx: g.along_track_m_per_px,
    nadirColumn: g.nadir_column,
    slantRangeCorrected: g.slant_range_corrected,
    startTime: date(g.start_time),
    endTime: date(g.end_time),
    assumptions: g.assumptions ?? [],
  };
}

export function scanFieldsFromAi(result) {
  const s = result.summary ?? {};
  const p = result.processing ?? {};
  const src = result.source ?? {};
  return {
    'source.width': src.width,
    'source.height': src.height,
    'source.format': src.format,
    'source.sonar': src.format === 'xtf'
      ? { name: src.sonar_name, pings: src.pings, frequencyKhz: src.frequency_khz, slantRangeM: src.slant_range_m }
      : undefined,
    georeference: georeferenceFromAi(result.georeference),
    summary: {
      candidates: s.candidates,
      confirmed: s.confirmed,
      suppressed: s.suppressed,
      hazards: s.hazards,
      byClass: s.by_class ?? {},
      suppressedByReason: s.suppressed_by_reason ?? {},
      maxSeverity: s.max_severity,
      meanConfidence: s.mean_confidence ?? undefined,
    },
    'processing.aiAnalysisId': result.analysis_id,
    'processing.models': p.models,
    'processing.tiled': p.tiled,
    'processing.tiles': p.tiles,
    'processing.timings': p.timings,
    'processing.filters': p.filters,
    'processing.cleaning': p.cleaning ?? undefined,
    'processing.falseAlarmFilter': p.false_alarm_filter ?? undefined,
  };
}

const NATURAL = new Set(['rock', 'sand_ripple', 'natural_shadow', 'seabed_texture']);

function naturalFromAi(n) {
  if (!n) return undefined;
  return {
    method: n.method,
    pManMade: n.p_man_made ?? undefined,
    label: NATURAL.has(n.label) ? n.label : undefined,
    subtypeProbabilities: n.subtype_probabilities ?? undefined,
    reasons: n.reasons ?? [],
  };
}

function shadowFromAi(sh) {
  if (!sh) return undefined;
  return {
    found: sh.found,
    polygon: sh.polygon?.length ? sh.polygon : undefined,
    lengthPx: sh.length_px,
    lengthRatio: sh.length_ratio,
    areaRatio: sh.area_ratio,
    solidity: sh.solidity,
    sharpness: sh.sharpness,
    darkness: sh.darkness,
    pieces: sh.pieces,
  };
}

function qualityFromAi(q) {
  if (!q) return undefined;
  return {
    repairedPings: q.repaired_pings,
    timeGap: q.time_gap,
    motionFlagged: q.motion_flagged,
    interference: q.interference,
    unrepairedDropout: q.unrepaired_dropout,
    inWaterColumn: q.in_water_column,
    nearNadir: q.near_nadir,
    resolutionM: q.resolution_m ?? undefined,
    flags: q.flags ?? [],
    score: q.score,
  };
}

export function detectionFromAi(d, { scanId, missionId, draft = false }) {
  const loc = d.location;
  const ev = d.evidence ?? {};
  const dim = d.dimensions;
  const ht = d.height;
  return {
    scan: scanId,
    mission: missionId,
    draft,
    code: d.id,
    className: d.class_name,
    category: d.category,
    severity: d.severity,
    isHazard: d.is_hazard,
    sourceModel: d.source,
    confidence: d.confidence,
    status: d.status,
    suppressionReasons: d.suppression_reasons ?? [],
    evidence: {
      modelConfidence: ev.model_confidence,
      calibratedThreshold: ev.calibrated_threshold,
      shadow: ev.shadow,
      linearity: ev.linearity,
      contrast: ev.contrast,
      acousticEvidence: ev.acoustic_evidence,
      modelAgreement: ev.model_agreement,
      isolation: ev.isolation,
      periodicity: ev.periodicity,
      orientationCoherence: ev.orientation_coherence,
      blobDensity: ev.blob_density,
    },
    natural: naturalFromAi(d.natural),
    shadow: shadowFromAi(d.shadow),
    quality: qualityFromAi(d.quality),
    bbox: d.bbox,
    bboxPct: d.bbox_pct,
    centroidPx: d.centroid_px,
    polygons: d.polygons?.length ? d.polygons : undefined,
    location: loc ? point(loc.latitude, loc.longitude) : undefined,
    geo: loc
      ? {
        side: loc.side,
        acrossTrackM: loc.across_track_m,
        vehicleLocation: point(loc.vehicle_latitude, loc.vehicle_longitude),
        vehicleHeadingDeg: loc.vehicle_heading_deg,
        altitudeM: loc.altitude_m ?? undefined,
        timestamp: date(loc.timestamp),
      }
      : undefined,
    dimensions: dim || ht?.height_m != null
      ? {
        acrossTrackM: dim?.across_track_m,
        alongTrackM: dim?.along_track_m,
        areaM2: dim?.area_m2,
        areaFrom: dim?.area_from,
        heightM: ht?.height_m ?? undefined,
        heightMethod: ht?.height_m != null ? ht.method : undefined,
        shadowLengthM: ht?.shadow_length_m ?? undefined,
        leastDepthM: ht?.least_depth_m ?? undefined,
      }
      : undefined,
  };
}

/** Seabed metadata (the heightfield and texture themselves are stored as files by the scan service). */
export function seabedFromAi(sb) {
  if (!sb?.available) return { available: false, reason: sb?.reason ?? 'Not produced by the AI service' };
  const g = sb.grid ?? {};
  const e = sb.elevation ?? {};
  return {
    available: true,
    kind: sb.kind,
    grid: { nx: g.nx, nz: g.nz, cellXM: g.cell_x_m, cellZM: g.cell_z_m, widthM: g.width_m, lengthM: g.length_m },
    elevation: { scale: e.scale, offset: e.offset, minM: e.min_m, maxM: e.max_m },
    depth: sb.depth ? { minM: sb.depth.min_m, maxM: sb.depth.max_m } : undefined,
    relief: sb.relief ? { rmsM: sb.relief.rms_m, maxAbsM: sb.relief.max_abs_m } : undefined,
    altitude: sb.altitude
      ? {
        minM: sb.altitude.min_m,
        maxM: sb.altitude.max_m,
        assumed: sb.altitude.assumed,
        source: sb.altitude.source,
        checkM: sb.altitude.check_m ?? undefined,
      }
      : undefined,
    slantRangeCorrected: sb.slant_range_corrected,
    geometry: sb.geometry
      ? {
        sources: sb.geometry.sources,
        nadirColumn: sb.geometry.nadir_column,
        swathM: sb.geometry.swath_m,
        bottomTrack: sb.geometry.bottom_track ?? undefined,
      }
      : undefined,
    coverage: sb.coverage
      ? {
        coveredFraction: sb.coverage.covered_fraction,
        dropoutFraction: sb.coverage.dropout_fraction,
        outsideSwathFraction: sb.coverage.outside_swath_fraction,
        nadirZoneM: sb.coverage.nadir_zone_m,
      }
      : undefined,
    track: sb.track,
    targets: (sb.targets ?? []).map((t) => ({
      detectionCode: t.detection_id,
      className: t.class_name,
      status: t.status,
      s: t.s,
      u: t.u,
      sizeM: t.size_m ?? null,
      heightM: t.height_m,
      heightMethod: t.height_method,
      seabedDepthM: t.seabed_depth_m ?? null,
      leastDepthM: t.least_depth_m ?? null,
    })),
    methods: sb.methods,
    assumptions: sb.assumptions ?? [],
  };
}
