import { useEffect, useState } from 'react';
import { getEmbedSync, subscribeEmbedSync, type EmbedSyncState } from '../canvas/file/embedSyncStore';

/**
 * Subscribe to embed-sync state for one specific canvas item. When relPath is
 * passed, scopes to one leaf inside a folder card; otherwise to the item's
 * top-level asset slot. Re-renders only when THAT (item, relPath) state
 * changes — the global subscription is filtered before setState fires, so a
 * 50-item canvas doesn't repaint 49 items per sync event.
 */
export function useEmbedSync(itemId: string, relPath?: string): EmbedSyncState {
    const [state, setState] = useState<EmbedSyncState>(() => getEmbedSync(itemId, relPath));
    useEffect(() => {
        // Re-read on mount in case state changed between initial useState and
        // subscribe (rare but real on fast IPC).
        setState(getEmbedSync(itemId, relPath));
        return subscribeEmbedSync((id, s, leafPath) => {
            if (id === itemId && leafPath === relPath) setState(s);
        });
    }, [itemId, relPath]);
    return state;
}
