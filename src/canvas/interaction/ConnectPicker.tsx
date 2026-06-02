import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { CanvasItem } from '../items/types';
import { t } from '../../i18n/strings';

// Optional "Connect to… (type a name)" affordance for the connect (arrow) tool.
// It lives in the TOP-RIGHT corner so it never blocks the canvas, and manual
// connect stays the default: with a source picked you still just click the
// target card (the green rubber-band follows your cursor as usual). This pill
// is the shortcut for FAR / off-screen targets — type a name instead of hunting
// for the card. The candidate list only appears once you start typing. The X
// MINIMIZES it to a tiny pill (it doesn't cancel — leaving the connect tool
// does that). It disappears entirely when the connect tool is exited (gated by
// the caller).

function labelFor(it: CanvasItem): string {
    switch (it.type) {
        case 'text': {
            for (const line of String(it.content ?? '').split('\n')) {
                const tr = line.trim();
                if (tr) return tr.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || tr;
            }
            return '(empty note)';
        }
        case 'image': return it.fileName || 'image';
        case 'file': return it.fileName || 'file';
        case 'container': return it.title || 'group';
        case 'code': return it.fileName || `${it.language} snippet`;
        case 'link': return it.title || it.url || 'link';
        default: return it.type;
    }
}

const CONNECTABLE = new Set(['text', 'image', 'file', 'container', 'code', 'link', 'video', 'audio']);

interface Props {
    sourceId: string;
    items: Record<string, CanvasItem>;
    order: string[];
    onPick: (targetId: string) => void;
    onCancel: () => void;
}

export function ConnectPicker({ sourceId, items, order, onPick, onCancel }: Props) {
    const [q, setQ] = useState('');
    const [idx, setIdx] = useState(0);
    const [minimized, setMinimized] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const sourceLabel = items[sourceId] ? labelFor(items[sourceId]) : '';

    const candidates = useMemo(() => {
        const ql = q.trim().toLowerCase();
        if (!ql) return [];
        return order
            .map(id => items[id])
            .filter((it): it is CanvasItem => !!it && it.id !== sourceId && CONNECTABLE.has(it.type))
            .map(it => ({ id: it.id, label: labelFor(it), type: it.type }))
            .filter(c => c.label.toLowerCase().includes(ql))
            .slice(0, 8);
    }, [q, items, order, sourceId]);

    useEffect(() => { setIdx(0); }, [q]);
    const pick = (i: number) => { const c = candidates[i]; if (c) onPick(c.id); };

    // Minimized → a tiny corner pill. Click to expand + focus the input.
    if (minimized) {
        return (
            <button
                data-canvas-ui="1"
                onClick={() => { setMinimized(false); requestAnimationFrame(() => inputRef.current?.focus()); }}
                className="absolute top-16 right-3 z-40 no-drag flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-[#12121a] border border-emerald-500/30 text-emerald-300 text-[11px] font-medium shadow-[0_6px_24px_rgba(0,0,0,0.5)] hover:bg-emerald-500/10 transition-colors animate-in fade-in duration-150"
                title={t('canvas.connect.expand')}
            >
                <ArrowRight size={12} /> {t('canvas.connect.to')}…
            </button>
        );
    }

    const showList = q.trim().length > 0;
    return (
        <div
            data-canvas-ui="1"
            className="absolute top-16 right-3 z-40 no-drag w-[min(300px,calc(100vw-24px))] rounded-xl bg-[#12121a] border border-emerald-500/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
        >
            <div className="flex items-center gap-2 px-3 py-2">
                <ArrowRight size={13} className="text-emerald-400 shrink-0" />
                <span className="text-[11.5px] text-white/55 shrink-0 truncate max-w-[80px]" title={sourceLabel}>{sourceLabel}</span>
                <span className="text-[11px] text-emerald-300/60 shrink-0">{t('canvas.connect.to')}</span>
                <input
                    ref={inputRef}
                    dir="auto"
                    value={q}
                    placeholder={t('canvas.connect.placeholder')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-white/85 placeholder-white/30"
                    onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                        else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, candidates.length - 1)); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
                        else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
                    }}
                    onChange={e => setQ(e.target.value)}
                />
                {/* X minimizes (does not cancel) — leaving the connect tool dismisses it. */}
                <button onClick={() => setMinimized(true)} className="p-1 rounded hover:bg-white/5 text-white/40 shrink-0" title={t('canvas.connect.minimize')}><X size={12} /></button>
            </div>
            {showList && candidates.length > 0 && (
                <div className="max-h-56 overflow-auto py-1 border-t border-white/5">
                    {candidates.map((c, i) => (
                        <button
                            key={c.id}
                            onMouseEnter={() => setIdx(i)}
                            onClick={() => pick(i)}
                            className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === idx ? 'bg-emerald-500/15' : 'hover:bg-white/5'}`}
                        >
                            <span className="text-[13px] text-white/85 truncate flex-1 min-w-0">{c.label}</span>
                            <span className="text-[9px] uppercase tracking-wider text-white/30 shrink-0">{c.type}</span>
                        </button>
                    ))}
                </div>
            )}
            {showList && candidates.length === 0 && (
                <div className="px-3 py-2 text-[12px] text-white/40 border-t border-white/5">{t('canvas.connect.empty')}</div>
            )}
            {!showList && (
                <div className="px-3 py-1.5 text-[10px] text-white/30 border-t border-white/5">{t('canvas.connect.hint')}</div>
            )}
        </div>
    );
}
