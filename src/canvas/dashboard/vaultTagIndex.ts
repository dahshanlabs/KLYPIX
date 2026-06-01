// Vault-wide #tag index — aggregates the #tags across the user's recent
// canvases so the dashboard can show a tag-filter chip row. Pure + async; no
// React, no localStorage. Reads each canvas through the SHARED vaultIndexCache
// (the same cache the palette search uses), so a tag rebuild costs zero extra
// file reads for canvases already parsed.

import type { RecentCanvas } from './recentCanvasesStore';
import { getOrIndexCanvas } from '../../palette/providers/vaultIndexCache';

// Bound the work: only the most-recent N canvases are tag-indexed (history cap
// is 50). Keeps a cold rebuild to a few hundred ms, parallelized + abortable.
const MAX_TAG_INDEXED = 25;

export interface VaultTagIndex {
    built: number;
    /** Tags sorted by count desc, then name asc. `tag` is original case. */
    tagCounts: Array<{ tag: string; count: number }>;
    /** lowercased-tag → set of canvas filePaths containing it. */
    tagToPaths: Map<string, Set<string>>;
}

export async function buildVaultTagIndex(recents: RecentCanvas[], signal: AbortSignal): Promise<VaultTagIndex> {
    const entries = await Promise.all(
        recents.slice(0, MAX_TAG_INDEXED).map(c => getOrIndexCanvas(c, signal)),
    );
    const map = new Map<string, { tag: string; count: number; paths: Set<string> }>();
    let built = 0;
    for (const entry of entries) {
        if (!entry) continue;
        built++;
        for (const card of entry.cards) {
            for (const raw of (card.tags || [])) {
                const key = raw.toLowerCase();
                let e = map.get(key);
                if (!e) { e = { tag: raw, count: 0, paths: new Set() }; map.set(key, e); }
                e.count++;
                e.paths.add(entry.filePath);
            }
        }
    }
    const tagCounts = [...map.values()]
        .map(e => ({ tag: e.tag, count: e.count }))
        .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    const tagToPaths = new Map([...map.entries()].map(([k, e]) => [k, e.paths] as const));
    return { built, tagCounts, tagToPaths };
}
