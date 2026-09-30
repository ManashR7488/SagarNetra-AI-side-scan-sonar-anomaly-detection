import { Fragment, useMemo, useState } from 'react';
import { FileJson, FileSpreadsheet, MapPinned } from 'lucide-react';
import { CONFIRMED } from '../hero/storyline';
import { cn } from '../../utils/cn';

const CATEGORY = { shipwreck: 'Shipwreck', aircraft_wreck: 'Aircraft Wreck', mine_like_object: 'Pipe / Cylinder / Mine-like Object', debris: 'Debris / Discarded Gear' };
const SEVERITY = { shipwreck: 'high', aircraft_wreck: 'high', mine_like_object: 'critical', debris: 'medium' };

/** Along/across-track extents of a target's footprint, as the pipeline reports them. */
function extents(t) {
  const h = (t.heading * Math.PI) / 180;
  const [len, wid] = t.dims;
  return {
    along: +(Math.abs(len * Math.cos(h)) + Math.abs(wid * Math.sin(h))).toFixed(1),
    across: +(Math.abs(len * Math.sin(h)) + Math.abs(wid * Math.cos(h))).toFixed(1),
    area: +(len * wid * 0.8).toFixed(1),
  };
}

function record(t) {
  const e = extents(t);
  return {
    id: t.id,
    class_name: t.cls,
    category: CATEGORY[t.cls],
    severity: SEVERITY[t.cls],
    is_hazard: true,
    confidence: t.confidence,
    status: 'confirmed',
    location: { latitude: +t.lat.toFixed(7), longitude: +t.lon.toFixed(7), side: t.side, across_track_m: t.acrossTrack },
    dimensions: { along_track_m: e.along, across_track_m: e.across, area_m2: e.area },
  };
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;

function highlight(text) {
  const out = [];
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) {
      out.push(<span key={m.index} className={m[2] ? 'text-sky-300' : 'text-amber-200'}>{m[1]}</span>);
      if (m[2]) out.push(m[2]);
    } else if (m[3]) out.push(<span key={m.index} className="text-violet-300">{m[3]}</span>);
    else out.push(<span key={m.index} className="text-emerald-300">{m[4]}</span>);
    last = TOKEN.lastIndex;
  }
  out.push(text.slice(last));
  return out;
}

export default function ReportPreview() {
  const [tab, setTab] = useState('json');
  const files = useMemo(() => {
    const wreck = CONFIRMED.find((t) => t.cls === 'shipwreck');
    const csvHeader = 'detection_id,class_name,confidence_pct,latitude,longitude,side,along_track_extent_m,across_track_extent_m';
    const csvRows = CONFIRMED.map((t) => {
      const e = extents(t);
      return [t.id, t.cls, t.confidence, t.lat.toFixed(7), t.lon.toFixed(7), t.side, e.along, e.across].join(',');
    });
    const geo = {
      type: 'FeatureCollection',
      features: CONFIRMED.slice(0, 2).map((t) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [+t.lon.toFixed(7), +t.lat.toFixed(7)] },
        properties: { id: t.id, class_name: t.cls, confidence: t.confidence },
      })),
    };
    const geoText = JSON.stringify(geo, null, 2);
    const end = geoText.lastIndexOf('\n  ]');
    return {
      json: { name: 'report.json', icon: FileJson, body: JSON.stringify(record(wreck), null, 2), highlight: true },
      csv: { name: 'report.csv', icon: FileSpreadsheet, body: [csvHeader, ...csvRows].join('\n') },
      geojson: { name: 'targets.geojson', icon: MapPinned, body: `${geoText.slice(0, end)},\n    …${geoText.slice(end)}`, highlight: true },
    };
  }, []);
  const file = files[tab];

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-[#06121c] shadow-2xl shadow-slate-900/25">
      <div className="flex items-center gap-1 border-b border-white/10 bg-white/[0.03] px-2 pt-2" role="tablist" aria-label="Report formats">
        {Object.entries(files).map(([key, f]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-t-lg px-3 py-2 font-mono text-xs transition-colors',
              tab === key ? 'bg-[#06121c] text-cyan-200 ring-1 ring-white/10' : 'text-slate-400 hover:text-slate-200',
            )}
          >
            <f.icon className="h-3.5 w-3.5" /> {f.name}
          </button>
        ))}
      </div>
      <pre className="max-h-[23rem] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-slate-300" role="tabpanel">
        <code>{file.highlight ? highlight(file.body).map((part, i) => <Fragment key={i}>{part}</Fragment>) : file.body}</code>
      </pre>
    </div>
  );
}
