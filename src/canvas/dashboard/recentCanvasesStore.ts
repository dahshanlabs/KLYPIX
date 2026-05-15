// Recent canvases — the "your stuff" list that powers the dashboard.
//
// Local-first by design: backed by localStorage, no network, no account
// required. Each entry is a pointer to a .klypix file on disk plus the
// metadata we need to render a dashboard row without opening the file:
// title, last-opened time, size, thumbnail (deferred to a follow-up).
//
// This intentionally does NOT scan the user's disk for .klypix files —
// users add canvases by opening them through KLYPIX. That keeps the
// surface predictable and avoids the "where did this canvas come from?"
// confusion that file-finder approaches create.

const STORAGE_KEY = 'klypix:recentCanvases';
const MAX_ENTRIES = 50; // soft cap; older entries fall off the list

export interface RecentCanvas {
    filePath: string;
    title: string;
    /** ms epoch — most recent open or save event. */
    lastOpened: number;
    /** File size in bytes at the time we last touched it. */
    sizeBytes?: number;
    /** Base64 thumbnail PNG — populated by the thumbnail generator (deferred). */
    thumbnailDataUrl?: string;
}

type Listener = (entries: RecentCanvas[]) => void;
const listeners = new Set<Listener>();

function readAll(): RecentCanvas[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
}

function writeAll(entries: RecentCanvas[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (err) {
        // QuotaExceededError when thumbnails balloon — drop them and retry.
        console.warn('[recentCanvases] write failed, retrying without thumbnails:', err);
        try {
            const stripped = entries.map(e => ({ ...e, thumbnailDataUrl: undefined }));
            localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
        } catch {
            // Give up silently — the list will be rebuilt as the user opens files.
        }
    }
    for (const l of listeners) {
        try { l(entries); } catch { /* never break the broadcast */ }
    }
}

/** Current list, newest first. Direct read from localStorage. */
export function listRecentCanvases(): RecentCanvas[] {
    return readAll().sort((a, b) => b.lastOpened - a.lastOpened);
}

/**
 * Record that a canvas was opened or saved. If the file path is already
 * in the list, update its timestamp and metadata; otherwise prepend it.
 * Caps the list at MAX_ENTRIES — oldest fall off.
 */
export function recordCanvasAccess(args: {
    filePath: string;
    title: string;
    sizeBytes?: number;
}): void {
    if (!args.filePath) return;
    const all = readAll();
    const idx = all.findIndex(e => e.filePath === args.filePath);
    const now = Date.now();

    if (idx >= 0) {
        const existing = all[idx];
        all[idx] = {
            ...existing,
            title: args.title || existing.title,
            sizeBytes: args.sizeBytes ?? existing.sizeBytes,
            lastOpened: now,
        };
    } else {
        all.push({
            filePath: args.filePath,
            title: args.title || args.filePath.split(/[\\/]/).pop() || 'Untitled',
            sizeBytes: args.sizeBytes,
            lastOpened: now,
        });
    }

    // Trim oldest if over cap.
    if (all.length > MAX_ENTRIES) {
        all.sort((a, b) => b.lastOpened - a.lastOpened);
        all.length = MAX_ENTRIES;
    }
    writeAll(all);
}

/** Remove an entry — used when the user explicitly removes a canvas from
 *  the dashboard, OR when an open attempt errors with file-not-found. */
export function removeRecentCanvas(filePath: string): void {
    const all = readAll().filter(e => e.filePath !== filePath);
    writeAll(all);
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeRecentCanvases(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

/** Update the thumbnail for a canvas (separate from access to keep writes
 *  cheap — thumbnails are larger and don't change every open). */
export function setCanvasThumbnail(filePath: string, thumbnailDataUrl: string | undefined): void {
    const all = readAll();
    const idx = all.findIndex(e => e.filePath === filePath);
    if (idx < 0) return;
    all[idx] = { ...all[idx], thumbnailDataUrl };
    writeAll(all);
}
