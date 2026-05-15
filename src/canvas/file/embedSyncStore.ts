// Per-item embed sync state — module-level pub-sub. Subscribed via the
// useEmbedSync hook so FileItem.tsx (and any other item that grows embed
// behavior later) can render a sync badge without prop-drilling.
//
// Mirrors the narrationStore pattern: simple Map + subscriber set, no React,
// works from anywhere. Main process drives state changes via the
// canvas:embed:sync-state IPC event; we listen once at module load and fan
// out to all subscribers.

export type EmbedSyncStatus = 'idle' | 'syncing' | 'synced' | 'error';

export interface EmbedSyncState {
    status: EmbedSyncStatus;
    /** When this state was set (ms epoch). Lets the UI auto-fade a "synced ✓"
     *  back to idle after a few seconds without coordinated cleanup. */
    at: number;
    error?: string;
    /** Local working-file path on disk. Useful for "show in folder" actions
     *  later, and for cleanup when the item is removed. */
    workingPath?: string;
}

type Listener = (itemId: string, state: EmbedSyncState) => void;

const states = new Map<string, EmbedSyncState>();
const listeners = new Set<Listener>();

/** Get current state for an item, or 'idle' if no embed activity yet. */
export function getEmbedSync(itemId: string): EmbedSyncState {
    return states.get(itemId) || { status: 'idle', at: 0 };
}

/** Update an item's sync state. Notifies all subscribers synchronously. */
export function setEmbedSync(itemId: string, partial: Partial<EmbedSyncState> & { status: EmbedSyncStatus }): void {
    const prev = states.get(itemId) || { status: 'idle' as const, at: 0 };
    const next: EmbedSyncState = { ...prev, ...partial, at: Date.now() };
    states.set(itemId, next);
    for (const l of listeners) {
        try { l(itemId, next); } catch { /* never let a bad listener stop the broadcast */ }
    }
}

/** Subscribe to ALL embed-sync events. Returns an unsubscribe function.
 *  For per-item subscription use the useEmbedSync hook. */
export function subscribeEmbedSync(l: Listener): () => void {
    listeners.add(l);
    return () => { listeners.delete(l); };
}

// ── Wire to main-process events ──
// Main emits canvas:embed:sync-state via webContents.send. We listen once and
// translate into store updates. If preload isn't ready yet (rare race), we
// retry on the next microtask — onEmbedSyncState is registered as soon as
// possible so subsequent events flow through.

function wireMainEvents(): void {
    const api = (window as any).electron?.canvas;
    if (!api?.onEmbedSyncState) {
        // Preload not ready yet; try again shortly. Capped retries to avoid
        // an infinite loop in environments without electron (web build).
        let attempts = 0;
        const id = setInterval(() => {
            attempts++;
            const a = (window as any).electron?.canvas;
            if (a?.onEmbedSyncState) {
                clearInterval(id);
                a.onEmbedSyncState((evt: any) => {
                    setEmbedSync(evt.itemId, { status: evt.kind, error: evt.error });
                });
            } else if (attempts > 20) {
                clearInterval(id);  // ~10s, give up silently
            }
        }, 500);
        return;
    }
    api.onEmbedSyncState((evt: any) => {
        setEmbedSync(evt.itemId, { status: evt.kind, error: evt.error });
    });
}

if (typeof window !== 'undefined') {
    wireMainEvents();
}
