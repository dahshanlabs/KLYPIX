// Starred canvases — the user's pinned favorites, shown at the top of the
// dashboard so the canvases you live in are one click away regardless of how
// far they've fallen down the recents list.
//
// Deliberately MINIMAL + PURE: stores only an array of filePaths (the pins).
// Title/size/thumbnail are joined from recentCanvasesStore at render time, so
// there's no duplicated metadata to keep in sync and no risk of a circular
// import (this store never imports recentCanvasesStore — the join happens in
// the hook/component layer).

const STORAGE_KEY = 'klypix:starredCanvases';

type Listener = (paths: string[]) => void;
const listeners = new Set<Listener>();

function readAll(): string[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(p => typeof p === 'string') : [];
    } catch { return []; }
}

function writeAll(paths: string[]): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(paths));
    } catch {
        // Pins are tiny (just paths) so quota should never bite, but never throw.
    }
    for (const l of listeners) {
        try { l(paths); } catch { /* never break the broadcast */ }
    }
}

/** Current starred file paths (insertion order = star order). */
export function listStarred(): string[] {
    return readAll();
}

export function isStarred(filePath: string): boolean {
    return readAll().includes(filePath);
}

export function starCanvas(filePath: string): void {
    if (!filePath) return;
    const all = readAll();
    if (all.includes(filePath)) return;
    writeAll([...all, filePath]);
}

export function unstarCanvas(filePath: string): void {
    const all = readAll();
    if (!all.includes(filePath)) return;
    writeAll(all.filter(p => p !== filePath));
}

export function toggleStarred(filePath: string): void {
    if (!filePath) return;
    const all = readAll();
    writeAll(all.includes(filePath) ? all.filter(p => p !== filePath) : [...all, filePath]);
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeStarred(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}
