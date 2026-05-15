import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { fitToViewport } from '../CanvasEngine';

interface Props {
    open: boolean;
    onClose: () => void;
}

// Ctrl+F search across all canvas items. Matches text item content, file names,
// container titles. Enter cycles results, arrow keys work too. Selected match
// is panned into view and highlighted in the selection.

interface Hit {
    id: string;
    label: string;
    snippet: string;
}

export function SearchPanel({ open, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    const [q, setQ] = useState('');
    const [idx, setIdx] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);

    const hits = useMemo<Hit[]>(() => {
        if (!q.trim()) return [];
        const qq = q.toLowerCase();
        const out: Hit[] = [];
        for (const id of state.order) {
            const it = state.items[id];
            if (!it) continue;
            let label = '';
            let hay = '';
            if (it.type === 'text') {
                label = 'text';
                hay = it.content;
            } else if (it.type === 'file') {
                label = `file · ${it.extension}`;
                hay = it.fileName;
            } else if (it.type === 'image') {
                label = 'image';
                hay = it.fileName || '';
            } else if (it.type === 'container') {
                label = 'container';
                hay = it.title || '';
            } else continue;
            const pos = hay.toLowerCase().indexOf(qq);
            if (pos < 0) continue;
            const s = Math.max(0, pos - 16);
            const e = Math.min(hay.length, pos + qq.length + 32);
            const snippet = (s > 0 ? '…' : '') + hay.slice(s, e) + (e < hay.length ? '…' : '');
            out.push({ id, label, snippet });
        }
        return out;
    }, [q, state.items, state.order]);

    useEffect(() => {
        if (open) {
            setQ('');
            setIdx(0);
            const r = requestAnimationFrame(() => inputRef.current?.focus());
            return () => cancelAnimationFrame(r);
        }
    }, [open]);

    useEffect(() => { setIdx(0); }, [q]);

    const jumpTo = (hitIdx: number) => {
        const hit = hits[hitIdx];
        if (!hit) return;
        const it = state.items[hit.id];
        if (!it) return;
        dispatch({ type: 'SELECT', ids: [hit.id] });
        const view = fitToViewport(
            { x: it.x - 200, y: it.y - 200, w: it.w + 400, h: it.h + 400 },
            { w: window.innerWidth, h: window.innerHeight },
        );
        dispatch({ type: 'SET_VIEW', view });
    };

    const next = () => {
        if (hits.length === 0) return;
        const n = (idx + 1) % hits.length;
        setIdx(n);
        jumpTo(n);
    };
    const prev = () => {
        if (hits.length === 0) return;
        const n = (idx - 1 + hits.length) % hits.length;
        setIdx(n);
        jumpTo(n);
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute top-3 right-3 z-40 no-drag w-[min(420px,calc(100vw-24px))] rounded-xl bg-[#12121a] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                <Search size={13} className="text-emerald-400" />
                <input
                    ref={inputRef}
                    placeholder="Search canvas"
                    className="flex-1 bg-transparent outline-none text-[13px] text-white/85 placeholder-white/30"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Escape') onClose();
                        else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); next(); }
                        else if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); prev(); }
                    }}
                />
                <span className="text-[10px] text-white/40 tabular-nums">
                    {hits.length > 0 ? `${idx + 1}/${hits.length}` : q ? 'no results' : ''}
                </span>
                <button onClick={prev} disabled={hits.length === 0} className="p-1 rounded hover:bg-white/5 text-white/50 disabled:opacity-30"><ChevronUp size={12} /></button>
                <button onClick={next} disabled={hits.length === 0} className="p-1 rounded hover:bg-white/5 text-white/50 disabled:opacity-30"><ChevronDown size={12} /></button>
                <button onClick={onClose} className="p-1 rounded hover:bg-white/5 text-white/50"><X size={12} /></button>
            </div>
            {hits.length > 0 && (
                <div className="max-h-64 overflow-auto">
                    {hits.map((h, i) => (
                        <button
                            key={h.id}
                            onClick={() => { setIdx(i); jumpTo(i); }}
                            className={`w-full text-left px-3 py-2 border-b border-white/[0.03] hover:bg-white/5 transition-colors ${i === idx ? 'bg-emerald-500/10' : ''}`}
                        >
                            <div className="text-[10px] text-emerald-300/70 uppercase tracking-widest">{h.label}</div>
                            <div className="text-[12px] text-white/80 truncate">{h.snippet}</div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
