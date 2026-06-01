import { useEffect, useRef, useState } from 'react';
import { listRecentCanvases, subscribeRecentCanvases } from '../canvas/dashboard/recentCanvasesStore';
import { buildVaultTagIndex, type VaultTagIndex } from '../canvas/dashboard/vaultTagIndex';

// Module-level singleton so reopening the dashboard reuses the last index
// instead of re-reading files. A recents change only marks the index STALE
// (bumps staleGen); the rebuild happens on the NEXT dashboard open — never on
// every autosave (which would thrash), never inside React render.
let cached: VaultTagIndex | null = null;
let staleGen = 0;   // bumped whenever recents change
let builtGen = -1;  // staleGen value the cached index was built at
let subscribed = false;

function ensureStalenessSub() {
    if (subscribed) return;
    subscribed = true;
    subscribeRecentCanvases(() => { staleGen++; });
}

/**
 * Lazy-once vault tag index. Builds exactly once per (active-open while stale),
 * aborts on close/unmount. Returns sorted tag counts + a tag→paths map for
 * O(1) client-side filtering. `active` must be true only while the dashboard
 * is actually shown.
 */
export function useVaultTags({ active }: { active: boolean }) {
    const [index, setIndex] = useState<VaultTagIndex | null>(cached);
    const [loading, setLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => { ensureStalenessSub(); }, []);

    useEffect(() => {
        if (!active) { abortRef.current?.abort(); return; }
        // Reuse the cached index if it's still fresh.
        if (cached && builtGen === staleGen) { setIndex(cached); return; }
        const ac = new AbortController();
        abortRef.current = ac;
        const gen = staleGen;
        setLoading(true);
        buildVaultTagIndex(listRecentCanvases(), ac.signal)
            .then(idx => {
                if (ac.signal.aborted) return;
                cached = idx; builtGen = gen;
                setIndex(idx); setLoading(false);
            })
            .catch(() => { if (!ac.signal.aborted) setLoading(false); });
        return () => ac.abort();
    }, [active]);

    return {
        tags: index?.tagCounts ?? [],
        tagToPaths: index?.tagToPaths ?? new Map<string, Set<string>>(),
        loading,
    };
}
