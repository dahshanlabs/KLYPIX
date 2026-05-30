import React, { useEffect, useRef, useState } from 'react';
import { X, Trash2, Check, CheckCircle2 } from 'lucide-react';
import type { CanvasItem, Comment } from '../items/types';
import { newId } from '../items/types';
import { useCanvasStore } from '../state/canvasStore';
import { useAuth } from '../../components/AuthProvider';

// Stable per-author color (same 12-slot palette idea as collab presence) so a
// commenter's avatar dot matches their identity across the thread.
const COMMENT_COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#f97316', '#a855f7', '#14b8a6', '#eab308'];
function colorForAuthor(key: string): string {
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    return COMMENT_COLORS[Math.abs(h) % COMMENT_COLORS.length];
}
// Parse @mentions: @name or @"first last". Returns the bare names.
function parseMentions(text: string): string[] {
    const out: string[] = [];
    const re = /@([\w][\w.\-]*)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(m[1]);
    return Array.from(new Set(out));
}
// Render comment text with @mentions highlighted.
function renderWithMentions(text: string): React.ReactNode[] {
    const parts: React.ReactNode[] = [];
    const re = /(@[\w][\w.\-]*)/g;
    let last = 0; let m: RegExpExecArray | null; let i = 0;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) parts.push(text.slice(last, m.index));
        const mention = m[1];
        const isClaude = /^@claude$/i.test(mention);
        parts.push(
            <span key={i++} style={{
                color: isClaude ? '#a78bfa' : '#10b981',
                fontWeight: 600,
            }}>{mention}</span>
        );
        last = m.index + mention.length;
    }
    if (last < text.length) parts.push(text.slice(last));
    return parts;
}

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
    const auth = useAuth();
    const current = (state.items[item.id] as CanvasItem | undefined) || item;
    const comments: Comment[] = current.comments || [];
    const threadResolved = comments.length > 0 && comments.every(c => c.resolved);
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
        // Real signed-in identity (was hardcoded 'You'). Falls back to 'You'
        // when not signed in (solo/offline). authorId + color give peers a
        // stable identity on the synced comment.
        const authorName = auth.user?.displayName || auth.user?.email?.split('@')[0] || 'You';
        const authorId = auth.user?.id;
        const c: Comment = {
            id: newId('cmt'),
            author: authorName,
            authorId,
            authorColor: colorForAuthor(authorId || authorName),
            text,
            timestamp: Date.now(),
            mentions: parseMentions(text),
            // Adding a comment re-opens a resolved thread.
            resolved: false,
        };
        // Adding also clears `resolved` on the existing comments so the thread
        // re-opens when someone replies after it was resolved.
        const reopened = comments.map(x => x.resolved ? { ...x, resolved: false } : x);
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { comments: [...reopened, c] } as any,
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

    // Toggle the whole thread resolved/open. Resolving sets `resolved` on
    // every comment so the item badge can render a resolved state. Synced +
    // persisted for free (UPDATE_ITEM).
    const toggleResolved = () => {
        const next = !threadResolved;
        dispatch({
            type: 'UPDATE_ITEM',
            id: item.id,
            patch: { comments: comments.map(c => ({ ...c, resolved: next })) } as any,
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
                    <div className="text-[10px] uppercase tracking-wider font-medium" style={{ color: threadResolved ? 'rgba(16,185,129,0.85)' : 'rgba(251,191,36,0.8)' }}>
                        {threadResolved ? 'Resolved' : 'Comments'}
                    </div>
                    <div className="text-[12px] text-white/80 truncate">{comments.length} {comments.length === 1 ? 'note' : 'notes'}</div>
                </div>
                {comments.length > 0 && (
                    <button
                        onClick={toggleResolved}
                        title={threadResolved ? 'Re-open thread' : 'Resolve thread'}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors"
                        style={{
                            background: threadResolved ? 'rgba(16,185,129,0.18)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid ' + (threadResolved ? 'rgba(16,185,129,0.35)' : 'rgba(255,255,255,0.1)'),
                            color: threadResolved ? '#10b981' : 'rgba(255,255,255,0.6)',
                        }}
                    >
                        <CheckCircle2 size={11} />
                        {threadResolved ? 'Resolved' : 'Resolve'}
                    </button>
                )}
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
                {comments.map(c => {
                    const dot = c.authorColor || colorForAuthor(c.authorId || c.author);
                    return (
                    <div key={c.id} className="group bg-white/5 rounded-lg px-2.5 py-1.5 text-white/85" style={c.resolved ? { opacity: 0.6 } : undefined}>
                        <div className="flex items-center gap-2 mb-0.5">
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, flexShrink: 0 }} />
                                <span className="text-[10px] uppercase tracking-wider font-medium truncate" style={{ color: dot }}>
                                    <bdi>{c.author}</bdi>
                                </span>
                            </span>
                            {c.resolved && <Check size={10} className="text-emerald-400 flex-shrink-0" />}
                            <span className="flex-1 text-[10px] text-white/30 text-right">{formatTs(c.timestamp)}</span>
                            <button
                                onClick={() => remove(c.id)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-white/40 hover:text-red-300 transition-all"
                                title="Remove comment"
                            >
                                <Trash2 size={10} />
                            </button>
                        </div>
                        <div className="whitespace-pre-wrap break-words"><bdi>{renderWithMentions(c.text)}</bdi></div>
                    </div>
                    );
                })}
            </div>

            <div className="p-2 border-t border-white/5">
                <div className="flex items-end gap-2 rounded-lg bg-white/5 px-2 py-1.5 focus-within:bg-white/[0.08] transition-colors">
                    <textarea
                        dir="auto"
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
