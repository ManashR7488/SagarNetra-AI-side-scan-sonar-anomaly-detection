import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';

function Toggle({ label, checked, onChange, hint, disabled }) {
  return (
    <label className={cn('flex items-start gap-2 text-[11px] text-slate-700 cursor-pointer', disabled && 'opacity-40 cursor-not-allowed')} title={hint}>
      <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="accent-blue-600 mt-0.5" />
      <span className="leading-tight">{label}{hint && <span className="block text-[10px] text-slate-400">{hint}</span>}</span>
    </label>
  );
}

function Slider({ label, value, min, max, step = 1, display, onChange, disabled }) {
  return (
    <div className={cn('space-y-0.5', disabled && 'opacity-40')}>
      <div className="flex justify-between text-[10px]">
        <span className="text-slate-600">{label}</span>
        <span className="font-mono font-bold text-blue-600">{display ?? value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value ?? min} disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600 disabled:cursor-not-allowed" />
    </div>
  );
}

function Group({ title, children, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-slate-200 rounded-md">
      <button type="button" onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-1 px-2 py-1.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50 cursor-pointer">
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
      </button>
      {open && <div className="px-2 pb-2 space-y-2">{children}</div>}
    </div>
  );
}

const METHODS = [['none', 'None'], ['lee', 'Lee'], ['kuan', 'Kuan'], ['frost', 'Frost'], ['median', 'Median'], ['nlm', 'Non-local means']];

/** Every stage-1 setting, starting from what Auto chose. `xtf`: motion controls apply; `scaleKnown`: resolution step. */
export default function CleaningSettings({ params, onChange, xtf, scaleKnown }) {
  if (!params) return null;
  const p = params;
  const set = (k) => (v) => onChange(k, v);
  return (
    <div className="space-y-1.5">
      <Group title="1 · Dropouts & bad pings" defaultOpen>
        <Toggle label="Repair blank, partial and repeated pings" checked={p.repair_dropouts} onChange={set('repair_dropouts')} />
        <Slider label="Longest run to repair" value={p.max_repair_pings} min={1} max={200} display={`${p.max_repair_pings} pings`}
          onChange={set('max_repair_pings')} disabled={!p.repair_dropouts} />
      </Group>
      <Group title="2 · Motion compensation (XTF)">
        <Toggle label="Re-space pings by distance travelled; correct yaw & pitch" checked={p.motion} onChange={set('motion')}
          disabled={!xtf} hint={xtf ? 'uses heading, pitch, roll, heave and navigation from the ping headers' : 'only XTF logs carry motion records'} />
      </Group>
      <Group title="3 · Gain & interference">
        <Toggle label="Remove interference line bursts" checked={p.destripe} onChange={set('destripe')} />
        <Toggle label="Ping gain (gain steps, jitter, roll)" checked={p.gain_along} onChange={set('gain_along')} />
        <Toggle label="Range gain (TVG / beam pattern)" checked={p.gain_across} onChange={set('gain_across')} />
        <Slider label="Gain correction strength" value={p.gain_strength} min={0} max={100} display={`${p.gain_strength}%`}
          onChange={set('gain_strength')} disabled={!p.gain_along && !p.gain_across} />
      </Group>
      <Group title="4 · Water column & geometry">
        <Toggle label="Mask the water column" checked={p.mask_water_column} onChange={set('mask_water_column')} />
        <Toggle label="Remove the sea-surface echo" checked={p.suppress_surface} onChange={set('suppress_surface')} disabled={!xtf}
          hint={xtf ? undefined : 'needs the sonar depth (XTF)'} />
        <Toggle label="Slant range → ground range" checked={p.slant_correct} onChange={set('slant_correct')}
          hint="true shapes; removes the water column" />
      </Group>
      <Group title="5 · Speckle">
        <div className="grid grid-cols-3 gap-1">
          {METHODS.map(([k, l]) => (
            <button key={k} type="button" onClick={() => onChange('despeckle', k)}
              className={cn('px-1 py-1 rounded text-[10px] border cursor-pointer', p.despeckle === k ? 'bg-blue-50 border-blue-300 text-blue-700 font-bold' : 'bg-slate-50 border-slate-200 text-slate-600 hover:bg-slate-100')}>
              {l}
            </button>
          ))}
        </div>
        <Slider label="Strength" value={p.despeckle_strength} min={0} max={100} display={`${p.despeckle_strength}%`}
          onChange={set('despeckle_strength')} disabled={p.despeckle === 'none'} />
      </Group>
      <Group title="6 · Resolution">
        <Toggle label="Resample to a standard pixel size" checked={p.normalize_resolution} onChange={set('normalize_resolution')}
          disabled={!scaleKnown} hint={scaleKnown ? undefined : 'enter the swath width (images) first'} />
        <Slider label="Target" value={p.target_m_per_px} min={0.02} max={0.5} step={0.01} display={`${Number(p.target_m_per_px).toFixed(2)} m/px`}
          onChange={set('target_m_per_px')} disabled={!p.normalize_resolution || !scaleKnown} />
      </Group>
      <Group title="Display (analyst view)">
        <Slider label="Shadow emphasis (gamma)" value={p.shadow_gamma} min={0.5} max={2.5} step={0.05} display={`γ ${Number(p.shadow_gamma).toFixed(2)}`}
          onChange={set('shadow_gamma')} />
        <Toggle label="Local contrast (CLAHE)" checked={p.clahe} onChange={set('clahe')} />
        <Slider label="Contrast strength" value={p.clahe_strength} min={0} max={100} display={`${p.clahe_strength}%`}
          onChange={set('clahe_strength')} disabled={!p.clahe} />
      </Group>
    </div>
  );
}
