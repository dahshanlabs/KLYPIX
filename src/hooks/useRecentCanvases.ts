import { useEffect, useState } from 'react';
import { listRecentCanvases, subscribeRecentCanvases, type RecentCanvas } from '../canvas/dashboard/recentCanvasesStore';

/** Subscribe to the recent-canvases list. Re-renders the consumer whenever
 *  the list changes (canvas opened, saved, removed, thumbnail updated). */
export function useRecentCanvases(): RecentCanvas[] {
    const [entries, setEntries] = useState<RecentCanvas[]>(() => listRecentCanvases());
    useEffect(() => {
        // Re-read on mount in case the list changed between initial useState
        // (synchronous, runs before subscribe) and the subscription firing.
        setEntries(listRecentCanvases());
        return subscribeRecentCanvases((next) => {
            // Store dispatches the raw array; sort newest-first here so consumers
            // can render in iteration order without extra work.
            setEntries([...next].sort((a, b) => b.lastOpened - a.lastOpened));
        });
    }, []);
    return entries;
}
