import { useEffect, useState } from 'react';
import { X, Stamp, Trash2 } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { deleteTemplate, listTemplates, stampTemplate, type Template } from '../file/templates';

interface Props {
    open: boolean;
    onClose: () => void;
}

export function TemplatesPanel({ open, onClose }: Props) {
    const { state, commit, dispatch } = useCanvasStore();
    const [templates, setTemplates] = useState<Template[]>([]);

    useEffect(() => { if (open) setTemplates(listTemplates()); }, [open]);

    const stamp = (tpl: Template) => {
        // Drop the template at the viewport center in world coords so the
        // user sees it right where they're looking.
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const worldX = (vw / 2 - state.view.panX) / state.view.zoom;
        const worldY = (vh / 2 - state.view.panY) / state.view.zoom;
        const { items, connections } = stampTemplate(tpl, worldX, worldY);
        const newIds: string[] = [];
        for (const it of items) {
            commit({ type: 'ADD_ITEM', item: it });
            newIds.push(it.id);
        }
        for (const c of connections) commit({ type: 'ADD_CONNECTION', connection: c });
        dispatch({ type: 'SELECT', ids: newIds });
        onClose();
    };

    const remove = (tpl: Template) => {
        if (!window.confirm(`Delete template "${tpl.name}"?`)) return;
        deleteTemplate(tpl.id);
        setTemplates(listTemplates());
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 right-3 bottom-16 z-30 no-drag w-[280px] rounded-xl bg-[#12121a]/95 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] flex flex-col overflow-hidden animate-in slide-in-from-right-2 fade-in duration-150">
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <Stamp size={12} className="text-emerald-400" />
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 flex-1">Templates</span>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/40"><X size={12} /></button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {templates.length === 0 && (
                    <div className="p-3 text-[11px] text-white/40 italic">
                        No templates yet. Select items on the canvas and right-click → "Save as template…" to add one.
                    </div>
                )}
                {templates.map(t => (
                    <div
                        key={t.id}
                        className="group px-3 py-2 border-b border-white/5 hover:bg-white/[0.03] transition-colors flex items-center gap-2"
                    >
                        <div className="min-w-0 flex-1">
                            <div className="text-[12px] text-white/80 truncate flex items-center gap-1.5">
                                {t.name}
                                {t.isBuiltin && (
                                    <span className="text-[8.5px] uppercase tracking-wider text-emerald-300/70 bg-emerald-500/10 border border-emerald-500/20 rounded px-1 py-[1px]">
                                        Sample
                                    </span>
                                )}
                            </div>
                            <div className="text-[9.5px] text-white/35 uppercase tracking-wider">
                                {t.items.length} {t.items.length === 1 ? 'item' : 'items'}
                                {t.connections.length > 0 && ` · ${t.connections.length} arrow${t.connections.length === 1 ? '' : 's'}`}
                            </div>
                        </div>
                        <button
                            onClick={() => stamp(t)}
                            className="p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/25 text-emerald-300 transition-all"
                            title="Stamp at viewport center"
                        >
                            <Stamp size={11} />
                        </button>
                        {!t.isBuiltin && (
                            <button
                                onClick={() => remove(t)}
                                className="p-1.5 rounded hover:bg-red-500/15 text-white/40 hover:text-red-300 transition-all"
                                title="Delete template"
                            >
                                <Trash2 size={11} />
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}
