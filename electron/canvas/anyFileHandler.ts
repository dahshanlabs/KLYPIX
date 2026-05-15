import * as fs from 'fs';
import * as crypto from 'crypto';
import JSZip from 'jszip';

// .any file I/O — runs in main process.
//
// Layout inside the ZIP (see docs/CLAUDE-KLYPIX-CANVAS.md §10):
//   canvas.json           ← state snapshot (items, connections, view, etc.)
//   assets/<a_name>       ← original binary files (Slice 4+)
//   thumbnails/<a_name>   ← generated previews (Slice 4+)
//   threads/<item_id>.json← chat threads per item (Slice 6+)
//
// Slice 3 only reads/writes canvas.json. Other folders are reserved — future
// slices append to them without changing the format.

export interface AnyAsset {
    path: string;          // path inside ZIP (e.g. "assets/a001_report.pdf")
    bytes: Buffer;
}

export interface SerializedCanvas {
    json: string;          // canvas.json contents (stringified doc)
    assets?: AnyAsset[];   // binary assets to embed
}

// On load we return both the asset paths (cheap, for indexing) and the bytes
// for entries under assets/ (eager hydration into the renderer registry).
// thumbnails/, threads/ etc. are listed in assetPaths but not auto-loaded —
// future slices will fetch those on demand.
export interface LoadedAsset {
    path: string;
    base64: string;
    mime: string;
}

export interface LoadedCanvas {
    json: string;
    assetPaths: string[];
    assets: LoadedAsset[];
}

function mimeFromPath(p: string): string {
    const idx = p.lastIndexOf('.');
    const ext = idx >= 0 ? p.slice(idx + 1).toLowerCase() : '';
    switch (ext) {
        case 'png': return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'gif': return 'image/gif';
        case 'webp': return 'image/webp';
        case 'bmp': return 'image/bmp';
        case 'svg': return 'image/svg+xml';
        case 'pdf': return 'application/pdf';
        case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        case 'xls': return 'application/vnd.ms-excel';
        case 'csv': return 'text/csv';
        case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'doc': return 'application/msword';
        case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        case 'ppt': return 'application/vnd.ms-powerpoint';
        case 'txt': return 'text/plain';
        case 'json': return 'application/json';
        default: return 'application/octet-stream';
    }
}

// Retain up to this many version snapshots inside the .any. One entry is
// appended per save; older entries rotate out.
const MAX_VERSIONS = 20;

// Sidecar manifest file that lets us skip re-compressing assets that didn't
// change since the last save (perf §23 L11). Shape:
//   { [assetPath]: "sha1hex" }
// Written to `_manifest.json` inside the ZIP. Only `assets/*` entries are
// tracked — canvas.json changes every save so it's not worth hashing.
const MANIFEST_PATH = '_manifest.json';

function sha1(bytes: Buffer | Uint8Array): string {
    return crypto.createHash('sha1').update(bytes as any).digest('hex');
}

export async function saveAnyFile(filePath: string, payload: SerializedCanvas): Promise<void> {
    // Incremental save strategy (perf §23 L11):
    //   - If an existing .any is present, load it and reuse untouched entries.
    //     JSZip retains the cached compressed bytes for entries we DON'T replace,
    //     so the total cost scales with "how many things changed" not file size.
    //   - Assets whose sha1 matches the stored manifest are left in place.
    //   - Everything else (canvas.json + dirty assets + new version entry) gets
    //     replaced, triggering recompression only for those entries.
    //   - Assets that disappeared from the incoming payload are removed.
    //
    // Cold start (no existing file): fall through to the old "rebuild from scratch"
    // path since there's nothing to reuse.

    let zip: JSZip;
    let priorManifest: Record<string, string> = {};
    const incomingAssetPaths = new Set((payload.assets || []).map(a => a.path));
    const incomingHashes: Record<string, string> = {};
    for (const a of payload.assets || []) incomingHashes[a.path] = sha1(a.bytes);

    const hasExisting = fs.existsSync(filePath);
    if (hasExisting) {
        try {
            zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
            const manifestEntry = zip.file(MANIFEST_PATH);
            if (manifestEntry) {
                try { priorManifest = JSON.parse(await manifestEntry.async('string')); }
                catch { priorManifest = {}; }
            }
            // Drop assets the caller didn't include this time (a delete on the
            // canvas shrinks the saved file).
            const toRemove: string[] = [];
            zip.forEach((relPath, entry) => {
                if (entry.dir) return;
                if (!relPath.startsWith('assets/')) return;
                if (!incomingAssetPaths.has(relPath)) toRemove.push(relPath);
            });
            for (const p of toRemove) zip.remove(p);
        } catch {
            // Corrupt existing zip — start clean.
            zip = new JSZip();
            priorManifest = {};
        }
    } else {
        zip = new JSZip();
    }

    // Canvas.json always changes — replace unconditionally.
    zip.file('canvas.json', payload.json);

    // Assets: only touch the ones whose hash differs from the manifest.
    if (payload.assets) {
        for (const a of payload.assets) {
            const priorHash = priorManifest[a.path];
            const newHash = incomingHashes[a.path];
            if (priorHash && priorHash === newHash && zip.file(a.path)) {
                // Unchanged — leave the cached compressed blob alone.
                continue;
            }
            zip.file(a.path, a.bytes);
        }
    }

    // Write the refreshed manifest.
    zip.file(MANIFEST_PATH, JSON.stringify(incomingHashes));

    // Version rotation: prune oldest to keep under MAX_VERSIONS - 1 slots,
    // then add today's snapshot. We operate directly on the loaded zip so we
    // don't re-extract the old version bodies just to re-insert them.
    const versionPaths: string[] = [];
    zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        if (relPath.startsWith('versions/')) versionPaths.push(relPath);
    });
    versionPaths.sort((a, b) => a.localeCompare(b));
    const keepCount = Math.max(0, MAX_VERSIONS - 1);
    const toDropCount = Math.max(0, versionPaths.length - keepCount);
    for (let i = 0; i < toDropCount; i++) zip.remove(versionPaths[i]);

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    zip.file(`versions/${ts}.json`, payload.json);

    const buf = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });
    await fs.promises.writeFile(filePath, buf);
    // Invalidate the cache; the next read will reload with the new mtime.
    // We don't bother keeping the in-memory zip because save builds a fresh
    // one each call — easier to reload on next read than to guarantee
    // in-memory parity with what was just written.
    anyZipCache.delete(filePath);
}

// Enumerate version snapshots stored inside a .any file. Returns paths +
// ISO timestamps sorted newest-first.
export async function listAnyVersions(filePath: string): Promise<Array<{ path: string; timestamp: string }>> {
    try {
        if (!fs.existsSync(filePath)) return [];
        const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
        const out: Array<{ path: string; timestamp: string }> = [];
        zip.forEach((relPath, entry) => {
            if (entry.dir) return;
            if (!relPath.startsWith('versions/')) return;
            // versions/2026-04-16T10-15-22-123Z.json → reconstruct the iso.
            const stem = relPath.replace(/^versions\//, '').replace(/\.json$/, '');
            // Restore the colons/period we replaced at save time so the
            // renderer can render a readable date.
            const iso = stem
                .replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, 'T$1:$2.$3Z')
                .replace(/T(\d{2})-/, 'T$1:')
                .replace(/-(\d{2})(\.\d{3})?Z$/, ':$1$2Z');
            out.push({ path: relPath, timestamp: iso });
        });
        out.sort((a, b) => b.path.localeCompare(a.path));
        return out;
    } catch {
        return [];
    }
}

export async function loadAnyVersion(filePath: string, versionPath: string): Promise<string | null> {
    try {
        if (!fs.existsSync(filePath)) return null;
        const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
        const entry = zip.file(versionPath);
        if (!entry) return null;
        return await entry.async('string');
    } catch {
        return null;
    }
}

// ── Lazy asset extraction (spec §23 L1/L4) ─────────────────────────────────
//
// JSZip instances are kept alive per filePath so subsequent `readAssetBytes`
// calls don't re-parse the ZIP on every asset lookup. The cache is keyed by
// path + mtime: if the file changed on disk (e.g. another tab saved), we
// reload. Eviction is best-effort — closing a tab drops the cache entry.
//
// Why this layer exists even without a full lazy-load on the renderer side
// yet: it's the foundation for L4 (viewport-driven extract+evict). Any item
// type can call `canvas:read-asset(filePath, assetPath)` to pull a single
// asset without redoing the full `loadAnyFile` work. Also used internally by
// save flow to copy through unchanged assets without having to carry their
// bytes from the renderer.

interface ZipCacheEntry {
    zip: JSZip;
    mtimeMs: number;
    filePath: string;
}

const anyZipCache = new Map<string, ZipCacheEntry>();

async function getCachedZip(filePath: string): Promise<JSZip | null> {
    try {
        const stat = await fs.promises.stat(filePath);
        const cached = anyZipCache.get(filePath);
        if (cached && cached.mtimeMs === stat.mtimeMs) return cached.zip;
        // (Re)load — file is new, missing from cache, or changed on disk.
        const data = await fs.promises.readFile(filePath);
        const zip = await JSZip.loadAsync(data);
        anyZipCache.set(filePath, { zip, mtimeMs: stat.mtimeMs, filePath });
        return zip;
    } catch {
        return null;
    }
}

export function evictZipCache(filePath: string): void {
    anyZipCache.delete(filePath);
}

export function evictAllZipCaches(): void {
    anyZipCache.clear();
}

// Read a single asset entry from a cached .any file. Returns null if the
// file or entry doesn't exist. Decoding is deferred to the caller (usually
// wants base64 for IPC transport).
export async function readAssetBytes(filePath: string, assetPath: string): Promise<Buffer | null> {
    const zip = await getCachedZip(filePath);
    if (!zip) return null;
    const entry = zip.file(assetPath);
    if (!entry) return null;
    try {
        const ab = await entry.async('nodebuffer');
        return ab;
    } catch {
        return null;
    }
}

export async function loadAnyFile(filePath: string): Promise<LoadedCanvas> {
    const data = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(data);
    // Populate the cache so subsequent per-asset reads don't re-parse.
    try {
        const stat = await fs.promises.stat(filePath);
        anyZipCache.set(filePath, { zip, mtimeMs: stat.mtimeMs, filePath });
    } catch { /* non-fatal */ }

    const canvasEntry = zip.file('canvas.json');
    if (!canvasEntry) {
        throw new Error('Not a valid .any file: missing canvas.json');
    }
    const json = await canvasEntry.async('string');

    // Enumerate asset paths and eagerly load bytes for entries under assets/.
    // Other top-level folders (thumbnails/, threads/, replay/) are listed but
    // their bytes are loaded lazily by future slices.
    const assetPaths: string[] = [];
    const assetEntries: Array<{ path: string; entry: JSZip.JSZipObject }> = [];
    zip.forEach((relativePath, entry) => {
        if (entry.dir || relativePath === 'canvas.json' || relativePath === MANIFEST_PATH) return;
        assetPaths.push(relativePath);
        if (relativePath.startsWith('assets/')) {
            assetEntries.push({ path: relativePath, entry });
        }
    });

    const assets: LoadedAsset[] = await Promise.all(
        assetEntries.map(async ({ path: p, entry }) => {
            const b64 = await entry.async('base64');
            return { path: p, base64: b64, mime: mimeFromPath(p) };
        }),
    );

    return { json, assetPaths, assets };
}
