import React, { useState, useEffect, useRef } from 'react';
import type { ContextInsight } from '../api/gemini';
import type { ScreenContext } from '../core/contextIntelligence';
import type { FileAccessResult, WebAccessResult } from '../core/autoEscalation';
import { getContextDisplayLabel, getAllContextOptions } from '../core/contextIntelligence';
import { KlypixEyes } from './KlypixEyes';

// ── Action type → icon + color mapping ────────────────────────────────────
const TYPE_ICONS: Record<string, string> = {
    chat: '💬',
    clipboard: '📋',
    document: '📄',
};

const TYPE_COLORS: Record<string, string> = {
    chat: 'bg-emerald-500/15 border-emerald-500/25 text-emerald-400 hover:bg-emerald-500/25',
    clipboard: 'bg-amber-500/15 border-amber-500/25 text-amber-400 hover:bg-amber-500/25',
    document: 'bg-blue-500/15 border-blue-500/25 text-blue-400 hover:bg-blue-500/25',
};

// Legacy fallback icons (for actions without typed actions)
const LEGACY_ICONS: Record<string, string> = {
    extract_table: '📊',
    save_file: '💾',
    copy_text: '📋',
    explain: '💡',
    summarize: '📝',
    search_error: '🔍',
    open_url: '🌐',
    compare: '⚖️',
};

// ── Loading Skeleton ────────────────────────────────────────────────────
export function WhatISeeSkeleton({ onDismiss, onRefresh, onStop, initialStopped = false }: { onDismiss?: () => void; onRefresh?: () => void; onStop?: () => void; initialStopped?: boolean } = {}) {
    const [stopped, setStopped] = React.useState(initialStopped);

    const handleStop = () => {
        setTransitioning(true);
        setTimeout(() => {
            setStopped(true);
            setTransitioning(false);
            onStop?.();
        }, 300);
    };

    const [transitioning, setTransitioning] = React.useState(false);

    const handleRefresh = () => {
        // Smooth transition: fade out sleeping → fade in scanning
        setTransitioning(true);
        setTimeout(() => {
            setStopped(false);
            setTransitioning(false);
            onRefresh?.();
        }, 300);
    };

    return (
        <div className="mx-4 mt-3 mb-2 rounded-2xl border overflow-hidden animate-in fade-in slide-in-from-top-2 duration-500 relative"
            style={{
                borderColor: stopped ? 'rgba(255,255,255,0.05)' : 'rgba(16,185,129,0.08)',
                background: stopped
                    ? 'linear-gradient(135deg, rgba(100,116,139,0.03) 0%, rgba(0,0,0,0) 60%)'
                    : 'linear-gradient(135deg, rgba(16,185,129,0.03) 0%, rgba(0,0,0,0) 60%)',
            }}>

            {/* Scan line — only when loading */}
            {!stopped && (
                <div className="absolute inset-0 pointer-events-none overflow-hidden">
                    <div
                        className="absolute left-0 right-0 h-[1px]"
                        style={{
                            animation: 'klypixScan 2.8s cubic-bezier(0.4, 0, 0.2, 1) infinite',
                            background: 'linear-gradient(90deg, transparent 0%, rgba(16,185,129,0.4) 20%, rgba(16,185,129,0.7) 50%, rgba(16,185,129,0.4) 80%, transparent 100%)',
                            boxShadow: '0 0 16px 2px rgba(16,185,129,0.1)',
                        }}
                    />
                </div>
            )}

            <div className="px-4 py-4 flex items-center gap-3.5 relative" style={{ opacity: transitioning ? 0 : 1, transition: 'opacity 0.3s ease-in-out' }}>
                {/* Eyes: active when loading, sleeping when stopped */}
                {stopped ? (
                    <SleepingEyes />
                ) : (
                    <KlypixEyes size={24} />
                )}

                <div className="flex-1 flex flex-col gap-0.5">
                    {stopped ? (
                        <>
                            <span className="text-[11px] text-white/30 font-medium tracking-wide">
                                On Screen paused
                            </span>
                            <span className="text-[9px] text-white/15 uppercase tracking-widest">klypix sleeping</span>
                        </>
                    ) : (
                        <>
                            <span className="text-[11px] text-emerald-400/70 font-medium tracking-wide"
                                style={{ animation: 'klypixTextFade 2.8s ease-in-out infinite' }}>
                                Seeing your screen
                            </span>
                            <span className="text-[9px] text-white/20 uppercase tracking-widest">klypix on screen</span>
                        </>
                    )}
                </div>

                {/* Buttons */}
                <div className="flex items-center gap-1 no-drag" style={{ position: 'relative', zIndex: 50 }}>
                    {stopped ? (
                        /* Stopped state: refresh + dismiss */
                        <>
                            <button onClick={handleRefresh} className="no-drag p-1.5 text-white/25 hover:text-emerald-400/70 hover:bg-white/5 rounded-lg transition-all cursor-pointer" title="Resume scanning">
                                <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M10 2.5V5H7.5M2 9.5V7H4.5M1.5 6A4.5 4.5 0 018.5 2.5M10.5 6A4.5 4.5 0 013.5 9.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                            </button>
                            {onDismiss && (
                                <button onClick={(e) => { e.stopPropagation(); onDismiss(); }} className="no-drag p-1.5 text-white/25 hover:text-red-400 hover:bg-white/10 rounded-lg transition-all cursor-pointer" title="Dismiss">
                                    <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                                </button>
                            )}
                        </>
                    ) : (
                        /* Loading state: stop button */
                        <button onClick={(e) => { e.stopPropagation(); handleStop(); }} className="no-drag p-1.5 text-red-400/70 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-all cursor-pointer" title="Stop scanning">
                            <svg width="14" height="14" viewBox="0 0 12 12" fill="none"><rect x="2.5" y="2.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="currentColor" strokeWidth="1"/></svg>
                        </button>
                    )}
                </div>
            </div>

            <style>{`
                @keyframes klypixScan {
                    0% { top: 0%; opacity: 0; }
                    5% { opacity: 1; }
                    85% { opacity: 1; }
                    100% { top: 100%; opacity: 0; }
                }
                @keyframes klypixTextFade {
                    0%, 100% { opacity: 0.5; }
                    50% { opacity: 1; }
                }
                @keyframes klypixZzz {
                    0% { opacity: 0.2; transform: translateY(0px) scale(0.9); }
                    50% { opacity: 0.7; transform: translateY(-5px) scale(1.1); }
                    100% { opacity: 0.2; transform: translateY(0px) scale(0.9); }
                }
            `}</style>
        </div>
    );
}

/** Sleeping eyes — same shape as KlypixEyes but closed, no animation, no square frame */
function SleepingEyes() {
    const d = { w: 24, gap: 3, r: 8 };

    const closedEye = (
        <div className="relative" style={{ width: d.w, height: d.w }}>
            <div className="absolute inset-0 overflow-hidden" style={{ borderRadius: d.r }}>
                {/* Closed eyelid — covers full eye */}
                <div className="absolute inset-0 bg-[#0a2417]" style={{ borderRadius: d.r }} />
                {/* Eyelash curve */}
                <svg className="absolute inset-0" width={d.w} height={d.w} viewBox="0 0 24 24" fill="none">
                    <path d="M5 13 C8 16, 16 16, 19 13" stroke="#4a8fbf" strokeWidth="1.5" strokeLinecap="round" />
                    <path d="M8 14.5 L7.5 16" stroke="#4a8fbf" strokeWidth="1" strokeLinecap="round" />
                    <path d="M12 15.5 L12 17" stroke="#4a8fbf" strokeWidth="1" strokeLinecap="round" />
                    <path d="M16 14.5 L16.5 16" stroke="#4a8fbf" strokeWidth="1" strokeLinecap="round" />
                </svg>
            </div>
        </div>
    );

    return (
        <div className="flex-shrink-0 relative">
            <div className="flex items-center" style={{ gap: d.gap }}>
                {closedEye}
                {closedEye}
            </div>
            {/* zZz floating above between the eyes */}
            <div className="absolute select-none flex flex-col items-center" style={{ top: -8, left: '50%', transform: 'translateX(-50%)' }}>
                <span className="text-[5px] text-emerald-400/25 font-bold leading-none" style={{ animation: 'klypixZzz 3s ease-in-out infinite 0.6s' }}>z</span>
                <span className="text-[8px] text-emerald-400/45 font-bold leading-none" style={{ animation: 'klypixZzz 3s ease-in-out infinite 0.3s' }}>Z</span>
                <span className="text-[5px] text-emerald-400/25 font-bold leading-none" style={{ animation: 'klypixZzz 3s ease-in-out infinite' }}>z</span>
            </div>
        </div>
    );
}

// ── Main Card ───────────────────────────────────────────────────────────
interface WhatISeeProps {
    insight: ContextInsight;
    onAction: (action: ContextInsight['actions'][0]) => void;
    onDismiss: () => void;
    onStop?: () => void;
    mode: 'screen' | 'snip' | 'deepfile';
    screenContext?: ScreenContext;
    onContextOverride?: (ctx: ScreenContext) => void;
    fileAccessState?: { loading: boolean; result: FileAccessResult | null };
    webAccessState?: { loading: boolean; result: WebAccessResult | null };
    onReadFullPage?: () => void;
    onRefresh?: () => void;
}

export function WhatISeeCard({ insight, onAction, onDismiss, onStop, mode, screenContext, onContextOverride, fileAccessState, webAccessState, onReadFullPage, onRefresh }: WhatISeeProps) {
    const [showContextDropdown, setShowContextDropdown] = useState(false);
    const [minimized, setMinimized] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const modeLabel = mode === 'deepfile' ? 'Reading' : mode === 'snip' ? 'In Selection' : 'On Screen';

    // Auto-minimize after 15 seconds
    useEffect(() => {
        const timer = setTimeout(() => setMinimized(true), 15000);
        return () => clearTimeout(timer);
    }, []);

    // Derive file access status
    const fileLoading = fileAccessState?.loading ?? false;
    const fileAccess = fileAccessState?.result;
    const hasFullAccess = fileAccess?.accessGranted ?? false;

    // Derive web access status
    const webLoading = webAccessState?.loading ?? false;
    const webAccess = webAccessState?.result;
    const hasWebAccess = webAccess?.accessGranted ?? false;
    const isBrowserCtx = screenContext?.startsWith('browser-') ?? false;

    // Close dropdown on click outside
    useEffect(() => {
        if (!showContextDropdown) return;
        const handler = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setShowContextDropdown(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [showContextDropdown]);

    const contextLabel = screenContext ? getContextDisplayLabel(screenContext) : null;

    // ── Minimized single-line bar ──
    if (minimized) {
        return (
            <div
                className="mx-4 mt-2 mb-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] backdrop-blur-xl no-drag animate-in fade-in duration-300"
                style={{ WebkitAppRegion: 'no-drag' } as any}
            >
                <div className="flex items-center gap-2.5 px-3.5 py-2">
                    {/* Green dot */}
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                    {/* Label */}
                    <span className="text-[10px] text-white/25 uppercase tracking-widest font-medium shrink-0">On Screen</span>
                    {/* Seeing text — truncated to one line */}
                    <span className="text-[13px] text-white/60 truncate flex-1 min-w-0">
                        {insight.seeing}
                    </span>
                    {/* Expand button */}
                    <button
                        onClick={() => setMinimized(false)}
                        className="text-white/20 hover:text-white/50 transition-colors cursor-pointer p-0.5 shrink-0"
                        title="Expand"
                    >
                        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" /></svg>
                    </button>
                    {/* Stop */}
                    {onStop && (
                        <button
                            onClick={onStop}
                            className="text-white/15 hover:text-orange-400 transition-colors cursor-pointer p-0.5 shrink-0"
                            title="Pause On Screen"
                        >
                            <svg width="8" height="8" viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" /></svg>
                        </button>
                    )}
                    {/* Dismiss */}
                    <button
                        onClick={onDismiss}
                        className="text-white/15 hover:text-white/40 transition-colors cursor-pointer p-0.5 shrink-0"
                        title="Dismiss"
                    >
                        <svg width="8" height="8" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" /></svg>
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div
            className="mx-4 mt-3 mb-2 rounded-2xl border border-white/[0.08] bg-gradient-to-br from-white/[0.04] to-white/[0.01] backdrop-blur-xl p-4 no-drag animate-in fade-in slide-in-from-top-2 duration-500"
            style={{ WebkitAppRegion: 'no-drag' } as any}
        >
            {/* Header */}
            <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                    <div className="relative">
                        <div className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
                        <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-500 animate-ping opacity-30" />
                    </div>
                    <span className="text-[10px] text-white/30 uppercase tracking-[0.15em] font-medium">
                        {modeLabel}
                    </span>
                    {/* Context badge */}
                    {contextLabel && onContextOverride && (
                        <div className="relative" ref={dropdownRef}>
                            <button
                                onClick={(e) => { e.stopPropagation(); setShowContextDropdown(prev => !prev); }}
                                className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/10 text-[10px] text-white/50 hover:text-white/70 hover:bg-white/[0.1] transition-all cursor-pointer"
                                title="Click to override detected context"
                            >
                                {contextLabel}
                                <svg width="8" height="8" viewBox="0 0 10 10" className="opacity-50"><path d="M2 4L5 7L8 4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
                            </button>
                            {showContextDropdown && (
                                <div className="absolute top-full left-0 mt-1 z-[200] bg-zinc-900/95 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl p-1.5 max-h-60 overflow-y-auto min-w-[180px] animate-in fade-in zoom-in-95 duration-150">
                                    {getAllContextOptions().filter(o => o.value !== 'unknown').map(opt => (
                                        <button
                                            key={opt.value}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                setShowContextDropdown(false);
                                                onContextOverride(opt.value);
                                            }}
                                            className={`w-full text-left px-3 py-1.5 text-[11px] rounded-lg transition-all cursor-pointer ${
                                                opt.value === screenContext
                                                    ? 'bg-emerald-500/15 text-emerald-400'
                                                    : 'text-white/60 hover:text-white/90 hover:bg-white/[0.06]'
                                            }`}
                                        >
                                            {opt.label}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    )}
                    {/* File/Web access badge */}
                    {mode === 'screen' && (
                        <span className={`text-[9px] font-medium tracking-wider uppercase ${
                            fileLoading || webLoading ? 'text-amber-400/60' :
                            hasWebAccess ? 'text-emerald-400/70' :
                            hasFullAccess ? 'text-emerald-400/70' :
                            'text-white/25'
                        }`}>
                            {fileLoading ? (
                                <span className="flex items-center gap-1">
                                    <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20" strokeDashoffset="10" /></svg>
                                    Reading file...
                                </span>
                            ) : webLoading ? (
                                <span className="flex items-center gap-1">
                                    <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 12 12"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20" strokeDashoffset="10" /></svg>
                                    Reading page...
                                </span>
                            ) : hasWebAccess ? (
                                '🌐 Web content'
                            ) : hasFullAccess ? (
                                '📄 Full doc'
                            ) : isBrowserCtx && onReadFullPage ? (
                                <button onClick={(e) => { e.stopPropagation(); onReadFullPage(); }}
                                    className="text-blue-400/60 hover:text-blue-400 transition-colors cursor-pointer uppercase text-[9px] font-medium tracking-wider">
                                    🌐 Read full page
                                </button>
                            ) : fileAccess !== null ? (
                                '👁 Visible only'
                            ) : null}
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-1">
                    {onRefresh && insight.key_data.length === 0 && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
                            className="text-white/15 hover:text-white/40 transition-colors cursor-pointer p-1"
                            title="Refresh analysis"
                        >
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M1 8a7 7 0 0 1 13-3.5M15 8a7 7 0 0 1-13 3.5" /><path d="M1 2v4h4M15 14v-4h-4" /></svg>
                        </button>
                    )}
                {/* Minimize button */}
                <button
                    onClick={() => setMinimized(true)}
                    className="no-drag text-white/15 hover:text-white/40 transition-colors cursor-pointer p-1.5 rounded hover:bg-white/5"
                    title="Minimize"
                >
                    <svg width="9" height="2" viewBox="0 0 9 2"><line x1="0" y1="1" x2="9" y2="1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
                </button>
                {onStop && (
                    <button
                        onClick={onStop}
                        className="no-drag text-white/15 hover:text-orange-400 transition-colors cursor-pointer p-1.5 rounded hover:bg-white/5"
                        title="Pause On Screen"
                    >
                        <svg width="9" height="9" viewBox="0 0 10 10">
                            <rect x="1" y="1" width="8" height="8" rx="1.5" fill="currentColor" />
                        </svg>
                    </button>
                )}
                <button
                    onClick={onDismiss}
                    className="no-drag text-white/15 hover:text-white/40 transition-colors cursor-pointer p-1.5 rounded hover:bg-white/5"
                    title="Dismiss"
                >
                    <svg width="9" height="9" viewBox="0 0 10 10">
                        <path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                </button>
                </div>
            </div>

            {/* What I See — main description */}
            <p className="text-white/85 text-[14px] font-medium leading-snug mb-3">
                {insight.seeing}
            </p>

            {/* Empty state — no context extracted */}
            {insight.key_data.length === 0 && insight.actions.length === 0 && (
                <div className="flex items-center gap-2 mb-3 text-amber-400/50 text-[12px]">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="shrink-0"><path d="M8 1L15 14H1L8 1Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round"/><path d="M8 6v3.5M8 11.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                    <span>Not enough context detected. Try refreshing or switch to a different window.</span>
                </div>
            )}

            {/* Key Data — extracted facts */}
            {insight.key_data.length > 0 && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mb-4">
                    {insight.key_data.map((item, i) => (
                        <div key={i} className="flex items-baseline gap-2 min-w-0">
                            <span className="text-[11px] text-white/25 shrink-0 uppercase tracking-wider">{item.label}</span>
                            <span className="text-[12px] text-white/70 truncate">{item.value}</span>
                        </div>
                    ))}
                </div>
            )}

            {/* Action Buttons — typed with icons, loading state while file access resolves */}
            {insight.actions.length > 0 && (
                <div className="flex flex-wrap gap-2">
                    {fileLoading ? (
                        // Show shimmer placeholders while file access is resolving
                        Array.from({ length: 3 }).map((_, i) => (
                            <div
                                key={`shimmer-${i}`}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-white/[0.06] bg-white/[0.03] text-[12px] text-white/20 font-medium"
                            >
                                <svg className="w-3 h-3 animate-spin opacity-40" viewBox="0 0 12 12">
                                    <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5" fill="none" strokeDasharray="20" strokeDashoffset="10" />
                                </svg>
                                <span className="w-16 h-3 bg-white/[0.06] rounded animate-pulse" />
                            </div>
                        ))
                    ) : (
                        insight.actions.map((action, i) => {
                            const actionType = action.type || 'chat';
                            const icon = action.icon || TYPE_ICONS[actionType] || LEGACY_ICONS[actionType] || '⚡';
                            const colors = TYPE_COLORS[actionType] || TYPE_COLORS.chat;
                            return (
                                <button
                                    key={i}
                                    onClick={(e) => { e.stopPropagation(); onAction(action); }}
                                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-[12px] font-medium transition-all cursor-pointer ${colors}`}
                                    title={`${actionType === 'clipboard' ? 'Copy to clipboard' : actionType === 'document' ? 'Generate document' : 'Show in chat'}${hasFullAccess ? ' (full document)' : ''}`}
                                >
                                    <span className="text-[13px]">{icon}</span>
                                    {action.label}
                                </button>
                            );
                        })
                    )}
                </div>
            )}
        </div>
    );
}
