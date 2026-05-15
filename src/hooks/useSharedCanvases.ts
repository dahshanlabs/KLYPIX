// Hook that returns the list of canvases the current user is a collaborator
// on (not owner). Backed by canvas-cloud:list-shared IPC, which queries
// canvas_collaborators joined to canvas_blobs.
//
// Re-fetches on mount and on a manual `refresh()` call. There's no realtime
// subscription yet — that arrives with the full sync engine. For now,
// closing + reopening the dashboard picks up new invitations.

import { useCallback, useEffect, useState } from 'react';

export interface SharedCanvas {
    blob_id: string;
    role: 'editor';
    accepted_at: string;
    canvas_blobs: {
        title_hint: string | null;
        byte_size: number;
        updated_at: string;
    } | null;
}

interface UseSharedCanvasesResult {
    canvases: SharedCanvas[];
    loading: boolean;
    error: string | null;
    refresh: () => void;
}

export function useSharedCanvases(): UseSharedCanvasesResult {
    const [canvases, setCanvases] = useState<SharedCanvas[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick(t => t + 1), []);

    useEffect(() => {
        let cancelled = false;
        const bridge: any = (window as any).electron?.cloud;
        if (!bridge?.listShared) {
            setLoading(false);
            setError('Cloud IPC unavailable (preload bridge missing)');
            return;
        }
        setLoading(true);
        setError(null);
        bridge.listShared()
            .then((rows: any) => {
                if (cancelled) return;
                setCanvases(Array.isArray(rows) ? rows as SharedCanvas[] : []);
                setLoading(false);
            })
            .catch((e: any) => {
                if (cancelled) return;
                // Swallow auth-required + missing-table gracefully — these
                // happen for unauthenticated users / projects without the
                // canvas_collaborators migration applied. Surface only as a
                // small error string instead of crashing the dashboard.
                const msg = e?.message || String(e);
                if (/CLOUD_AUTH_REQUIRED|sign[-\s]?in/i.test(msg)) {
                    setCanvases([]);
                } else {
                    setError(msg);
                }
                setLoading(false);
            });
        return () => { cancelled = true; };
    }, [tick]);

    return { canvases, loading, error, refresh };
}
