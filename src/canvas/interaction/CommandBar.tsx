import React, { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, X, Square } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { resolveScope } from '../agent/canvasScopeResolver';
import { runCanvasAgent, type AgentProgress } from '../agent/canvasAgent';
import { AgentRobot } from '../../components/AgentRobot';
import type { CanvasItem } from '../items/types';
import { t, useLocale } from '../../i18n/strings';

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
    useLocale();
    const { state, dispatch, pushSnapshot } = useCanvasStore();
    const stateRef = useRef(state);
    stateRef.current = state;
    const [input, setInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [progress, setProgress] = useState<AgentProgress | null>(null);
    const [error, setError] = useState<string | null>(null);
    // Minimized: the bar collapses to a small corner pill while the run keeps
    // going. abortRef carries the current run's AbortController so Stop can
    // cancel it cooperatively.
    const [minimized, setMinimized] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
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
        const controller = new AbortController();
        abortRef.current = controller;
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
                signal: controller.signal,
                onProgress: (p) => {
                    setProgress(p);
                    onProgress?.(p);
                },
            });
            if (runErr === 'aborted') {
                // User pressed Stop — not a failure. Dismiss quietly; whatever
                // the agent already placed on the canvas stays.
                onToast(t('canvas.command_bar.stopped'));
                onClose();
                return;
            }
            if (runErr) {
                setMinimized(false); // surface the error in the full bar
                setError(runErr);
                onError?.(runErr);
                return;
            }
            onClose();
        } catch (err: any) {
            const msg = err?.message || 'Agent call failed';
            setMinimized(false);
            setError(msg);
            onError?.(msg);
        } finally {
            setBusy(false);
            setProgress(null);
            onProgress?.(null);
            abortRef.current = null;
        }
    };

    // Stop the in-flight run — cooperative abort, so it ends at the next turn /
    // tool boundary. Leaves whatever the agent already placed on the canvas.
    const stop = () => {
        if (!busy) return;
        abortRef.current?.abort();
        onToast(t('canvas.command_bar.stopping'));
    };

    // X while a run is in flight → minimize to the corner pill (keep working);
    // otherwise close the bar.
    const handleDismiss = () => {
        if (busy) setMinimized(true);
        else onClose();
    };

    if (!open) return null;

    // Minimized while running → a compact corner pill (mascot + live step + Stop).
    // Click the pill body to bring the full bar back. The run keeps going either
    // way. bottom-4 left-16 sits clear of the left toolbar + bottom status bar.
    if (minimized && busy) {
        return (
            <div data-canvas-ui="1" className="absolute bottom-4 left-16 z-40 no-drag animate-in fade-in slide-in-from-left-1 duration-200">
                <div className="flex items-center gap-1.5 pl-1.5 pr-1.5 py-1.5 rounded-2xl bg-[#12121a]/95 backdrop-blur-xl border border-purple-500/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
                    <button onClick={() => setMinimized(false)} title={t('canvas.command_bar.restore')} className="flex items-center gap-2 cursor-pointer">
                        <AgentRobot isWorking />
                        <div className="flex flex-col leading-tight text-left pr-1">
                            <span className="text-purple-300 text-[11px] font-bold">KLYPIX Agent</span>
                            <span className="text-white/50 text-[10px] max-w-[160px] truncate">
                                {progress
                                    ? t('canvas.command_bar.step').replace('{n}', String(progress.turn)) + (progress.tool ? ` · ${progress.tool}` : '')
                                    : t('canvas.command_bar.thinking')}
                            </span>
                        </div>
                    </button>
                    <button onClick={stop} title={t('canvas.command_bar.stop')} className="w-6 h-6 flex items-center justify-center rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/30 transition-all cursor-pointer shrink-0">
                        <Square size={10} fill="currentColor" />
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div data-canvas-ui="1" className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40 w-[min(640px,90vw)] no-drag animate-in slide-in-from-bottom-2 fade-in duration-150">
            {/* Working mascot — same purple AgentRobot the chat agent uses, floating
                above the bar while a canvas-agent run is in flight. */}
            {busy && (
                <div className="absolute -top-[68px] left-1/2 -translate-x-1/2 flex items-center gap-2.5 pl-2.5 pr-4 py-2 rounded-2xl bg-[#12121a]/95 backdrop-blur-xl border border-purple-500/30 shadow-[0_-8px_32px_rgba(0,0,0,0.5)] animate-in fade-in slide-in-from-bottom-1 duration-200">
                    <AgentRobot isWorking />
                    <div className="flex flex-col leading-tight">
                        <span className="text-purple-300 text-[12px] font-bold">KLYPIX Agent</span>
                        <span className="text-white/50 text-[11px]">{t('canvas.command_bar.thinking')}</span>
                    </div>
                </div>
            )}
            <div className="bg-[#12121a]/95 backdrop-blur-xl border border-emerald-500/30 rounded-2xl shadow-[0_-8px_32px_rgba(0,0,0,0.5)] overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3">
                    <span className="text-emerald-400 text-lg font-bold leading-none">/</span>
                    <input
                        dir="auto"
                        ref={inputRef}
                        className="flex-1 bg-transparent outline-none text-white/90 text-[15px] placeholder-white/30 font-[Thmanyah_Sans,system-ui,sans-serif]"
                        placeholder={busy ? t('canvas.command_bar.thinking') : t('canvas.command_bar.placeholder')}
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
                        <>
                            <Loader2 size={16} className="text-emerald-400 animate-spin" />
                            <button onClick={stop} className="ml-0.5 text-white/40 hover:text-red-400 transition-colors cursor-pointer" title={t('canvas.command_bar.stop')}>
                                <Square size={12} fill="currentColor" />
                            </button>
                        </>
                    ) : (
                        <button onClick={submit} className="text-white/40 hover:text-emerald-300 transition-colors" title={t('canvas.command_bar.run_hint')}>
                            <CornerDownLeft size={14} />
                        </button>
                    )}
                    <button onClick={handleDismiss} className="text-white/30 hover:text-white/70 transition-colors ml-1" title={busy ? t('canvas.command_bar.minimize') : t('canvas.command_bar.close_hint')}>
                        <X size={14} />
                    </button>
                </div>
                <div className="px-4 pb-2 pt-1 text-[11px] text-white/40 flex items-center gap-2">
                    <span className="text-emerald-300/80">{scope.description}</span>
                    {progress && (
                        <span className="text-white/50">
                            · {t('canvas.command_bar.step').replace('{n}', String(progress.turn))}
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
