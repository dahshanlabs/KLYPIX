import React, { useMemo } from 'react';
import { Eye, EyeOff, Lock, Unlock, X } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';

interface Props {
    open: boolean;
    onClose: () => void;
}

// Layers: items with the same layerId group together. Toggle visibility or
// lock a layer. Default layer 'content' holds any item without an explicit
// layerId. Auto-generated layers 'agent' and 'drawings' appear when there are
// matching items.

const DEFAULT_LAYERS = ['content', 'agent', 'drawings'];

export function LayersPanel({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();

    const layerInfo = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const id of state.order) {
            const it = state.items[id];
            if (!it) continue;
            const layer = it.layerId || (it.createdBy === 'agent' ? 'agent' : 'content');
            counts[layer] = (counts[layer] || 0) + 1;
        }
        for (const l of DEFAULT_LAYERS) if (!(l in counts)) counts[l] = 0;
        return Object.entries(counts).sort((a, b) => a[0].localeCompare(b[0]));
    }, [state.items, state.order]);

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 right-3 z-30 no-drag w-[200px] rounded-xl bg-[#12121a]/95 border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden animate-in slide-in-from-right-2 fade-in duration-150">
            <div className="px-3 py-2 border-b border-white/5 flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-widest text-white/60 flex-1">Layers</span>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/40"><X size={12} /></button>
            </div>
            <div className="py-1">
                {layerInfo.map(([layer, count]) => {
                    const hidden = state.hiddenLayers.includes(layer);
                    const locked = state.lockedLayers.includes(layer);
                    return (
                        <div key={layer} className="px-3 py-1.5 flex items-center gap-2 hover:bg-white/5">
                            <button
                                onClick={() => dispatch({ type: 'TOGGLE_LAYER_HIDDEN', layerId: layer })}
                                className={`p-1 rounded ${hidden ? 'text-white/30' : 'text-emerald-300/80'} hover:bg-white/5`}
                                title={hidden ? 'Show layer' : 'Hide layer'}
                            >
                                {hidden ? <EyeOff size={11} /> : <Eye size={11} />}
                            </button>
                            <button
                                onClick={() => dispatch({ type: 'TOGGLE_LAYER_LOCKED', layerId: layer })}
                                className={`p-1 rounded ${locked ? 'text-amber-300' : 'text-white/40'} hover:bg-white/5`}
                                title={locked ? 'Unlock layer' : 'Lock layer'}
                            >
                                {locked ? <Lock size={11} /> : <Unlock size={11} />}
                            </button>
                            <span className={`flex-1 text-[11px] truncate ${hidden ? 'text-white/30' : 'text-white/75'}`}>{layer}</span>
                            <span className="text-[9px] text-white/30 tabular-nums">{count}</span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

/** Resolve the effective layer id for an item (default fallbacks). */
export function effectiveLayerId(item: { layerId?: string; createdBy: string }): string {
    if (item.layerId) return item.layerId;
    if (item.createdBy === 'agent') return 'agent';
    return 'content';
}
