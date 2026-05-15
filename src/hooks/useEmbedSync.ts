import { useEffect, useState } from 'react';
import { getEmbedSync, subscribeEmbedSync, type EmbedSyncState } from '../canvas/file/embedSyncStore';

/**
 * Subscribe to embed-sync state for one specific canvas item. Re-renders only
 * when THAT item's state changes — the global subscription is filtered before
 * setState fires, so a 50-item canvas doesn't repaint 49 items per sync event.
 */
export function useEmbedSync(itemId: string): EmbedSyncState {
    const [state, setState] = useState<EmbedSyncState>(() => getEmbedSync(itemId));
    useEffect(() => {
        // Re-read on mount in case state changed between initial useState and
        // subscribe (rare but real on fast IPC).
        setState(getEmbedSync(itemId));
        return subscribeEmbedSync((id, s) => {
            if (id === itemId) setState(s);
        });
    }, [itemId]);
    return state;
}
