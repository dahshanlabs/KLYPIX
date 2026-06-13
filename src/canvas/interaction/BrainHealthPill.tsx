import { useState } from 'react';
import { Activity, Link2, Sprout, Unlink, HelpCircle, ChevronUp, ChevronDown, X } from 'lucide-react';
import { t, useLocale } from '../../i18n/strings';
import type { BrainHealth } from '../agent/brainHealth';

// In-app Brain Health — the human-facing twin of the MCP brain_insights +
// brain_connect tools, so you get the diagnose→fix loop WITHOUT an agent the
// moment you open a brain. Collapsed it's a one-line nudge; expanded it shows
// what's unlinked / stale and offers one-click Connect (structural, in-app) and
// Tidy (the gardener). Clicking a listed card jumps to it. Appears only when
// there's something actionable, and only on the active tab. Bottom-left, clear
// of the command bar (center), status bar, and AI Activity tray (top-right).
interface Props {
    health: BrainHealth;
    onConnect: () => void;
    onTidy: () => void;
    onJump: (id: string) => void;
    onDismiss: () => void;
}

export function BrainHealthPill({ health, onConnect, onTidy, onJump, onDismiss }: Props) {
    useLocale();
    const [open, setOpen] = useState(false);
    const { orphans, staleQuestions, tidyable, connectable, hubs } = health;

    // Collapsed summary picks the most salient signal to surface first.
    const summary = connectable > 0
        ? t('canvas.brain.connectable').replace('{n}', String(connectable))
        : orphans.length > 0
            ? t('canvas.brain.orphans').replace('{n}', String(orphans.length))
            : tidyable > 0
                ? t('canvas.tidy.action') + ' · ' + tidyable
                : t('canvas.brain.stale').replace('{n}', String(staleQuestions.length));

    const listed = [
        ...orphans.slice(0, 5).map(c => ({ ...c, kind: 'orphan' as const })),
        ...staleQuestions.slice(0, 3).map(c => ({ ...c, kind: 'stale' as const })),
    ].slice(0, 6);

    return (
        <div data-canvas-ui="1" className="absolute bottom-4 left-16 z-40 no-drag animate-in fade-in slide-in-from-left-1 duration-200">
            {open && (
                <div className="mb-2 w-[320px] rounded-2xl bg-[#12121a]/97 backdrop-blur-xl border border-blue-400/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)] overflow-hidden animate-in fade-in slide-in-from-bottom-1 duration-150">
                    {/* stats */}
                    <div className="px-3.5 pt-3 pb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-white/55">
                        <span title={t('canvas.brain.hubs_hint')}>🪢 {hubs.length} {t('canvas.brain.hubs')}</span>
                        <span>🔌 {orphans.length} {t('canvas.brain.unlinked')}</span>
                        {staleQuestions.length > 0 && <span>⏳ {staleQuestions.length} {t('canvas.brain.stale_short')}</span>}
                    </div>
                    {/* actions */}
                    <div className="px-3.5 pb-2.5 flex gap-2">
                        <button
                            onClick={() => { setOpen(false); onConnect(); }}
                            className="flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/30 transition-all cursor-pointer"
                        >
                            <Link2 size={13} /> {t('canvas.brain.connect').replace('{n}', String(connectable))}
                        </button>
                        {tidyable > 0 && (
                            <button
                                onClick={() => { setOpen(false); onTidy(); }}
                                className="flex items-center gap-1.5 text-[12px] font-medium px-2.5 py-1.5 rounded-lg bg-blue-400/15 text-blue-200 hover:bg-blue-400/30 transition-all cursor-pointer"
                            >
                                <Sprout size={13} /> {t('canvas.tidy.action')} {tidyable}
                            </button>
                        )}
                    </div>
                    {/* jump list */}
                    {listed.length > 0 && (
                        <div className="max-h-[180px] overflow-y-auto border-t border-white/5">
                            {listed.map(c => (
                                <button
                                    key={c.id}
                                    onClick={() => { setOpen(false); onJump(c.id); }}
                                    title={t('canvas.brain.jump_hint')}
                                    className="w-full flex items-start gap-2 px-3.5 py-1.5 text-left hover:bg-white/[0.06] transition-colors cursor-pointer group"
                                >
                                    {c.kind === 'orphan'
                                        ? <Unlink size={12} className="text-white/30 mt-0.5 shrink-0 group-hover:text-emerald-300/70" />
                                        : <HelpCircle size={12} className="text-amber-300/50 mt-0.5 shrink-0" />}
                                    <span className="text-[11.5px] text-white/65 leading-snug line-clamp-2 group-hover:text-white/90">{c.headline}</span>
                                </button>
                            ))}
                        </div>
                    )}
                    {/* semantic hint — the in-app connect is structural; semantic lives in the MCP tool */}
                    <div className="px-3.5 py-2 border-t border-white/5 text-[10.5px] text-white/35 leading-snug">
                        {t('canvas.brain.semantic_hint')}
                    </div>
                </div>
            )}

            <div className="flex items-center gap-2 pl-2.5 pr-1.5 py-1.5 rounded-2xl bg-[#12121a]/95 backdrop-blur-xl border border-blue-400/30 shadow-[0_8px_32px_rgba(0,0,0,0.5)]">
                <Activity size={15} className="text-blue-300 shrink-0" />
                <button
                    onClick={() => setOpen(o => !o)}
                    className="flex items-center gap-1.5 text-[12px] text-white/75 hover:text-white/95 transition-colors cursor-pointer"
                >
                    <span className="font-medium">{t('canvas.brain.health')}</span>
                    <span className="text-white/45 max-w-[150px] truncate">· {summary}</span>
                    {open ? <ChevronDown size={13} className="text-white/40" /> : <ChevronUp size={13} className="text-white/40" />}
                </button>
                <button
                    onClick={onDismiss}
                    title={t('canvas.command_bar.close_hint')}
                    className="w-6 h-6 flex items-center justify-center rounded-full text-white/35 hover:bg-white/10 hover:text-white/70 transition-all cursor-pointer shrink-0"
                >
                    <X size={11} />
                </button>
            </div>
        </div>
    );
}
