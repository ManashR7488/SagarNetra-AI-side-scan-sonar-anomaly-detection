import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, FolderPlus, Loader2, Pencil, Target, Trash2, X } from 'lucide-react';
import { cn } from '../utils/cn';
import { useMissionStore } from '../store/useMissionStore';
import Modal, { Field, inputClass } from './Modal';

const EMPTY = { name: '', region: '', platformName: '', platformType: 'ship', swathWidthM: '', description: '' };

function NewMissionDialog({ open, onClose }) {
  const createMission = useMissionStore((s) => s.createMission);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e?.preventDefault();
    if (!form.name.trim()) return;
    setSaving(true);
    try {
      await createMission({
        name: form.name.trim(),
        region: form.region.trim() || undefined,
        description: form.description.trim() || undefined,
        platform: form.platformName.trim() ? { name: form.platformName.trim(), type: form.platformType } : undefined,
        defaults: form.swathWidthM ? { swathWidthM: Number(form.swathWidthM) } : undefined,
      });
      setForm(EMPTY);
      onClose();
    } catch {
      /* toast already shown by the store */
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New survey mission"
      icon={FolderPlus}
      footer={(
        <>
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-300 bg-white hover:bg-slate-100 cursor-pointer">Cancel</button>
          <button type="button" onClick={submit} disabled={!form.name.trim() || saving} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer flex items-center gap-1.5">
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Create mission
          </button>
        </>
      )}
    >
      <form onSubmit={submit} className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="Mission name *"><input autoFocus className={inputClass} value={form.name} onChange={set('name')} placeholder="Chennai coast debris survey – Oct 2026" maxLength={120} /></Field>
        </div>
        <Field label="Region"><input className={inputClass} value={form.region} onChange={set('region')} placeholder="Bay of Bengal" /></Field>
        <Field label="Default swath width (m)" hint="Used to scale images uploaded with only a position">
          <input type="number" min="1" className={inputClass} value={form.swathWidthM} onChange={set('swathWidthM')} placeholder="150" />
        </Field>
        <Field label="Platform name"><input className={inputClass} value={form.platformName} onChange={set('platformName')} placeholder="NIOT AUV-1" /></Field>
        <Field label="Platform type">
          <select className={inputClass} value={form.platformType} onChange={set('platformType')}>
            {['ship', 'auv', 'usv', 'rov', 'other'].map((t) => <option key={t} value={t}>{t.toUpperCase()}</option>)}
          </select>
        </Field>
        <div className="col-span-2">
          <Field label="Description"><textarea rows={2} className={inputClass} value={form.description} onChange={set('description')} maxLength={2000} /></Field>
        </div>
      </form>
    </Modal>
  );
}

/** Confirm deleting a mission; shows exactly what will be removed. */
function DeleteMissionDialog({ mission, onClose }) {
  const deleteMission = useMissionStore((s) => s.deleteMission);
  const [busy, setBusy] = useState(false);
  if (!mission) return null;
  const confirm = async () => {
    setBusy(true);
    try {
      await deleteMission(mission.id);
      onClose();
    } catch {
      /* toast shown by the store */
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={busy ? undefined : onClose}
      title="Delete mission"
      icon={AlertTriangle}
      footer={(
        <>
          <button type="button" onClick={onClose} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-300 bg-white hover:bg-slate-100 cursor-pointer disabled:opacity-50">Cancel</button>
          <button type="button" onClick={confirm} disabled={busy} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-60 cursor-pointer flex items-center gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
        </>
      )}
    >
      <p className="mb-2">
        Delete <strong>&quot;{mission.name}&quot;</strong> and everything in it? This cannot be undone.
      </p>
      <ul className="list-disc pl-5 space-y-0.5 text-slate-600">
        <li><strong>{mission.stats?.scans ?? 0}</strong> scans and their uploaded files and result images</li>
        <li><strong>{mission.stats?.detections ?? 0}</strong> detections ({mission.stats?.confirmed ?? 0} confirmed), including operator reviews</li>
      </ul>
      {mission.isDefault && (
        <p className="mt-2 text-[11px] text-slate-500">This is the default mission; it is created again automatically the next time a scan is uploaded without a mission.</p>
      )}
    </Modal>
  );
}

/** One mission row in the dropdown: select, inline rename, delete. */
function MissionRow({ mission, active, onSelect, onDelete }) {
  const updateMission = useMissionStore((s) => s.updateMission);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(mission.name);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const next = name.trim();
    if (!next || next === mission.name) return setEditing(false);
    setSaving(true);
    try {
      await updateMission(mission.id, { name: next });
      setEditing(false);
    } catch {
      /* keep editing; toast shown by the store (e.g. duplicate name) */
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="flex items-center gap-1 px-2 py-1.5 bg-blue-50" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
            if (e.key === 'Escape') { e.stopPropagation(); setName(mission.name); setEditing(false); }
          }}
          className="flex-1 min-w-0 bg-white border border-blue-300 rounded px-1.5 py-0.5 text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
          aria-label="Mission name"
        />
        <button type="button" onClick={save} disabled={saving} className="p-1 text-emerald-600 hover:bg-emerald-100 rounded cursor-pointer" title="Save (Enter)">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
        </button>
        <button type="button" onClick={() => { setName(mission.name); setEditing(false); }} className="p-1 text-slate-500 hover:bg-slate-200 rounded cursor-pointer" title="Cancel (Esc)">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={cn('group flex items-center gap-2 px-2 py-1.5 cursor-pointer', active ? 'bg-blue-50' : 'hover:bg-slate-50')}
    >
      <span className="w-3.5 shrink-0">{active && <Check className="w-3.5 h-3.5 text-blue-600" />}</span>
      <span className="flex-1 min-w-0">
        <span className={cn('block truncate text-xs', active ? 'font-semibold text-blue-700' : 'text-slate-800')} title={mission.name}>{mission.name}</span>
        <span className="block text-[10px] font-mono text-slate-400">
          {mission.stats?.scans ?? 0} scans · {mission.stats?.confirmed ?? 0} det.{mission.isDefault ? ' · default' : ''}
        </span>
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setName(mission.name); setEditing(true); }}
        className="p-1 rounded text-slate-400 hover:text-blue-600 hover:bg-blue-100 opacity-60 group-hover:opacity-100 cursor-pointer"
        title="Rename mission"
        aria-label={`Rename ${mission.name}`}
      >
        <Pencil className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(mission); }}
        className="p-1 rounded text-slate-400 hover:text-red-600 hover:bg-red-100 opacity-60 group-hover:opacity-100 cursor-pointer"
        title="Delete mission and all its detections"
        aria-label={`Delete ${mission.name}`}
      >
        <Trash2 className="w-3 h-3" />
      </button>
    </div>
  );
}

/** Mission dropdown: select (incl. "All missions"), rename and delete in place, create new. */
function MissionDropdown({ open, onClose, onNew, className }) {
  const missions = useMissionStore((s) => s.missions);
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const setActiveMission = useMissionStore((s) => s.setActiveMission);
  const [toDelete, setToDelete] = useState(null);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (toDelete) return;                              // clicks inside the confirm dialog
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    const onKey = (e) => e.key === 'Escape' && !toDelete && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, onClose, toDelete]);

  const pick = (id) => {
    setActiveMission(id);
    onClose();
  };

  return (
    <>
      {open && (
        <div ref={ref} role="listbox" className={cn('absolute z-[1500] bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden', className)}>
          <div className="max-h-72 overflow-y-auto divide-y divide-slate-100">
            <div
              role="option"
              aria-selected={!activeMissionId}
              onClick={() => pick(null)}
              className={cn('flex items-center gap-2 px-2 py-1.5 cursor-pointer', !activeMissionId ? 'bg-blue-50' : 'hover:bg-slate-50')}
            >
              <span className="w-3.5 shrink-0">{!activeMissionId && <Check className="w-3.5 h-3.5 text-blue-600" />}</span>
              <span className={cn('text-xs', !activeMissionId ? 'font-semibold text-blue-700' : 'text-slate-800')}>All missions</span>
            </div>
            {missions.map((m) => (
              <MissionRow key={m.id} mission={m} active={m.id === activeMissionId} onSelect={() => pick(m.id)} onDelete={setToDelete} />
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onClose(); onNew(); }}
            className="w-full flex items-center gap-1.5 px-2.5 py-2 text-xs font-semibold text-blue-600 hover:bg-blue-50 border-t border-slate-200 cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5" />New mission…
          </button>
        </div>
      )}
      <DeleteMissionDialog mission={toDelete} onClose={() => setToDelete(null)} />
    </>
  );
}

/** Sidebar block: choose, rename, delete or create the active mission (scopes every tab). */
export default function MissionPanel({ collapsed }) {
  const missions = useMissionStore((s) => s.missions);
  const activeMissionId = useMissionStore((s) => s.activeMissionId);
  const [newOpen, setNewOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = missions.find((m) => m.id === activeMissionId);
  const closeMenu = useCallback(() => setMenuOpen(false), []);

  if (collapsed) {
    return (
      <div className="relative mx-auto my-1">
        <button
          type="button"
          title={`Mission: ${active?.name ?? 'All missions'}`}
          onClick={() => setMenuOpen((v) => !v)}
          className="p-1.5 rounded-md text-blue-600 hover:bg-blue-50 cursor-pointer"
        >
          <Target className="w-4 h-4" />
        </button>
        <MissionDropdown open={menuOpen} onClose={closeMenu} onNew={() => setNewOpen(true)} className="left-full top-0 ml-2 w-72" />
        <NewMissionDialog open={newOpen} onClose={() => setNewOpen(false)} />
      </div>
    );
  }

  return (
    <div className="mx-3 mt-3 p-2.5 rounded-lg bg-slate-50 border border-slate-200 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono font-bold text-slate-500 uppercase">Active Mission</span>
        <button type="button" onClick={() => setNewOpen(true)} className="text-[10px] font-semibold text-blue-600 hover:text-blue-800 flex items-center gap-1 cursor-pointer" title="Create a new mission">
          <FolderPlus className="w-3 h-3" />New
        </button>
      </div>
      <div className="relative">
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className="w-full flex items-center justify-between gap-1 bg-white border border-slate-300 text-slate-800 rounded-md px-2 py-1 text-xs font-medium hover:border-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-500 cursor-pointer"
        >
          <span className="truncate">{active?.name ?? 'All missions'}</span>
          <ChevronDown className={cn('w-3.5 h-3.5 shrink-0 text-slate-500 transition-transform', menuOpen && 'rotate-180')} />
        </button>
        <MissionDropdown open={menuOpen} onClose={closeMenu} onNew={() => setNewOpen(true)} className="left-0 top-full mt-1 w-72" />
      </div>
      <div className="text-[10px] font-mono text-slate-500 flex justify-between">
        {active ? (
          <>
            <span>{active.stats.scans} scans</span>
            <span>{active.stats.confirmed} detections</span>
            <span className={active.stats.hazards ? 'text-red-600 font-bold' : ''}>{active.stats.hazards} hazards</span>
          </>
        ) : (
          <span>Uploads go to "General Survey"</span>
        )}
      </div>
      <NewMissionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}
