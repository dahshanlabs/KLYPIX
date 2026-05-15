import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import JSZip from 'jszip';

// .klypix format v4 — main-process zip I/O.
//
// On-disk layout (see docs/KLYPIX_FORMAT_V2.md):
//   manifest.json              ← small index, parsed FIRST to detect format
//   canvas.json                ← spatial state (positions, connections, order)
//   items/<prefix>/<id>.json   ← per-item content, sharded by id prefix
//   assets/<assetId>           ← binary assets (Phase 1 keeps assetId-based;
//                                content-addressing is Phase 1.5)
//
// Why a separate handler from anyFileHandler.ts: v3 (.any) and v4 (.klypix)
// have fundamentally different on-disk layouts. Sharing one handler that
// branches everywhere would be a mess. Two clean handlers, dispatch picks
// one based on manifest detection at open time.

// ── Path conventions (must match src/canvas/file/klypixFormatV4.ts) ────

const MANIFEST_PATH = 'manifest.json';
const CANVAS_JSON_PATH = 'canvas.json';

function shardPrefix(idOrSha: string): string {
    const hex = idOrSha.replace(/^[a-z]+[_:]/i, '').toLowerCase();
    return hex.slice(0, 2).padStart(2, '_');
}

function itemPath(itemId: string): string {
    return `items/${shardPrefix(itemId)}/${itemId}.json`;
}

// ── Types — match the renderer-side shapes from klypixFormatV4.ts ──────

export interface KlypixAssetIn {
    /** Path inside the zip (e.g., "assets/<assetId>"). */
    path: string;
    /** Raw bytes (base64-encoded for IPC transport). */
    bytes: Buffer;
}

/** What the renderer hands over on save. */
export interface KlypixWritePayloadIn {
    /** JSON string for manifest.json. Already serialized by renderer. */
    manifestJson: string;
    /** JSON string for canvas.json. */
    canvasJson: string;
    /** Per-item JSON strings keyed by their in-zip path (items/<prefix>/<id>.json). */
    items: Record<string, string>;
    assets?: KlypixAssetIn[];
}

/** What main returns on load. */
export interface KlypixLoadResult {
    formatVersion: 'v4';
    /** Raw manifest.json contents — caller parses. */
    manifest: string;
    /** Raw canvas.json contents — caller parses. */
    canvasJson: string;
    /** Per-item JSON contents keyed by item id (renderer-friendly, NOT by path). */
    items: Record<string, string>;
    /** Asset paths inside the zip — informational. */
    assetPaths: string[];
    /** Eagerly-loaded asset bytes, base64 + mime, same shape as v3 loader. */
    assets: Array<{ path: string; base64: string; mime: string }>;
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

// ── Save ──────────────────────────────────────────────────────────────

/**
 * Write a .klypix file (v4 layout). Atomic: writes to .tmp, then renames.
 * Never corrupts the user's existing file mid-write.
 *
 * Phase 1.5 work item: incremental save — copy unchanged entries from
 * existing zip without re-compressing. For now: full rewrite every save
 * (still fast for canvases under ~100MB; we'll optimize when users hit it).
 */
export async function saveKlypixFile(filePath: string, payload: KlypixWritePayloadIn): Promise<void> {
    const zip = new JSZip();

    // Top-level metadata files. Deflate JSON — small wins on text payloads.
    zip.file(MANIFEST_PATH, payload.manifestJson);
    zip.file(CANVAS_JSON_PATH, payload.canvasJson);

    // Per-item content files, sharded into items/<prefix>/<id>.json.
    for (const [itemKey, itemBody] of Object.entries(payload.items)) {
        zip.file(itemKey, itemBody);
    }

    // Binary assets — stored as-is (most binaries are already compressed).
    if (payload.assets) {
        for (const asset of payload.assets) {
            zip.file(asset.path, asset.bytes);
        }
    }

    const buf = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
    });

    // Atomic rename: write to .tmp, fsync, rename. Prevents half-written files
    // if the process crashes or the disk runs out of space mid-write.
    const tmpPath = filePath + '.tmp';
    await fs.promises.writeFile(tmpPath, buf);
    await fs.promises.rename(tmpPath, filePath);
}

// ── Load ──────────────────────────────────────────────────────────────

/**
 * Read a .klypix file (v4 layout). Eager-loads everything for MVP correctness.
 *
 * Phase 1.5 work item: lazy load — return manifest + canvas.json eagerly,
 * but defer item content fetches until the renderer asks (viewport-aware).
 * yauzl will replace JSZip for the read path when that lands.
 */
export async function loadKlypixFile(filePath: string): Promise<KlypixLoadResult> {
    const buf = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(buf);

    const manifestEntry = zip.file(MANIFEST_PATH);
    if (!manifestEntry) throw new Error('Not a v4 .klypix file — missing manifest.json');
    const manifest = await manifestEntry.async('string');

    const canvasEntry = zip.file(CANVAS_JSON_PATH);
    if (!canvasEntry) throw new Error('Corrupt .klypix file — missing canvas.json');
    const canvasJson = await canvasEntry.async('string');

    const items: Record<string, string> = {};
    const assetPaths: string[] = [];
    const assetEntries: Array<{ path: string; entry: JSZip.JSZipObject }> = [];

    zip.forEach((relPath, entry) => {
        if (entry.dir) return;
        if (relPath.startsWith('items/') && relPath.endsWith('.json')) {
            // Recover the item id from the path: items/<prefix>/<id>.json
            const fileName = relPath.split('/').pop()!;
            const id = fileName.replace(/\.json$/i, '');
            // Store both raw content fetch promise and the id mapping.
            // We resolve the promise below so we can await all items concurrently.
            assetEntries.push({ path: relPath, entry });  // reused holder
            items[id] = '';                                // placeholder; filled in loop below
        } else if (relPath.startsWith('assets/')) {
            assetPaths.push(relPath);
            assetEntries.push({ path: relPath, entry });
        }
    });

    // Resolve all item + asset bodies in parallel.
    const bodies = await Promise.all(assetEntries.map(async (e) => {
        if (e.path.startsWith('items/') && e.path.endsWith('.json')) {
            const body = await e.entry.async('string');
            return { kind: 'item' as const, path: e.path, body };
        }
        const bytes = await e.entry.async('nodebuffer');
        return { kind: 'asset' as const, path: e.path, bytes };
    }));

    const assets: Array<{ path: string; base64: string; mime: string }> = [];
    for (const b of bodies) {
        if (b.kind === 'item') {
            const fileName = b.path.split('/').pop()!;
            const id = fileName.replace(/\.json$/i, '');
            items[id] = b.body;
        } else {
            assets.push({
                path: b.path,
                base64: b.bytes.toString('base64'),
                mime: mimeFromPath(b.path),
            });
        }
    }

    return {
        formatVersion: 'v4',
        manifest,
        canvasJson,
        items,
        assetPaths,
        assets,
    };
}

// ── Format detection ──────────────────────────────────────────────────

/**
 * Read just the manifest.json (if any) from a zip file to decide which codec
 * to use. Returns 'v4' if the file is a valid v4 .klypix, 'legacy' for any
 * older zip we should hand to the v3 (.any) reader, or 'unknown' if we can't
 * even open it as a zip.
 *
 * This is the dispatcher in the open path. Reads minimal bytes — full file
 * fetch already happened (JSZip needs the full buffer); the work is just
 * parsing one entry. When we move to yauzl streaming reads, this becomes
 * truly cheap (one zip-directory scan + one entry extraction).
 */
export async function detectKlypixFormat(filePath: string): Promise<'v4' | 'legacy' | 'unknown'> {
    try {
        const buf = await fs.promises.readFile(filePath);
        const zip = await JSZip.loadAsync(buf);
        const manifestEntry = zip.file(MANIFEST_PATH);
        if (!manifestEntry) return 'legacy';
        const text = await manifestEntry.async('string');
        try {
            const m = JSON.parse(text);
            if (m?.format === 'klypix' && typeof m?.version === 'number' && m.version >= 4) {
                return 'v4';
            }
        } catch {
            // bad manifest → treat as legacy and let the v3 reader try
        }
        return 'legacy';
    } catch {
        return 'unknown';
    }
}

// Silence unused-import warning from path/crypto if perf paths land later
void path;
void crypto;
