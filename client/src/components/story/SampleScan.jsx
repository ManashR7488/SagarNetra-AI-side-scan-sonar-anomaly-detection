import { useState } from 'react';
import { ScanSearch, Eye } from 'lucide-react';
import { cn } from '../../utils/cn';
import sampleStrip from '../../images_sonar/EB_Allen_06.png';

// Real output of the pipeline on this bundled strip (1728 x 1929 px): box as % of the image.
export const SAMPLE_DETECTION = { x: 8.8, y: 31.5, w: 29.3, h: 48.2, label: 'Shipwreck', confidence: 97.8 };

export const SAMPLE_NOTES = [
  { x: 50, y: 11, title: 'Water column', text: 'Directly under the vehicle the sound has not reached the seabed yet, so the centre is dark.' },
  { x: 24, y: 62, title: 'Wreck hull', text: 'Hard surfaces facing the sonar send back strong echoes and show up bright.' },
  { x: 6, y: 46, title: 'Acoustic shadow', text: 'Sound cannot get behind the hull. The shadow’s length gives the wreck’s height.' },
  { x: 78, y: 57, title: 'Seabed texture', text: 'Rock, sand patches and small debris: the clutter the model must not flag.' },
];

/** The real E.B. Allen strip, raw (with what an analyst reads in it) or with SagarNetra's detection. */
export default function SampleScan() {
  const [mode, setMode] = useState('raw');
  const d = SAMPLE_DETECTION;

  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-2xl shadow-slate-900/30">
      <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
        <span className="truncate font-mono text-[11px] text-slate-400">EB_Allen_06.png · side-scan strip</span>
        <div className="flex shrink-0 rounded-lg bg-white/5 p-0.5 ring-1 ring-white/10" role="group" aria-label="Choose view">
          {[
            ['raw', 'Raw sonar', Eye],
            ['ai', 'SagarNetra', ScanSearch],
          ].map(([key, label, Icon]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
                mode === key ? 'bg-cyan-400 text-slate-950' : 'text-slate-300 hover:text-white',
              )}
            >
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>
      </div>

      <div className="relative aspect-[1728/1929] bg-black">
        <img src={sampleStrip} alt="Side-scan sonar strip showing the E.B. Allen shipwreck" className="absolute inset-0 h-full w-full object-cover grayscale contrast-125" />

        {mode === 'raw' &&
          SAMPLE_NOTES.map((n, i) => (
            <span
              key={n.title}
              className="absolute flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-slate-950 shadow-[0_0_0_4px_rgba(251,191,36,0.25)]"
              style={{ left: `${n.x}%`, top: `${n.y}%` }}
              title={n.title}
            >
              {i + 1}
            </span>
          ))}

        {mode === 'ai' && (
          <>
            <div className="scan-line absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-cyan-300 to-transparent shadow-[0_0_12px_2px_rgba(34,211,238,0.6)]" aria-hidden="true" />
            <div
              className="absolute rounded-sm border-2 border-sky-400 bg-sky-400/15 shadow-[0_0_20px_rgba(56,189,248,0.45)]"
              style={{ left: `${d.x}%`, top: `${d.y}%`, width: `${d.w}%`, height: `${d.h}%` }}
            >
              <span className="absolute -top-6 left-0 whitespace-nowrap rounded-t bg-sky-500 px-1.5 py-0.5 font-mono text-[10px] font-bold text-white">
                DET-001 {d.label} {d.confidence}%
              </span>
            </div>
          </>
        )}
      </div>

      <div className="grid grid-cols-3 divide-x divide-white/10 border-t border-white/10 text-center">
        {(mode === 'ai'
          ? [['Class', d.label], ['Confidence', `${d.confidence}%`], ['Status', 'Confirmed']]
          : [['Targets marked', '0'], ['Review', 'By eye'], ['Position', 'Unknown']]
        ).map(([k, v]) => (
          <div key={k} className="py-2.5">
            <p className="font-mono text-[10px] uppercase tracking-wider text-slate-500">{k}</p>
            <p className={cn('text-sm font-semibold', mode === 'ai' ? 'text-white' : 'text-slate-400')}>{v}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
