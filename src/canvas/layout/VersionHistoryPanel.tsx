import { useEffect, useState } from 'react';
import { X, Clock, RotateCcw } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { deserialize, titleFromPath, type CanvasDocumentV3 } from '../file/anyFormat';
import type { CanvasItem, Connection, DrawnLine, FreehandStroke } from '../items/types';

interface Props {
    open: boolean;
    onClose: () => void;
}

interface VersionEntry {
    path: string;
    timestamp: string;
}

// Sidebar for browsing previous save snapshots stored in the .any file.
// Click a version to restore (with confirmation). Versions are saved one per
// save into versions/<iso>.json by the main-process saveAnyFile handler.

export function VersionHistoryPanel({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    const [versions, setVersions] = useState<VersionEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const filePath = state.filePath;

    useEffect(() => {
        if (!open) return;
        if (!filePath) { setVersions([]); setError('Save the canvas first to start tracking versions.'); return; }
        let cancelled = false;
        setLoading(true);
        setError(null);
        (async () => {
            try {
                const api: any = (window as any).electron?.canvas;
                const res = await api?.listVersions?.(filePath);
                if (cancelled) return;
                if (res?.ok) setVersions(res.versions || []);
                else setError(res?.error || 'Could not read versions');
            } catch (err: any) {
                if (!cancelled) setError(err?.message || String(err));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, [open, filePath]);

    const restore = async (v: VersionEntry) => {
        if (!filePath) return;
        const ok = window.confirm(`Restore this version?\n\n${formatTs(v.timestamp)}\n\nThe current canvas will be replaced. (You can save again afterwards to create a new version.)`);
        if (!ok) return;
        const api: any = (window as any).electron?.canvas;
        const res = await api?.loadVersion?.({ filePath, versionPath: v.path });
        if (!res?.ok) { window.alert('Failed to load version: ' + (res?.error || 'unknown')); return; }
        try {
            const doc: CanvasDocumentV3 = deserialize(res.json);
            const itemMap: Record<string, CanvasItem> = {};
            for (const it of doc.items) itemMap[it.id] = it;
            const connMap: Record<string, Connection> = {};
            for (const c of (doc.connections || [])) connMap[c.id] = c;
            const lineMap: Record<string, DrawnLine> = {};
            for (const l of (doc.lines || [])) lineMap[l.id] = l;
            const strokeMap: Record<string, FreehandStroke> = {};
            for (const s of (doc.strokes || [])) strokeMap[s.id] = s;
            dispatch({
                type: 'LOAD_FILE',
                items: itemMap,
                order: doc.order,
                connections: connMap,
                lines: lineMap,
                strokes: strokeMap,
                view: doc.view,
                filePath,
                title: doc.title || titleFromPath(filePath),
            });
            // Mark dirty so the user knows to save; next save adds a new
            // version entry (which happens to equal this restored state).
            dispatch({ type: 'SET_DIRTY', dirty: true });
            onClose();
        } catch (err: any) {
            window.alert('Failed to restore: ' + (err?.message || String(err)));
        }
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 right-3 bottom-16 z-30 no-drag w-[280px] rounded-xl bg-[#12121a]/95 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden animate-in slide-in-from-right-2 fade-in duration-150">
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <Clock size={12} className="text-emerald-400" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 flex-1">Version history</span>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/40"><X size={12} /></button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {loading && <div className="p-3 text-[11px] text-white/40 italic">Loading…</div>}
                {error && <div className="p-3 text-[11px] text-amber-400/80">{error}</div>}
                {!loading && !error && versions.length === 0 && (
                    <div className="p-3 text-[11px] text-white/40 italic">No versions yet. Save the canvas to start the history.</div>
                )}
                {!loading && versions.map((v, i) => (
                    <div
                        key={v.path}
                        className="group px-3 py-2 border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <div className="min-w-0 flex-1">
                                <div className="text-[11.5px] text-white/80 truncate">{formatTs(v.timestamp)}</div>
                                <div className="text-[9.5px] text-white/35 uppercase tracking-wider">{relativeTs(v.timestamp)}{i === 0 ? ' · latest' : ''}</div>
                            </div>
                            <button
                                onClick={() => restore(v)}
                                className="opacity-60 group-hover:opacity-100 p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-300 transition-all"
                                title="Restore this version"
                            >
                                <RotateCcw size={11} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

function formatTs(iso: string): string {
    try {
        return new Date(iso).toLocaleString(undefined, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: '2-digit', minute: '2-digit',
        });
    } catch { return iso; }
}

function relativeTs(iso: string): string {
    try {
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) return '';
        const delta = Date.now() - t;
        if (delta < 60_000) return 'just now';
        if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
        if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
        return `${Math.floor(delta / 86_400_000)}d ago`;
    } catch { return ''; }
}
