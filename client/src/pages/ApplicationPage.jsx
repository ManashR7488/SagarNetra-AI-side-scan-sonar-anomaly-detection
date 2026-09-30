import { useEffect, useState } from "react";
import { Routes, Route, NavLink, Navigate, Link } from "react-router-dom";
import { 
  Search, 
  Filter, 
  MapPin, 
  LayoutDashboard, 
  ArrowLeft, 
  Anchor,
  PanelLeftClose,
  PanelLeftOpen
} from "lucide-react";
import { cn } from "../utils/cn";
import Logo, { LogoMark } from "../components/brand/Logo";
import { BRAND } from "../config/brand";
import MissionPanel from "../components/MissionPanel";
import SystemStatus from "../components/SystemStatus";
import Toaster from "../components/Toaster";
import { useMissionStore } from "../store/useMissionStore";
import { useSystemStore } from "../store/useSystemStore";
import AiDetectionTab from "./tabs/AiDetectionTab";
import NoiseFiltrationTab from "./tabs/NoiseFiltrationTab";
import GeoTagTab from "./tabs/GeoTagTab";
import DashboardTab from "./tabs/DashboardTab";

const tabs = [
  { id: "ai-detection", label: "AI Detection", icon: Search, path: "ai-detection" },
  { id: "noise-filtration", label: "Noise Filtration", icon: Filter, path: "noise-filtration" },
  { id: "geo-tag", label: "Geo Tag", icon: MapPin, path: "geo-tag" },
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard, path: "dashboard" },
];

export default function ApplicationPage() {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const fetchMissions = useMissionStore((s) => s.fetchMissions);
  const startPolling = useSystemStore((s) => s.startPolling);
  const fetchModels = useSystemStore((s) => s.fetchModels);

  // Load shared data once for the whole console: missions, AI model cards, and live health polling.
  useEffect(() => {
    fetchMissions();
    fetchModels();
    return startPolling(30000);
  }, [fetchMissions, fetchModels, startPolling]);

  return (
    <div className="flex h-screen bg-slate-100 text-slate-900 font-sans overflow-hidden">
      <Toaster />
      {/* Sidebar in clean White/Light theme */}
      <aside 
        className={cn(
          "bg-white border-r border-slate-200 flex flex-col shrink-0 shadow-xs z-20 transition-all duration-200 ease-in-out relative",
          isSidebarOpen ? "w-64" : "w-16"
        )}
      >
        {/* Brand Header with Close/Open Toggle Button */}
        <div className={cn(
          "p-3.5 border-b border-slate-200 flex items-center justify-between",
          !isSidebarOpen && "justify-center p-2.5 flex-col gap-2"
        )}>
          {isSidebarOpen ? (
            <>
              <Link to="/" className="group" title={`${BRAND.name} home`}>
                <Logo size={32} />
              </Link>
              <button
                type="button"
                onClick={() => setIsSidebarOpen(false)}
                className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                title="Collapse Sidebar"
                aria-label="Collapse Sidebar"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            </>
          ) : (
            <>
              <Link to="/" title={`${BRAND.name} home`} className="shrink-0">
                <LogoMark size={32} />
              </Link>
              <button
                type="button"
                onClick={() => setIsSidebarOpen(true)}
                className="p-1.5 text-slate-500 hover:text-blue-600 hover:bg-slate-100 rounded-md transition-colors cursor-pointer"
                title="Expand Sidebar"
                aria-label="Expand Sidebar"
              >
                <PanelLeftOpen className="w-4 h-4" />
              </button>
            </>
          )}
        </div>

        {/* Active mission (scopes every tab) + live backend / AI / database status */}
        <MissionPanel collapsed={!isSidebarOpen} />
        <SystemStatus collapsed={!isSidebarOpen} />

        {/* Navigation Tabs */}
        <nav className={cn("flex-1 py-2 flex flex-col gap-1.5", isSidebarOpen ? "px-3" : "px-2")}>
          {isSidebarOpen && (
            <div className="px-3 pb-1 text-[10px] font-mono font-bold text-slate-400 uppercase tracking-wider">
              Analysis Modules
            </div>
          )}
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <NavLink
                key={tab.id}
                to={`/app/${tab.path}`}
                title={!isSidebarOpen ? tab.label : undefined}
                className={({ isActive }) =>
                  cn(
                    "flex items-center rounded-lg text-xs font-semibold transition-all",
                    isSidebarOpen ? "gap-3 px-3.5 py-2.5" : "justify-center p-2.5",
                    isActive
                      ? "bg-blue-50 text-blue-600 border border-blue-200 shadow-2xs"
                      : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                  )
                }
              >
                <Icon className="w-4 h-4 shrink-0" />
                {isSidebarOpen && <span>{tab.label}</span>}
              </NavLink>
            );
          })}
        </nav>

        {/* Bottom Sidebar Institutional Badge & Navigation */}
        <div className={cn(
          "border-t border-slate-200 bg-slate-50 text-[11px] text-slate-500 flex items-center",
          isSidebarOpen ? "p-3 justify-between" : "p-2 justify-center flex-col gap-2"
        )}>
          {isSidebarOpen ? (
            <>
              <div className="flex items-center gap-1.5">
                <Anchor className="w-3.5 h-3.5 text-blue-600" />
                <span className="font-mono text-[10px]">PS ID: 26057</span>
              </div>
              <Link to="/" className="text-slate-600 hover:text-blue-600 font-medium text-[11px] flex items-center gap-1">
                <ArrowLeft className="w-3 h-3" />
                Home
              </Link>
            </>
          ) : (
            <Link to="/" title="Back to Home" className="p-1 text-slate-600 hover:text-blue-600">
              <ArrowLeft className="w-4 h-4" />
            </Link>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 bg-slate-100 overflow-hidden">
        <Routes>
          <Route path="/" element={<Navigate to="ai-detection" replace />} />
          <Route path="ai-detection" element={<AiDetectionTab />} />
          <Route path="noise-filtration" element={<NoiseFiltrationTab />} />
          <Route path="geo-tag" element={<GeoTagTab />} />
          <Route path="dashboard" element={<DashboardTab />} />
        </Routes>
      </main>
    </div>
  );
}
