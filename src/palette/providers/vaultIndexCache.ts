// Shared lazy index of canvas CONTENT, cached by (filePath, lastOpened).
//
// Extracted so the Command Palette's canvas search AND the dashboard's vault
// tag index parse each .klypix at most once until its lastOpened changes — one
// cache, one set of file reads. The (filePath, lastOpened) key IS the
// per-file invalidation: re-saving a canvas bumps lastOpened (via
// recordCanvasAccess), so the next read re-parses; nothing else needed.

import type { RecentCanvas } from '../../canvas/dashboard/recentCanvasesStore';
import { klypixBytesToBrief, type KlypixCard } from '../../canvas/file/klypixBrief';

export interface IndexEntry {
    filePath: string;
    title: string;
    cards: KlypixCard[];
}

const fileName = (p: string) => p.replace(/^.*[\\/]/, '');

const cache = new Map<string, { lastOpened: number; entry: IndexEntry }>();

/** Parse a canvas's content (cards/tags/links), reusing the cache. Images are
 *  skipped (skipImages) since callers only need text. Returns null for an
 *  unreadable/non-canvas file or if the query was aborted. */
export async function getOrIndexCanvas(c: RecentCanvas, signal: AbortSignal): Promise<IndexEntry | null> {
    const hit = cache.get(c.filePath);
    if (hit && hit.lastOpened === c.lastOpened) return hit.entry;
    try {
        const r: any = await (window as any).electron?.readFileBytes?.(c.filePath);
        if (signal.aborted || !r?.success || !r.base64) return null;
        const u8 = Uint8Array.from(atob(r.base64), ch => ch.charCodeAt(0));
        const brief = await klypixBytesToBrief(u8, fileName(c.filePath), { skipImages: true });
        const entry: IndexEntry = { filePath: c.filePath, title: brief.title || c.title || fileName(c.filePath), cards: brief.cards };
        cache.set(c.filePath, { lastOpened: c.lastOpened, entry });
        return entry;
    } catch {
        return null;
    }
}
