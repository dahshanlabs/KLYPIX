// Phase 23 Day 5 — Web provider.
//
// Three behaviors keyed on query shape:
//   1. URL-looking input ('example.com', 'https://...', 'localhost:3000'):
//      surface "Open https://example.com" as the top result; Enter opens
//      in the user's default browser via shell.openExternal.
//   2. Otherwise: a "Search the web for X" row at lower priority so it
//      doesn't interrupt better-matched providers. Opens Google.
//   3. Inline answer card: if the first token looks like a single-word
//      noun (no operators, no spaces), fetch Wikipedia summary via the
//      anonymous REST API. Cached for 7 days. Result shows the summary
//      under a "Wikipedia · <title>" subtitle.
//
// The Wikipedia fetch is a STREAMING result: the row appears immediately
// with pending:true, then re-yields once the fetch resolves. Aligns with
// the AsyncIterable contract from Day 1 paletteStore.

import type { PaletteProvider, PaletteResult, PaletteProviderContext } from './types';
import { Globe, BookOpen, Search } from 'lucide-react';
import React from 'react';

function looksLikeUrl(input: string): string | null {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    // domain-ish: ends in a known tld OR has dots and no spaces
    if (/^[\w.-]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(trimmed) && !/\s/.test(trimmed)) {
        return 'https://' + trimmed;
    }
    if (/^localhost(:\d+)?(\/.*)?$/i.test(trimmed)) {
        return 'http://' + trimmed;
    }
    return null;
}

function openExternal(url: string): void {
    const bridge: any = (window as any).electron;
    if (bridge?.openExternal) {
        try { bridge.openExternal(url); return; } catch { /* fallthrough */ }
    }
    try { window.open(url, '_blank'); } catch { /* swallow */ }
}

// Wikipedia summary cache. Stored in localStorage keyed by the EXACT
// lowercased query — re-typing the same word skips the network call.
const WIKI_CACHE_KEY = 'klypix:palette:wikiCache:v1';
const WIKI_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface WikiEntry { title: string; extract: string; url: string; fetchedAt: number }

function loadWikiCache(): Record<string, WikiEntry> {
    try {
        const raw = localStorage.getItem(WIKI_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') return parsed;
        }
    } catch { /* fall through */ }
    return {};
}
function saveWikiCache(c: Record<string, WikiEntry>): void {
    try {
        // Cap at 100 entries; drop oldest.
        const entries = Object.entries(c);
        if (entries.length > 100) {
            entries.sort((a, b) => b[1].fetchedAt - a[1].fetchedAt);
            c = Object.fromEntries(entries.slice(0, 100));
        }
        localStorage.setItem(WIKI_CACHE_KEY, JSON.stringify(c));
    } catch { /* quota */ }
}

async function fetchWiki(term: string, signal: AbortSignal): Promise<WikiEntry | null> {
    const cache = loadWikiCache();
    const key = term.toLowerCase().trim();
    const cached = cache[key];
    if (cached && Date.now() - cached.fetchedAt < WIKI_TTL_MS) return cached;
    try {
        const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}?redirect=true`;
        const res = await fetch(url, { signal });
        if (!res.ok) return null;
        const data: any = await res.json();
        if (!data || data.type === 'disambiguation' || !data.extract) return null;
        const entry: WikiEntry = {
            title: data.title || term,
            extract: data.extract,
            url: data.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(data.title || term)}`,
            fetchedAt: Date.now(),
        };
        cache[key] = entry;
        saveWikiCache(cache);
        return entry;
    } catch {
        return null;
    }
}

export const webProvider: PaletteProvider = {
    id: 'web',
    weight: 1.4,

    async * query(input: string, ctx: PaletteProviderContext): AsyncIterable<PaletteResult[]> {
        const q = input.trim();
        if (q.length === 0) { yield []; return; }

        const results: PaletteResult[] = [];

        // 1. URL → "Open" row
        const url = looksLikeUrl(q);
        if (url) {
            results.push({
                id: `web:url:${url}`,
                title: `Open ${url}`,
                subtitle: 'Launches in your default browser',
                accent: '#3b82f6',
                icon: React.createElement(Globe, { size: 14 }),
                score: 0.05,
                primaryAction: {
                    label: 'Open',
                    handler: () => openExternal(url),
                },
            });
        }

        // 2. "Search the web for ..." — only when length >= 3, otherwise
        //    appears for every single character typed.
        if (q.length >= 3 && !url) {
            const search = `https://www.google.com/search?q=${encodeURIComponent(q)}`;
            results.push({
                id: `web:search:${q.toLowerCase()}`,
                title: `Search the web for "${q}"`,
                subtitle: 'Opens Google in your default browser',
                accent: '#9ca3af',
                icon: React.createElement(Search, { size: 14 }),
                score: 0.6,
                primaryAction: {
                    label: 'Search',
                    handler: () => openExternal(search),
                },
            });
        }

        // Yield the synchronous part FIRST so the user sees URL/Search rows
        // immediately, then the Wikipedia row streams in if it resolves.
        yield results.slice();

        // 3. Wikipedia inline answer — only for "term-shaped" queries
        //    (single word OR a few words, no operators).
        const isTermShaped = q.length >= 3 && /^[\p{L}\p{N}][\p{L}\p{N}\s'-]{1,40}$/u.test(q);
        if (!isTermShaped) return;

        const wiki = await fetchWiki(q, ctx.signal);
        if (ctx.signal.aborted || !wiki) return;
        results.push({
            id: `web:wiki:${wiki.title}`,
            title: wiki.title,
            subtitle: wiki.extract.slice(0, 160),
            accent: '#a855f7',
            icon: React.createElement(BookOpen, { size: 14 }),
            score: 0.35,                 // ranks above generic web search, below URL
            primaryAction: {
                label: 'Open on Wikipedia',
                handler: () => openExternal(wiki.url),
            },
            secondaryActions: [
                {
                    label: 'Copy summary',
                    chord: 'Shift+Enter',
                    handler: async () => {
                        try { await navigator.clipboard.writeText(wiki.extract); } catch { /* swallow */ }
                    },
                },
            ],
        });
        yield results.slice();
    },
};
