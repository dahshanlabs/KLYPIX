// Canvas sync operation types — the wire format between clients.
//
// Each canvas mutation gets serialized as one of these ops, pushed to
// Supabase's canvas_ops table, and broadcast to other clients via Realtime
// or polling. Receiving clients replay the op against their local store.
//
// Design:
//   - Coarse-grained ops, not per-field. "item.update" carries a patch object
//     rather than one op per changed field — keeps the op log small and
//     replay deterministic.
//   - Self-contained: no op references state not in the payload. Replay can
//     run on a canvas that's missing context.
//   - Versioned via the v field. Bump when the op shape evolves; older
//     clients can skip ops with higher versions instead of crashing.

export type CanvasOp =
    | ItemCreateOp
    | ItemUpdateOp
    | ItemDeleteOp
    | StrokeCreateOp
    | LineCreateOp
    | LineUpdateOp
    | LineDeleteOp
    | ConnectionCreateOp
    | ConnectionDeleteOp
    | ViewUpdateOp;

interface BaseOp {
    /** Op-shape schema version. Increment when fields change. */
    v: 1;
    type: string;
    /** Client-side timestamp (ms). Server's created_at is the source of
     *  truth for ordering; this is informational. */
    ts: number;
}

export interface ItemCreateOp extends BaseOp {
    type: 'item.create';
    id: string;
    /** The full item shape — replay just dispatches ADD_ITEM with this. */
    item: Record<string, unknown>;
}

export interface ItemUpdateOp extends BaseOp {
    type: 'item.update';
    id: string;
    /** Partial item — fields to overwrite. */
    patch: Record<string, unknown>;
}

export interface ItemDeleteOp extends BaseOp {
    type: 'item.delete';
    id: string;
}

export interface StrokeCreateOp extends BaseOp {
    type: 'stroke.create';
    id: string;
    stroke: Record<string, unknown>;
}

export interface LineCreateOp extends BaseOp {
    type: 'line.create';
    id: string;
    line: Record<string, unknown>;
}

export interface LineUpdateOp extends BaseOp {
    type: 'line.update';
    id: string;
    patch: Record<string, unknown>;
}

export interface LineDeleteOp extends BaseOp {
    type: 'line.delete';
    id: string;
}

export interface ConnectionCreateOp extends BaseOp {
    type: 'connection.create';
    id: string;
    connection: Record<string, unknown>;
}

export interface ConnectionDeleteOp extends BaseOp {
    type: 'connection.delete';
    id: string;
}

export interface ViewUpdateOp extends BaseOp {
    type: 'view.update';
    view: { x: number; y: number; zoom: number };
}

// ── Wire envelope (what main.ts sends/receives) ──────────────────────────

export interface CanvasOpRow {
    seq: number;
    blob_id: string;
    author_id: string;
    device_id: string;
    op: CanvasOp;
    created_at: string;
}

// ── Stable per-device id ─────────────────────────────────────────────────

const DEVICE_ID_KEY = 'klypix:device-id';

/** Stable per-device UUID. Persists in localStorage so the same browser /
 *  Electron install reuses it across restarts. */
export function getDeviceId(): string {
    try {
        const existing = localStorage.getItem(DEVICE_ID_KEY);
        if (existing) return existing;
        const fresh = crypto.randomUUID();
        localStorage.setItem(DEVICE_ID_KEY, fresh);
        return fresh;
    } catch {
        // localStorage unavailable (server-side render?) — return a throwaway
        return crypto.randomUUID();
    }
}
