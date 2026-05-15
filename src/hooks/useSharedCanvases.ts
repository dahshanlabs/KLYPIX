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
    /** Canvas decryption key, copied from the invitation on accept. Null if
     *  the inviter didn't include it (legacy invitations or share-by-URL
     *  upgrades) — UI should disable "Open" in that case. */
    key_b64: string | null;
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
    /** Remove the current user from a shared canvas (the recipient-side
     *  "leave"). Optimistically removes the row from local state; on
     *  failure the row is restored and the error is surfaced via window.alert
     *  to keep the call site simple. */
    leave: (blobId: string) => Promise<void>;
}

export function useSharedCanvases(): UseSharedCanvasesResult {
    const [canvases, setCanvases] = useState<SharedCanvas[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick(t => t + 1), []);

    const leave = useCallback(async (blobId: string) => {
        const bridge: any = (window as any).electron?.cloud;
        if (!bridge?.leaveShared) {
            window.alert('Cloud IPC unavailable — cannot leave canvas.');
            return;
        }
        // Optimistic remove so the dashboard updates instantly. Snapshot the
        // previous row so we can restore on failure.
        let snapshot: SharedCanvas | undefined;
        setCanvases(prev => {
            snapshot = prev.find(c => c.blob_id === blobId);
            return prev.filter(c => c.blob_id !== blobId);
        });
        try {
            await bridge.leaveShared(blobId);
        } catch (e: any) {
            if (snapshot) setCanvases(prev => [snapshot!, ...prev]);
            window.alert(`Couldn't leave canvas: ${e?.message || String(e)}`);
        }
    }, []);

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

    return { canvases, loading, error, refresh, leave };
}
