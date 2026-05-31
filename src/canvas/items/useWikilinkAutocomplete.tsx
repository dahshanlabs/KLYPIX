import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CanvasItem } from './types';
import { cardTitle } from './wikilinks';

// 2026-05-31 — `[[` autocomplete for normal users.
//
// When someone types `[[` inside a text card, a dropdown of existing card
// titles appears; pick one (click / Enter / Tab) and it inserts `[[Title]]`
// with the caret placed after. So users never have to remember or type exact
// titles — they pick from a list, exactly like Obsidian/Notion. This is the
// piece that makes the wikilink graph usable by non-power-users.
//
// Design notes that keep it SAFE against the delicate text-editing path:
//  • The hook lives at the TOP of TextItemViewImpl (hook-rules), and commits
//    through a ref the editing block assigns to its existing
//    applyContentChange — so styleRun shifting stays correct and we don't
//    duplicate edit logic.
//  • The dropdown is a PORTAL positioned by the textarea's screen rect. That
//    sidesteps the bordered editor's overflow:hidden and the world-transform
//    zoom — it renders crisp at document.body, like any real autocomplete.
//  • It never intercepts a keystroke unless the dropdown is actually open
//    with results, so normal typing is untouched.

interface Candidate { id: string; title: string; }

export interface WikilinkAutocomplete {
    /** Call from the textarea onChange with the new value + caret. */
    onValueChange: (value: string, caret: number) => void;
    /** Call FIRST in the textarea onKeyDown. Returns true if it consumed the
     *  key (caller must then `return` without running its own handlers). */
    onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
    /** The dropdown (portal) — render it once in the editing JSX. */
    dropdown: React.ReactNode;
    /** True while the menu is showing — lets the caller suppress blur-close. */
    open: boolean;
}

const MAX_RESULTS = 8;

export function useWikilinkAutocomplete(opts: {
    items: Record<string, CanvasItem>;
    selfId: string;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    /** Ref the editing block points at its applyContentChange. */
    commitRef: React.RefObject<((newContent: string) => void) | null>;
}): WikilinkAutocomplete {
    const { items, selfId, textareaRef, commitRef } = opts;
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [index, setIndex] = useState(0);
    const startRef = useRef(-1); // string index of the '[[' that opened this menu

    // Find an UNCLOSED `[[` immediately governing the caret. Returns the
    // start index of the `[[` and the query typed after it, or null.
    const detect = (value: string, caret: number): { start: number; query: string } | null => {
        const before = value.slice(0, caret);
        const start = before.lastIndexOf('[[');
        if (start === -1) return null;
        const between = value.slice(start + 2, caret);
        // A closing ]] or a newline ends the link context.
        if (between.includes(']]') || between.includes('\n')) return null;
        return { start, query: between };
    };

    const onValueChange = (value: string, caret: number) => {
        const d = detect(value, caret);
        if (d) {
            startRef.current = d.start;
            setQuery(d.query);
            setOpen(true);
            setIndex(0);
        } else if (open) {
            setOpen(false);
        }
    };

    const candidates = (): Candidate[] => {
        const q = query.trim().toLowerCase();
        const out: Candidate[] = [];
        const seen = new Set<string>();
        for (const id in items) {
            if (id === selfId) continue;
            const t = cardTitle(items[id]);
            if (!t) continue;
            const key = t.toLowerCase();
            if (seen.has(key)) continue;
            if (q && !key.includes(q)) continue;
            seen.add(key);
            out.push({ id, title: t });
            if (out.length >= MAX_RESULTS) break;
        }
        return out;
    };

    const commit = (title: string) => {
        const ta = textareaRef.current;
        const apply = commitRef.current;
        const start = startRef.current;
        if (!ta || !apply || start < 0) { setOpen(false); return; }
        const value = ta.value;
        const caret = ta.selectionStart ?? value.length;
        const insert = `[[${title}]]`;
        const next = value.slice(0, start) + insert + value.slice(caret);
        apply(next);
        setOpen(false);
        // Restore caret after the inserted ]] once React re-renders the value.
        const newCaret = start + insert.length;
        requestAnimationFrame(() => {
            const t = textareaRef.current;
            if (!t) return;
            try { t.focus(); t.setSelectionRange(newCaret, newCaret); } catch { /* noop */ }
        });
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
        if (!open) return false;
        const list = candidates();
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return true; }
        if (list.length === 0) return false; // nothing to pick — let typing flow
        if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); setIndex(i => (i + 1) % list.length); return true; }
        if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); setIndex(i => (i - 1 + list.length) % list.length); return true; }
        if (e.key === 'Enter' || e.key === 'Tab') {
            e.preventDefault(); e.stopPropagation();
            commit(list[Math.min(index, list.length - 1)].title);
            return true;
        }
        return false;
    };

    let dropdown: React.ReactNode = null;
    if (open) {
        const list = candidates();
        const ta = textareaRef.current;
        if (list.length > 0 && ta) {
            const r = ta.getBoundingClientRect();
            // Anchor under the textarea; flip above if near the bottom edge.
            const belowSpace = window.innerHeight - r.bottom;
            const top = belowSpace < 220 ? undefined : r.bottom + 4;
            const bottom = belowSpace < 220 ? (window.innerHeight - r.top + 4) : undefined;
            dropdown = createPortal(
                <div
                    style={{
                        position: 'fixed',
                        left: Math.max(8, Math.min(r.left, window.innerWidth - 268)),
                        top, bottom,
                        width: 260,
                        maxHeight: 220,
                        overflowY: 'auto',
                        background: '#0e0e14',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 8,
                        boxShadow: '0 12px 32px rgba(0,0,0,0.5)',
                        zIndex: 10000,
                        padding: 4,
                        fontFamily: 'Thmanyah Sans, system-ui, sans-serif',
                    }}
                    // Prevent the textarea from blurring when the user clicks
                    // an option (blur would close edit mode + the menu).
                    onMouseDown={(e) => e.preventDefault()}
                >
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: 0.6, padding: '4px 8px 6px' }}>
                        Link to card
                    </div>
                    {list.map((c, i) => (
                        <div
                            key={c.id}
                            onClick={() => commit(c.title)}
                            onMouseEnter={() => setIndex(i)}
                            style={{
                                display: 'flex', alignItems: 'center', gap: 8,
                                padding: '7px 8px', borderRadius: 6, cursor: 'pointer',
                                background: i === index ? 'rgba(139,156,255,0.18)' : 'transparent',
                                color: i === index ? '#c7d0ff' : 'rgba(255,255,255,0.82)',
                                fontSize: 12,
                            }}
                        >
                            <span style={{ color: '#8b9cff', flexShrink: 0 }}>[[</span>
                            <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                <bdi>{c.title}</bdi>
                            </span>
                        </div>
                    ))}
                </div>,
                document.body,
            );
        }
    }

    return { onValueChange, onKeyDown, dropdown, open };
}
