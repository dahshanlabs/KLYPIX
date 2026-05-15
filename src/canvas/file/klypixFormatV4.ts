// .klypix format v4 — per-item layout, content-addressed assets, manifest-first.
// Spec: docs/KLYPIX_FORMAT_V2.md
//
// This file is the RENDERER side: it converts CanvasState → a V4 payload that the
// main process writes to the .klypix zip. Reading is the inverse.
//
// Why renderer-side: CanvasState lives in the renderer; main process never sees
// React state. The renderer prepares the payload (a structured object); main
// process turns that into a zip on disk. Same split as the existing v3 path.

import type { CanvasState } from '../state/canvasStore';
import type { CanvasItem, Connection, DrawnLine, FreehandStroke, ViewState } from '../items/types';
import { getCurrentGridSettings, type GridSettings } from '../gridSettings';

// ── Constants ──────────────────────────────────────────────────────────

export const V4_FORMAT = 'klypix' as const;
export const V4_LAYOUT_VERSION = 4 as const;   // on-disk layout version (this file)
export const V4_SCHEMA_VERSION = 4 as const;   // canvas document version (covers items, connections, etc.)

// ── Path conventions inside the zip ───────────────────────────────────

/** First two hex chars of an id/sha — the directory shard. Bounds files-per-dir to ~256. */
function shardPrefix(idOrSha: string): string {
    // Strip "item_", "sha256:", or any other namespace prefix before hex.
    const hex = idOrSha.replace(/^[a-z]+[_:]/i, '').toLowerCase();
    return hex.slice(0, 2).padStart(2, '_');
}

/** items/<prefix>/<id>.json — per-item content path. */
export function itemPath(itemId: string): string {
    return `items/${shardPrefix(itemId)}/${itemId}.json`;
}

/** assets/files/<prefix>/<sha>.bin — content-addressed user-file asset path. */
export function fileAssetPath(sha: string): string {
    return `assets/files/${shardPrefix(sha)}/${sha}.bin`;
}

/** assets/images/<prefix>/<sha>.<ext> — content-addressed image asset path.
 *  Image extension is preserved so OS/renderer can dispatch without sniffing. */
export function imageAssetPath(sha: string, ext: string): string {
    const safeExt = ext.replace(/^\.+/, '').toLowerCase().slice(0, 8) || 'bin';
    return `assets/images/${shardPrefix(sha)}/${sha}.${safeExt}`;
}

/** assets/thumbs/<item-id>.png — dashboard thumbnail path. */
export function thumbPath(itemId: string): string {
    return `assets/thumbs/${itemId}.png`;
}

export const MANIFEST_PATH = 'manifest.json';
export const CANVAS_JSON_PATH = 'canvas.json';

// ── On-disk shapes ────────────────────────────────────────────────────

/** manifest.json — small index, read FIRST on canvas open. */
export interface KlypixManifest {
    format: typeof V4_FORMAT;
    /** Layout version. Bumped when the on-disk file structure changes. */
    version: number;
    /** Document/schema version. Bumped when canvas item shapes change. */
    schemaVersion: number;
    createdAt: string;
    updatedAt: string;
    title: string;
    stats: {
        itemCount: number;
        assetCount: number;
        /** Uncompressed total of declared content. Informational only — the actual
         *  on-disk .klypix size depends on compression. */
        totalBytes: number;
    };
    sync: {
        /** Whether this canvas is opted into cloud sync. */
        enabled: boolean;
        /** Cloud revision number — bumps server-side on each accepted save. */
        lastSyncRev: number | null;
        /** ISO timestamp of last successful sync, or null. */
        lastSyncAt: string | null;
        /** Stable per-device UUID for conflict attribution. Survives reinstall via localStorage. */
        deviceId: string;
    };
}

/** canvas.json — spatial state. Read AFTER manifest, before any item content. */
export interface KlypixCanvasJson {
    version: number;
    view: ViewState;
    order: string[];
    connections: Connection[];
    lines: DrawnLine[];
    strokes: FreehandStroke[];
    nextGroupNumber?: number;
    /** Per-item position-only data. Item *content* lives in items/<id>.json.
     *  Renderer can draw the full canvas frame layout from this alone, then
     *  lazy-load item content as items enter the viewport. */
    positions: Record<string, KlypixPosition>;
    /** Optional canvas-level settings captured at save time. Lets web viewer +
     *  any future device match the sender's visual context. Grid + background
     *  are otherwise device-local (live in localStorage), so without this the
     *  recipient sees their own theme on someone else's canvas. */
    settings?: {
        background?: string;
        gridStyle?: GridSettings['style'];
        gridColor?: string;
    };
}

/** Position-only data for one item — split out from item content for fast first-render. */
export interface KlypixPosition {
    x: number;
    y: number;
    w: number;
    h: number;
    /** Fractional sort key (e.g. "a0V"). Source of truth for z-order. */
    zKey?: string;
    /** Numeric stacking cache, kept in step with order[] index. */
    zIndex: number;
    /** Container parent id, or null at root level. */
    parentId: string | null;
}

/** Per-item content file. Everything about an item EXCEPT id (lives in path)
 *  and position (lives in canvas.json positions). Stripping `id` prevents
 *  the spread-order ambiguity when reconstructing the full CanvasItem. */
export type KlypixItemContent = Omit<CanvasItem, 'id' | 'x' | 'y' | 'w' | 'h' | 'zIndex' | 'zKey' | 'parentId'>;

// ── Payload the renderer hands to the main-process zip writer ─────────

/** Binary asset (file or image) with its content hash + intended in-zip path. */
export interface KlypixAssetPayload {
    /** Path inside the zip — already computed via fileAssetPath() / imageAssetPath(). */
    path: string;
    /** Raw bytes — for IPC, this gets base64'd at the boundary. */
    bytes: Uint8Array;
    /** Content hash (sha256 hex). Same value embedded in the path. */
    sha: string;
}

/** Complete V4 payload — everything needed to write a .klypix file. */
export interface KlypixWritePayload {
    manifest: KlypixManifest;
    canvasJson: KlypixCanvasJson;
    /** Per-item content keyed by path (items/<prefix>/<id>.json). */
    items: Record<string, KlypixItemContent>;
    /** Binary assets keyed by sha (caller can dedupe before writing). */
    assets: KlypixAssetPayload[];
}

// ── Serializer: CanvasState → KlypixWritePayload ──────────────────────

export interface SerializeOptions {
    title: string;
    /** Override the createdAt timestamp (loaded files preserve their original). */
    createdAt?: string;
    /** Stable per-device UUID. Read from localStorage by caller. */
    deviceId: string;
    /** Sync state from the in-memory canvas (carries forward across saves). */
    sync?: Partial<KlypixManifest['sync']>;
}

/**
 * Build a V4 write payload from the current canvas state.
 *
 * Does NOT touch disk or assets — those live elsewhere (in the asset registry).
 * The caller is responsible for collecting binary asset bytes and passing them
 * through; this function only emits the structural metadata.
 */
export function serializeV4(state: CanvasState, opts: SerializeOptions): KlypixWritePayload {
    const now = new Date().toISOString();
    const createdAt = opts.createdAt || now;

    // ── Build positions map + per-item content from state.items ──
    const positions: Record<string, KlypixPosition> = {};
    const items: Record<string, KlypixItemContent> = {};

    for (const id of state.order) {
        const it = state.items[id];
        if (!it) continue;

        positions[id] = {
            x: it.x,
            y: it.y,
            w: it.w,
            h: it.h,
            zKey: it.zKey,
            zIndex: it.zIndex,
            parentId: it.parentId,
        };

        // Strip id + position fields; everything else (content, metadata,
        // type-specific properties) goes into the per-item file. We use a
        // destructure-rest to keep this future-proof: when a new content field
        // is added to CanvasItem, it lands in `content` automatically with no
        // change here. id is omitted because it's already encoded in the path
        // (items/<prefix>/<id>.json) — storing it twice would invite drift.
        const { id: _id, x: _x, y: _y, w: _w, h: _h, zIndex: _zi, zKey: _zk, parentId: _pid, ...content } = it as any;
        items[itemPath(id)] = content as KlypixItemContent;
    }

    const grid = getCurrentGridSettings();
    const canvasJson: KlypixCanvasJson = {
        version: V4_SCHEMA_VERSION,
        view: state.view,
        order: [...state.order],
        connections: Object.values(state.connections),
        lines: Object.values(state.lines),
        strokes: Object.values(state.strokes),
        nextGroupNumber: state.nextGroupNumber,
        positions,
        settings: {
            background: grid.background,
            gridStyle: grid.style,
            gridColor: grid.color,
        },
    };

    // Asset payloads are collected by the caller (they need the asset registry
    // which is renderer-side state). This function declares the SHAPE; the
    // assets-collection step (in useAnyFile / save-as flow) populates them.
    const assets: KlypixAssetPayload[] = [];

    const manifest: KlypixManifest = {
        format: V4_FORMAT,
        version: V4_LAYOUT_VERSION,
        schemaVersion: V4_SCHEMA_VERSION,
        createdAt,
        updatedAt: now,
        title: opts.title,
        stats: {
            itemCount: state.order.length,
            assetCount: assets.length,            // populated after caller fills assets[]
            totalBytes: 0,                         // populated after caller fills assets[]
        },
        sync: {
            enabled: opts.sync?.enabled ?? false,
            lastSyncRev: opts.sync?.lastSyncRev ?? null,
            lastSyncAt: opts.sync?.lastSyncAt ?? null,
            deviceId: opts.deviceId,
        },
    };

    return { manifest, canvasJson, items, assets };
}

/**
 * Finalize a payload after the caller has added all asset bytes. Updates the
 * manifest stats so they reflect the real numbers. Returns the same payload
 * (mutated) for chaining convenience.
 */
export function finalizePayload(payload: KlypixWritePayload): KlypixWritePayload {
    payload.manifest.stats.assetCount = payload.assets.length;
    payload.manifest.stats.totalBytes = payload.assets.reduce((sum, a) => sum + a.bytes.length, 0)
        + JSON.stringify(payload.canvasJson).length
        + Object.values(payload.items).reduce((sum, it) => sum + JSON.stringify(it).length, 0)
        + JSON.stringify(payload.manifest).length;
    return payload;
}

// ── Format detection: is this a v4 .klypix or a legacy v1-v3 .any? ────

/**
 * Decide which codec to use based on the manifest (or its absence). Called by
 * the load path BEFORE any heavy work — we read just one entry from the zip
 * (manifest.json), parse, dispatch. Legacy .any files have no manifest.json;
 * they have canvas.json at the root with `version: 1|2|3`.
 */
export function detectFormatVersion(manifestText: string | null): 'v4' | 'legacy-v3' {
    if (!manifestText) return 'legacy-v3';
    try {
        const m = JSON.parse(manifestText);
        if (m?.format === V4_FORMAT && typeof m?.version === 'number' && m.version >= 4) {
            return 'v4';
        }
    } catch {
        // fall through to legacy
    }
    return 'legacy-v3';
}

// ── Deserializer skeleton ─────────────────────────────────────────────

/**
 * Read side of the V4 codec. The CALLER is responsible for fetching individual
 * zip entries (manifest.json, canvas.json, items/<id>.json on demand) — this
 * function just shapes them back into CanvasState.
 *
 * Lazy loading: the caller passes a `fetchItem` callback. For first render, it
 * returns null/undefined for items not yet loaded; the canvas renders empty
 * frames at their positions. The viewport-aware fetcher fills items in as they
 * become visible. For initial implementation, the caller can fetch all items
 * eagerly — same code path, just no lazy benefit.
 */
export interface DeserializeInput {
    manifest: KlypixManifest;
    canvasJson: KlypixCanvasJson;
    /** Called once per item id; may return a placeholder for not-yet-loaded items. */
    fetchItem: (itemId: string) => KlypixItemContent | undefined;
}

export function deserializeV4(input: DeserializeInput): {
    items: CanvasItem[];
    order: string[];
    connections: Connection[];
    lines: DrawnLine[];
    strokes: FreehandStroke[];
    view: ViewState;
    nextGroupNumber?: number;
    title: string;
} {
    const { manifest, canvasJson, fetchItem } = input;

    const items: CanvasItem[] = [];
    for (const id of canvasJson.order) {
        const pos = canvasJson.positions[id];
        if (!pos) continue; // canvas.json referenced an item not present in positions — skip defensively

        const content = fetchItem(id);
        if (!content) {
            // Not yet loaded. Emit a stub item with position only — the renderer
            // can draw a placeholder frame. When the viewport-aware loader fills
            // the content in, the reducer dispatches a hydrate action.
            items.push({
                id,
                type: 'text',         // placeholder type — overwritten on hydrate
                ...pos,
                locked: false,
                createdAt: Date.now(),
                createdBy: 'user',
                content: '',           // placeholder
            } as unknown as CanvasItem);
            continue;
        }

        items.push({
            id,
            ...content,
            ...pos,
        } as unknown as CanvasItem);
    }

    return {
        items,
        order: [...canvasJson.order],
        connections: canvasJson.connections,
        lines: canvasJson.lines,
        strokes: canvasJson.strokes,
        view: canvasJson.view,
        nextGroupNumber: canvasJson.nextGroupNumber,
        title: manifest.title,
    };
}
