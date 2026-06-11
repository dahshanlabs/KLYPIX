// Recently closed canvases — session-scoped, in-memory only.
//
// Stores the serialized state of canvases the user closed in this run of the
// app so the launcher can offer a one-click undo. Unlike recentCanvasesStore
// (which is localStorage-backed and points at saved .klypix files), this
// list lives only as long as the process — quit + reopen drops everything.
//
// Why not persist? Two reasons:
//  1. The "Recent canvases" list already covers saved files across restarts.
//  2. Persisting full serialized state for unsaved canvases would bloat
//     localStorage fast (10 large canvases × MBs each) and the user's recent
//     state isn't ours to keep beyond the session.
//
// Asset bytes intentionally NOT snapshotted: the assetRegistry survives the
// tab close (it's a renderer-side Map), so as long as the same process is
// running, restoring deserializes successfully against the still-loaded
// assets. Cross-session restore is not a goal.

const MAX_ENTRIES = 10;

export interface ClosedCanvas {
    /** Unique id for this close event — used as the listener key. */
    id: string;
    /** Display name at close time (could be Untitled). */
    title: string;
    /** When the close happened. */
    closedAt: number;
    /** Original file path if the canvas was backed by a saved file. Null
     *  for never-saved Untitled canvases. */
    filePath: string | null;
    /** Serialized JSON of the canvas state at close time. Restored via
     *  the same deserialize() path as opening a .klypix file. */
    snapshotJson: string;
    /** Quick stats for the dashboard row (avoids a parse of snapshotJson
     *  just to show a count). */
    itemCount: number;
}

const queue: ClosedCanvas[] = [];
type Listener = (entries: ClosedCanvas[]) => void;
const listeners = new Set<Listener>();

function broadcast(): void {
    const snapshot = [...queue];
    for (const l of listeners) {
        try { l(snapshot); } catch { /* never break the broadcast */ }
    }
}

/** Push a newly-closed canvas to the head of the list. Cap to MAX_ENTRIES. */
export function pushClosedCanvas(entry: ClosedCanvas): void {
    // Same FILE closed again (reopen → close, or two tabs of one path): the
    // new snapshot supersedes — drop stale entries so the list never shows
    // duplicate rows for one canvas. Unsaved (null-path) entries are
    // genuinely distinct canvases and are all kept.
    if (entry.filePath) {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].filePath === entry.filePath) queue.splice(i, 1);
        }
    }
    queue.unshift(entry);
    if (queue.length > MAX_ENTRIES) queue.length = MAX_ENTRIES;
    broadcast();
}

/** Read the list in newest-first order. */
export function listClosedCanvases(): ClosedCanvas[] {
    return [...queue];
}

/** Remove an entry — used after a successful restore so the user can't
 *  re-trigger the same restore twice (which would create duplicate items
 *  in the destination canvas). */
export function consumeClosedCanvas(id: string): ClosedCanvas | null {
    const idx = queue.findIndex(e => e.id === id);
    if (idx < 0) return null;
    const [removed] = queue.splice(idx, 1);
    broadcast();
    return removed;
}

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeClosedCanvases(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}
