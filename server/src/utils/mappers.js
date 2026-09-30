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
  };
}

export function detectionFromAi(d, { scanId, missionId }) {
  const loc = d.location;
  const ev = d.evidence ?? {};
  const dim = d.dimensions;
  return {
    scan: scanId,
    mission: missionId,
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
    },
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
    dimensions: dim
      ? { acrossTrackM: dim.across_track_m, alongTrackM: dim.along_track_m, areaM2: dim.area_m2, areaFrom: dim.area_from }
      : undefined,
  };
}
