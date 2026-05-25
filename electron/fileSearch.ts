// Phase 23 Day 5 — File search for the palette Files provider.
//
// Walks an allow-listed set of root directories (Desktop, Documents,
// Downloads by default) up to a configurable depth, filters by filename
// substring, returns the top N matches. Uses Node's fs (not PowerShell)
// for portability and to avoid the ~300ms PS spawn on every query.
//
// Tradeoffs:
//   - Walk happens per-query but is cancelable via AbortSignal so a fast
//     typist doesn't pile up parallel walks.
//   - Cached results: the most recent (root, depth, query) tuple's result
//     stays in main-process memory for 30s. Beyond that we re-walk.
//   - Allow-listed roots only. Users can extend via Settings (future);
//     for v1 we just default to the three biggest user-content folders.

import { app, ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAX_DEPTH = 3;
const MAX_RESULTS = 30;
const CACHE_TTL_MS = 30_000;

interface FileMatch {
    name: string;
    path: string;
    isDirectory: boolean;
    modifiedAt: number;
}

let cache: { key: string; results: FileMatch[]; cachedAt: number } | null = null;
let inFlight: AbortController | null = null;

function getRoots(): string[] {
    // app.getPath('desktop' / 'documents' / 'downloads') is the cross-locale
    // safe way to get these — works on non-English Windows installs where
    // the actual folder names are localized.
    const out: string[] = [];
    try { out.push(app.getPath('desktop')); } catch { /* not available */ }
    try { out.push(app.getPath('documents')); } catch { /* not available */ }
    try { out.push(app.getPath('downloads')); } catch { /* not available */ }
    return out;
}

// Folders to skip walking — they're either system files or massive node_modules
// trees that would dominate the results without being useful.
const SKIP_DIRS = new Set([
    'node_modules', '.git', '.next', '.cache', 'dist', 'build',
    '$RECYCLE.BIN', 'System Volume Information',
]);

async function walk(root: string, query: string, signal: AbortSignal, depth: number, out: FileMatch[]): Promise<void> {
    if (signal.aborted) return;
    if (depth > MAX_DEPTH) return;
    if (out.length >= MAX_RESULTS) return;
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(root, { withFileTypes: true });
    } catch {
        return;
    }
    const q = query.toLowerCase();
    for (const ent of entries) {
        if (signal.aborted) return;
        if (out.length >= MAX_RESULTS) return;
        if (ent.name.startsWith('.')) continue;          // hidden files
        if (SKIP_DIRS.has(ent.name)) continue;
        const full = path.join(root, ent.name);
        const lcName = ent.name.toLowerCase();
        if (lcName.includes(q)) {
            try {
                const stat = await fs.promises.stat(full);
                out.push({
                    name: ent.name,
                    path: full,
                    isDirectory: ent.isDirectory(),
                    modifiedAt: stat.mtimeMs,
                });
            } catch { /* permission denied, skip */ }
        }
        if (ent.isDirectory()) {
            await walk(full, query, signal, depth + 1, out);
        }
    }
}

export function registerFileSearchIpc(): void {
    ipcMain.handle('file-search:query', async (_e, args: { query: string }) => {
        const query = (args?.query ?? '').trim();
        if (query.length < 2) return [];        // avoid walking the whole tree on '.'
        const key = `q:${query.toLowerCase()}`;
        if (cache && cache.key === key && Date.now() - cache.cachedAt < CACHE_TTL_MS) {
            return cache.results;
        }
        // Cancel any in-flight walk; only the latest query matters.
        if (inFlight) inFlight.abort();
        inFlight = new AbortController();
        const signal = inFlight.signal;
        const out: FileMatch[] = [];
        for (const root of getRoots()) {
            if (signal.aborted) break;
            try { await walk(root, query, signal, 0, out); } catch { /* ignore root-level errors */ }
            if (out.length >= MAX_RESULTS) break;
        }
        out.sort((a, b) => b.modifiedAt - a.modifiedAt);
        const trimmed = out.slice(0, MAX_RESULTS);
        cache = { key, results: trimmed, cachedAt: Date.now() };
        return trimmed;
    });
    ipcMain.handle('file-search:open', async (_e, filePath: string) => {
        const { shell } = await import('electron');
        try { shell.openPath(filePath); return true; } catch { return false; }
    });
    ipcMain.handle('file-search:reveal', async (_e, filePath: string) => {
        const { shell } = await import('electron');
        try { shell.showItemInFolder(filePath); return true; } catch { return false; }
    });
}
