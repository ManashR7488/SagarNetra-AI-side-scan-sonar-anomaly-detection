import { useEffect, useRef, useState } from 'react';
import { CLASS_TINT, CONFIRMED, SURVEY, TARGETS } from './storyline';
import { cn } from '../../utils/cn';

const FILTERED = TARGETS.filter((t) => t.filtered);

/**
 * Full-bleed three.js background for the hero. three.js is loaded lazily after first paint; without WebGL
 * (or while loading) the section keeps its plain gradient. `?heroT=12` freezes the scene at t = 12 s.
 */
export default function HeroOcean({ phase, onPhase, stepperRef }) {
  const hostRef = useRef(null);
  const labelsRef = useRef(null);
  const waterfallRef = useRef(null);
  const depthRef = useRef(null);
  const altitudeRef = useRef(null);
  const positionRef = useRef(null);
  const pingsRef = useRef(null);
  const onPhaseRef = useRef(onPhase);
  onPhaseRef.current = onPhase;
  const [status, setStatus] = useState('loading');
  // ?heroT=… freezes the scene (handy for screenshots); skip the fade-ins so captures are exact.
  const [frozen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('heroT'));

  useEffect(() => {
    let scene = null;
    let cancelled = false;
    const param = new URLSearchParams(window.location.search).get('heroT');
    const freezeAt = param !== null && Number.isFinite(Number(param)) ? Number(param) : null;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    import('./ocean/OceanScene')
      .then(({ default: OceanScene }) => {
        if (cancelled) return null;
        // Disposed straight away if this effect is cleaned up mid-build (StrictMode, fast navigation).
        scene = new OceanScene({
          host: hostRef.current,
          labels: labelsRef.current,
          waterfall: waterfallRef.current,
          telemetry: { depth: depthRef.current, altitude: altitudeRef.current, position: positionRef.current, pings: pingsRef.current },
          stepper: stepperRef?.current,
          onPhase: (i) => onPhaseRef.current?.(i),
          freezeAt,
          still,
        });
        return scene.build();
      })
      .then(() => {
        if (cancelled || !scene || scene.disposed) return;
        scene.start();
        setStatus('ready');
      })
      .catch((err) => {
        console.warn('Hero scene unavailable, using the static background.', err);
        if (!cancelled) setStatus('failed');
      });

    return () => {
      cancelled = true;
      scene?.dispose();
    };
  }, [stepperRef]);

  const ready = status === 'ready';
  const report = phase >= 3;

  return (
    <>
      <div ref={hostRef} className={cn('absolute inset-0', !frozen && 'transition-opacity duration-[1600ms]', ready ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
      {/* Legibility scrims: the headline sits on the left, the action plays on the right. */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#031521]/80 via-[#031521]/45 to-transparent md:from-[#031521]/95 md:via-[#031521]/30" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-36 bg-gradient-to-b from-[#031521]/80 to-transparent" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#031521] to-transparent" aria-hidden="true" />
      <div ref={labelsRef} className={cn('ocean-tags hidden sm:block', !frozen && 'transition-opacity duration-700', ready ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />

      {status !== 'failed' && (
        <div
          className={cn(
            'pointer-events-none absolute bottom-7 right-6 xl:right-10 z-[5] hidden lg:block w-[320px]',
            !frozen && 'transition-opacity duration-700',
            ready ? 'opacity-100' : 'opacity-0',
          )}
          aria-hidden="true"
        >
          <div className="overflow-hidden rounded-xl border border-cyan-300/20 bg-[#03131f]/85 shadow-2xl shadow-black/50">
            <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
              <span className="flex items-center gap-1.5 text-cyan-200">
                <span className={cn('h-1.5 w-1.5 rounded-full', report ? 'bg-amber-400' : 'bg-emerald-400 animate-pulse')} />
                {report ? `Mission ${SURVEY.mission} · report` : `${SURVEY.vehicle} · side-scan ${SURVEY.frequencyKHz} kHz`}
              </span>
              <span className="text-slate-400">{report ? 'geotagged' : 'live'}</span>
            </div>

            <div className="relative h-[176px]">
              <canvas ref={waterfallRef} className={cn('absolute inset-0 h-full w-full transition-opacity duration-500', report ? 'opacity-0' : 'opacity-100')} />
              <div className={cn('absolute inset-x-0 bottom-1 flex justify-between px-2 font-mono text-[9px] text-cyan-100/60 transition-opacity', report ? 'opacity-0' : 'opacity-100')}>
                <span>PORT 30 m</span>
                <span>STBD 30 m</span>
              </div>

              <div className={cn('absolute inset-0 flex flex-col px-3 py-2.5 font-mono text-[10.5px] transition-opacity duration-500', report ? 'opacity-100' : 'opacity-0')}>
                <ul className="space-y-1.5">
                  {CONFIRMED.map((t, i) => (
                    <li
                      key={t.id}
                      className={cn('flex items-center gap-2 transition-all duration-500', report ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0')}
                      style={{ transitionDelay: report ? `${150 + i * 110}ms` : '0ms' }}
                    >
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: CLASS_TINT[t.cls] }} />
                      <span className="text-sky-300">{t.id}</span>
                      <span className="min-w-0 flex-1 truncate text-slate-100">{t.label}</span>
                      <span className="text-slate-400">{t.lat.toFixed(4)}°N {t.lon.toFixed(4)}°E</span>
                      <span className="w-9 text-right font-bold" style={{ color: CLASS_TINT[t.cls] }}>{Math.round(t.confidence)}%</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-slate-500">{FILTERED.length} filtered: {FILTERED.map((t) => t.label.toLowerCase()).join(', ')}</p>
                <div className="mt-auto flex gap-1.5">
                  {['report.json', 'report.csv', 'targets.geojson'].map((f) => (
                    <span key={f} className="rounded border border-cyan-300/25 bg-cyan-300/10 px-1.5 py-0.5 text-[9.5px] text-cyan-100">{f}</span>
                  ))}
                </div>
              </div>
            </div>

            <dl className="grid grid-cols-4 divide-x divide-white/10 border-t border-white/10 text-center font-mono">
              {[
                ['Depth', depthRef, '42.0 m'],
                ['Altitude', altitudeRef, '8.0 m'],
                ['Speed', null, `${SURVEY.displaySpeedKn} kn`],
                ['Pings', pingsRef, '0000'],
              ].map(([label, ref, initial]) => (
                <div key={label} className="py-1.5">
                  <dt className="text-[8.5px] uppercase tracking-wider text-slate-500">{label}</dt>
                  <dd ref={ref} className="text-[11px] font-semibold text-slate-100">{initial}</dd>
                </div>
              ))}
            </dl>
            <p className="border-t border-white/10 px-3 py-1.5 font-mono text-[9.5px] text-slate-400">
              <span className="text-slate-500">POS </span><span ref={positionRef}>—</span>
              <span className="text-slate-500"> · HDG </span>{SURVEY.headingDeg}°
            </p>
          </div>
        </div>
      )}
    </>
  );
}
