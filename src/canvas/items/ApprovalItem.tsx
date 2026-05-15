import React from 'react';
import { Check, X, Clock, ShieldAlert } from 'lucide-react';
import type { ApprovalItem as ApprovalItemType } from './types';
import { useCanvasStore } from '../state/canvasStore';
import { resolveApproval } from '../agent/approvalRegistry';

interface Props {
    item: ApprovalItemType;
    selected: boolean;
}

export const ApprovalItemView = React.memo(ApprovalItemViewImpl, (prev, next) => {
    return prev.item === next.item && prev.selected === next.selected;
});

// Convention: if the option looks like "Approve" / "Yes" / "Accept" it gets
// emerald; "Deny" / "No" / "Reject" / "Cancel" gets red. Anything else is
// neutral. Keeps the agent from having to specify colors explicitly.
const POSITIVE_WORDS = /^(approve|yes|accept|allow|ok|confirm|continue|proceed)$/i;
const NEGATIVE_WORDS = /^(deny|no|reject|cancel|abort|stop|refuse|block)$/i;

function optionTone(opt: string): 'positive' | 'negative' | 'neutral' {
    if (POSITIVE_WORDS.test(opt.trim())) return 'positive';
    if (NEGATIVE_WORDS.test(opt.trim())) return 'negative';
    return 'neutral';
}

function ApprovalItemViewImpl({ item, selected }: Props) {
    const { dispatch } = useCanvasStore();
    const resolved = item.decision !== null;

    const click = (option: string) => {
        if (resolved) return;
        // Update state first so the card immediately reflects the choice,
        // then release the agent's awaiting Promise. The executor will then
        // finish its await and return the decision to Gemini.
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { decision: option, decidedAt: Date.now() } as any,
        });
        resolveApproval(item.id, option);
    };

    const style: React.CSSProperties = {
        position: 'absolute',
        left: item.x,
        top: item.y,
        width: item.w,
        height: item.h,
        borderRadius: 12,
        background: resolved ? '#12121a' : '#141422',
        border: `1.5px solid ${
            selected
                ? 'rgba(16,185,129,0.7)'
                : resolved
                    ? 'rgba(255,255,255,0.08)'
                    : 'rgba(245,166,35,0.55)'
        }`,
        boxShadow: selected
            ? '0 0 0 3px rgba(16,185,129,0.25), 0 8px 28px rgba(0,0,0,0.45)'
            : resolved
                ? '0 4px 14px rgba(0,0,0,0.35)'
                : '0 0 0 2px rgba(245,166,35,0.15), 0 8px 28px rgba(0,0,0,0.45)',
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        color: '#e8e8ed',
        fontFamily: 'Outfit, system-ui, sans-serif',
        pointerEvents: 'auto',
        WebkitAppRegion: 'no-drag',
    } as React.CSSProperties & { WebkitAppRegion?: string };

    return (
        <div data-canvas-item={item.id} style={style} className="no-drag">
            {/* Header */}
            <div className="flex items-center gap-2">
                <div className={resolved ? 'text-white/40' : 'text-amber-400'}>
                    {resolved ? <Clock size={14} /> : <ShieldAlert size={14} />}
                </div>
                <div className="text-[10px] uppercase tracking-[0.12em] font-medium">
                    {resolved ? 'Resolved' : 'Awaiting approval'}
                </div>
                <div className="flex-1" />
                <div className="text-[9px] text-white/30">Agent</div>
            </div>

            {/* Question */}
            <div className="text-[13px] font-medium leading-snug text-white/90">{item.question}</div>

            {/* Details (optional) */}
            {item.details && (
                <div onWheel={(e) => e.stopPropagation()} className="text-[11.5px] text-white/55 leading-relaxed whitespace-pre-wrap overflow-auto flex-1 pr-1">
                    {item.details}
                </div>
            )}

            {/* Footer: buttons or resolved stamp */}
            <div className="mt-auto">
                {resolved ? (
                    <div className="flex items-center gap-1.5 text-[11px] text-white/55">
                        <Check size={11} />
                        <span>Chose</span>
                        <span className="text-white/85 font-medium">"{item.decision}"</span>
                        {item.decidedAt && (
                            <span className="ml-auto text-white/30 text-[10px]">
                                {timeSince(item.decidedAt)}
                            </span>
                        )}
                    </div>
                ) : (
                    <div className="flex items-center gap-2">
                        {item.options.map((opt) => {
                            const tone = optionTone(opt);
                            return (
                                <button
                                    key={opt}
                                    onPointerDown={(e) => e.stopPropagation()}
                                    onClick={(e) => { e.stopPropagation(); click(opt); }}
                                    className={`flex-1 py-1.5 px-3 rounded-md text-[12px] font-medium transition-colors ${toneClass(tone)}`}
                                >
                                    <span className="inline-flex items-center gap-1.5 justify-center">
                                        {tone === 'positive' && <Check size={12} />}
                                        {tone === 'negative' && <X size={12} />}
                                        {opt}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

function toneClass(tone: 'positive' | 'negative' | 'neutral'): string {
    if (tone === 'positive') return 'bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/30';
    if (tone === 'negative') return 'bg-red-500/15 text-red-200 hover:bg-red-500/30';
    return 'bg-white/8 text-white/75 hover:bg-white/15';
}

function timeSince(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
}
