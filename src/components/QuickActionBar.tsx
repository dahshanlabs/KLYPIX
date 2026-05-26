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
import { Globe, Pencil, FileText, Sparkles, Lightbulb, ArrowRight, X, Clipboard, MessageSquare, ArrowDownToLine, Loader2, Wand2 } from 'lucide-react';
import { getApiKeySync } from '../api/gemini';
import { GoogleGenerativeAI } from '@google/generative-ai';
import clsx, { type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

type ActionId = 'translate' | 'improve' | 'summarize' | 'grammar' | 'explain' | 'continue' | 'custom';

interface ActionDef {
    id: ActionId;
    label: string;
    sublabel: string;
    icon: typeof Globe;
    accent: string;
    promptFor(text: string, custom?: string): string;
}

const ACTIONS: ActionDef[] = [
    {
        id: 'translate',
        label: 'Translate',
        sublabel: 'Auto-detect language',
        icon: Globe,
        accent: '#38bdf8',
        promptFor: (text) => `Translate the following text. If it's in English, translate to Arabic. If it's in any other language, translate to English. Output ONLY the translation, no commentary, no quotes around it, no "Translation:" prefix. Preserve formatting (line breaks, bullets).\n\n---\n${text}`,
    },
    {
        id: 'improve',
        label: 'Improve writing',
        sublabel: 'Clearer, more direct',
        icon: Pencil,
        accent: '#a78bfa',
        promptFor: (text) => `Rewrite the following text to be clearer, more direct, and better-flowing. Keep the original meaning, tone, and approximate length. Output ONLY the rewritten text, no commentary, no quotes.\n\n---\n${text}`,
    },
    {
        id: 'summarize',
        label: 'Summarize',
        sublabel: 'Key points only',
        icon: FileText,
        accent: '#fb7185',
        promptFor: (text) => `Summarize the following text into the most important points. Use short bullet points (3-6 bullets). If the source is one paragraph, give a single tight sentence instead. Output ONLY the summary, no preamble.\n\n---\n${text}`,
    },
    {
        id: 'grammar',
        label: 'Fix grammar',
        sublabel: 'Spelling & syntax',
        icon: Sparkles,
        accent: '#34d399',
        promptFor: (text) => `Fix any spelling, grammar, and punctuation errors in the following text. Do NOT change the meaning, tone, or word choices beyond what's required for correctness. Output ONLY the corrected text, no commentary.\n\n---\n${text}`,
    },
    {
        id: 'explain',
        label: 'Explain',
        sublabel: 'What this means',
        icon: Lightbulb,
        accent: '#fbbf24',
        promptFor: (text) => `Explain the following clearly and concisely (3-5 sentences). If it's code, explain what it does and why. If it's a concept, give a plain-English explanation a smart non-expert could follow. Output the explanation only, no commentary.\n\n---\n${text}`,
    },
    {
        id: 'continue',
        label: 'Continue',
        sublabel: 'Keep writing',
        icon: ArrowRight,
        accent: '#f472b6',
        promptFor: (text) => `Continue the following text in the same voice, tone, and style. Pick up exactly where it ends — your output will be appended directly so do NOT repeat the original. Output the continuation only.\n\n---\n${text}`,
    },
];

const CUSTOM_ACTION: ActionDef = {
    id: 'custom',
    label: 'Custom',
    sublabel: 'Your instruction',
    icon: Wand2,
    accent: '#10b981',
    promptFor: (text, custom) => `${(custom || '').trim()}\n\nText:\n---\n${text}`,
};

interface Props {
    selection: string;
    targetHwnd: string;
    sourceApp?: string;
    onClose: () => void;
}

function detectSmartDefault(selection: string): ActionId {
    const s = selection.trim();
    if (!s) return 'translate';
    // Arabic / RTL detection — Unicode range U+0600..U+06FF (Arabic) and U+FB50..U+FDFF (presentation forms)
    const arabicChars = (s.match(/[؀-ۿﭐ-﷿]/g) || []).length;
    if (arabicChars / s.length > 0.3) return 'translate';
    // Code-ish: contains common code tokens AND multiple lines OR ends with });/]/}.
    const codeTokens = /\b(function|const|let|var|class|import|export|return|async|await|if|else|for|while|public|private)\b/;
    if (codeTokens.test(s) && (/[{}();]/.test(s) || s.includes('=>'))) return 'explain';
    // Long → summarize. Threshold ~600 chars (about a screenful).
    if (s.length > 600) return 'summarize';
    // Unfinished sentence — ends with letter or comma, no terminal punct in last 40 chars.
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
            if (!chosenAction && /^[1-6]$/.test(e.key)) {
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
            {/* Outer glass shell — same theme as palette. `relative` so the
                apply-toast can anchor to the bottom of this card. */}
            <div className="relative w-full h-full flex flex-col bg-zinc-900/95 backdrop-blur-2xl border border-white/10 rounded-2xl overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.6)] drag">
                {/* Header / selection preview — taller, more readable preview
                    (sans-serif, 3 lines, better contrast). Sparkle icon gets
                    a subtle pulsing ring while streaming for ambient feedback. */}
                <div className="px-4 pt-3.5 pb-3 flex items-start gap-3 border-b border-white/5 no-drag" dir="ltr">
                    <div className={cn(
                        'relative flex items-center justify-center w-8 h-8 rounded-xl bg-emerald-500/15 text-emerald-400 shrink-0',
                        isStreaming && 'after:absolute after:inset-0 after:rounded-xl after:ring-2 after:ring-emerald-400/40 after:animate-ping',
                    )}>
                        <Sparkles size={15} />
                    </div>
                    <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45 font-semibold flex items-center gap-1.5">
                            <span className="truncate">{sourceApp ? `Selected from ${sourceApp}` : 'Selected text'}</span>
                            {selection && <span className="text-white/25">·</span>}
                            {selection && <span className="text-white/35 tabular-nums shrink-0">{selection.length} chars</span>}
                        </div>
                        <div className="text-[13px] leading-[1.45] text-white/85 mt-1 line-clamp-3" dir="auto">
                            {selection || <span className="italic text-white/40 text-[12.5px]">No text selected — type a custom instruction below or pick an action to retry capture</span>}
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
                                        style={{ animationDelay: `${i * 30}ms` }}
                                        className={cn(
                                            'group relative flex items-center gap-3 px-3 py-3 rounded-xl border text-left transition-all duration-150 animate-in fade-in slide-in-from-bottom-1',
                                            'hover:bg-white/[0.07] hover:border-white/15 hover:scale-[1.01]',
                                            isHighlighted
                                                ? 'bg-white/[0.07] border-emerald-500/40 ring-1 ring-emerald-500/20 shadow-[0_4px_20px_-8px_rgba(16,185,129,0.4)]'
                                                : 'bg-white/[0.025] border-white/8',
                                            isSmart && !isHighlighted && 'border-emerald-500/25',
                                        )}
                                    >
                                        {isSmart && (
                                            <span className="absolute -top-1.5 -right-1.5 text-[8.5px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded-full bg-emerald-500 text-zinc-900 font-bold shadow-[0_2px_8px_rgba(16,185,129,0.5)] z-10">
                                                Best
                                            </span>
                                        )}
                                        <div
                                            className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0 transition-transform group-hover:scale-110"
                                            style={{ background: `${a.accent}22`, color: a.accent, boxShadow: isHighlighted ? `0 0 0 1px ${a.accent}40` : 'none' }}
                                        >
                                            <Icon size={16} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="text-[13px] font-semibold text-white/95 leading-tight">{a.label}</div>
                                            <div className="text-[10.5px] text-white/50 truncate mt-0.5">{a.sublabel}</div>
                                        </div>
                                        <kbd className={cn(
                                            'text-[10.5px] px-1.5 py-0.5 rounded font-mono shrink-0 transition-colors',
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
                                className="flex-1 px-2 py-2.5 bg-transparent text-[13px] text-white placeholder:text-white/40 focus:outline-none"
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
                                    window.dispatchEvent(new CustomEvent('klypix:chat-input-append', { detail: { text: responseText } }));
                                    onClose();
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
                                <span><kbd className="px-1 py-px rounded bg-white/8 text-white/60 font-mono">1–6</kbd> action</span>
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
