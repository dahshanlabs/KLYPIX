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

// Decode/inflate/parse is synchronous main-thread work (base64 → ZIP inflate →
// JSON.parse). Firing all 25 at once saturated the thread in one burst and
// janked the launcher (shimmer + scroll stuttered). We process in small
// batches and YIELD to the event loop between them so a paint can happen — the
// thread breathes, the shimmer animates, and chips fill in waves.
const BATCH_SIZE = 4;
// setTimeout(0) (a macrotask), not a microtask: a microtask flush wouldn't let
// the compositor paint between batches, which is the whole point.
const yieldToPaint = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export interface VaultTagIndex {
    built: number;
    /** Tags sorted by count desc, then name asc. `tag` is original case. */
    tagCounts: Array<{ tag: string; count: number }>;
    /** lowercased-tag → set of canvas filePaths containing it. */
    tagToPaths: Map<string, Set<string>>;
}

/**
 * Build the vault tag index in main-thread-friendly batches.
 *
 * `onProgress` (optional) is called with a fresh snapshot after EACH batch, so
 * the dashboard can fill chips in waves while the rest decode. The returned
 * promise resolves with the final, complete index (same shape as a snapshot).
 */
export async function buildVaultTagIndex(
    recents: RecentCanvas[],
    signal: AbortSignal,
    onProgress?: (partial: VaultTagIndex) => void,
): Promise<VaultTagIndex> {
    const slice = recents.slice(0, MAX_TAG_INDEXED);
    const map = new Map<string, { tag: string; count: number; paths: Set<string> }>();
    let built = 0;

    const snapshot = (): VaultTagIndex => {
        const tagCounts = [...map.values()]
            .map(e => ({ tag: e.tag, count: e.count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
        const tagToPaths = new Map([...map.entries()].map(([k, e]) => [k, e.paths] as const));
        return { built, tagCounts, tagToPaths };
    };

    for (let i = 0; i < slice.length; i += BATCH_SIZE) {
        if (signal.aborted) break;
        // Within a batch the decodes overlap (I/O), but we cap concurrency so
        // the synchronous inflate/parse work can't pile up past BATCH_SIZE.
        const entries = await Promise.all(slice.slice(i, i + BATCH_SIZE).map(c => getOrIndexCanvas(c, signal)));
        if (signal.aborted) break;
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
        // Emit a partial so chips appear in waves, then let the thread paint
        // before the next decode burst (skip the yield after the last batch).
        onProgress?.(snapshot());
        if (i + BATCH_SIZE < slice.length) await yieldToPaint();
    }

    return snapshot();
}
