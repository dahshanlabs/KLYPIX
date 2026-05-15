import React from 'react';
import { ChevronRight, Home } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import type { CanvasItem } from '../items/types';

// Trail at the top of the canvas when the user has focused into a container.
// Clicking "Root" exits focus mode; clicking an intermediate container hops
// focus to that level. Spec §22B.

export function Breadcrumbs() {
    const { state, dispatch } = useCanvasStore();
    const focusedId = state.focusedContainerId;
    if (!focusedId) return null;
    const chain = buildChain(focusedId, state.items);
    if (chain.length === 0) return null;

    return (
        <div
            data-canvas-ui="1"
            className="absolute top-3 left-1/2 -translate-x-1/2 z-40 no-drag animate-in fade-in slide-in-from-top-2 duration-150"
        >
            <div
                className="flex items-center gap-1 px-3 py-1.5 rounded-full bg-[#12121a]/90 backdrop-blur-xl border border-emerald-500/20 shadow-lg text-[11px] text-white/70 font-[Outfit,system-ui,sans-serif]"
            >
                <button
                    onClick={(e) => { e.stopPropagation(); dispatch({ type: 'SET_FOCUSED_CONTAINER', id: null }); }}
                    title="Exit to root"
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-emerald-500/15 hover:text-emerald-200 transition-colors"
                >
                    <Home size={11} />
                    <span>Root</span>
                </button>
                {chain.map((c, i) => {
                    const isLast = i === chain.length - 1;
                    return (
                        <React.Fragment key={c.id}>
                            <ChevronRight size={11} className="text-white/25" />
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (isLast) return;
                                    dispatch({ type: 'SET_FOCUSED_CONTAINER', id: c.id });
                                }}
                                title={isLast ? 'You are here' : `Focus into "${c.title}"`}
                                className={`px-1.5 py-0.5 rounded transition-colors truncate max-w-[140px] ${
                                    isLast ? 'text-emerald-300 bg-emerald-500/10' : 'hover:bg-emerald-500/15 hover:text-emerald-200'
                                }`}
                            >
                                {c.title || '(untitled)'}
                            </button>
                        </React.Fragment>
                    );
                })}
            </div>
        </div>
    );
}

// Walk parent chain from the focused container up to the root. Returns
// containers from outermost → innermost (the focused container is last).
function buildChain(focusedId: string, items: Record<string, CanvasItem>): Array<{ id: string; title: string }> {
    const chain: Array<{ id: string; title: string }> = [];
    const seen = new Set<string>();
    let cur: CanvasItem | undefined = items[focusedId];
    while (cur && cur.type === 'container' && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift({ id: cur.id, title: cur.title });
        cur = cur.parentId ? items[cur.parentId] : undefined;
    }
    return chain;
}
