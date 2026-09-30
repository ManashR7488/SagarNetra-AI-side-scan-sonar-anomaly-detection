import { Compass, FileUp, X } from 'lucide-react';
import { useWorkspaceStore } from '../store/useWorkspaceStore';
import Modal, { Field, inputClass } from './Modal';

/** Where the sonar was when the images were recorded: used by the AI service to geotag detections. */
export default function GeoreferenceDialog({ open, onClose }) {
  const georef = useWorkspaceStore((s) => s.georef);
  const setGeoref = useWorkspaceStore((s) => s.setGeoref);
  const useDemoGeoref = useWorkspaceStore((s) => s.useDemoGeoref);
  const setUseDemoGeoref = useWorkspaceStore((s) => s.setUseDemoGeoref);
  const set = (k) => (e) => setGeoref({ [k]: e.target.value });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Georeference for new predictions"
      icon={Compass}
      width="max-w-xl"
      footer={<button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">Done</button>}
    >
      <div className="space-y-4">
        <p className="text-slate-500 leading-relaxed">
          XTF logs carry their own navigation in the ping headers. For plain images, give the survey position here
          (or attach a navigation CSV/JSON with one fix per ping) so detections get latitude/longitude and real-world size.
        </p>

        <label className="flex items-center gap-2 font-semibold cursor-pointer">
          <input type="checkbox" checked={georef.enabled} onChange={(e) => setGeoref({ enabled: e.target.checked })} className="accent-blue-600" />
          Apply this georeference to images I predict
        </label>

        <fieldset disabled={!georef.enabled} className="grid grid-cols-2 gap-3 disabled:opacity-50">
          <Field label="Latitude (°)" hint="Negative = South"><input type="number" step="any" className={inputClass} value={georef.latitude} onChange={set('latitude')} placeholder="13.0842" /></Field>
          <Field label="Longitude (°)" hint="Negative = West"><input type="number" step="any" className={inputClass} value={georef.longitude} onChange={set('longitude')} placeholder="80.3824" /></Field>
          <Field label="Heading (° true)"><input type="number" min="0" max="360" step="any" className={inputClass} value={georef.headingDeg} onChange={set('headingDeg')} placeholder="0" /></Field>
          <Field label="Swath width (m)" hint="Port + starboard; mission default if empty"><input type="number" min="1" step="any" className={inputClass} value={georef.swathWidthM} onChange={set('swathWidthM')} placeholder="150" /></Field>
          <Field label="Position refers to">
            <select className={inputClass} value={georef.anchor} onChange={set('anchor')}>
              <option value="center">Image centre</option>
              <option value="start">First ping (top row)</option>
            </select>
          </Field>
          <Field label="Navigation file (optional)" hint="CSV/JSON: lat, lon, [heading], [ping|row], [altitude]">
            {georef.navFile ? (
              <div className="flex items-center justify-between bg-slate-50 border border-slate-300 rounded-md px-2.5 py-1.5 font-mono">
                <span className="truncate">{georef.navFile.name}</span>
                <button type="button" onClick={() => setGeoref({ navFile: null })} className="text-slate-400 hover:text-red-600 cursor-pointer"><X className="w-3.5 h-3.5" /></button>
              </div>
            ) : (
              <span className={`${inputClass} flex items-center gap-1.5 cursor-pointer hover:bg-slate-50`}>
                <FileUp className="w-3.5 h-3.5 text-blue-600" />Attach CSV / JSON
                <input type="file" accept=".csv,.json,.txt" className="hidden" onChange={(e) => setGeoref({ navFile: e.target.files?.[0] ?? null })} />
              </span>
            )}
          </Field>
        </fieldset>

        <label className="flex items-start gap-2 cursor-pointer border-t border-slate-100 pt-3">
          <input type="checkbox" checked={useDemoGeoref} onChange={(e) => setUseDemoGeoref(e.target.checked)} className="accent-blue-600 mt-0.5" />
          <span>
            <span className="font-semibold">Use demo positions for bundled sample images</span>
            <span className="block text-slate-500">Samples have no navigation data; this places them at demo survey positions in the Bay of Bengal so the map and cleanup route can be shown. Ignored when the georeference above is enabled.</span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
