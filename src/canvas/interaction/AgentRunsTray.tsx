import { Square, X } from 'lucide-react';
import { AgentRobot } from '../../components/AgentRobot';
import { t, useLocale } from '../../i18n/strings';
import type { AgentRun } from '../agent/useAgentRuns';

// AI Activity tray — one pill per concurrent canvas-agent run (parallel agents).
// Each pill: the purple mascot, the command label, a live step/tool line, and a
// per-run Stop (■) while running / dismiss (✕) on error. Clicking the pill BODY
// re-opens the command bar (so you can see/continue) — only the ■ stops the run.
// Docked right, BELOW the top file-ops bar (top-3 + ~34px tall → top-14 clears
// it), stacking downward so pills never overlap the toolbar row.
interface Props {
    runs: AgentRun[];
    onStop: (id: string) => void;
    onDismiss: (id: string) => void;
    /** Re-open the command bar — fired when the pill body is clicked. */
    onOpen: () => void;
}

export function AgentRunsTray({ runs, onStop, onDismiss, onOpen }: Props) {
    useLocale();
    if (runs.length === 0) return null;
    return (
        <div data-canvas-ui="1" className="absolute top-14 right-4 z-40 no-drag flex flex-col gap-2 items-end">
            {runs.map(run => {
                const isError = run.status === 'error';
                const stepText = isError
                    ? (run.error || t('canvas.command_bar.stopped'))
                    : run.progress
                        ? t('canvas.command_bar.step').replace('{n}', String(run.progress.turn)) + (run.progress.tool ? ` · ${run.progress.tool}` : '')
                        : t('canvas.command_bar.thinking');
                return (
                    <div
                        key={run.id}
                        className={`flex items-center gap-2 pl-1.5 pr-1.5 py-1.5 rounded-2xl bg-[#292C2C] border shadow-[0_8px_32px_rgba(0,0,0,0.5)] animate-in fade-in slide-in-from-right-1 duration-200 max-w-[300px] ${isError ? 'border-red-500/40' : 'border-emerald-500/30'}`}
                    >
                        {/* Body → re-open the command bar (NOT stop). */}
                        <button
                            onClick={onOpen}
                            title={t('canvas.command_bar.restore')}
                            className="flex items-center gap-2 min-w-0 cursor-pointer text-left"
                        >
                            <AgentRobot isWorking={!isError} />
                            <div className="flex flex-col leading-tight min-w-0 pr-1">
                                <span className={`text-[11px] font-medium truncate ${isError ? 'text-red-300' : 'text-white/85'}`}>{run.label}</span>
                                <span className={`text-[10px] truncate ${isError ? 'text-red-400/80' : 'text-white/50'}`}>{stepText}</span>
                            </div>
                        </button>
                        {isError ? (
                            <button
                                onClick={() => onDismiss(run.id)}
                                title={t('canvas.command_bar.close_hint')}
                                className="w-6 h-6 flex items-center justify-center rounded-full bg-white/5 text-white/40 hover:bg-white/10 hover:text-white/70 transition-all shrink-0 cursor-pointer"
                            >
                                <X size={11} />
                            </button>
                        ) : (
                            <button
                                onClick={() => onStop(run.id)}
                                title={t('canvas.command_bar.stop')}
                                className="w-6 h-6 flex items-center justify-center rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/30 transition-all shrink-0 cursor-pointer"
                            >
                                <Square size={10} fill="currentColor" />
                            </button>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
