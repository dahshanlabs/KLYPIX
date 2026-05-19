import React, { useEffect, useRef, useState } from 'react';
import { X, Send, MessageSquare } from 'lucide-react';
import { t, useLocale } from '../../i18n/strings';
import type { CollabMessage } from './useCanvasCollab';

interface Props {
    open: boolean;
    onClose: () => void;
    messages: CollabMessage[];
    onSend: (text: string) => CollabMessage | null;
    /** Own userId — distinguishes "you" from "them" in the bubble layout. */
    selfUserId: string | null;
    /** True when the realtime channel is up. When false the input still
     *  works (messages queue locally as optimistic appends) but we show
     *  a small "reconnecting" hint so the user isn't surprised when the
     *  peer doesn't see it. */
    connected: boolean;
    /** True when there's at least one other peer on the canvas. Used to
     *  show a soft empty-state nudge when chatting solo — sending a
     *  message right now means nobody hears it. */
    hasPeers: boolean;
}

/** Phase 21: ephemeral per-canvas chat. No persistence — the panel is a
 *  live conversation surface while two or more collaborators are on the
 *  same canvas at the same time. Bottom-right docked, ~320px wide,
 *  flexes vertically, closes via the chrome X / Esc. */
export function CanvasChatPanel({ open, onClose, messages, onSend, selfUserId, connected, hasPeers }: Props) {
    useLocale();
    const [text, setText] = useState('');
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    // Auto-scroll to bottom whenever a new message comes in. Skipped when
    // the user has scrolled up to read history (within 80px of bottom = "they're
    // following along"; further than that = leave their view alone).
    const lastSeenLenRef = useRef(messages.length);
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        if (isAtBottom || messages.length === lastSeenLenRef.current + 1) {
            el.scrollTop = el.scrollHeight;
        }
        lastSeenLenRef.current = messages.length;
    }, [messages.length]);

    // Esc closes; clicking outside the panel does NOT close (canvas chat
    // should stay open while the user clicks around the canvas to reference
    // something). The X button + Esc are the explicit exits.
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [open, onClose]);

    useEffect(() => {
        if (open) {
            // Slight delay so the panel mounts before focus + the autosroll
            // settles, preventing the input from being jammed off-screen on
            // an Android-style soft-keyboard popup.
            const id = setTimeout(() => inputRef.current?.focus(), 60);
            return () => clearTimeout(id);
        }
    }, [open]);

    if (!open) return null;

    const handleSend = () => {
        const sent = onSend(text);
        if (sent) setText('');
    };

    return (
        <div
            data-canvas-ui="1"
            className="no-drag absolute z-30 flex flex-col rounded-xl border border-white/10 bg-[#0e0e14]/95 backdrop-blur-md shadow-2xl"
            style={{
                width: 320,
                maxHeight: 'calc(100vh - 140px)',
                minHeight: 240,
                bottom: 56,
                right: 12,
                boxShadow: '0 16px 40px rgba(0,0,0,0.55)',
            }}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
                <div className="flex items-center gap-2 text-white/85 text-[12px] font-medium">
                    <MessageSquare size={13} />
                    <span>{t('canvas.chat.title')}</span>
                    {!connected && (
                        <span className="text-amber-400/80 text-[10px] font-normal ml-1">
                            · {t('canvas.chat.connecting')}
                        </span>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    title={t('common.close')}
                    className="text-white/40 hover:text-white/80 transition-colors cursor-pointer"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Message list */}
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2" style={{ minHeight: 0 }}>
                {messages.length === 0 ? (
                    <div className="text-center text-white/35 text-[11px] my-auto leading-relaxed px-2">
                        {hasPeers ? t('canvas.chat.empty_has_peers') : t('canvas.chat.empty_solo')}
                    </div>
                ) : (
                    messages.map(m => (
                        <Bubble key={m.id} msg={m} isSelf={m.fromUserId === selfUserId} />
                    ))
                )}
            </div>

            {/* Input */}
            <div className="px-2 py-2 border-t border-white/10 flex items-end gap-2">
                <textarea
                    ref={inputRef}
                    value={text}
                    onChange={e => setText(e.target.value.slice(0, 2000))}
                    onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            handleSend();
                        }
                    }}
                    placeholder={t('canvas.chat.placeholder')}
                    rows={1}
                    className="flex-1 resize-none bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-white text-[12px] placeholder-white/30 focus:outline-none focus:border-emerald-500/40"
                    style={{ maxHeight: 96, minHeight: 28, fontFamily: 'inherit' }}
                />
                <button
                    type="button"
                    onClick={handleSend}
                    disabled={!text.trim()}
                    title={t('canvas.chat.send')}
                    className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 disabled:opacity-30 disabled:cursor-not-allowed border border-emerald-500/30 text-emerald-300 transition-colors cursor-pointer"
                >
                    <Send size={12} />
                </button>
            </div>
        </div>
    );
}

function Bubble({ msg, isSelf }: { msg: CollabMessage; isSelf: boolean }) {
    const time = (() => {
        try {
            const d = new Date(msg.ts);
            return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch { return ''; }
    })();
    return (
        <div className={`flex flex-col ${isSelf ? 'items-end' : 'items-start'}`}>
            {!isSelf && (
                <div className="text-[10px] font-medium mb-0.5 ml-0.5" style={{ color: msg.color }}>
                    {msg.fromName}
                </div>
            )}
            <div
                className="max-w-[85%] rounded-xl px-2.5 py-1.5 text-[12px] leading-snug break-words whitespace-pre-wrap"
                style={{
                    background: isSelf ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255,255,255,0.06)',
                    border: '1px solid ' + (isSelf ? 'rgba(16, 185, 129, 0.35)' : 'rgba(255,255,255,0.08)'),
                    color: 'rgba(255,255,255,0.92)',
                }}
            >
                {msg.text}
            </div>
            <div className="text-[9px] text-white/30 mt-0.5 mx-1">{time}</div>
        </div>
    );
}
