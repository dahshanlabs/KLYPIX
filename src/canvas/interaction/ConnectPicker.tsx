import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { CanvasItem } from '../items/types';
import { t } from '../../i18n/strings';

// "Connect to… (type a name)" picker. Shown when the connect (arrow) tool has a
// pending source card. Instead of forcing a second click on the target — painful
// when the target is far away or off-screen — the user types the target card's
// name and picks it; the hook's connectTo() then draws a real arrow. The
// existing click-the-second-card path keeps working alongside this.

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
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        // rAF: Electron needs a paint before focus sticks.
        const raf = requestAnimationFrame(() => inputRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, []);

    const sourceLabel = items[sourceId] ? labelFor(items[sourceId]) : '';

    const candidates = useMemo(() => {
        const ql = q.trim().toLowerCase();
        return order
            .map(id => items[id])
            .filter((it): it is CanvasItem => !!it && it.id !== sourceId && CONNECTABLE.has(it.type))
            .map(it => ({ id: it.id, label: labelFor(it), type: it.type }))
            .filter(c => !ql || c.label.toLowerCase().includes(ql))
            .slice(0, 8);
    }, [q, items, order, sourceId]);

    useEffect(() => { setIdx(0); }, [q]);

    const pick = (i: number) => { const c = candidates[i]; if (c) onPick(c.id); };

    return (
        <div
            data-canvas-ui="1"
            className="absolute top-16 left-1/2 -translate-x-1/2 z-40 no-drag w-[min(440px,calc(100vw-24px))] rounded-xl bg-[#12121a] border border-emerald-500/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150"
        >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                <ArrowRight size={13} className="text-emerald-400 shrink-0" />
                <span className="text-[12px] text-white/55 shrink-0 truncate max-w-[150px]" title={sourceLabel}>{sourceLabel}</span>
                <span className="text-[11px] text-emerald-300/60 shrink-0">{t('canvas.connect.to')}</span>
                <input
                    ref={inputRef}
                    dir="auto"
                    value={q}
                    placeholder={t('canvas.connect.placeholder')}
                    className="flex-1 min-w-0 bg-transparent outline-none text-[13px] text-white/85 placeholder-white/30"
                    onChange={e => setQ(e.target.value)}
                    onKeyDown={e => {
                        e.stopPropagation();
                        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
                        else if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(i => Math.min(i + 1, candidates.length - 1)); }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(i => Math.max(i - 1, 0)); }
                        else if (e.key === 'Enter') { e.preventDefault(); pick(idx); }
                    }}
                />
                <button onClick={onCancel} className="p-1 rounded hover:bg-white/5 text-white/50 shrink-0" title="Esc"><X size={12} /></button>
            </div>
            <div className="max-h-64 overflow-auto py-1">
                {candidates.length === 0 ? (
                    <div className="px-3 py-3 text-[12px] text-white/40">{t('canvas.connect.empty')}</div>
                ) : candidates.map((c, i) => (
                    <button
                        key={c.id}
                        onMouseEnter={() => setIdx(i)}
                        onClick={() => pick(i)}
                        className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${i === idx ? 'bg-emerald-500/15' : 'hover:bg-white/5'}`}
                    >
                        <span className="text-[9px] uppercase tracking-widest text-emerald-300/50 w-11 shrink-0">{c.type}</span>
                        <span className="text-[13px] text-white/85 truncate">{c.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
