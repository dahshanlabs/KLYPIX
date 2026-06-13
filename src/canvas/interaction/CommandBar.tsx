import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, X } from 'lucide-react';
import { useCanvasStore } from '../state/canvasStore';
import { resolveScope, type CommandScope } from '../agent/canvasScopeResolver';
import type { CanvasItem } from '../items/types';
import { t, useLocale } from '../../i18n/strings';

// CommandBar is a pure LAUNCHER: it collects a slash command + resolves scope,
// then hands the run off to the agent-runs registry (which executes it and shows
// a pill in the AI Activity tray). It no longer runs the agent inline or tracks
// busy state, so launching a second command doesn't block on the first — that's
// what makes parallel runs possible.
interface Props {
    open: boolean;
    onClose: () => void;
    onStartRun: (args: { command: string; scope: CommandScope; scopeItems: CanvasItem[] }) => void;
    /** /garden — run the brain gardener (deterministic consolidation pass)
     *  instead of an agent run. */
    onGarden?: () => void;
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
// /garden still WORKS if typed (power users / agents), but it's intentionally
// not a visible chip — the brain offers tidying via the proactive TidyBrainPill
// instead, so normal users never need to learn a slash command for maintenance.

export function CommandBar({ open, onClose, onStartRun, onGarden }: Props) {
    useLocale();
    const { state } = useCanvasStore();
    const [input, setInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const scope = resolveScope(input, state.selectedIds, state.order, state.items);

    // Focus on open.
    useEffect(() => {
        if (open) {
            setInput('');
            // rAF: DOM must paint first in Electron before focus sticks.
            const raf = requestAnimationFrame(() => inputRef.current?.focus());
            return () => cancelAnimationFrame(raf);
        }
    }, [open]);

    const submit = () => {
        const command = input.trim();
        if (!command) return;
        // /garden is a deterministic consolidation pass, not an agent run.
        if (/^\/garden\b/i.test(command)) {
            onGarden?.();
            setInput('');
            onClose();
            return;
        }
        const scopeItems: CanvasItem[] = scope.itemIds
            .map(id => state.items[id])
            .filter(Boolean) as CanvasItem[];
        onStartRun({ command, scope, scopeItems });
        // Launch + clear so the user can immediately queue another (each run goes
        // to the AI Activity tray and can run alongside the others). Bar stays
        // open; Esc / ✕ closes it.
        setInput('');
        requestAnimationFrame(() => inputRef.current?.focus());
    };

    if (!open) return null;

    return (
        <div data-canvas-ui="1" className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40 w-[min(640px,90vw)] no-drag animate-in slide-in-from-bottom-2 fade-in duration-150">
            <div className="bg-[#12121a]/95 backdrop-blur-xl border border-emerald-500/30 rounded-2xl shadow-[0_-8px_32px_rgba(0,0,0,0.5)] overflow-hidden">
                <div className="flex items-center gap-2 px-4 py-3">
                    <span className="text-emerald-400 text-lg font-bold leading-none">/</span>
                    <input
                        dir="auto"
                        ref={inputRef}
                        className="flex-1 bg-transparent outline-none text-white/90 text-[15px] placeholder-white/30 font-[Thmanyah_Sans,system-ui,sans-serif]"
                        placeholder={t('canvas.command_bar.placeholder')}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                            else if (e.key === 'Enter') { e.preventDefault(); submit(); }
                        }}
                    />
                    <button onClick={submit} className="text-white/40 hover:text-emerald-300 transition-colors" title={t('canvas.command_bar.run_hint')}>
                        <CornerDownLeft size={14} />
                    </button>
                    <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors ml-1" title={t('canvas.command_bar.close_hint')}>
                        <X size={14} />
                    </button>
                </div>
                <div className="px-4 pb-2 pt-1 text-[11px] text-white/40 flex items-center gap-2">
                    <span className="text-emerald-300/80">{scope.description}</span>
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
