// Canvas provider for the Command Palette — quick-switcher + global search.
//
// Two jobs in one provider (they share the recent-canvases list):
//   • Switcher (B1): empty state + name/path matches → jump between your
//     .klypix / .any canvases like VSCode's Ctrl+P.
//   • Global search (B2): once you type 2+ chars, also searches INSIDE every
//     recent canvas — card text, titles, and #tags — so you can find a note
//     by its content, not just its filename, and open the canvas it lives in.
//
// Prefix 'canvas:' routes the query here exclusively (Ctrl+O opens with it).
// Content is read lazily via readFileBytes + klypixBytesToBrief and cached by
// (path, lastOpened) so we parse each file at most once until it's re-touched.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { LayoutGrid, Search } from 'lucide-react';
import React from 'react';
import { listRecentCanvases, type RecentCanvas } from '../../canvas/dashboard/recentCanvasesStore';
import { getOrIndexCanvas } from './vaultIndexCache';

const MAX_SWITCHER = 8;
const MAX_CONTENT_HITS = 12;
const HITS_PER_CANVAS = 2;
const MAX_INDEXED = 15; // only content-search the most recent N canvases

function fileName(p: string): string { return p.replace(/^.*[\\/]/, ''); }

function ageLabel(ms: number): string {
    const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (sec < 60) return 'just now';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `${hr}h ago`;
    const day = Math.round(hr / 24);
    if (day < 30) return `${day}d ago`;
    return `${Math.round(day / 30)}mo ago`;
}

// The app (App.tsx onOpenCanvas) listens for this and queues the open via the
// canvas surface's drain — the same path the dashboard uses.
function openCanvas(filePath: string) {
    window.dispatchEvent(new CustomEvent('klypix:palette-open-canvas', { detail: { filePath } }));
}

function switcherResult(c: RecentCanvas): PaletteResult {
    return {
        id: `canvas:file:${c.filePath}`,
        title: c.title || fileName(c.filePath),
        subtitle: `${fileName(c.filePath)} · ${ageLabel(c.lastOpened)}`,
        accent: '#10b981',
        icon: React.createElement(LayoutGrid, { size: 14 }),
        primaryAction: { label: 'Open canvas', handler: () => openCanvas(c.filePath) },
    };
}

// Content indexing now lives in ./vaultIndexCache (shared with the dashboard
// vault tag index) so each .klypix is parsed at most once across both.

// Vault-folder scan, cached briefly — lets the switcher find ANY canvas in the
// user's vault by name (not just ones already opened), VSCode/Obsidian-style.
let vaultCache: { ts: number; list: RecentCanvas[] } | null = null;
async function getVaultCanvases(): Promise<RecentCanvas[]> {
    if (vaultCache && Date.now() - vaultCache.ts < 8000) return vaultCache.list;
    try {
        const raw: Array<{ filePath: string; mtimeMs: number }> = await (window as any).electron?.vault?.listCanvases?.();
        const list: RecentCanvas[] = Array.isArray(raw)
            ? raw.map(r => ({ filePath: r.filePath, title: fileName(r.filePath).replace(/\.(klypix|any)$/i, ''), lastOpened: r.mtimeMs || 0 }))
            : [];
        vaultCache = { ts: Date.now(), list };
        return list;
    } catch { return vaultCache?.list || []; }
}

/** Recents ∪ vault-folder canvases, deduped (recents win — they carry the real
 *  title + last-opened time). */
async function getAllCanvases(): Promise<RecentCanvas[]> {
    const recents = listRecentCanvases();
    const seen = new Set(recents.map(r => r.filePath));
    const vault = (await getVaultCanvases()).filter(v => !seen.has(v.filePath));
    return [...recents, ...vault];
}

function snippet(text: string, at: number, qlen: number): string {
    const start = Math.max(0, at - 24);
    const end = Math.min(text.length, at + qlen + 36);
    return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

export const canvasProvider: PaletteProvider = {
    id: 'canvas',
    prefix: 'canvas:',
    weight: 40, // canvases rank above generic file/web hits

    emptyState() {
        return listRecentCanvases().slice(0, MAX_SWITCHER).map(switcherResult);
    },

    async query(input: string, ctx: PaletteProviderContext): Promise<PaletteResult[]> {
        const q = input.trim().toLowerCase();
        if (!q) return listRecentCanvases().slice(0, MAX_SWITCHER).map(switcherResult);

        // Search recents AND every canvas in the vault folder — so a canvas is
        // findable by name even if it's never been opened.
        const all = await getAllCanvases();
        if (ctx.signal.aborted) return [];

        // 1. name / filename matches (the switcher)
        const nameHits = all.filter(c =>
            (c.title || '').toLowerCase().includes(q) || fileName(c.filePath).toLowerCase().includes(q)).slice(0, 12);
        const matchedPaths = new Set(nameHits.map(c => c.filePath));
        const results: PaletteResult[] = nameHits.map(switcherResult);

        // 2. content search across the OTHER canvases (needs 2+ chars). Only the
        // first MAX_INDEXED are read so a big vault doesn't turn a keystroke
        // into hundreds of file reads (the shared cache makes repeats free).
        if (q.length < 2) return results;
        const entries = await Promise.all(all.slice(0, MAX_INDEXED).map(c => getOrIndexCanvas(c, ctx.signal)));
        if (ctx.signal.aborted) return results;

        let total = 0;
        for (const entry of entries) {
            if (!entry || matchedPaths.has(entry.filePath) || total >= MAX_CONTENT_HITS) continue;
            let perCanvas = 0;
            for (const card of entry.cards) {
                if (perCanvas >= HITS_PER_CANVAS || total >= MAX_CONTENT_HITS) break;
                const hay = `${card.title} ${card.text} ${card.tags.map(t => '#' + t).join(' ')}`.toLowerCase();
                const at = hay.indexOf(q);
                if (at < 0) continue;
                results.push({
                    id: `canvas:card:${entry.filePath}:${card.id}`,
                    title: card.title || '(untitled card)',
                    subtitle: `in ${entry.title} · ${snippet(`${card.title} ${card.text}`, at, q.length)}`,
                    accent: '#8b9cff',
                    icon: React.createElement(Search, { size: 14 }),
                    primaryAction: { label: 'Open canvas', handler: () => openCanvas(entry.filePath) },
                });
                perCanvas++; total++;
            }
        }
        return results;
    },
};
