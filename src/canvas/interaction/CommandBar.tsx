import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, X } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { resolveScope } from '../agent/canvasScopeResolver';
import { runCanvasAgent, type AgentProgress } from '../agent/canvasAgent';
import type { CanvasItem } from '../items/types';

interface Props {
    open: boolean;
    onClose: () => void;
    onToast: (message: string) => void;
    onProgress?: (p: AgentProgress | null) => void;
    onError?: (msg: string) => void;
}

const SUGGESTED_COMMANDS = [
    '/summarize',
    '/compare',
    '/translate',
    '/research',
    '/chart',
    '/analyze',
    '/compile',
    '/organize',
    '/cleanup',
];

export function CommandBar({ open, onClose, onToast, onProgress, onError }: Props) {
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    const stateRef = useRef(state);
    stateRef.current = state;
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<AgentProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    const scope = resolveScope(input, state.selectedIds, state.order, state.items);

    // Focus on open.
    useEffect(() => {
        if (open) {
            setInput('');
            setError(null);
            // rAF: DOM must paint first in Electron before focus sticks.
            const raf = requestAnimationFrame(() => inputRef.current?.focus());
            return () => cancelAnimationFrame(raf);
        }
    }, [open]);

    const submit = async () => {
        const command = input.trim();
        if (!command || busy) return;
        setBusy(true);
        setError(null);
        setProgress(null);
        // One undo snapshot for the whole multi-tool session — Ctrl+Z reverts
        // everything the agent did in one shot.
        pushSnapshot();
        try {
            const scopeItems: CanvasItem[] = scope.itemIds
                .map(id => state.items[id])
                .filter(Boolean) as CanvasItem[];
            const { error: runErr } = await runCanvasAgent({
                command,
                scope,
                scopeItems,
                getState: () => stateRef.current,
                dispatch,
                onToast,
                onProgress: (p) => {
                    setProgress(p);
                    onProgress?.(p);
                },
            });
            if (runErr) {
                setError(runErr);
                onError?.(runErr);
                return;
            }
            onClose();
        } catch (err: any) {
            const msg = err?.message || 'Agent call failed';
            setError(msg);
            onError?.(msg);
        } finally {
            setBusy(false);
            setProgress(null);
            onProgress?.(null);
        }
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40 w-[min(640px,90vw)] no-drag animate-in slide-in-from-bottom-2 fade-in duration-150">
            <div className="bg-[#12121a]/95 backdrop-blur-xl border border-emerald-500/30 rounded-2xl shadow-[0_-8px_32px_rgba(0,0,0,0.5)] overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3">
                    <span className="text-emerald-400 text-lg font-bold leading-none">/</span>
                    <input
                        ref={inputRef}
                        className="flex-1 bg-transparent outline-none text-white/90 text-[15px] placeholder-white/30 font-[Outfit,system-ui,sans-serif]"
                        placeholder={busy ? 'thinking…' : 'ask the agent, or pick a command below'}
                        value={input}
                        disabled={busy}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                            else if (e.key === 'Enter') { e.preventDefault(); submit(); }
                        }}
                    />
                    {busy ? (
                        <Loader2 size={16} className="text-emerald-400 animate-spin" />
                    ) : (
                        <button onClick={submit} className="text-white/40 hover:text-emerald-300 transition-colors" title="Run (Enter)">
                            <CornerDownLeft size={14} />
                        </button>
                    )}
                    <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors ml-1" title="Close (Esc)">
                        <X size={14} />
                    </button>
                </div>
                <div className="px-4 pb-2 pt-1 text-[11px] text-white/40 flex items-center gap-2">
                    <span className="text-emerald-300/80">{scope.description}</span>
                    {progress && (
                        <span className="text-white/50">
                            · step {progress.turn}
                            {progress.tool && <span className="text-emerald-300/70"> · {progress.tool}</span>}
                        </span>
                    )}
                    {error && <span className="text-red-400">· {error}</span>}
                </div>
                <div className="border-t border-white/5 px-2 py-2 flex flex-wrap gap-1">
                    {SUGGESTED_COMMANDS.map(c => (
                        <button
                            key={c}
                            onClick={() => setInput((prev) => prev.startsWith('/') ? c + ' ' : c + ' ' + prev)}
                            className="text-[11px] font-medium text-white/55 hover:text-emerald-300 hover:bg-emerald-500/10 px-2.5 py-1 rounded-md transition-all"
                        >
                            {c}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}
