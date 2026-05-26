// QuickActionBar — Alt+; mini-window. Captures the user's current selection
// from the foreground app, lets them run a one-shot AI action (translate,
// improve, summarize, fix grammar, explain, continue) or a custom prompt,
// then writes the result back into the source app via SendKeys ^v.
//
// Best-in-class UX rules baked in:
//   • Smart default action is auto-detected from the selection content
//     (Arabic → translate, code → explain, long text → summarize, etc.)
//     and pre-highlighted with a subtle emerald ring so a single Enter
//     runs the most likely action.
//   • Keyboard-first: 1-6 pick an action, Enter runs the highlighted /
//     custom prompt, Esc dismisses, Tab cycles outputs after streaming.
//   • Streaming response renders character-by-character so the user sees
//     the model working — no "spinning forever" blank state.
//   • Output bar appears only after the stream completes so users can't
//     accidentally Replace a half-finished response.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, Pencil, FileText, Sparkles, Lightbulb, ArrowRight, X, Clipboard, MessageSquare, ArrowDownToLine, Loader2, Wand2, LayoutGrid } from 'lucide-react';
import { getApiKeySync } from '../api/gemini';
import { GoogleGenerativeAI } from '@google/generative-ai';
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { KlypixEyes } from './KlypixEyes';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

type ActionId = 'translate' | 'improve' | 'summarize' | 'grammar' | 'explain' | 'continue' | 'send_chat' | 'send_canvas' | 'custom';

interface ActionDef {
    id: ActionId;
    label: string;
    sublabel: string;
    icon: typeof Globe;
    accent: string;
    /** Tailwind class applied to the icon tile on group-hover. Each action
     *  mirrors its meaning: Translate rotates (globe spinning to a new
     *  language), Improve tilts (pencil editing), Fix grammar spins
     *  (correcting), Continue slides right (moving forward), etc.
     *  Subtle — duration is 300-400ms, easing soft. */
    hoverAnim: string;
    /** When true, the action skips the AI streaming entirely — the user's
     *  raw selection is dispatched directly to chat / canvas / clipboard
     *  via runDirect(). Frictionless "I just want this somewhere" path. */
    skipAI?: boolean;
    promptFor(text: string, custom?: string): string;
}

const ACTIONS: ActionDef[] = [
    {
        id: 'translate',
        label: 'Translate',
        sublabel: 'Auto-detect language',
        icon: Globe,
        accent: '#38bdf8',
        hoverAnim: 'group-hover:rotate-[20deg]',
        promptFor: (text) => `Translate the following text. If it's in English, translate to Arabic. If it's in any other language, translate to English. Output ONLY the translation, no commentary, no quotes around it, no "Translation:" prefix. Preserve formatting (line breaks, bullets).\n\n---\n${text}`,
    },
    {
        id: 'improve',
        label: 'Improve writing',
        sublabel: 'Clearer, more direct',
        icon: Pencil,
        accent: '#a78bfa',
        hoverAnim: 'group-hover:-rotate-12 group-hover:-translate-y-0.5',
        promptFor: (text) => `Rewrite the following text to be clearer, more direct, and better-flowing. Keep the original meaning, tone, and approximate length. Output ONLY the rewritten text, no commentary, no quotes.\n\n---\n${text}`,
    },
    {
        id: 'summarize',
        label: 'Summarize',
        sublabel: 'Key points only',
        icon: FileText,
        accent: '#fb7185',
        hoverAnim: 'group-hover:scale-y-[0.85] group-hover:translate-y-0.5',
        promptFor: (text) => `Summarize the following text into the most important points. Use short bullet points (3-6 bullets). If the source is one paragraph, give a single tight sentence instead. Output ONLY the summary, no preamble.\n\n---\n${text}`,
    },
    {
        id: 'grammar',
        label: 'Fix grammar',
        sublabel: 'Spelling & syntax',
        icon: Sparkles,
        accent: '#34d399',
        hoverAnim: 'group-hover:rotate-[180deg] group-hover:scale-110',
        promptFor: (text) => `Fix any spelling, grammar, and punctuation errors in the following text. Do NOT change the meaning, tone, or word choices beyond what's required for correctness. Output ONLY the corrected text, no commentary.\n\n---\n${text}`,
    },
    {
        id: 'explain',
        label: 'Explain',
        sublabel: 'What this means',
        icon: Lightbulb,
        accent: '#fbbf24',
        // Lightbulb "turns on" — scales up, gets a glow halo via hover ring on parent tile.
        hoverAnim: 'group-hover:scale-125 group-hover:drop-shadow-[0_0_8px_rgba(251,191,36,0.6)]',
        promptFor: (text) => `Explain the following clearly and concisely (3-5 sentences). If it's code, explain what it does and why. If it's a concept, give a plain-English explanation a smart non-expert could follow. Output the explanation only, no commentary.\n\n---\n${text}`,
    },
    {
        id: 'continue',
        label: 'Continue',
        sublabel: 'Keep writing',
        icon: ArrowRight,
        accent: '#f472b6',
        hoverAnim: 'group-hover:translate-x-1',
        promptFor: (text) => `Continue the following text in the same voice, tone, and style. Pick up exactly where it ends — your output will be appended directly so do NOT repeat the original. Output the continuation only.\n\n---\n${text}`,
    },
    // ── No-AI shortcuts ──────────────────────────────────────────────
    // These skip the streaming step and hand off the raw selection
    // directly to chat or canvas. Visual style mirrors the AI actions
    // so they feel part of the same menu, but they have a distinct
    // accent (slate vs the warm AI colors) signaling "transport,
    // not transform".
    {
        id: 'send_chat',
        label: 'Ask in chat',
        sublabel: 'Open chat with this text',
        icon: MessageSquare,
        accent: '#94a3b8',
        hoverAnim: 'group-hover:scale-110',
        skipAI: true,
        promptFor: () => '',
    },
    {
        id: 'send_canvas',
        label: 'Add to canvas',
        sublabel: 'Drop as a card',
        icon: LayoutGrid,
        accent: '#94a3b8',
        hoverAnim: 'group-hover:scale-110',
        skipAI: true,
        promptFor: () => '',
    },
];

const CUSTOM_ACTION: ActionDef = {
    id: 'custom',
    label: 'Custom',
    sublabel: 'Your instruction',
    icon: Wand2,
    accent: '#10b981',
    hoverAnim: 'group-hover:rotate-[20deg]',
    promptFor: (text, custom) => `${(custom || '').trim()}\n\nText:\n---\n${text}`,
};

interface Props {
    selection: string;
    targetHwnd: string;
    sourceApp?: string;
    /** Default onClose used for X / Esc — fully hides Klypix.
     *  Internal handlers that want to land the user in chat/canvas use
     *  closeKeepOpen() (sent via the electron bridge directly) instead. */
    onClose: () => void;
}

// Closes the QA popup but keeps the Klypix window VISIBLE — used by all
// "send to elsewhere in Klypix" actions (Ask in chat, Add to canvas,
// output-bar Chat/Canvas). The renderer has already switched activeTab
// via the dispatched event; main exits QA mode, restores chat-default
// bounds, and the natural render takes over. No window flash.
function closeKeepOpen() {
    (window as any).electron?.quickAction?.close?.({ keepOpen: true });
}

// Smart default only ever picks from AI transformations — the skip-AI
// shortcuts (send_chat / send_canvas) are user-intent actions, not
// suggestions. Returning their id would mislead users into thinking
// they should ship raw text to chat by default.
function detectSmartDefault(selection: string): ActionId {
    const s = selection.trim();
    if (!s) return 'translate';
    const arabicChars = (s.match(/[؀-ۿﭐ-﷿]/g) || []).length;
    if (arabicChars / s.length > 0.3) return 'translate';
    const codeTokens = /\b(function|const|let|var|class|import|export|return|async|await|if|else|for|while|public|private)\b/;
    if (codeTokens.test(s) && (/[{}();]/.test(s) || s.includes('=>'))) return 'explain';
    if (s.length > 600) return 'summarize';
    const tail = s.slice(-40);
    if (!/[.!?…]/.test(tail) && s.length > 40) return 'continue';
    return 'improve';
}

async function* streamGemini(prompt: string): AsyncGenerator<string> {
    const key = getApiKeySync();
    if (!key) {
        throw new Error('No Gemini API key configured. Set one in Settings → AI.');
    }
    const genAI = new GoogleGenerativeAI(key);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' }, { apiVersion: 'v1beta' });
    const result = await model.generateContentStream(prompt);
    for await (const chunk of result.stream) {
        const text = chunk.text();
        if (text) yield text;
    }
}

export function QuickActionBar({ selection, targetHwnd, sourceApp, onClose }: Props) {
    const smartDefault = useMemo(() => detectSmartDefault(selection), [selection]);
    const [highlightedAction, setHighlightedAction] = useState<ActionId>(smartDefault);
    const [chosenAction, setChosenAction] = useState<ActionId | null>(null);
    const [customPrompt, setCustomPrompt] = useState('');
    const [responseText, setResponseText] = useState('');
    const [isStreaming, setIsStreaming] = useState(false);
    const [streamError, setStreamError] = useState<string | null>(null);
    const [applyToast, setApplyToast] = useState<string | null>(null);
    const customInputRef = useRef<HTMLInputElement>(null);
    const responseRef = useRef<HTMLDivElement>(null);
    const abortRef = useRef<boolean>(false);

    // Keyboard: 1-6 picks action, Enter runs highlighted, Esc dismisses
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                if (isStreaming) {
                    abortRef.current = true;
                    setIsStreaming(false);
                    return;
                }
                if (chosenAction) {
                    // Back to action picker
                    setChosenAction(null);
                    setResponseText('');
                    setStreamError(null);
                    return;
                }
                onClose();
                return;
            }
            // Don't intercept number keys when the user is typing in the
            // custom-prompt input.
            if (document.activeElement === customInputRef.current) return;
            if (!chosenAction && /^[1-8]$/.test(e.key)) {
                e.preventDefault();
                const idx = parseInt(e.key, 10) - 1;
                const action = ACTIONS[idx];
                if (action) runAction(action);
                return;
            }
            if (!chosenAction && e.key === 'Enter') {
                e.preventDefault();
                const action = ACTIONS.find(a => a.id === highlightedAction) || ACTIONS[0];
                runAction(action);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [chosenAction, isStreaming, highlightedAction, customPrompt]);

    // Auto-scroll the response area as new tokens stream in.
    useEffect(() => {
        if (responseRef.current) responseRef.current.scrollTop = responseRef.current.scrollHeight;
    }, [responseText]);

    async function runAction(action: ActionDef, customOverride?: string) {
        if (!selection && action.id !== 'custom') {
            // No selection → force custom prompt path with text-as-instruction.
            customInputRef.current?.focus();
            return;
        }
        // Skip-AI shortcut: dispatch the raw selection to chat/canvas
        // directly. No streaming, no token spend, no response view —
        // popup closes immediately.
        if (action.skipAI) {
            if (action.id === 'send_chat') {
                // Use chat-input-append (paste to textarea) so the user can
                // edit/extend their question before sending. Different from
                // the output-bar Chat button (which dispatches a primed
                // 2-message conversation around an AI result).
                window.dispatchEvent(new CustomEvent('klypix:chat-input-append', { detail: { text: selection } }));
            } else if (action.id === 'send_canvas') {
                window.dispatchEvent(new CustomEvent('klypix:canvas-add-text', { detail: { text: selection } }));
            }
            // keepOpen: land the user IN chat/canvas, don't hide Klypix.
            closeKeepOpen();
            return;
        }
        setChosenAction(action.id);
        setResponseText('');
        setStreamError(null);
        setIsStreaming(true);
        abortRef.current = false;
        try {
            const prompt = action.promptFor(selection, customOverride);
            for await (const chunk of streamGemini(prompt)) {
                if (abortRef.current) break;
                setResponseText(prev => prev + chunk);
            }
        } catch (e: any) {
            setStreamError(e?.message || 'Stream failed');
        } finally {
            setIsStreaming(false);
        }
    }

    function runCustom() {
        const p = customPrompt.trim();
        if (!p) return;
        runAction(CUSTOM_ACTION, p);
    }

    async function apply(mode: 'replace' | 'insert' | 'copy') {
        if (!responseText || isStreaming) return;
        const bridge: any = (window as any).electron?.quickAction;
        if (!bridge?.apply) return;
        const res = await bridge.apply({ mode, text: responseText, hwnd: targetHwnd });
        if (res?.ok) {
            setApplyToast(mode === 'copy' ? 'Copied' : mode === 'insert' ? 'Inserted' : 'Pasted');
            // For copy mode, the window stays open so the user can pick
            // another mode. For replace/insert, main already hid us.
            if (mode === 'copy') {
                setTimeout(() => setApplyToast(null), 1400);
            }
        } else {
            setApplyToast('Failed: ' + (res?.error || 'unknown'));
            setTimeout(() => setApplyToast(null), 2200);
        }
    }

    const showingResponse = chosenAction !== null;

    return (
        <div className="h-screen w-screen flex items-stretch justify-center text-white">
            {/* Outer glass shell — Klypix-branded green-tinted background.
                Three layers:
                  1. Top-left radial emerald glow (where the eyes/header sits)
                     — gives the panel a warm "energy source" feel that points
                     at the mascot.
                  2. Bottom-right softer emerald glow — balances the
                     composition and pulls the eye to the output bar.
                  3. Diagonal base gradient (zinc-950 → zinc-900) for depth.
                Border picks up a faint emerald tint, outer drop-shadow has
                a subtle emerald halo, and the inset top highlight gives the
                glass a real beveled edge. `relative` so the apply-toast can
                anchor to the bottom of this card. */}
            <div
                className="relative w-full h-full flex flex-col backdrop-blur-2xl border border-emerald-500/20 rounded-2xl overflow-hidden drag"
                style={{
                    background: `
                        radial-gradient(circle at 0% 0%, rgba(16,185,129,0.20) 0%, transparent 45%),
                        radial-gradient(circle at 100% 100%, rgba(16,185,129,0.10) 0%, transparent 55%),
                        linear-gradient(135deg, rgba(12,16,18,0.96) 0%, rgba(20,24,27,0.96) 100%)
                    `,
                    boxShadow: '0 20px 60px rgba(0,0,0,0.7), 0 0 80px -20px rgba(16,185,129,0.35), inset 0 1px 0 rgba(255,255,255,0.06)',
                }}
            >
                {/* Header / selection preview.
                    Typography hierarchy (top → bottom by importance):
                      1. Selection text (15px, semibold, white/95) — THE anchor
                      2. Meta line (10px, tracked, white/40) — context only
                    Old version inverted this — the bold uppercase meta header
                    pulled focus from the actual selected text. KlypixEyes
                    mascot replaces the generic sparkle for brand presence.
                    Eyes are slightly larger (24) so they read as a presence
                    in the panel, not just an icon. */}
                <div className="px-4 pt-3.5 pb-3 flex items-start gap-3 border-b border-white/5 no-drag" dir="ltr">
                    {/* KlypixEyes naked — no colored frame, the mascot is the
                        brand. While streaming, a soft emerald glow radiates
                        from behind the eyes (radial blur, no hard ring).
                        Container has a tiny hover lift for affordance — the
                        eyes follow the cursor anyway via the look-around
                        animation. */}
                    <div className={cn(
                        'relative shrink-0 self-start mt-1 transition-transform duration-200 hover:scale-110',
                        isStreaming && 'after:absolute after:inset-[-6px] after:rounded-full after:bg-emerald-400/25 after:blur-md after:animate-pulse after:-z-10',
                    )}>
                        <KlypixEyes size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-[14.5px] leading-[1.4] font-semibold text-white/95 line-clamp-2 tracking-tight" dir="auto">
                            {selection || <span className="text-white/45 font-normal italic text-[13px]">No text selected — type a custom instruction below</span>}
                        </div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-white/40 font-medium mt-1.5 flex items-center gap-1.5">
                            {sourceApp && <span className="truncate">From {sourceApp}</span>}
                            {selection && sourceApp && <span className="text-white/20">·</span>}
                            {selection && <span className="text-white/45 tabular-nums shrink-0">{selection.length} chars</span>}
                            {!sourceApp && !selection && <span className="italic normal-case tracking-normal text-[11px]">Quick AI</span>}
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="text-white/35 hover:text-white/90 hover:bg-white/8 p-1.5 rounded-lg transition-colors shrink-0"
                        title="Close (Esc)"
                    >
                        <X size={14} />
                    </button>
                </div>

                {/* Body — action grid OR response. `dir="ltr"` on the grid
                    forces left-to-right cell flow regardless of the app's
                    locale, so the keyboard chord numbers always read 1→6
                    in the natural reading order (Arabic users were seeing
                    "2,1 / 4,3 / 6,5" before). Action labels still respect
                    text direction internally. */}
                {!showingResponse && (
                    <div className="flex-1 flex flex-col overflow-y-auto px-4 py-3.5 gap-3 no-drag" dir="ltr">
                        <div className="grid grid-cols-2 gap-2">
                            {ACTIONS.map((a, i) => {
                                const Icon = a.icon;
                                const isHighlighted = highlightedAction === a.id;
                                const isSmart = smartDefault === a.id;
                                return (
                                    <button
                                        key={a.id}
                                        onClick={() => runAction(a)}
                                        onMouseEnter={() => setHighlightedAction(a.id)}
                                        style={{ animationDelay: `${i * 25}ms` }}
                                        className={cn(
                                            'group relative flex items-center gap-2.5 px-2.5 py-2 rounded-xl border text-left transition-all duration-200 animate-in fade-in slide-in-from-bottom-1 overflow-hidden',
                                            'hover:border-white/20 hover:scale-[1.015]',
                                            isHighlighted
                                                ? 'bg-white/[0.07] border-emerald-500/40 ring-1 ring-emerald-500/20 shadow-[0_4px_20px_-8px_rgba(16,185,129,0.4)]'
                                                : 'bg-white/[0.025] border-white/8',
                                            isSmart && !isHighlighted && 'border-emerald-500/25',
                                            a.skipAI && 'border-dashed',
                                        )}
                                    >
                                        {/* Gradient sweep on hover — subtle accent-tinted wash
                                            from left to right that fades in. Pure CSS, no JS. */}
                                        <div
                                            className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300 pointer-events-none"
                                            style={{ background: `linear-gradient(135deg, ${a.accent}14 0%, transparent 60%)` }}
                                        />
                                        <div
                                            className="relative flex items-center justify-center w-8 h-8 rounded-lg shrink-0 z-10"
                                            style={{ background: `${a.accent}22`, color: a.accent, boxShadow: isHighlighted ? `0 0 0 1px ${a.accent}40` : 'none' }}
                                        >
                                            {/* Inner span carries the per-action hover motion.
                                                Transition is on transform + filter so animations
                                                stack (scale + rotate + drop-shadow). */}
                                            <span className={cn('transition-all duration-300 ease-out inline-block', a.hoverAnim)}>
                                                <Icon size={14} />
                                            </span>
                                            {/* Tiny "Best" indicator dot anchored to the icon
                                                corner — INSIDE the card so overflow-hidden
                                                doesn't clip it. The dot pulses softly so it
                                                catches the eye without shouting. */}
                                            {isSmart && (
                                                <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-zinc-900 animate-pulse" />
                                            )}
                                        </div>
                                        <div className="flex-1 min-w-0 relative z-10">
                                            <div className="flex items-center gap-1.5">
                                                <span className="text-[13.5px] font-semibold text-white tracking-tight leading-[1.2] truncate">{a.label}</span>
                                                {isSmart && (
                                                    <span className="text-[8.5px] uppercase tracking-[0.12em] px-1.5 py-px rounded bg-emerald-500/20 text-emerald-300 font-bold shrink-0 ring-1 ring-emerald-500/30">
                                                        Best
                                                    </span>
                                                )}
                                            </div>
                                            <div className="text-[11px] text-white/55 truncate mt-1 leading-tight">{a.sublabel}</div>
                                        </div>
                                        <kbd className={cn(
                                            'relative z-10 text-[11px] w-5 h-5 flex items-center justify-center rounded font-mono shrink-0 transition-colors',
                                            isHighlighted ? 'bg-emerald-500/25 text-emerald-200' : 'bg-white/8 text-white/60',
                                        )}>{i + 1}</kbd>
                                    </button>
                                );
                            })}
                        </div>

                        {/* Custom prompt — primary input style, with explicit
                            Run button on the right. Becomes the primary
                            action when there's no selection (highlighted in
                            the empty-state branch above). */}
                        <div className={cn(
                            'relative flex items-stretch rounded-xl border transition-all',
                            customPrompt.trim()
                                ? 'bg-emerald-500/[0.07] border-emerald-500/40 ring-1 ring-emerald-500/15'
                                : 'bg-white/5 border-white/10 focus-within:border-emerald-500/35 focus-within:ring-1 focus-within:ring-emerald-500/15',
                        )}>
                            <div className="flex items-center pl-3 pr-1 text-emerald-400/80">
                                <Wand2 size={14} />
                            </div>
                            <input
                                ref={customInputRef}
                                type="text"
                                value={customPrompt}
                                onChange={e => setCustomPrompt(e.target.value)}
                                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); runCustom(); } }}
                                placeholder="Or type a custom instruction…"
                                dir="auto"
                                className="flex-1 px-2 py-2.5 bg-transparent text-[13.5px] text-white placeholder:text-white/50 focus:outline-none"
                            />
                            <button
                                onClick={runCustom}
                                disabled={!customPrompt.trim()}
                                className={cn(
                                    'mr-1 my-1 px-2.5 rounded-lg text-[11px] font-semibold transition-all flex items-center gap-1',
                                    customPrompt.trim()
                                        ? 'bg-emerald-500 text-zinc-900 hover:bg-emerald-400 cursor-pointer'
                                        : 'bg-white/8 text-white/30 cursor-not-allowed',
                                )}
                            >
                                Run <kbd className={cn('text-[10px] px-1 py-px rounded font-mono', customPrompt.trim() ? 'bg-zinc-900/30 text-zinc-900/80' : 'bg-white/8 text-white/40')}>⏎</kbd>
                            </button>
                        </div>

                        {/* Empty-state hints — when there's no selection,
                            surface example prompts as clickable chips so
                            the user understands what custom prompts can do. */}
                        {!selection && (
                            <div className="pt-1">
                                <div className="text-[10px] uppercase tracking-[0.15em] text-white/35 font-semibold mb-1.5">Try a custom instruction</div>
                                <div className="flex flex-wrap gap-1.5">
                                    {['Translate to English', 'Summarize my last email', 'Generate a SQL query', 'Brainstorm 5 ideas for…'].map(ex => (
                                        <button
                                            key={ex}
                                            onClick={() => { setCustomPrompt(ex); customInputRef.current?.focus(); }}
                                            className="text-[11px] px-2 py-1 rounded-full bg-white/[0.04] border border-white/10 text-white/60 hover:bg-white/[0.08] hover:text-white/90 hover:border-white/20 transition-all cursor-pointer"
                                        >
                                            {ex}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {showingResponse && (
                    <div className="flex-1 flex flex-col overflow-hidden no-drag" dir="ltr">
                        {/* Action header */}
                        <div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-white/5">
                            <button
                                onClick={() => { setChosenAction(null); setResponseText(''); setStreamError(null); abortRef.current = true; }}
                                className="text-[10px] uppercase tracking-widest text-white/50 hover:text-white px-2 py-1 rounded hover:bg-white/5 transition-colors"
                            >
                                ← Back
                            </button>
                            <div className="text-[11px] uppercase tracking-widest text-white/70 font-semibold flex items-center gap-2">
                                {(() => {
                                    const a = ACTIONS.find(x => x.id === chosenAction) || CUSTOM_ACTION;
                                    const Icon = a.icon;
                                    return <>
                                        <Icon size={12} style={{ color: a.accent }} />
                                        {a.label}
                                    </>;
                                })()}
                            </div>
                            {isStreaming && (
                                <div className="ml-auto flex items-center gap-1.5 text-[10px] text-white/50">
                                    <Loader2 size={11} className="animate-spin" />
                                    Thinking…
                                </div>
                            )}
                        </div>

                        {/* Response area */}
                        <div
                            ref={responseRef}
                            className="flex-1 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed text-white/90 whitespace-pre-wrap"
                            dir="auto"
                        >
                            {streamError ? (
                                <div className="text-rose-400 bg-rose-500/10 border border-rose-500/20 rounded-lg px-3 py-2 text-[12px]">
                                    {streamError}
                                </div>
                            ) : (
                                <>
                                    {responseText}
                                    {isStreaming && <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-emerald-400/80 align-middle animate-pulse" />}
                                </>
                            )}
                        </div>

                        {/* Output bar — Replace is the visual primary action
                            (filled emerald, takes ~40% width), the rest are
                            secondary outlined chips. Apply-toast slides up
                            from the bottom of the response area. */}
                        <div className="px-3 pt-2.5 pb-3 border-t border-white/5 flex items-stretch gap-2" dir="ltr">
                            <button
                                onClick={() => apply('replace')}
                                disabled={!responseText || isStreaming || !!streamError}
                                className={cn(
                                    'flex-[1.4] flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-bold transition-all duration-150',
                                    'disabled:opacity-40 disabled:cursor-not-allowed',
                                    (!responseText || isStreaming || !!streamError)
                                        ? 'bg-white/5 text-white/40'
                                        : 'bg-emerald-500 text-zinc-900 hover:bg-emerald-400 hover:shadow-[0_4px_20px_-4px_rgba(16,185,129,0.5)] cursor-pointer',
                                )}
                            >
                                <ArrowDownToLine size={13} />
                                Replace
                                <kbd className={cn('text-[10px] px-1 py-px rounded font-mono', (!responseText || isStreaming || !!streamError) ? 'bg-white/10 text-white/40' : 'bg-zinc-900/30 text-zinc-900/85')}>⏎</kbd>
                            </button>
                            <OutputButton
                                label="Insert"
                                icon={ArrowRight}
                                accent="#a78bfa"
                                disabled={!responseText || isStreaming || !!streamError}
                                onClick={() => apply('insert')}
                            />
                            <OutputButton
                                label="Copy"
                                icon={Clipboard}
                                accent="#38bdf8"
                                disabled={!responseText || isStreaming || !!streamError}
                                onClick={() => apply('copy')}
                            />
                            <OutputButton
                                label="Chat"
                                icon={MessageSquare}
                                accent="#fb7185"
                                disabled={!responseText || isStreaming || !!streamError}
                                onClick={() => {
                                    // Frictionless: instead of pasting the result into the
                                    // chat textarea (which forces the user to press Enter),
                                    // inject the full exchange as a 2-message conversation —
                                    // user "prompt" + assistant response. The user lands in
                                    // chat with a primed thread and can ask follow-ups
                                    // ("now make it shorter", "what's a synonym for X").
                                    const action = ACTIONS.find(x => x.id === chosenAction) || CUSTOM_ACTION;
                                    const userPrompt = chosenAction === 'custom'
                                        ? `${customPrompt.trim()}\n\n> ${selection}`
                                        : `${action.label} this${sourceApp ? ` (from ${sourceApp})` : ''}:\n\n> ${selection}`;
                                    window.dispatchEvent(new CustomEvent('klypix:chat-inject-conversation', {
                                        detail: {
                                            messages: [
                                                { role: 'user', content: userPrompt },
                                                { role: 'assistant', content: responseText },
                                            ],
                                        },
                                    }));
                                    closeKeepOpen();
                                }}
                            />
                            <OutputButton
                                label="Canvas"
                                icon={LayoutGrid}
                                accent="#10b981"
                                disabled={!responseText || isStreaming || !!streamError}
                                onClick={() => {
                                    // Drop the result onto the infinite canvas as a new
                                    // TextItem (same pipeline the chat "send to canvas"
                                    // hover button uses). Reuses pendingCanvasItems queue
                                    // so a not-yet-mounted canvas still receives it.
                                    window.dispatchEvent(new CustomEvent('klypix:canvas-add-text', {
                                        detail: { text: responseText },
                                    }));
                                    closeKeepOpen();
                                }}
                            />
                        </div>
                        {applyToast && (
                            <div className="absolute bottom-[58px] left-1/2 -translate-x-1/2 text-[11px] px-3 py-1.5 rounded-full bg-emerald-500/90 text-zinc-900 font-bold shadow-[0_4px_20px_rgba(16,185,129,0.4)] animate-in fade-in slide-in-from-bottom-2 z-10">
                                ✓ {applyToast}
                            </div>
                        )}
                    </div>
                )}

                {/* Footer hints — always LTR so keyboard chords don't mirror. */}
                <div className="px-4 py-1.5 border-t border-white/5 flex items-center justify-between text-[10px] text-white/35 font-medium no-drag" dir="ltr">
                    <div className="flex items-center gap-3">
                        {!showingResponse ? (
                            <>
                                <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">1–8</kbd> action</span>
                                <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">⏎</kbd> run</span>
                            </>
                        ) : (
                            <>
                                <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">⏎</kbd> replace</span>
                                <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">esc</kbd> back</span>
                            </>
                        )}
                    </div>
                    <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">esc</kbd> close</span>
                </div>
            </div>
        </div>
    );
}

function OutputButton({ label, chord, icon: Icon, accent, disabled, onClick }: {
    label: string;
    chord?: string;
    icon: typeof ArrowRight;
    accent: string;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg border text-[11.5px] font-semibold transition-all duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                !disabled && 'hover:bg-white/8 hover:border-white/15 cursor-pointer',
                'border-white/8 bg-white/4 text-white/80',
            )}
        >
            <Icon size={12} style={!disabled ? { color: accent } : undefined} />
            {label}
            {chord && <kbd className="text-[9.5px] px-1 py-px rounded bg-white/10 text-white/55 font-mono">{chord}</kbd>}
        </button>
    );
}
