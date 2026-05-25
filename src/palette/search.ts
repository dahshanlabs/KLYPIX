// Phase 23 — Fuse-backed fuzzy ranking with frecency.
//
// Providers supply pre-shaped PaletteResult arrays. The palette UI uses
// this module to:
//   1. Fuse-rank items WITHIN one provider that produced > 1 result for
//      the same query (some providers do their own ranking — they can
//      pass score=0 to opt out of re-ranking).
//   2. Merge results from multiple providers into one ranked list, using
//      score × (1 / frecencyBoost) as the composite rank.
//
// Why merge centrally: providers don't know about each other. The user
// experience is one ranked list — so we own the merge math.

import Fuse from 'fuse.js';
import type { PaletteResult, RankedResult } from './providers/types';
import { getBoost } from './frecency';

/** Fuse search inside ONE provider's result set. Use when a provider
 *  delivers a raw candidate pool and wants the palette to filter +
 *  rank by the query. Returns a new array; input is not mutated.
 *
 *  Searches both `title` and `subtitle` with title weighted 2× — a hit
 *  in the headline outranks a hit in the dim second line. */
export function fuzzyFilter(
    candidates: PaletteResult[],
    query: string,
    options?: { titleWeight?: number; subtitleWeight?: number; threshold?: number },
): PaletteResult[] {
    if (!query.trim()) return candidates;
    const fuse = new Fuse(candidates, {
        includeScore: true,
        // 0.0 = exact match only; 1.0 = matches anything. 0.4 is balanced.
        threshold: options?.threshold ?? 0.4,
        ignoreLocation: true,           // don't penalize matches deep in the string
        minMatchCharLength: 1,
        keys: [
            { name: 'title', weight: options?.titleWeight ?? 2 },
            { name: 'subtitle', weight: options?.subtitleWeight ?? 1 },
        ],
    });
    return fuse.search(query).map(r => ({
        ...r.item,
        score: r.score ?? 1,
    }));
}

/** Merge results from multiple providers into one ranked list.
 *  - `sourceWeight` lets us bump certain sources up or down across the
 *    whole result list (e.g. Klypix-native search ranks higher than web).
 *  - Frecency boost compresses repeat picks toward the top.
 *  - Stable tiebreaker on id so render order doesn't oscillate. */
export function mergeAndRank(
    bySource: Map<string, PaletteResult[]>,
    sourceWeight: Map<string, number>,
): RankedResult[] {
    const out: RankedResult[] = [];
    for (const [source, results] of bySource) {
        const sw = sourceWeight.get(source) ?? 1;
        for (const r of results) {
            const baseScore = r.score ?? 0.3;       // unknown-score default = mid-quality
            const boost = getBoost(r.id);
            // Lower rank = higher in list. sw < 1 promotes a source.
            const rank = (baseScore * sw) / boost;
            out.push({
                ...r,
                source,
                rank,
            });
        }
    }
    out.sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return out;
}

/** Boost factor for exact-prefix matches in the title. Applied after
 *  Fuse scoring so "calc" beats "calendar" when the user typed "calc".
 *  Returns a multiplier ≤ 1 (lower = better rank). */
export function exactPrefixBoost(title: string, query: string): number {
    if (!query) return 1;
    const t = title.toLowerCase();
    const q = query.toLowerCase();
    if (t === q) return 0.1;
    if (t.startsWith(q)) return 0.4;
    return 1;
}
