import { useEffect } from "react";
import { Link } from "react-router-dom";
import {
  AlertTriangle, Anchor, ArrowRight, BadgeCheck, CheckCircle2, Clock, Cpu, Crosshair, Database, FileDown, FileText, Filter,
  Fish, Gauge, Hand, Layers, LifeBuoy, MapPin, Navigation, Route, ScanSearch, ShieldCheck, Upload,
} from "lucide-react";
import Logo from "../components/brand/Logo";
import Hero from "../components/hero/Hero";
import Reveal from "../components/story/Reveal";
import SonarDiagram from "../components/story/SonarDiagram";
import SampleScan, { SAMPLE_NOTES } from "../components/story/SampleScan";
import ReportPreview from "../components/story/ReportPreview";
import { BRAND } from "../config/brand";
import { CLASS_META } from "../utils/classes";
import { cn } from "../utils/cn";

const BLIND_SPOT = [
  { icon: Fish, title: "Ghost nets keep fishing", text: "Lost and abandoned gear keeps trapping fish, turtles and dolphins for years after it is gone." },
  { icon: AlertTriangle, title: "Hazards stay hidden", text: "Wrecks, debris and mine-like objects put ships, dredgers, cables and divers at risk." },
  { icon: LifeBuoy, title: "Rescue cannot wait", text: "After an accident at sea, every hour spent scrolling through sonar is an hour lost to the search." },
];

const BOTTLENECK = [
  { icon: Clock, title: "Hours of logs", text: "per survey day" },
  { icon: Hand, title: "Read by eye", text: "line by line" },
  { icon: MapPin, title: "Positions by hand", text: "copied into reports" },
];

const SONAR_STEPS = [
  { title: "Ping", text: "Transducers on both sides of the AUV send a thin fan of sound out to 30 m, many times a second." },
  { title: "Echo", text: "Hard surfaces facing the sonar, like a steel hull, send back strong echoes and appear bright. Soft mud stays dark." },
  { title: "Shadow", text: "Sound cannot reach the seabed behind a raised object. The shadow it leaves tells you how tall the object is." },
  { title: "Waterfall", text: "Each ping becomes one line of the image. Stacked as the vehicle moves, the lines form the waterfall an operator watches." },
];

const PIPELINE = [
  { icon: Upload, title: "Ingest", text: "Raw XTF logs or sonar images, with ping-header or CSV/JSON navigation." },
  { icon: Filter, title: "Clean", text: "Lee / Frost / Kuan despeckling, ping-dropout repair, contrast equalisation." },
  { icon: ScanSearch, title: "Detect", text: "YOLO11 detector plus wreck segmentation, tiled at native resolution." },
  { icon: ShieldCheck, title: "Verify", text: "Calibrated 0–100 % score; shadow, edge and contrast evidence suppress false alarms." },
  { icon: MapPin, title: "Geotag", text: "Pixel to latitude / longitude with slant-range correction; size in metres." },
  { icon: Route, title: "Act", text: "Review, cleanup route planning and JSON / CSV / GeoJSON reports." },
];

const GEOTAG_POINTS = [
  "Slant range converted to ground range using the vehicle's altitude",
  "Position from XTF ping headers or a CSV / JSON track, offset to port or starboard",
  "Length, width and area from the box or the segmentation mask",
  "Severity by class: mine-like objects are critical, wrecks are high",
  "JSON and CSV for reports, GeoJSON for any GIS tool",
];

const COMPONENTS = [
  {
    icon: Crosshair, tone: "sky", req: "Requirement 1", title: "Detection & segmentation model",
    points: ["Boxes for 6 classes, pixel masks for wrecks", "Long survey strips tiled, fragments merged into one object", "Detector and segmenter cross-checked"],
  },
  {
    icon: Gauge, tone: "emerald", req: "Requirement 2", title: "Confidence scoring & noise filtering",
    points: ["0–100 % score per anomaly, 50 = calibrated decision point", "Rejects marine life, speckle and dropout artefacts", "Every score comes with its evidence"],
  },
  {
    icon: Navigation, tone: "amber", req: "Requirement 3", title: "Geotagging & reporting engine",
    points: ["XTF ping headers, navigation CSV / JSON or a survey position", "Exact lat / lon, side, range and dimensions", "JSON, CSV and GeoJSON exports per scan or mission"],
  },
  {
    icon: Layers, tone: "indigo", req: "Requirement 4", title: "Mission dashboard",
    points: ["Upload a raw log, predict and see detections on the map", "Operator review: verify, schedule cleanup, clear", "Optimal cleanup route and live system health"],
  },
];

const TONES = {
  sky: "bg-sky-50 text-sky-700 ring-sky-200",
  emerald: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-200",
};

function ChapterTitle({ n, eyebrow, title, text, dark = false, center = false }) {
  return (
    <Reveal className={cn("max-w-2xl", center && "mx-auto text-center")}>
      <p className={cn("mb-3 font-mono text-xs font-bold uppercase tracking-[0.2em]", dark ? "text-cyan-300" : "text-sky-600")}>
        Chapter {n} · {eyebrow}
      </p>
      <h2 className={cn("text-3xl font-extrabold tracking-tight sm:text-4xl", dark ? "text-white" : "text-slate-900")}>{title}</h2>
      {text && <p className={cn("mt-4 text-lg leading-relaxed", dark ? "text-slate-300" : "text-slate-600")}>{text}</p>}
    </Reveal>
  );
}

export default function HomePage() {
  // The page renders client-side, so honour deep links like /#reports once the chapters exist.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id) document.getElementById(id)?.scrollIntoView();
  }, []);

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900">
      <Hero />

      {/* ------------------------------------------------------------ 01 the blind spot */}
      <section id="story" className="scroll-mt-4 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <ChapterTitle
            n="01"
            eyebrow="The blind spot"
            title="The seabed is the one place nobody can see."
            text="Ghost nets, wrecks, lost cargo and unexploded ordnance lie tens of metres down, beyond the reach of cameras and satellites. Side-scan sonar can see them, but every survey day brings back hours of imagery that experts still read line by line."
          />
          <div className="mt-12 grid gap-5 md:grid-cols-3">
            {BLIND_SPOT.map(({ icon: Icon, title, text }, i) => (
              <Reveal key={title} delay={i * 90} className="rounded-2xl border border-slate-200 bg-slate-50/60 p-6">
                <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#04182F] text-cyan-300"><Icon className="h-5 w-5" /></span>
                <h3 className="mt-4 text-lg font-bold text-slate-900">{title}</h3>
                <p className="mt-1.5 leading-relaxed text-slate-600">{text}</p>
              </Reveal>
            ))}
          </div>
          <Reveal className="mt-6 flex flex-col gap-6 rounded-2xl bg-[#04182F] p-6 text-white md:flex-row md:items-center md:justify-between md:p-8">
            <div>
              <p className="font-mono text-xs uppercase tracking-[0.2em] text-amber-300">The real bottleneck</p>
              <p className="mt-2 max-w-md text-xl font-bold">It is not collecting the sonar. It is reading it.</p>
            </div>
            <ol className="flex flex-wrap items-center gap-3">
              {BOTTLENECK.map(({ icon: Icon, title, text }, i) => (
                <li key={title} className="flex items-center gap-3">
                  {i > 0 && <ArrowRight className="h-4 w-4 text-slate-500" />}
                  <span className="flex items-center gap-2.5 rounded-xl bg-white/5 px-3.5 py-2.5 ring-1 ring-white/10">
                    <Icon className="h-4 w-4 text-amber-300" />
                    <span>
                      <span className="block text-sm font-semibold">{title}</span>
                      <span className="block text-xs text-slate-400">{text}</span>
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ 02 how sonar sees */}
      <section id="sonar" className="scroll-mt-4 bg-[#031521] text-white">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <ChapterTitle
              n="02"
              eyebrow="How sonar sees"
              title="Sound draws the seabed, one line at a time."
              text="A side-scan sonar does not take photos. It listens. What comes back is the picture the rest of this story is built on."
              dark
            />
            <Reveal className="mt-10 rounded-2xl border border-white/10 bg-white/[0.03] p-3 sm:p-5">
              <SonarDiagram />
            </Reveal>
          </div>
          <ol className="space-y-4">
            {SONAR_STEPS.map(({ title, text }, i) => (
              <Reveal as="li" key={title} delay={i * 90} className="flex gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 font-mono text-sm font-bold text-cyan-300 ring-1 ring-cyan-300/30">
                  {i + 1}
                </span>
                <div>
                  <h3 className="font-bold text-white">{title}</h3>
                  <p className="mt-1 leading-relaxed text-slate-300">{text}</p>
                </div>
              </Reveal>
            ))}
            <Reveal as="li" className="px-1 text-sm text-slate-400">
              The live waterfall in the hero is exactly this: each new line appears at the top as the AUV moves.
            </Reveal>
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------ 03 reading the image */}
      <section id="image" className="scroll-mt-4 border-b border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-[minmax(0,26rem)_1fr]">
          <Reveal className="mx-auto w-full max-w-md">
            <SampleScan />
            <p className="mt-3 text-center font-mono text-[11px] text-slate-500">Real sonar and real model output · AI4Shipwrecks sample</p>
          </Reveal>
          <div>
            <ChapterTitle
              n="03"
              eyebrow="Reading the image"
              title="Can you spot the wreck?"
              text="This is a real side-scan strip from the public AI4Shipwrecks dataset. Analysts learn to read the dark band, the bright hull and the long shadow. SagarNetra learned the same cues from thousands of labelled examples."
            />
            <ol className="mt-8 grid gap-3 sm:grid-cols-2">
              {SAMPLE_NOTES.map((n, i) => (
                <Reveal as="li" key={n.title} delay={i * 80} className="flex gap-3 rounded-xl border border-slate-200 bg-white p-4">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-400 text-xs font-bold text-slate-950">{i + 1}</span>
                  <div>
                    <h3 className="font-semibold text-slate-900">{n.title}</h3>
                    <p className="mt-0.5 text-sm leading-relaxed text-slate-600">{n.text}</p>
                  </div>
                </Reveal>
              ))}
            </ol>
            <Reveal className="mt-5 flex items-start gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sky-900">
              <BadgeCheck className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
              <p className="text-sm leading-relaxed">
                Switch the viewer to <strong>SagarNetra</strong> for the model's answer: a shipwreck at <strong>97.8 %</strong> confidence,
                boxed and ready to geotag.
              </p>
            </Reveal>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ 04 pipeline */}
      <section id="pipeline" className="scroll-mt-4 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <ChapterTitle
            n="04"
            eyebrow="The pipeline"
            title="From raw log to a scored, geotagged target"
            text="Everything you watched in the hero is this pipeline, running on one survey line."
            center
          />
          <ol className="relative mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-6">
            <div className="pointer-events-none absolute left-[8%] right-[8%] top-9 hidden h-px bg-gradient-to-r from-cyan-400/0 via-cyan-400/60 to-cyan-400/0 lg:block" aria-hidden="true" />
            {PIPELINE.map(({ icon: Icon, title, text }, i) => (
              <Reveal as="li" key={title} delay={i * 70} className="relative rounded-2xl border border-slate-200 bg-white p-5 shadow-xs transition-all hover:border-sky-300 hover:shadow-md">
                <div className="mb-4 flex items-center justify-between">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#04182F] text-cyan-300"><Icon className="h-5 w-5" /></span>
                  <span className="font-mono text-xs font-bold text-slate-300">0{i + 1}</span>
                </div>
                <h3 className="font-bold text-slate-900">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">{text}</p>
              </Reveal>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------------ 05 geotag & report */}
      <section id="reports" className="scroll-mt-4 border-y border-slate-200 bg-slate-50">
        <div className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
          <div>
            <ChapterTitle
              n="05"
              eyebrow="Geotag & report"
              title="Every target gets an address."
              text="A box on an image is not something a dive team can act on. SagarNetra turns each detection into a position, a size and a priority."
            />
            <ul className="mt-8 space-y-3">
              {GEOTAG_POINTS.map((p, i) => (
                <Reveal as="li" key={p} delay={i * 70} className="flex gap-3 text-slate-700">
                  <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-500" /> {p}
                </Reveal>
              ))}
            </ul>
          </div>
          <Reveal>
            <ReportPreview />
            <p className="mt-3 font-mono text-[11px] text-slate-500">Same schema as the API's reports · targets from the survey in the hero</p>
          </Reveal>
        </div>
      </section>

      {/* ------------------------------------------------------------ 06 act */}
      <section id="act" className="scroll-mt-4 bg-white">
        <div className="mx-auto max-w-7xl px-6 py-24">
          <ChapterTitle
            n="06"
            eyebrow="Act"
            title="From a report to a cleaner, safer seabed."
            text="Teams review each target, schedule cleanup, plan the shortest route between targets and keep every mission on one map. Each part answers one requirement of the problem statement."
            center
          />
          <div className="mt-12 grid gap-5 md:grid-cols-2">
            {COMPONENTS.map(({ icon: Icon, tone, req, title, points }, i) => (
              <Reveal key={title} delay={(i % 2) * 90} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xs">
                <div className="mb-4 flex items-center gap-3">
                  <span className={`flex h-11 w-11 items-center justify-center rounded-xl ring-1 ${TONES[tone]}`}><Icon className="h-5 w-5" /></span>
                  <div>
                    <p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">{req}</p>
                    <h3 className="text-lg font-bold text-slate-900">{title}</h3>
                  </div>
                </div>
                <ul className="space-y-2">
                  {points.map((p) => (
                    <li key={p} className="flex gap-2 text-sm text-slate-600">
                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />{p}
                    </li>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>

          <Reveal className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-6">
            <p className="mb-4 font-mono text-xs font-bold uppercase tracking-[0.2em] text-slate-500">What it detects</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(CLASS_META).map(([key, meta]) => (
                <span key={key} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: meta.color }} />
                  {meta.label}
                </span>
              ))}
            </div>
            <p className="mt-3 text-xs text-slate-500">Marine life is detected so it can be filtered out as a natural feature, not reported as a hazard.</p>
          </Reveal>

          <div className="mt-6 grid gap-5 md:grid-cols-3">
            {[
              { icon: Database, title: "Reads", items: ["XTF raw logs (ping headers)", "PNG / JPG / TIFF sonar images", "Navigation CSV / JSON"] },
              { icon: FileText, title: "Writes", items: ["JSON & CSV anomaly reports", "GeoJSON for GIS", "Cleanup route plan"] },
              { icon: Cpu, title: "Runs", items: ["FastAPI + ONNX models on CPU / GPU", "Express + MongoDB mission store", "Shore dashboard in any browser"] },
            ].map(({ icon: Icon, title, items }, i) => (
              <Reveal key={title} delay={i * 80} className="rounded-2xl border border-slate-200 p-6">
                <div className="mb-3 flex items-center gap-2 text-slate-900">
                  <Icon className="h-5 w-5 text-sky-600" /><h3 className="font-bold">{title}</h3>
                </div>
                <ul className="space-y-1.5 text-sm text-slate-600">
                  {items.map((it) => <li key={it} className="flex gap-2"><span className="text-sky-500">›</span>{it}</li>)}
                </ul>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------ CTA */}
      <section className="px-6 pb-20">
        <Reveal className="relative mx-auto max-w-7xl overflow-hidden rounded-3xl bg-[#04111f] px-8 py-14 text-center text-white">
          <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,rgba(14,77,146,0.6),transparent_70%)]" aria-hidden="true" />
          <div className="relative">
            <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Your survey is the next chapter.</h2>
            <p className="mx-auto mt-3 max-w-xl text-slate-300">Create a mission, upload a sonar log and get geotagged, scored detections on the map.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link to="/app/ai-detection" className="inline-flex items-center gap-2 rounded-lg bg-cyan-400 px-6 py-3 font-bold text-slate-950 transition-colors hover:bg-cyan-300">
                <Upload className="h-5 w-5" /> Upload sonar data
              </Link>
              <Link to="/app/dashboard" className="inline-flex items-center gap-2 rounded-lg px-6 py-3 font-semibold ring-1 ring-white/25 transition-colors hover:bg-white/10">
                <FileDown className="h-5 w-5 text-cyan-300" /> Dashboard & reports
              </Link>
            </div>
          </div>
        </Reveal>
      </section>

      {/* ------------------------------------------------------------ footer */}
      <footer className="border-t border-slate-200">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 py-8 md:flex-row">
          <Logo size={32} subtitle={BRAND.tagline} />
          <p className="flex items-center gap-1.5 text-center text-xs text-slate-500">
            <Anchor className="h-3.5 w-3.5 text-sky-600" />
            National Institute of Ocean Technology (NIOT) · Ministry of Earth Sciences (MoES) · {BRAND.problemStatement}
          </p>
        </div>
      </footer>
    </div>
  );
}
