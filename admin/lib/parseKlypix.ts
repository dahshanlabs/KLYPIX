// Parse a decrypted .klypix (or legacy .any) ZIP into a render-friendly shape.
//
// Two formats supported:
//   - v4 (.klypix): manifest.json + canvas.json + items/<prefix>/<id>.json + assets/
//   - v3 (.any legacy): single canvas.json with items inline + assets/<assetId>
//
// The web viewer doesn't need full editing fidelity — it strips unused fields
// (CRDT ops, sync metadata, layer registry) and only keeps what's renderable.

import JSZip from 'jszip';

export interface ParsedCanvas {
    title: string;
    view: { x: number; y: number; zoom: number };
    items: ParsedItem[];
    strokes: ParsedStroke[];
    lines: ParsedLine[];
    connections: ParsedConnection[];
    /** assetId or sha → blob URL. Call revokeAssetUrls when the viewer unmounts. */
    assetUrls: Record<string, string>;
    /** Format detected — useful for the UI to show. */
    formatLabel: string;
    /** Canvas-level visual settings captured by sender at save time. Optional
     *  because v3 files and pre-settings v4 files don't include them. */
    settings?: {
        background?: string;
        gridStyle?: 'dots' | 'lines' | 'off';
        gridColor?: string;
    };
}

export interface ParsedItem {
    id: string;
    type: string;
    x: number;
    y: number;
    w: number;
    h: number;
    zIndex: number;
    parentId: string | null;
    opacity?: number;
    // type-specific fields are kept as a loose bag so the renderer can pull
    // what it needs without forcing every type into this interface.
    [key: string]: unknown;
}

export interface ParsedStroke {
    id: string;
    points: { x: number; y: number; p?: number }[];
    color: string;
    size: number;
    parentId?: string | null;
}

export interface ParsedLine {
    id: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    color: string;
    thickness: number;
    arrowEnd?: boolean;
    arrowStart?: boolean;
    parentId?: string | null;
}

export interface ParsedConnection {
    id: string;
    fromItemId: string;
    toItemId: string;
    color?: string;
    thickness?: number;
    label?: string;
}

export type ParseError =
    | 'not-a-zip'
    | 'missing-canvas-json'
    | 'malformed-json'
    | 'unsupported-version';

export class KlypixParseError extends Error {
    constructor(public code: ParseError, message: string) {
        super(message);
    }
}

/**
 * Revoke all blob: URLs created by parseKlypix to free memory. Call when
 * unmounting the viewer or before loading a different canvas.
 */
export function revokeAssetUrls(urls: Record<string, string>): void {
    for (const url of Object.values(urls)) {
        try { URL.revokeObjectURL(url); } catch { /* no-op */ }
    }
}

export async function parseKlypix(bytes: Uint8Array): Promise<ParsedCanvas> {
    let zip: JSZip;
    try {
        // Cast to ArrayBuffer for JSZip's type signature
        zip = await JSZip.loadAsync(bytes as Uint8Array<ArrayBuffer>);
    } catch (e: any) {
        throw new KlypixParseError('not-a-zip', `Could not unzip: ${e?.message ?? e}`);
    }

    // ── Format detection ──────────────────────────────────────────────────
    // v4 has manifest.json at root. v3 doesn't.
    const manifestFile = zip.file('manifest.json');
    if (manifestFile) {
        return await parseV4(zip);
    }
    const canvasFile = zip.file('canvas.json');
    if (canvasFile) {
        return await parseV3(zip, canvasFile);
    }
    throw new KlypixParseError('missing-canvas-json', 'Neither manifest.json nor canvas.json found in archive');
}

// ── v4 parser ──────────────────────────────────────────────────────────

async function parseV4(zip: JSZip): Promise<ParsedCanvas> {
    const manifestText = await zip.file('manifest.json')!.async('string');
    const canvasFile = zip.file('canvas.json');
    if (!canvasFile) throw new KlypixParseError('missing-canvas-json', 'manifest present but canvas.json missing');
    const canvasText = await canvasFile.async('string');

    let manifest: any, canvasJson: any;
    try {
        manifest = JSON.parse(manifestText);
        canvasJson = JSON.parse(canvasText);
    } catch (e: any) {
        throw new KlypixParseError('malformed-json', `JSON parse: ${e?.message ?? e}`);
    }

    const positions: Record<string, any> = canvasJson.positions || {};
    const order: string[] = canvasJson.order || [];

    // Load each item's content file in parallel.
    const items: ParsedItem[] = [];
    await Promise.all(order.map(async (id, idx) => {
        const path = itemPathV4(id);
        const f = zip.file(path);
        if (!f) return; // item file missing — skip silently
        try {
            const content = JSON.parse(await f.async('string'));
            const pos = positions[id] || {};
            items.push({
                ...content,
                id,
                x: pos.x ?? 0,
                y: pos.y ?? 0,
                w: pos.w ?? 100,
                h: pos.h ?? 60,
                zIndex: pos.zIndex ?? idx,
                parentId: pos.parentId ?? null,
            });
        } catch { /* skip malformed item */ }
    }));

    // Re-sort items by their order in canvas.json (zKey/zIndex) so painter's
    // algorithm puts later items on top.
    items.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    const assetUrls = await extractAssetsV4(zip);

    const view = canvasJson.view || { x: 0, y: 0, zoom: 1 };
    const strokes = (canvasJson.strokes || []).map(normalizeStroke);
    const lines = (canvasJson.lines || []).map(normalizeLine);
    const connections = (canvasJson.connections || []).map(normalizeConnection);

    return {
        title: manifest.title || 'Untitled',
        view: { x: view.x || 0, y: view.y || 0, zoom: view.zoom || 1 },
        items,
        strokes,
        lines,
        connections,
        assetUrls,
        formatLabel: `.klypix v${manifest.version ?? 4}`,
        settings: canvasJson.settings || undefined,
    };
}

function itemPathV4(itemId: string): string {
    const hex = itemId.replace(/^[a-z]+[_:]/i, '').toLowerCase();
    const prefix = (hex.slice(0, 2) || '__').padStart(2, '_');
    return `items/${prefix}/${itemId}.json`;
}

async function extractAssetsV4(zip: JSZip): Promise<Record<string, string>> {
    const urls: Record<string, string> = {};
    const promises: Promise<void>[] = [];

    zip.forEach((relPath, file) => {
        if (file.dir) return;
        // v4 image asset paths: assets/images/<prefix>/<sha>.<ext>
        if (relPath.startsWith('assets/images/')) {
            promises.push((async () => {
                try {
                    const blob = await file.async('blob');
                    const url = URL.createObjectURL(blob);
                    // Items reference image assets via assetId === "sha256:<hex>"
                    // (v4 convention). The path is the sha; key the URL map by
                    // BOTH the bare sha and the prefixed form so renderer can
                    // look up either.
                    const filename = relPath.split('/').pop() || '';
                    const shaHex = filename.replace(/\.[^.]+$/, '');
                    urls[shaHex] = url;
                    urls[`sha256:${shaHex}`] = url;
                } catch { /* skip */ }
            })());
        }
    });
    await Promise.all(promises);
    return urls;
}

// ── v3 (legacy .any) parser ─────────────────────────────────────────────

async function parseV3(zip: JSZip, canvasFile: JSZip.JSZipObject): Promise<ParsedCanvas> {
    const text = await canvasFile.async('string');
    let doc: any;
    try { doc = JSON.parse(text); }
    catch (e: any) { throw new KlypixParseError('malformed-json', `JSON parse: ${e?.message ?? e}`); }

    const rawItems: any[] = doc.items || [];
    const items: ParsedItem[] = rawItems.map((it, idx) => ({
        ...it,
        zIndex: it.zIndex ?? idx,
        parentId: it.parentId ?? null,
    }));
    items.sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    const assetUrls = await extractAssetsV3(zip);

    const view = doc.view || { x: 0, y: 0, zoom: 1 };
    const strokes = (doc.strokes || []).map(normalizeStroke);
    const lines = (doc.lines || []).map(normalizeLine);
    const connections = (doc.connections || []).map(normalizeConnection);

    return {
        title: doc.title || 'Untitled',
        view: { x: view.x || 0, y: view.y || 0, zoom: view.zoom || 1 },
        items,
        strokes,
        lines,
        connections,
        assetUrls,
        formatLabel: `.any v${doc.version ?? 3} (legacy)`,
    };
}

async function extractAssetsV3(zip: JSZip): Promise<Record<string, string>> {
    const urls: Record<string, string> = {};
    const promises: Promise<void>[] = [];

    zip.forEach((relPath, file) => {
        if (file.dir) return;
        // v3 paths: assets/<assetId>  or  assets/<assetId>.<ext>
        if (relPath.startsWith('assets/') && !relPath.includes('/files/') && !relPath.includes('/thumbs/')) {
            promises.push((async () => {
                try {
                    const blob = await file.async('blob');
                    const url = URL.createObjectURL(blob);
                    // Key by both the bare filename (without extension) and
                    // with extension so image items can resolve either form.
                    const filename = relPath.replace('assets/', '');
                    const bare = filename.replace(/\.[^.]+$/, '');
                    urls[filename] = url;
                    urls[bare] = url;
                } catch { /* skip */ }
            })());
        }
    });
    await Promise.all(promises);
    return urls;
}

// ── Normalizers (defensive against missing fields in older files) ─────────

function normalizeStroke(s: any): ParsedStroke {
    return {
        id: s.id || randomId(),
        points: Array.isArray(s.points) ? s.points : [],
        color: s.color || '#10b981',
        size: typeof s.size === 'number' ? s.size : 2,
        parentId: s.parentId ?? null,
    };
}

function normalizeLine(l: any): ParsedLine {
    return {
        id: l.id || randomId(),
        x1: l.x1 ?? 0,
        y1: l.y1 ?? 0,
        x2: l.x2 ?? 0,
        y2: l.y2 ?? 0,
        color: l.color || '#ffffff',
        thickness: typeof l.thickness === 'number' ? l.thickness : 1.5,
        arrowEnd: !!l.arrowEnd,
        arrowStart: !!l.arrowStart,
        parentId: l.parentId ?? null,
    };
}

function normalizeConnection(c: any): ParsedConnection {
    return {
        id: c.id || randomId(),
        fromItemId: c.fromItemId || c.from || '',
        toItemId: c.toItemId || c.to || '',
        color: c.color,
        thickness: c.thickness,
        label: c.label,
    };
}

function randomId(): string {
    return 'a' + Math.random().toString(36).slice(2, 10);
}
