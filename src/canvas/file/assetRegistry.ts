// Renderer-side registry for binary canvas assets (image + file bytes).
//
// Why a singleton (not store state):
//   - Bytes / blob URLs are large and not part of the undo timeline. Putting
//     them in useReducer state would balloon every snapshot.
//   - Items reference assets by id; render is "look up by id, fall back to
//     legacy data URL". No re-render needed when the registry mutates because
//     entries are populated *before* the items that reference them are
//     dispatched into store state (drop handler awaits the registration; load
//     hydrates the registry before LOAD_FILE runs).
//
// Lifecycle:
//   - clear() on NEW_FILE / LOAD_FILE — we revoke blob URLs to avoid leaks.
//   - The .any ZIP's assets/<assetId>.<ext> path is rebuilt by serialize-time
//     callers; the registry only knows the id, mime, blob URL, and raw bytes.

let counter = 0;

export interface AssetEntry {
    id: string;
    mime: string;
    extension: string;        // lowercase, no dot ("png", "pdf")
    bytes: Uint8Array;        // canonical source — used to write to the ZIP on save
    blobUrl: string;          // for <img src> / fetch(); revoked on clear/replace
    fileName?: string;        // original filename if known (for display only)
}

const registry = new Map<string, AssetEntry>();

export function newAssetId(extension: string): string {
    counter += 1;
    const stem = `${Date.now().toString(36)}_${counter}`;
    return extension ? `${stem}.${extension.toLowerCase()}` : stem;
}

export function registerAsset(args: {
    id?: string;
    mime: string;
    extension: string;
    bytes: Uint8Array;
    fileName?: string;
}): AssetEntry {
    const id = args.id || newAssetId(args.extension);
    // If an entry with the same id exists, revoke its blob URL first.
    const existing = registry.get(id);
    if (existing) {
        try { URL.revokeObjectURL(existing.blobUrl); } catch { /* no-op */ }
    }
    const blob = new Blob([args.bytes as any], { type: args.mime });
    const blobUrl = URL.createObjectURL(blob);
    const entry: AssetEntry = {
        id,
        mime: args.mime,
        extension: args.extension.toLowerCase().replace(/^\./, ''),
        bytes: args.bytes,
        blobUrl,
        fileName: args.fileName,
    };
    registry.set(id, entry);
    return entry;
}

export function getAsset(id: string | undefined | null): AssetEntry | undefined {
    if (!id) return undefined;
    return registry.get(id);
}

export function listAssets(): AssetEntry[] {
    return Array.from(registry.values());
}

export function listAssetsForIds(ids: Iterable<string>): AssetEntry[] {
    const out: AssetEntry[] = [];
    for (const id of ids) {
        const entry = registry.get(id);
        if (entry) out.push(entry);
    }
    return out;
}

export function clearAssets(): void {
    for (const entry of registry.values()) {
        try { URL.revokeObjectURL(entry.blobUrl); } catch { /* no-op */ }
    }
    registry.clear();
}

// Lazy-load an asset from a .any file on disk. Used by future slices that
// migrate heavy item types (ImageItem/VideoItem/FileItem) off eager load —
// they'll skip their initial registerAsset() during LOAD_FILE and instead
// call this when the item actually mounts + needs bytes. Returns the
// hydrated AssetEntry, or null if the load fails. Already-hydrated assets
// short-circuit via getAsset() instead of re-reading from disk.
//
// This is spec §23 L1 scaffolding: the IPC + cache it rides on is
// already in place (`canvas:read-asset` + main-side JSZip cache); item
// components can opt into it incrementally without changing the overall
// load flow.
export async function readLazyAsset(args: {
    id: string;
    filePath: string;
    assetPath: string;
    fileName?: string;
}): Promise<AssetEntry | null> {
    const existing = registry.get(args.id);
    if (existing) return existing;
    const api: any = (globalThis as any).electron || (globalThis as any).window?.electron;
    const readAsset = api?.canvas?.readAsset || (globalThis as any).window?.electron?.canvas?.readAsset;
    if (!readAsset) return null;
    try {
        const res = await readAsset({ filePath: args.filePath, assetPath: args.assetPath });
        if (!res?.ok || !res.base64) return null;
        const bytes = base64ToBytes(res.base64);
        const dot = args.id.lastIndexOf('.');
        const extension = dot >= 0 ? args.id.slice(dot + 1) : '';
        return registerAsset({
            id: args.id,
            mime: res.mime || mimeFromExtension(extension),
            extension,
            bytes,
            fileName: args.fileName,
        });
    } catch { return null; }
}

// Per-tab cleanup: revoke/delete ONLY the given asset ids. Used by multi-tab
// flows so closing/reloading one tab doesn't trash assets the other tabs
// still reference. Unknown ids are silently ignored.
export function clearAssetsForIds(ids: Iterable<string>): void {
    for (const id of ids) {
        const entry = registry.get(id);
        if (!entry) continue;
        try { URL.revokeObjectURL(entry.blobUrl); } catch { /* no-op */ }
        registry.delete(id);
    }
}

// Helpers shared between drop and load paths.

export function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
    // Chunk to avoid call-stack limits on large buffers.
    const CHUNK = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as any);
    }
    return btoa(bin);
}

// Generate a downscaled JPEG thumbnail for an image. Used so a canvas full
// of images doesn't hold hundreds of MB of decoded full-resolution bitmaps
// in GPU memory at low zoom. Returns JPEG bytes; reuses the browser's
// canvas 2D compositor. Resolves with null on any failure — the caller just
// continues without a thumbnail.
export async function generateThumbnail(bytes: Uint8Array, mime: string, maxDim = 320): Promise<Uint8Array | null> {
    try {
        const blob = new Blob([bytes as any], { type: mime });
        const url = URL.createObjectURL(blob);
        try {
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
                const el = new Image();
                el.onload = () => resolve(el);
                el.onerror = () => reject(new Error('image decode failed'));
                el.src = url;
            });
            const nw = img.naturalWidth || img.width;
            const nh = img.naturalHeight || img.height;
            if (!nw || !nh) return null;
            const scale = Math.min(1, maxDim / Math.max(nw, nh));
            // If the image is already tiny, skip the thumbnail — no benefit.
            if (scale >= 1) return null;
            const tw = Math.max(1, Math.round(nw * scale));
            const th = Math.max(1, Math.round(nh * scale));
            const canvas = document.createElement('canvas');
            canvas.width = tw;
            canvas.height = th;
            const ctx = canvas.getContext('2d');
            if (!ctx) return null;
            ctx.drawImage(img, 0, 0, tw, th);
            return await new Promise<Uint8Array | null>((resolve) => {
                canvas.toBlob(async (b) => {
                    if (!b) { resolve(null); return; }
                    const buf = new Uint8Array(await b.arrayBuffer());
                    resolve(buf);
                }, 'image/jpeg', 0.75);
            });
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch { return null; }
}

export function mimeFromExtension(ext: string): string {
    const e = ext.toLowerCase().replace(/^\./, '');
    switch (e) {
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
