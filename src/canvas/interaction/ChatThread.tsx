import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Send, Trash2 } from 'lucide-react';
import type { CanvasItem, ThreadMessage } from '../items/types';
import { newId } from '../items/types';
import { useCanvasStore } from '../state/canvasStore';
import { runCanvasThread } from '../agent/canvasThread';

// Floating chat panel anchored near a canvas item. Screen coords, not world —
// stays same size while the canvas pans/zooms, always readable. Agent sees
// ONLY this item plus the thread history (not the rest of the canvas).

interface Props {
    item: CanvasItem;
    screenX: number;   // top-left of the anchor item in screen coords
    screenY: number;
    itemScreenW: number;
    itemScreenH: number;
    onClose: () => void;
}

const PANEL_W = 360;
const PANEL_H = 420;
const MARGIN = 12;

function clampToViewport(x: number, y: number): { x: number; y: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
        x: Math.max(8, Math.min(x, vw - PANEL_W - 8)),
        y: Math.max(8, Math.min(y, vh - PANEL_H - 8)),
    };
}

export function ChatThread({ item, screenX, screenY, itemScreenW, itemScreenH, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    // We pull the thread fresh from store every render so streaming updates show.
    const current = (state.items[item.id] as CanvasItem | undefined) || item;
    const thread: ThreadMessage[] = current.thread || [];

    const [draft, setDraft] = useState('');
    const [sending, setSending] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    // Prefer placing the panel to the right of the item; fall back to left,
    // then below if neither side fits. Clamped to viewport.
    const position = useMemo(() => {
        const vw = window.innerWidth;
        const spaceRight = vw - (screenX + itemScreenW) - MARGIN;
        const spaceLeft = screenX - MARGIN;
        let x: number, y: number;
        if (spaceRight >= PANEL_W) {
            x = screenX + itemScreenW + MARGIN;
            y = screenY;
        } else if (spaceLeft >= PANEL_W) {
            x = screenX - PANEL_W - MARGIN;
            y = screenY;
        } else {
            x = screenX;
            y = screenY + itemScreenH + MARGIN;
        }
        return clampToViewport(x, y);
    }, [screenX, screenY, itemScreenW, itemScreenH]);

    // Autoscroll to bottom on new messages / streaming tokens.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [thread]);

    // Focus input on open.
    useEffect(() => { inputRef.current?.focus(); }, []);

    // Escape closes, but only when we're not mid-send (avoids accidental stop).
    useEffect(() => {
        const handler = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && !sending) onClose();
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
    }, [onClose, sending]);

    // Abort any in-flight stream if the panel unmounts.
    useEffect(() => () => { abortRef.current?.abort(); }, []);

    async function send() {
        const text = draft.trim();
        if (!text || sending) return;
        const userMsg: ThreadMessage = {
            id: newId('msg'),
            role: 'user',
            content: text,
            timestamp: Date.now(),
            status: 'done',
        };
        const assistantMsg: ThreadMessage = {
            id: newId('msg'),
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            status: 'streaming',
        };
        dispatch({ type: 'ADD_THREAD_MESSAGE', itemId: item.id, message: userMsg });
        dispatch({ type: 'ADD_THREAD_MESSAGE', itemId: item.id, message: assistantMsg });
        setDraft('');
        setSending(true);
        const ctl = new AbortController();
        abortRef.current = ctl;
        const res = await runCanvasThread({
            item: current,
            items: state.items,
            history: thread,
            userMessage: text,
            onChunk: (textSoFar) => {
                dispatch({
                    type: 'UPDATE_THREAD_MESSAGE',
                    itemId: item.id,
                    messageId: assistantMsg.id,
                    patch: { content: textSoFar },
                });
            },
            signal: ctl.signal,
        });
        if (res.error) {
            dispatch({
                type: 'UPDATE_THREAD_MESSAGE',
                itemId: item.id,
                messageId: assistantMsg.id,
                patch: { content: `(error: ${res.error})`, status: 'error' },
            });
        } else {
            dispatch({
                type: 'UPDATE_THREAD_MESSAGE',
                itemId: item.id,
                messageId: assistantMsg.id,
                patch: { content: res.text || '(no response)', status: 'done' },
            });
        }
        setSending(false);
        abortRef.current = null;
    }

    function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
        }
    }

    function clearThread() {
        if (!thread.length) return;
        if (!window.confirm('Clear this thread? Messages are saved in the file.')) return;
        dispatch({ type: 'CLEAR_THREAD', itemId: item.id });
    }

    const title = getItemTitle(current);

    return (
        <div
            data-thread-panel="1"
            className="fixed z-[85] no-drag flex flex-col rounded-xl border border-white/10 bg-[#0e0e15] shadow-[0_16px_48px_rgba(0,0,0,0.7)] animate-in fade-in zoom-in-95 duration-150"
            style={{ left: position.x, top: position.y, width: PANEL_W, height: PANEL_H }}
            onWheel={(e) => e.stopPropagation()}
        >
            {/* Header — the only region that swallows pointerdown, so it acts
                as a drag-guard for the title bar without blocking text
                selection in the message scroll area below. */}
            <div
                className="flex items-center gap-2 px-3 py-2 border-b border-white/5"
                onPointerDown={(e) => e.stopPropagation()}
            >
                <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-emerald-400/80 font-medium">Thread</div>
                    <div className="text-[12px] text-white/80 truncate">{title}</div>
                </div>
                <button
                    onClick={clearThread}
                    title="Clear thread"
                    className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-red-300 transition-colors"
                    disabled={thread.length === 0 || sending}
                >
                    <Trash2 size={13} />
                </button>
                <button
                    onClick={onClose}
                    title="Close"
                    className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
                >
                    <X size={14} />
                </button>
            </div>

            {/* Messages — selectable. user-select:text must be explicit because
                some ancestor (the canvas surface) sets select-none. */}
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto px-3 py-3 space-y-3 text-[12.5px] leading-[1.5]"
                style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
            >
                {thread.length === 0 && (
                    <div className="text-white/30 text-[11.5px] italic">
                        Ask anything about this item. The agent only sees this item, not the rest of the canvas.
                    </div>
                )}
                {thread.map((m) => (
                    <MessageBubble key={m.id} message={m} />
                ))}
            </div>

            {/* Input */}
            <div className="p-2 border-t border-white/5">
                <div className="flex items-end gap-2 rounded-lg bg-white/5 px-2 py-1.5 focus-within:bg-white/[0.08] transition-colors">
                    <textarea
                        ref={inputRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={handleKey}
                        placeholder={sending ? 'Thinking…' : 'Ask a follow-up…'}
                        disabled={sending}
                        rows={1}
                        className="flex-1 bg-transparent outline-none resize-none text-[12.5px] text-white/90 placeholder:text-white/30 max-h-[100px]"
                        style={{ minHeight: 20 }}
                    />
                    <button
                        onClick={send}
                        disabled={!draft.trim() || sending}
                        className="p-1.5 rounded-md bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Send (Enter)"
                    >
                        <Send size={13} />
                    </button>
                </div>
            </div>
        </div>
    );
}

function MessageBubble({ message }: { message: ThreadMessage }) {
    const isUser = message.role === 'user';
    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
            <div
                className={`max-w-[88%] rounded-lg px-2.5 py-1.5 whitespace-pre-wrap break-words cursor-text ${
                    isUser
                        ? 'bg-emerald-500/15 text-emerald-100'
                        : message.status === 'error'
                          ? 'bg-red-500/10 text-red-200'
                          : 'bg-white/5 text-white/85'
                }`}
                style={{ userSelect: 'text', WebkitUserSelect: 'text' } as React.CSSProperties}
            >
                {message.content || (message.status === 'streaming' ? <TypingDots /> : '…')}
            </div>
        </div>
    );
}

function TypingDots() {
    return (
        <span className="inline-flex gap-1">
            <span className="typing-dot" style={{ animationDelay: '0ms' }} />
            <span className="typing-dot" style={{ animationDelay: '150ms' }} />
            <span className="typing-dot" style={{ animationDelay: '300ms' }} />
        </span>
    );
}

function getItemTitle(item: CanvasItem): string {
    if ((item as any).fileName) return (item as any).fileName;
    if (item.type === 'text') return (item.content || 'Text').slice(0, 60);
    if (item.type === 'container') return item.title || 'Container';
    if (item.type === 'code') return `${item.language} snippet`;
    return `${item.type} item`;
}
