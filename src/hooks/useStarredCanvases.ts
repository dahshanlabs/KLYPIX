import { useEffect, useState } from 'react';
import { listStarred, subscribeStarred } from '../canvas/dashboard/starredCanvasesStore';

/** Subscribe to the starred file-path list (pins only). The join to full
 *  RecentCanvas metadata happens in the dashboard, keeping this hook and the
 *  store free of cross-store imports. */
export function useStarredCanvases(): string[] {
    const [paths, setPaths] = useState<string[]>(() => listStarred());
    useEffect(() => {
        setPaths(listStarred()); // re-read in case it changed before subscribe
        return subscribeStarred((next) => setPaths([...next]));
    }, []);
    return paths;
}
