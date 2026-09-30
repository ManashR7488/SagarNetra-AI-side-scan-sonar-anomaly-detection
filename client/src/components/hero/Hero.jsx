import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, MapPin, ShieldCheck } from 'lucide-react';
import Logo from '../brand/Logo';
import { BRAND } from '../../config/brand';
import { cn } from '../../utils/cn';
import HeroOcean from './HeroOcean';
import { PHASES } from './storyline';

const NAV = [
  ['#story', 'The story'],
  ['#sonar', 'How sonar sees'],
  ['#pipeline', 'Pipeline'],
  ['#reports', 'Reports'],
];

export default function Hero() {
  const [phase, setPhase] = useState(0);
  const stepperRef = useRef(null);

  return (
    <section className="relative isolate flex min-h-svh flex-col overflow-hidden bg-[#031521] text-white">
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_70%_45%,rgba(14,116,144,0.35),transparent_60%),radial-gradient(ellipse_at_top_left,rgba(14,77,146,0.45),transparent_55%)]"
        aria-hidden="true"
      />
      <HeroOcean phase={phase} onPhase={setPhase} stepperRef={stepperRef} />

      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between px-6 py-5">
        <Logo size={40} tone="dark" subtitle={`${BRAND.nativeName} · ${BRAND.org}`} />
        <nav className="hidden items-center gap-7 text-sm text-slate-300 md:flex">
          {NAV.map(([href, label]) => (
            <a key={href} href={href} className="transition-colors hover:text-white">{label}</a>
          ))}
        </nav>
        <Link
          to="/app/ai-detection"
          className="inline-flex items-center gap-2 rounded-lg bg-white/10 px-4 py-2 text-sm font-semibold text-white ring-1 ring-white/20 backdrop-blur transition-colors hover:bg-white/20"
        >
          Open console <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-1 items-center px-6 py-10">
        <div className="max-w-xl">
          <span className="inline-flex items-center gap-2 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 text-xs font-semibold text-cyan-200">
            <ShieldCheck className="h-4 w-4" />
            {BRAND.problemStatement} · Disaster Management
          </span>
          <h1 className="mt-6 text-4xl font-extrabold leading-[1.05] tracking-tight sm:text-6xl">
            Find what the<br />
            <span className="bg-gradient-to-r from-cyan-300 via-sky-300 to-sky-500 bg-clip-text text-transparent">sea hides.</span>
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-slate-300">
            {BRAND.name} <span className="text-slate-400">({BRAND.meaning})</span> turns side-scan sonar surveys into a map of
            wrecks, ghost nets and mine-like objects, each with a confidence score and an exact position.
          </p>
          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              to="/app/ai-detection"
              className="group inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-6 py-3 text-base font-bold text-slate-950 shadow-lg shadow-cyan-500/25 transition-colors hover:bg-cyan-300"
            >
              Start detecting <ArrowRight className="h-5 w-5 transition-transform group-hover:translate-x-0.5" />
            </Link>
            <Link
              to="/app/geo-tag"
              className="inline-flex items-center gap-2 rounded-lg px-6 py-3 text-base font-semibold text-white ring-1 ring-white/25 backdrop-blur transition-colors hover:bg-white/10"
            >
              <MapPin className="h-5 w-5 text-cyan-300" /> View the mission map
            </Link>
          </div>

          <div ref={stepperRef} className="mt-12 max-w-lg">
            <p className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">One survey, start to finish</p>
            <ol className="grid grid-cols-5 gap-2">
              {PHASES.map((p, i) => (
                <li key={p.id}>
                  <div className="h-1 overflow-hidden rounded-full bg-white/15">
                    <div className={cn('h-full rounded-full bg-cyan-300', i < phase && 'w-full', i === phase && 'story-step__bar', i > phase && 'w-0')} />
                  </div>
                  <p className={cn('mt-2 font-mono text-[10.5px] uppercase tracking-wider', i === phase ? 'text-cyan-200' : i < phase ? 'text-slate-300' : 'text-slate-500')}>
                    <span className="text-slate-500">0{i + 1}</span> {p.title}
                  </p>
                </li>
              ))}
            </ol>
            <p key={phase} className="fade-in mt-3 min-h-[2.75rem] text-sm leading-relaxed text-slate-300">{PHASES[phase].text}</p>
          </div>
        </div>
      </div>

      <a
        href="#story"
        className="relative z-10 mx-auto mb-5 hidden flex-col items-center gap-1 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-400 transition-colors hover:text-cyan-300 lg:flex"
      >
        Scroll <ChevronDown className="h-4 w-4 motion-safe:animate-bounce" />
      </a>
    </section>
  );
}
