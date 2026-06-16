import React, { useEffect, useRef, useState } from 'react';
import { useSyncExternalStore } from 'react';
import { Check, CornerDownLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { getCurrentAsk, subscribeAsk, submitAsk, cancelAsk, type AskAnswer } from '../agent/agentAskStore';
import { AgentRobot } from '../../components/AgentRobot';
import { t, getLocale } from '../../i18n/strings';

// The Claude-Code-style question chooser for the canvas agent. Renders whenever
// the agent calls canvas_ask_user (via agentAskStore). It's a STEPPER: ONE
// question at a time, tabs across the top (click to jump), a fade as you advance
// (palette-row-in), Back / Next, and Submit on the last step. Single-select with
// a real option auto-advances for the snappy one-by-one feel; "Other" and
// multi-select wait for Next. The agent run blocks on the askUser() promise
// until Submit (→ answers) or Esc/dismiss (→ null). The executor pins a canvas
// card separately as the durable record.
//
// Theme: compact, neutral grey to match the app's panels (no background blur),
// emerald only as the active/selected accent.

const OTHER = ' other';
const PANEL_BG = '#292C2C';

export function AgentQuestionDialog() {
    const ask = useSyncExternalStore(subscribeAsk, getCurrentAsk, getCurrentAsk);

    const [sel, setSel] = useState<Record<number, Set<string>>>({});
    const [other, setOther] = useState<Record<number, string>>({});
    const [step, setStep] = useState(0);

    // Reset whenever a new ask arrives (keyed on its id).
    useEffect(() => { setSel({}); setOther({}); setStep(0); }, [ask?.id]);

    // Focus the panel ONCE per ask (for Esc/Enter). Must NOT be an inline ref on
    // the panel — that re-runs every render and steals focus from the "Other"
    // input on each keystroke (the "type letter by letter" bug).
    const panelRef = useRef<HTMLDivElement>(null);
    useEffect(() => { panelRef.current?.focus(); }, [ask?.id]);

    if (!ask) return null;
    const rtl = getLocale() === 'ar';
    const total = ask.questions.length;
    const last = total - 1;
    const q = ask.questions[step];
    const multi = !!q.multiSelect;

    const answeredAt = (qi: number): boolean => {
        const s = sel[qi];
        if (!s || s.size === 0) return false;
        if (s.has(OTHER) && !(other[qi] ?? '').trim()) return false;
        return true;
    };
    const currentAnswered = answeredAt(step);
    const allAnswered = ask.questions.every((_q, qi) => answeredAt(qi));

    const toggle = (label: string) => {
        const wasEmpty = !(sel[step]?.size);
        setSel(prev => {
            const cur = new Set(prev[step] ?? []);
            if (multi) { if (cur.has(label)) cur.delete(label); else cur.add(label); }
            else { cur.clear(); cur.add(label); }
            return { ...prev, [step]: cur };
        });
        // Snappy one-by-one: a fresh single-select pick (not "Other") advances.
        if (!multi && label !== OTHER && wasEmpty && step < last) {
            setTimeout(() => setStep(s => Math.min(s + 1, last)), 240);
        }
    };

    const buildAnswers = (): AskAnswer[] => ask.questions.map((qq, qi) => {
        const s = sel[qi] ?? new Set<string>();
        const selected: string[] = [];
        for (const label of s) {
            if (label === OTHER) { const txt = (other[qi] ?? '').trim(); if (txt) selected.push(txt); }
            else selected.push(label);
        }
        return { question: qq.question, selected };
    });

    const next = () => {
        if (step < last) { if (currentAnswered) setStep(step + 1); }
        else if (allAnswered) submitAsk(buildAnswers());
    };
    const back = () => setStep(s => Math.max(0, s - 1));

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') { e.stopPropagation(); cancelAsk(); }
        else if (e.key === 'Enter') { e.stopPropagation(); next(); }
    };

    const otherOn = (sel[step] ?? new Set<string>()).has(OTHER);
    const optClass = (on: boolean) => `text-start w-full rounded-md px-2.5 py-1.5 transition-colors border ${on
        ? 'bg-emerald-500/15 border-emerald-500/45'
        : 'bg-white/[0.03] border-white/8 hover:bg-white/[0.06]'}`;
    const boxClass = (on: boolean) => `shrink-0 w-3.5 h-3.5 flex items-center justify-center border ${multi ? 'rounded' : 'rounded-full'} ${on ? 'bg-emerald-500 border-emerald-500' : 'border-white/30'}`;

    return (
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center p-6"
            style={{ background: 'rgba(0,0,0,0.28)' }}
            onKeyDown={onKeyDown}
            onPointerDown={(e) => { if (e.target === e.currentTarget) cancelAsk(); }}
        >
            <div
                dir={rtl ? 'rtl' : 'ltr'}
                role="dialog"
                aria-modal="true"
                tabIndex={-1}
                ref={panelRef}
                className="w-full max-w-[420px] rounded-xl outline-none"
                style={{
                    background: PANEL_BG,
                    border: '1px solid rgba(255,255,255,0.09)',
                    boxShadow: '0 18px 50px rgba(0,0,0,0.5)',
                    color: '#e8e8ed',
                    fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                }}
                onPointerDown={(e) => e.stopPropagation()}
            >
                <style>{`@keyframes klypixAskFloat{0%,100%{transform:translateY(0);opacity:.45}50%{transform:translateY(-4px);opacity:1}}`}</style>
                {/* Header — KLYPIX robot with floating "?" marks */}
                <div className="flex items-center gap-2 px-4 pt-2.5 pb-2">
                    <div className="relative shrink-0 w-[34px] h-[30px]">
                        <div className="absolute -top-0.5 left-0 scale-[0.72] origin-top-left">
                            <AgentRobot isWorking={false} />
                        </div>
                        <span className="absolute top-0 right-0 text-emerald-300 text-[12px] font-bold leading-none" style={{ animation: 'klypixAskFloat 1.6s ease-in-out infinite' }}>?</span>
                        <span className="absolute -top-1.5 right-2.5 text-emerald-300/60 text-[9px] font-bold leading-none" style={{ animation: 'klypixAskFloat 1.6s ease-in-out infinite 0.4s' }}>?</span>
                    </div>
                    <span className="text-[10.5px] font-semibold tracking-wide text-white/85">{t('canvas.ask.title')}</span>
                    <span className="flex-1" />
                    <span className="text-[9px] text-white/30">{t('canvas.ask.esc_hint')}</span>
                </div>

                {/* Tabs (one per question) — only when there's more than one */}
                {total > 1 && (
                    <div className="flex items-center gap-1 px-4 pb-2 flex-wrap">
                        {ask.questions.map((qq, qi) => {
                            const active = qi === step;
                            const done = answeredAt(qi);
                            return (
                                <button
                                    key={qi}
                                    onClick={() => setStep(qi)}
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[8.5px] uppercase tracking-[0.1em] font-semibold transition-colors ${active
                                        ? 'bg-emerald-500/18 text-emerald-200'
                                        : done
                                            ? 'bg-white/[0.05] text-white/55'
                                            : 'bg-white/[0.03] text-white/30 hover:text-white/55'
                                        }`}
                                >
                                    {done && !active && <Check size={9} />}
                                    {qq.header || `Q${qi + 1}`}
                                </button>
                            );
                        })}
                    </div>
                )}

                <div className="border-t border-white/8" />

                {/* Current question — keyed so it re-runs the fade on each step */}
                <div key={step} className="px-4 py-3" style={{ animation: 'palette-row-in 200ms ease-out' }}>
                    <div className="text-[12.5px] font-medium leading-snug text-white/95 mb-2.5">{q.question}</div>

                    <div className="flex flex-col gap-1">
                        {q.options.map((opt) => {
                            const on = (sel[step] ?? new Set<string>()).has(opt.label);
                            return (
                                <button key={opt.label} onClick={() => toggle(opt.label)} className={optClass(on)}>
                                    <span className="flex items-start gap-2">
                                        <span className={`mt-0.5 ${boxClass(on)}`}>
                                            {on && <Check size={10} className="text-[#0b0b12]" />}
                                        </span>
                                        <span className="flex flex-col gap-0.5">
                                            <span className="text-[12px] font-medium text-white/90 leading-tight">{opt.label}</span>
                                            {opt.description && (
                                                <span className="text-[10.5px] text-white/45 leading-snug">{opt.description}</span>
                                            )}
                                        </span>
                                    </span>
                                </button>
                            );
                        })}

                        {/* Auto-appended "Other" free-text option */}
                        <button onClick={() => toggle(OTHER)} className={optClass(otherOn)}>
                            <span className="flex items-center gap-2">
                                <span className={boxClass(otherOn)}>
                                    {otherOn && <Check size={10} className="text-[#0b0b12]" />}
                                </span>
                                <span className="text-[12px] font-medium text-white/70">{t('canvas.ask.other')}</span>
                            </span>
                        </button>
                        {otherOn && (
                            <input
                                autoFocus
                                value={other[step] ?? ''}
                                onChange={(e) => setOther(prev => ({ ...prev, [step]: e.target.value }))}
                                placeholder={t('canvas.ask.other_placeholder')}
                                className="mt-1 w-full rounded-md px-2.5 py-1.5 text-[12px] bg-black/25 border border-white/12 outline-none focus:border-emerald-500/55 text-white/90 placeholder:text-white/30"
                            />
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center gap-1.5 px-4 py-2.5 border-t border-white/8">
                    <button
                        onClick={cancelAsk}
                        className="px-2.5 py-1 rounded text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors"
                    >
                        {t('canvas.ask.cancel')}
                    </button>
                    {step > 0 && (
                        <button
                            onClick={back}
                            className="inline-flex items-center gap-0.5 px-2 py-1 rounded text-[11px] font-medium text-white/55 hover:text-white/90 hover:bg-white/8 transition-colors"
                        >
                            {rtl ? <ChevronRight size={12} /> : <ChevronLeft size={12} />}
                            {t('canvas.ask.back')}
                        </button>
                    )}
                    <span className="flex-1" />
                    {total > 1 && <span className="text-[9px] text-white/30 tabular-nums">{step + 1} / {total}</span>}
                    {step < last ? (
                        <button
                            onClick={next}
                            disabled={!currentAnswered}
                            className={`inline-flex items-center gap-0.5 px-3 py-1 rounded text-[11px] font-semibold transition-colors ${currentAnswered
                                ? 'bg-emerald-500 text-[#0b0b12] hover:bg-emerald-400'
                                : 'bg-white/8 text-white/35 cursor-not-allowed'
                                }`}
                        >
                            {t('canvas.ask.next')}
                            {rtl ? <ChevronLeft size={12} /> : <ChevronRight size={12} />}
                        </button>
                    ) : (
                        <button
                            onClick={next}
                            disabled={!allAnswered}
                            className={`inline-flex items-center gap-1 px-3 py-1 rounded text-[11px] font-semibold transition-colors ${allAnswered
                                ? 'bg-emerald-500 text-[#0b0b12] hover:bg-emerald-400'
                                : 'bg-white/8 text-white/35 cursor-not-allowed'
                                }`}
                        >
                            {t('canvas.ask.submit')}
                            <CornerDownLeft size={11} />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}
