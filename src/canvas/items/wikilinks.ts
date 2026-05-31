// Wikilinks (2026-05-31, Obsidian comfort layer step 1).
//
// `[[Card Title]]` inside a text card becomes a clickable link to the card
// whose TITLE matches "Card Title". A card's title = the first non-empty
// line of its text content (trimmed). Matching is case-insensitive.
//
// These links also drive the auto-graph: CanvasRenderer derives a dashed
// connection line from each card to every card it links to. The edges are
// COMPUTED from content (never stored / synced) so they always reflect the
// current text and don't pollute user-drawn connections.
//
// Why first-line-as-title (not a separate title field): zero schema churn,
// matches how people already write cards (a heading line), and keeps the
// link target visible/editable. A future explicit-title field can layer on.

import type { CanvasItem } from './types';

// [[Anything but brackets]]. Captures the inner title. Global for scanning.
export const WIKILINK_REGEX = /\[\[([^[\]]+)\]\]/g;

// #tag — '#' at start-of-text or after whitespace, FIRST char a letter (so
// hex colors like #10b981 and bare numbers #123 don't match), then word
// chars / hyphens. The leading boundary is a non-capturing group so the
// match start can be re-derived. Linear-time (no nested quantifiers) → no
// ReDoS risk.
export const TAG_REGEX = /(^|\s)(#[a-zA-Z][\w-]*)/g;

/** Extract #tags from text (without the leading '#'), de-duplicated
 *  case-insensitively (first-seen casing preserved). */
export function extractTags(content: string | undefined | null): string[] {
    if (!content) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    TAG_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TAG_REGEX.exec(content)) !== null) {
        const tag = m[2].slice(1); // drop '#'
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    return out;
}

/** All item ids whose text contains the given tag (case-insensitive). */
export function findCardsWithTag(items: Record<string, CanvasItem>, tag: string): string[] {
    const want = tag.trim().toLowerCase();
    if (!want) return [];
    const ids: string[] = [];
    for (const id in items) {
        const it = items[id];
        if ((it as any).type !== 'text') continue;
        if (extractTags((it as any).content).some(t => t.toLowerCase() === want)) ids.push(id);
    }
    return ids;
}

/** All distinct tags across the canvas with their card counts, sorted by
 *  count desc then name. Powers a future tag-filter sidebar. */
export function computeTagCounts(items: Record<string, CanvasItem>): Array<{ tag: string; count: number }> {
    const counts = new Map<string, { tag: string; count: number }>();
    for (const id in items) {
        const it = items[id];
        if ((it as any).type !== 'text') continue;
        for (const tag of extractTags((it as any).content)) {
            const key = tag.toLowerCase();
            const cur = counts.get(key);
            if (cur) cur.count++;
            else counts.set(key, { tag, count: 1 });
        }
    }
    return Array.from(counts.values()).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Backlinks: all item ids that link TO the given target via [[Title]],
 *  where the target's title matches. Computed from current content. */
export function computeBacklinks(items: Record<string, CanvasItem>, targetId: string): string[] {
    const target = items[targetId];
    if (!target) return [];
    const title = cardTitle(target);
    if (!title) return [];
    const want = title.toLowerCase();
    const out: string[] = [];
    for (const id in items) {
        if (id === targetId) continue;
        const it = items[id];
        if ((it as any).type !== 'text') continue;
        if (extractWikilinks((it as any).content).some(t => t.toLowerCase() === want)) out.push(id);
    }
    return out;
}

/** Extract the link titles from a piece of text, trimmed + de-duplicated
 *  (case-insensitively, preserving first-seen casing). */
export function extractWikilinks(content: string | undefined | null): string[] {
    if (!content) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    WIKILINK_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_REGEX.exec(content)) !== null) {
        const title = m[1].trim();
        if (!title) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(title);
    }
    return out;
}

/** A card's title for link-matching: first non-empty line of a text item's
 *  content, trimmed. Non-text items (or empty ones) have no title. */
export function cardTitle(item: CanvasItem): string | null {
    if (!item || (item as any).type !== 'text') return null;
    const content: string = (item as any).content ?? '';
    for (const rawLine of content.split('\n')) {
        const line = rawLine.trim();
        if (line) {
            // Strip a leading list/heading prefix so "• Foo" / "# Foo" still
            // titles as "Foo" (matches what a user would type in [[Foo]]).
            return line.replace(/^([#>\-*•]+\s+|\d+\.\s+)/, '').trim() || line;
        }
    }
    return null;
}

/** Build a lower-cased title → itemId index over all items. When two cards
 *  share a title, the FIRST in iteration order wins (stable enough; a future
 *  disambiguation UI can improve this). */
export function buildTitleIndex(items: Record<string, CanvasItem>): Map<string, string> {
    const index = new Map<string, string>();
    for (const id in items) {
        const t = cardTitle(items[id]);
        if (!t) continue;
        const key = t.toLowerCase();
        if (!index.has(key)) index.set(key, id);
    }
    return index;
}

/** Resolve a single wikilink title to an item id, or null if no card has
 *  that title. */
export function resolveWikilink(title: string, index: Map<string, string>): string | null {
    return index.get(title.trim().toLowerCase()) ?? null;
}

/** Derived link edges for the whole canvas: for every text item, each
 *  wikilink it contains that resolves to another card becomes a
 *  {fromId, toId, title} edge. Self-links and unresolved links are skipped. */
export interface WikilinkEdge { fromId: string; toId: string; title: string; }
export function computeWikilinkEdges(items: Record<string, CanvasItem>): WikilinkEdge[] {
    const index = buildTitleIndex(items);
    const edges: WikilinkEdge[] = [];
    const seen = new Set<string>();
    for (const id in items) {
        const it = items[id];
        if ((it as any).type !== 'text') continue;
        const titles = extractWikilinks((it as any).content);
        for (const title of titles) {
            const toId = resolveWikilink(title, index);
            if (!toId || toId === id) continue;
            const key = `${id}->${toId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push({ fromId: id, toId, title });
        }
    }
    return edges;
}
