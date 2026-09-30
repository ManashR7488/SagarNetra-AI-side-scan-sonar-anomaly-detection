import { useEffect } from "react";
import { LayoutDashboard, AlertTriangle, ShieldCheck, Download, MapPin, Activity, Loader2, RefreshCw, Filter } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Cell, Legend } from "recharts";
import { downloadUrl } from "../../api";
import { useDashboardStore } from "../../store/useDashboardStore";
import { useMissionStore } from "../../store/useMissionStore";
import { useSystemStore } from "../../store/useSystemStore";
import { classColor, classLabel, REVIEW_META, SEVERITY_META } from "../../utils/classes";
import { downloadFromUrl } from "../../utils/download";
import { cn } from "../../utils/cn";
import { fmtDateTime, fmtPoint } from "../../utils/format";

const tooltipStyle = { backgroundColor: "#ffffff", borderColor: "#e2e8f0", color: "#0f172a", fontSize: 11 };

function StatCard({ label, icon: Icon, iconClass, value, unit, sub, subClass = "text-slate-500" }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-xs">
      <div className="flex items-center justify-between text-xs text-slate-500 font-medium mb-1">
        <span>{label}</span>
        <Icon className={cn("w-4 h-4", iconClass)} />
      </div>
      <div className="text-2xl font-extrabold text-slate-900">
        {value} {unit && <span className="text-xs font-normal text-slate-500">{unit}</span>}
      </div>
      <div className={cn("text-[11px] font-medium mt-1", subClass)}>{sub}</div>
    </div>
  );
}

export default function DashboardTab() {
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const dataVersion = useMissionStore((s) => s.dataVersion);
  const missions = useMissionStore((s) => s.missions);
  const models = useSystemStore((s) => s.models);
  const stats = useDashboardStore((s) => s.stats);
  const recent = useDashboardStore((s) => s.recent);
  const loading = useDashboardStore((s) => s.loading);
  const error = useDashboardStore((s) => s.error);
  const fetch = useDashboardStore((s) => s.fetch);

  useEffect(() => {
    fetch(activeMissionId);
  }, [activeMissionId, dataVersion, fetch]);

  const scoped = activeMissionId ? missions.filter((m) => m.id === activeMissionId) : missions;
  const scanCount = scoped.reduce((n, m) => n + (m.stats?.scans ?? 0), 0);
  const activeMission = missions.find((m) => m.id === activeMissionId);

  const t = stats?.totals;
  const critical = stats?.bySeverity?.find((s) => s.key === "critical")?.count ?? 0;
  const reviewed = t?.reviewed ?? 0;

  const byClass = (stats?.byClass ?? []).map((c) => ({ name: classLabel(c.className), count: c.count, color: classColor(c.className), meanConfidence: c.meanConfidence }));

  // Real per-class test metrics from the detector's model card (held-out test set).
  const detector = models?.detector;
  const perClass = (detector?.test_metrics?.box ?? []).filter((r) => r.class !== "ALL").map((r) => ({
    name: classLabel(r.class), precision: +(r.precision * 100).toFixed(1), recall: +(r.recall * 100).toFixed(1), mAP50: +(r.mAP50 * 100).toFixed(1),
  }));
  const overall = detector?.test_metrics?.box?.find((r) => r.class === "ALL");

  return (
    <div className="flex flex-col h-full bg-slate-100 p-3 gap-3 overflow-y-auto text-slate-900 font-sans">
      <div className="bg-white border border-slate-200 rounded-lg p-3 flex items-center justify-between shadow-xs shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center border border-blue-200">
            <LayoutDashboard className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-slate-900">Mission Overview & Anomaly Analytics Dashboard</h2>
            <p className="text-[11px] text-slate-500 font-mono">{activeMission ? `Mission: ${activeMission.name}` : "All missions"} &bull; MoES / NIOT</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => fetch(activeMissionId)} className="p-1.5 rounded-md text-slate-500 hover:bg-slate-100 hover:text-blue-600 cursor-pointer" title="Refresh">
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            onClick={() => downloadFromUrl(downloadUrl("/detections/export.csv", { missionId: activeMissionId ?? undefined }))}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-md shadow-2xs transition-colors cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Export Detections CSV
          </button>
        </div>
      </div>

      {error && <div className="bg-red-50 border border-red-200 text-red-700 text-xs rounded-lg px-3 py-2 font-mono">{error}</div>}

      <div className="grid grid-cols-4 gap-3 shrink-0">
        <StatCard label="Confirmed Detections" icon={AlertTriangle} iconClass="text-red-600" value={t?.confirmed ?? "—"} unit="targets"
          sub={t?.meanConfidence !== undefined && t?.meanConfidence !== null ? `${t.meanConfidence}% mean confidence · ${t.suppressed} suppressed as false positives` : "No detections yet"} subClass="text-emerald-600" />
        <StatCard label="Critical Hazards" icon={ShieldCheck} iconClass="text-amber-600" value={critical} unit={`of ${t?.hazards ?? 0} hazards`}
          sub="Mine-like objects & human bodies" subClass={critical ? "text-red-600" : "text-slate-500"} />
        <StatCard label="Geotagged / Scans" icon={MapPin} iconClass="text-blue-600" value={t?.geotagged ?? "—"} unit={`geotagged candidates · ${scanCount} scans`}
          sub={`${reviewed} reviewed by an operator`} subClass="text-blue-600" />
        <StatCard label="Detector (test set)" icon={Activity} iconClass="text-emerald-600" value={overall ? overall.mAP50.toFixed(3) : "—"} unit="mAP@50"
          sub={detector ? `${detector.architecture.toUpperCase()} · P ${(overall?.precision * 100).toFixed(0)}% · R ${(overall?.recall * 100).toFixed(0)}% · ${detector.cpu_onnx_latency_ms_per_tile} ms/tile CPU` : "Model card unavailable"} subClass="text-emerald-600" />
      </div>

      <div className="grid grid-cols-12 gap-3 min-h-[260px]">
        <div className="col-span-6 bg-white border border-slate-200 rounded-lg p-3 flex flex-col shadow-xs">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-2">Confirmed Detections by Class</span>
          <div className="flex-1 min-h-[200px]">
            {byClass.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byClass} layout="vertical">
                  <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" horizontal={false} />
                  <XAxis type="number" stroke="#64748b" fontSize={10} allowDecimals={false} />
                  <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={150} />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v, _n, p) => [`${v} (mean ${p.payload.meanConfidence}%)`, "Detections"]} />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {byClass.map((entry) => <Cell key={entry.name} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs font-mono text-slate-400">{loading ? <Loader2 className="w-5 h-5 animate-spin" /> : "No confirmed detections yet"}</div>
            )}
          </div>
        </div>

        <div className="col-span-6 bg-white border border-slate-200 rounded-lg p-3 flex flex-col shadow-xs">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-2 flex justify-between">
            <span>Detector Accuracy per Class (held-out test set, %)</span>
            <span className="text-[10px] font-mono font-normal text-slate-400 normal-case">from model_card.json</span>
          </span>
          <div className="flex-1 min-h-[200px]">
            {perClass.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={perClass}>
                  <CartesianGrid strokeDasharray="2 2" stroke="#f1f5f9" />
                  <XAxis dataKey="name" stroke="#64748b" fontSize={9} interval={0} tickFormatter={(v) => v.split(" ")[0]} />
                  <YAxis domain={[0, 100]} stroke="#64748b" fontSize={10} width={28} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 10 }} />
                  <Bar dataKey="mAP50" fill="#0284c7" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="precision" fill="#94a3b8" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="recall" fill="#cbd5e1" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-xs font-mono text-slate-400">Model metrics unavailable (AI service offline?)</div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-3">
        <div className="col-span-4 bg-white border border-slate-200 rounded-lg p-3 shadow-xs">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5 mb-2"><Filter className="w-3.5 h-3.5 text-blue-600" />False-positive filter</span>
          {stats?.suppressedByReason?.length ? (
            <div className="space-y-1 text-[11px] font-mono">
              {stats.suppressedByReason.map((r) => (
                <div key={r.key} className="flex justify-between"><span className="text-slate-500">{r.key.replaceAll("_", " ")}</span><span className="font-bold">{r.count}</span></div>
              ))}
            </div>
          ) : <p className="text-[11px] font-mono text-slate-400">No candidates suppressed yet.</p>}
        </div>
        <div className="col-span-4 bg-white border border-slate-200 rounded-lg p-3 shadow-xs">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-2 block">Severity (confirmed)</span>
          <div className="space-y-1 text-[11px] font-mono">
            {["critical", "high", "medium", "none"].map((s) => (
              <div key={s} className="flex justify-between"><span className={cn("px-1 rounded border", SEVERITY_META[s].badge)}>{SEVERITY_META[s].label}</span>
                <span className="font-bold">{stats?.bySeverity?.find((x) => x.key === s)?.count ?? 0}</span></div>
            ))}
          </div>
        </div>
        <div className="col-span-4 bg-white border border-slate-200 rounded-lg p-3 shadow-xs">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide mb-2 block">Operator review</span>
          <div className="space-y-1 text-[11px] font-mono">
            {Object.entries(REVIEW_META).map(([k, meta]) => (
              <div key={k} className="flex justify-between"><span className={cn("px-1 rounded border", meta.badge)}>{meta.label}</span>
                <span className="font-bold">{stats?.byReview?.find((x) => x.key === k)?.count ?? 0}</span></div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-xs">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-bold text-slate-800 uppercase tracking-wide">Latest Confirmed Detections</span>
          <span className="text-[11px] font-mono text-slate-500">from MongoDB</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs font-sans">
            <thead>
              <tr className="bg-slate-50 text-slate-500 font-mono text-[11px] border-b border-slate-200">
                <th className="py-2 px-3">ID</th>
                <th className="py-2 px-3">Classification</th>
                <th className="py-2 px-3">Confidence</th>
                <th className="py-2 px-3">Coordinates (WGS-84)</th>
                <th className="py-2 px-3">Scan / Mission</th>
                <th className="py-2 px-3">Review</th>
                <th className="py-2 px-3">Detected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-mono text-slate-700">
              {recent.length === 0 && (
                <tr><td colSpan={7} className="py-6 text-center text-slate-400">No detections yet: analyse scans in the AI Detection tab.</td></tr>
              )}
              {recent.map((d) => (
                <tr key={d.id} className="hover:bg-slate-50/80 transition-colors">
                  <td className="py-2 px-3 font-bold text-slate-900">{d.code}</td>
                  <td className="py-2 px-3 font-sans font-medium text-slate-900">
                    <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full" style={{ background: classColor(d.className) }} />{classLabel(d.className)}</span>
                  </td>
                  <td className="py-2 px-3 text-emerald-600 font-bold">{d.confidence.toFixed(1)}%</td>
                  <td className="py-2 px-3 text-slate-600">{fmtPoint(d.location, 4)}</td>
                  <td className="py-2 px-3 text-slate-500 truncate max-w-[220px]" title={`${d.scan?.name} · ${d.mission?.name}`}>{d.scan?.name} · {d.mission?.name}</td>
                  <td className="py-2 px-3"><span className={cn("px-1 rounded border text-[10px]", REVIEW_META[d.review?.status]?.badge)}>{REVIEW_META[d.review?.status]?.label}</span></td>
                  <td className="py-2 px-3 text-slate-500">{fmtDateTime(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
