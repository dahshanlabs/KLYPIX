import { useEffect, useState } from 'react';
import { listClosedCanvases, subscribeClosedCanvases, type ClosedCanvas } from '../canvas/dashboard/recentlyClosedStore';

/** React hook over the recently-closed module store. Re-renders when an
 *  entry is added or consumed. Session-scoped — empty on first app launch. */
export function useRecentlyClosed(): ClosedCanvas[] {
    const [entries, setEntries] = useState<ClosedCanvas[]>(() => listClosedCanvases());
    useEffect(() => {
        return subscribeClosedCanvases(setEntries);
    }, []);
    return entries;
}
