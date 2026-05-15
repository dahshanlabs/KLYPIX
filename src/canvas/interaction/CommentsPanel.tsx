import React, { useEffect, useRef, useState } from 'react';
import { X, Trash2 } from 'lucide-react';
import type { CanvasItem, Comment } from '../items/types';
import { newId } from '../items/types';
import { useCanvasStore } from '../state/canvasStore';

// Floating comments thread for a canvas item. Data model was already in
// place (BaseItem.comments + right-click "Add comment…" in the context
// menu); this component gives the user a thread view to read, add, and
// delete comments. Opened from the comment-count badge on an item.

interface Props {
    item: CanvasItem;
    screenX: number;
    screenY: number;
    itemScreenW: number;
    itemScreenH: number;
    onClose: () => void;
}

const PANEL_W = 300;
const PANEL_H = 360;
const MARGIN = 12;

function clampToViewport(x: number, y: number): { x: number; y: number } {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
        x: Math.max(8, Math.min(x, vw - PANEL_W - 8)),
        y: Math.max(8, Math.min(y, vh - PANEL_H - 8)),
    };
}

export function CommentsPanel({ item, screenX, screenY, itemScreenW, itemScreenH, onClose }: Props) {
    const { state, dispatch } = useCanvasStore();
    const current = (state.items[item.id] as CanvasItem | undefined) || item;
    const comments: Comment[] = current.comments || [];
    const [draft, setDraft] = useState('');
    const scrollRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const position = (() => {
        const vw = window.innerWidth;
        const spaceRight = vw - (screenX + itemScreenW) - MARGIN;
        const spaceLeft = screenX - MARGIN;
        let x: number, y: number;
        if (spaceRight >= PANEL_W) { x = screenX + itemScreenW + MARGIN; y = screenY; }
        else if (spaceLeft >= PANEL_W) { x = screenX - PANEL_W - MARGIN; y = screenY; }
        else { x = screenX; y = screenY + itemScreenH + MARGIN; }
        return clampToViewport(x, y);
    })();

    useEffect(() => {
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }, [comments.length]);
    useEffect(() => { inputRef.current?.focus(); }, []);

    useEffect(() => {
        const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    const add = () => {
        const text = draft.trim();
        if (!text) return;
        const c: Comment = { id: newId('cmt'), author: 'You', text, timestamp: Date.now() };
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { comments: [...comments, c] } as any,
        });
        setDraft('');
    };

    const remove = (id: string) => {
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { comments: comments.filter(c => c.id !== id) } as any,
        });
    };

    return (
        <div
            data-canvas-ui="1"
            className="fixed z-[85] no-drag flex flex-col rounded-xl border border-white/10 bg-[#0e0e15] shadow-[0_16px_48px_rgba(0,0,0,0.7)] animate-in fade-in zoom-in-95 duration-150"
            style={{ left: position.x, top: position.y, width: PANEL_W, height: PANEL_H }}
        >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/5">
                <div className="flex-1 min-w-0">
                    <div className="text-[10px] uppercase tracking-wider text-amber-400/80 font-medium">Comments</div>
                    <div className="text-[12px] text-white/80 truncate">{comments.length} {comments.length === 1 ? 'note' : 'notes'}</div>
                </div>
                <button
                    onClick={onClose}
                    title="Close"
                    className="p-1.5 rounded hover:bg-white/5 text-white/40 hover:text-white/80 transition-colors"
                >
                    <X size={14} />
                </button>
            </div>

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 text-[12.5px] leading-[1.5]">
                {comments.length === 0 && (
                    <div className="text-white/30 text-[11.5px] italic">
                        No comments yet. Use the text area below to add one.
                    </div>
                )}
                {comments.map(c => (
                    <div key={c.id} className="group bg-white/5 rounded-lg px-2.5 py-1.5 text-white/85">
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[10px] uppercase tracking-wider text-amber-400/80 font-medium">{c.author}</span>
                            <span className="flex-1 text-[10px] text-white/30">{formatTs(c.timestamp)}</span>
                            <button
                                onClick={() => remove(c.id)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/40 hover:text-red-300 transition-all"
                                title="Remove comment"
                            >
                                <Trash2 size={10} />
                            </button>
                        </div>
                        <div className="whitespace-pre-wrap break-words">{c.text}</div>
                    </div>
                ))}
            </div>

            <div className="p-2 border-t border-white/5">
                <div className="flex items-end gap-2 rounded-lg bg-white/5 px-2 py-1.5 focus-within:bg-white/[0.08] transition-colors">
                    <textarea
                        ref={inputRef}
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); }
                        }}
                        placeholder="Write a note…"
                        rows={1}
                        className="flex-1 bg-transparent outline-none resize-none text-[12.5px] text-white/90 placeholder:text-white/30 max-h-[100px]"
                        style={{ minHeight: 20 }}
                    />
                    <button
                        onClick={add}
                        disabled={!draft.trim()}
                        className="px-2.5 py-1 rounded-md bg-amber-500/15 text-amber-300 text-[11px] font-medium hover:bg-amber-500/25 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        Add
                    </button>
                </div>
            </div>
        </div>
    );
}

function formatTs(ts: number): string {
    const delta = Date.now() - ts;
    if (delta < 60_000) return 'just now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
}
