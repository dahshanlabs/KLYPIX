import React from 'react';
import type { Intent, ActionResult } from '../core/engine/intentTypes';
import type { QuickAction, AgentHistoryEntry, ClipboardInfo, ScreenAction, AmbientNotice } from '../hooks/useAgent';

// ── Confirmation Card ──────────────────────────────────────────────────

interface ConfirmationCardProps {
    intent: Intent;
    onConfirm: () => void;
    onCancel: () => void;
    isExecuting?: boolean;
}

export function ConfirmationCard({ intent, onConfirm, onCancel, isExecuting }: ConfirmationCardProps) {
    const isDestructive = intent.requiresConfirmation;
    const confidence = Math.round(intent.confidence * 100);
    const isSuggestion = intent.confidence < 0.80;

    return (
        <div className={`mx-4 my-2 rounded-xl border ${isDestructive ? 'border-red-500/30 bg-red-500/5' : 'border-emerald-500/30 bg-emerald-500/5'} p-4 no-drag`} style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-start gap-3">
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm shrink-0 ${isDestructive ? 'bg-red-500/20' : 'bg-emerald-500/20'}`}>
                    {getIntentIcon(intent.type)}
                </div>
                <div className="flex-1 min-w-0">
                    {isSuggestion && (
                        <div className="text-xs text-amber-400/80 mb-1">Did you mean to...</div>
                    )}
                    <div className="text-white/90 text-sm font-medium">
                        {intent.previewDescription}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-white/30 uppercase tracking-wider">{intent.type.replace('_', ' ')}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${confidence >= 90 ? 'bg-emerald-500/20 text-emerald-400' : confidence >= 80 ? 'bg-blue-500/20 text-blue-400' : 'bg-amber-500/20 text-amber-400'}`}>
                            {confidence}%
                        </span>
                        {isDestructive && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400">requires confirmation</span>
                        )}
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-2 mt-3 ml-11">
                <button
                    onClick={onConfirm}
                    disabled={isExecuting}
                    className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all cursor-pointer ${isDestructive ? 'bg-red-500/80 hover:bg-red-500 text-white' : 'bg-emerald-500/80 hover:bg-emerald-500 text-white'} ${isExecuting ? 'opacity-50 cursor-wait' : ''}`}
                >
                    {isExecuting ? 'Executing...' : isSuggestion ? 'Yes, do it' : 'Execute'}
                </button>
                <button
                    onClick={onCancel}
                    disabled={isExecuting}
                    className="px-4 py-1.5 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-white/60 transition-all cursor-pointer"
                >
                    {isSuggestion ? 'No, just chat' : 'Cancel'}
                </button>
            </div>
        </div>
    );
}

// ── Result Card ────────────────────────────────────────────────────────

interface ResultCardProps {
    result: ActionResult;
    onUndo?: () => void;
    onDismiss: () => void;
    canUndo: boolean;
}

export function ResultCard({ result, onUndo, onDismiss, canUndo }: ResultCardProps) {
    return (
        <div className={`mx-4 my-2 rounded-xl border ${result.success ? 'border-emerald-500/20 bg-emerald-500/5' : 'border-red-500/20 bg-red-500/5'} p-3 no-drag`} style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-center gap-2">
                <span className="text-sm">{result.success ? '✅' : '❌'}</span>
                <span className="text-white/80 text-sm flex-1">{result.message}</span>
                {canUndo && result.success && (
                    <button onClick={onUndo} className="text-xs text-amber-400/80 hover:text-amber-400 px-2 py-1 rounded hover:bg-white/5 transition-all cursor-pointer">
                        Undo
                    </button>
                )}
                <button onClick={onDismiss} className="text-xs text-white/30 hover:text-white/60 px-1 cursor-pointer">✕</button>
            </div>
        </div>
    );
}

// ── Quick Actions Bar ──────────────────────────────────────────────────

interface QuickActionsBarProps {
    actions: QuickAction[];
    onAction: (action: QuickAction) => void;
    screenActions: ScreenAction[];
    onScreenAction: (action: ScreenAction) => void;
    onRefresh?: () => void;
    contextLabel?: string;
}

export function QuickActionsBar({ actions, onAction, screenActions, onScreenAction, onRefresh, contextLabel }: QuickActionsBarProps) {
    if (actions.length === 0 && screenActions.length === 0) return null;

    return (
        <div className="px-4 py-2 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-center gap-2 mb-2">
                <span className="text-[10px] text-white/25 uppercase tracking-widest">Quick Actions</span>
                {contextLabel && <span className="text-[10px] text-purple-400/40 truncate max-w-[200px]">{contextLabel}</span>}
                {onRefresh && (
                    <button onClick={onRefresh} className="text-white/20 hover:text-white/50 transition-all cursor-pointer ml-auto" title="Refresh actions">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                        </svg>
                    </button>
                )}
            </div>
            <div className="flex flex-wrap gap-1.5">
                {screenActions.map((sa, i) => (
                    <button
                        key={`screen-${i}`}
                        onClick={() => onScreenAction(sa)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 text-blue-300/80 hover:text-blue-300 text-xs transition-all cursor-pointer"
                    >
                        <span>{sa.icon}</span>
                        <span>{sa.label}</span>
                    </button>
                ))}
                {actions.map((qa, i) => (
                    <button
                        key={`qa-${i}`}
                        onClick={() => onAction(qa)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-white/60 hover:text-white/80 text-xs transition-all cursor-pointer"
                    >
                        <span>{qa.icon}</span>
                        <span>{qa.label}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

// ── Smart Paste Banner ─────────────────────────────────────────────────

interface SmartPasteBannerProps {
    clipboardInfo: ClipboardInfo;
    onAiFormat: () => void;
    onSave: () => void;
    onCopyFormatted: () => void;
    onRewrite?: (style: 'professional' | 'shorter' | 'clearer') => void;
    onSummarize?: () => void;
    onUseInPrompt?: () => void;
    onDismiss: () => void;
}

export function SmartPasteBanner({ clipboardInfo, onAiFormat, onSave, onCopyFormatted, onRewrite, onSummarize, onUseInPrompt, onDismiss }: SmartPasteBannerProps) {
    const isPlainText = clipboardInfo.type === 'plain';
    const wordCount = clipboardInfo.wordCount || clipboardInfo.text.split(/\s+/).length;

    const typeLabels: Record<ClipboardInfo['type'], string> = {
        table: '📊 Table data',
        json: '{ } JSON',
        code: '💻 Code',
        urls: '🔗 URLs',
        emails: '📧 Emails',
        plain: '📝 Text copied',
    };

    const saveLabels: Record<ClipboardInfo['type'], string> = {
        table: 'Save as Excel',
        json: 'Save as .json',
        code: 'Save as file',
        urls: 'Save URL list',
        emails: 'Save as CSV',
        plain: 'Save as file',
    };

    return (
        <div className="mx-4 my-2 rounded-xl border border-purple-500/20 bg-purple-500/5 p-3 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-center gap-2">
                <span className="text-sm text-purple-300/80">{typeLabels[clipboardInfo.type]}</span>
                <span className="text-xs text-white/25">
                    {isPlainText ? `${wordCount} words` : 'on clipboard'}
                </span>
                <div className="flex-1" />
                <button onClick={onDismiss} className="text-white/20 hover:text-white/50 transition-colors cursor-pointer p-1 -m-1">
                    <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1L9 9M9 1L1 9" stroke="currentColor" strokeWidth="1.5" /></svg>
                </button>
            </div>

            {/* Preview text */}
            <div className="mt-2 text-xs text-white/25 font-mono truncate max-w-full">
                {clipboardInfo.text.substring(0, 100)}{clipboardInfo.text.length > 100 ? '...' : ''}
            </div>

            {/* Action buttons */}
            <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                {isPlainText ? (
                    <>
                        {onRewrite && (
                            <>
                                <button onClick={() => onRewrite('professional')} className="text-[11px] px-2.5 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-all cursor-pointer">
                                    Rewrite Pro
                                </button>
                                <button onClick={() => onRewrite('shorter')} className="text-[11px] px-2.5 py-1 rounded-lg bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 transition-all cursor-pointer">
                                    Shorter
                                </button>
                                <button onClick={() => onRewrite('clearer')} className="text-[11px] px-2.5 py-1 rounded-lg bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 transition-all cursor-pointer">
                                    Clearer
                                </button>
                            </>
                        )}
                        {onSummarize && wordCount > 30 && (
                            <button onClick={onSummarize} className="text-[11px] px-2.5 py-1 rounded-lg bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 transition-all cursor-pointer">
                                Summarize
                            </button>
                        )}
                        {onUseInPrompt && (
                            <button onClick={onUseInPrompt} className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 transition-all cursor-pointer">
                                Use in prompt
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        <button onClick={onAiFormat} className="text-[11px] px-2.5 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-all cursor-pointer">
                            AI Format
                        </button>
                        <button onClick={onSave} className="text-[11px] px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 transition-all cursor-pointer">
                            {saveLabels[clipboardInfo.type]}
                        </button>
                        <button onClick={onCopyFormatted} className="text-[11px] px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 transition-all cursor-pointer">
                            Copy formatted
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

// ── Agent History Panel ────────────────────────────────────────────────

interface AgentHistoryPanelProps {
    history: AgentHistoryEntry[];
    onUndo: (entry: AgentHistoryEntry) => void;
    onClear: () => void;
    onClose: () => void;
}

export function AgentHistoryPanel({ history, onUndo, onClear, onClose }: AgentHistoryPanelProps) {
    const grouped = groupByDate(history);

    return (
        <div className="absolute inset-0 bg-[#0a0a0a]/95 z-50 flex flex-col">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <span className="text-white/60 text-sm font-medium">Agent History</span>
                <div className="flex items-center gap-2">
                    {history.length > 0 && (
                        <button onClick={onClear} className="text-xs text-red-400/60 hover:text-red-400 cursor-pointer">Clear all</button>
                    )}
                    <button onClick={onClose} className="text-white/30 hover:text-white/60 cursor-pointer">✕</button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-2">
                {history.length === 0 ? (
                    <div className="text-center text-white/20 text-sm mt-8">No agent actions yet</div>
                ) : (
                    Object.entries(grouped).map(([date, entries]) => (
                        <div key={date} className="mb-4">
                            <div className="text-[10px] text-white/20 uppercase tracking-widest mb-2">{date}</div>
                            {entries.map((entry, i) => (
                                <div key={i} className="flex items-center gap-2 py-1.5 border-b border-white/3">
                                    <span className="text-xs text-white/20 w-12 shrink-0">
                                        {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                    <span className="text-sm">{entry.result.success ? '✅' : '❌'}</span>
                                    <span className="text-xs text-white/60 flex-1 truncate">{entry.result.message}</span>
                                    {!!entry.result.undoPayload && entry.result.success && (
                                        <button
                                            onClick={() => onUndo(entry)}
                                            className="text-[10px] text-amber-400/60 hover:text-amber-400 px-1.5 py-0.5 rounded hover:bg-white/5 cursor-pointer"
                                        >
                                            Undo
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}

// ── Agent Mode Toggle Button ───────────────────────────────────────────

interface AgentToggleProps {
    isActive: boolean;
    onToggle: () => void;
}

export function AgentToggle({ isActive, onToggle }: AgentToggleProps) {
    return (
        <button
            onClick={onToggle}
            className={`p-2 rounded-lg transition-all cursor-pointer ${isActive ? 'bg-purple-500/20 text-purple-400 border border-purple-500/30' : 'text-white/40 hover:text-white/70 hover:bg-white/5'}`}
            title={isActive ? 'Agent Mode ON' : 'Agent Mode OFF'}
        >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="10" rx="2" />
                <circle cx="12" cy="5" r="3" />
                <path d="M12 8v3" />
                <circle cx="8" cy="16" r="1" fill="currentColor" />
                <circle cx="16" cy="16" r="1" fill="currentColor" />
                <path d="M9 19h6" />
            </svg>
        </button>
    );
}

// ── Helpers ─────────────────────────────────────────────────────────────

function getIntentIcon(type: string): string {
    const icons: Record<string, string> = {
        file_save: '💾', file_rename: '✏️', file_move: '📁', file_create: '📄', file_delete: '🗑️',
        clipboard_copy: '📋', clipboard_save: '💾',
        browser_navigate: '🌐', browser_fill: '✍️', browser_click: '👆', browser_scroll: '📜',
        system_open: '🚀', system_type: '⌨️', system_click: '👆', system_screenshot: '📸',
    };
    return icons[type] || '⚡';
}

function groupByDate(entries: AgentHistoryEntry[]): Record<string, AgentHistoryEntry[]> {
    const groups: Record<string, AgentHistoryEntry[]> = {};
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    [...entries].reverse().forEach(entry => {
        const dateStr = new Date(entry.timestamp).toDateString();
        const label = dateStr === today ? 'Today' : dateStr === yesterday ? 'Yesterday' : dateStr;
        if (!groups[label]) groups[label] = [];
        groups[label].push(entry);
    });
    return groups;
}

// ── Ambient Awareness Banner ───────────────────────────────────────────

interface AmbientBannerProps {
    notices: AmbientNotice[];
    onDismiss: (id: string) => void;
}

export function AmbientBanner({ notices, onDismiss }: AmbientBannerProps) {
    if (notices.length === 0) return null;

    return (
        <div className="mx-4 my-2 rounded-xl border border-amber-500/15 bg-amber-500/5 p-3 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="text-[10px] text-amber-400/50 uppercase tracking-widest mb-2">While you were working</div>
            {notices.map(notice => (
                <div key={notice.id} className="flex items-center gap-2 py-1">
                    <span className="text-sm">{notice.icon}</span>
                    <span className="text-xs text-white/60 flex-1">{notice.message}</span>
                    <button onClick={() => onDismiss(notice.id)} className="text-[10px] text-white/20 hover:text-white/40 cursor-pointer">✕</button>
                </div>
            ))}
        </div>
    );
}

// ── Cross-Reference Notice ─────────────────────────────────────────────

interface CrossRefNoticeProps {
    message: string;
    onDismiss: () => void;
}

export function CrossRefNotice({ message, onDismiss }: CrossRefNoticeProps) {
    return (
        <div className="mx-4 my-2 rounded-xl border border-blue-500/20 bg-blue-500/5 p-3 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-center gap-2">
                <span className="text-sm">🔗</span>
                <span className="text-xs text-blue-300/80 flex-1">{message}</span>
                <button onClick={onDismiss} className="text-[10px] text-white/20 hover:text-white/40 cursor-pointer">✕</button>
            </div>
        </div>
    );
}

// ── Repetition Detector Notice ─────────────────────────────────────────

interface RepetitionNoticeProps {
    message: string;
    onDismiss: () => void;
    onHelp: () => void;
}

export function RepetitionNotice({ message, onDismiss, onHelp }: RepetitionNoticeProps) {
    return (
        <div className="mx-4 my-2 rounded-xl border border-orange-500/20 bg-orange-500/5 p-3 no-drag" style={{ WebkitAppRegion: 'no-drag' } as any}>
            <div className="flex items-center gap-2">
                <span className="text-sm">🔄</span>
                <span className="text-xs text-orange-300/80 flex-1">{message}</span>
                <button onClick={onHelp} className="text-[11px] px-2.5 py-1 rounded-lg bg-orange-500/20 hover:bg-orange-500/30 text-orange-300 transition-all cursor-pointer">
                    Help me
                </button>
                <button onClick={onDismiss} className="text-[10px] text-white/20 hover:text-white/40 cursor-pointer">✕</button>
            </div>
        </div>
    );
}
