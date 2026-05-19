// Phase 17: watch for new accepted collaborators on a canvas you OWN.
//
// Real two-PC test feedback: the inviter had no signal when a recipient
// finally accepted their share. They'd send the link, the other person
// would accept on the web page, and the inviter would have to manually
// re-open the Share modal to check whether membership changed.
//
// This hook polls list-collaborators every POLL_MS while the canvas is
// active. It compares the result to a baseline captured on mount, fires
// `onNewCollaborator` once per newly-appearing collaborator. Owners only
// (RLS blocks the SELECT for non-owners; the IPC throws which we treat
// as "no permission, just stop watching").
//
// Why not Realtime postgres_changes? It requires REPLICA IDENTITY full +
// table broadcast + per-row RLS — significantly more infrastructure for
// what is, at the rate humans accept invitations, a 30-second cadence
// problem. Poll is good enough and survives missing migrations gracefully.

import { useEffect, useRef } from 'react';

const POLL_MS = 30_000;

export interface CollaboratorRow {
    user_id: string;
    role: string;
    accepted_at: string;
    invited_by: string | null;
    /** Phase 17 RPC adds these — legacy SELECT fallback leaves them null. */
    email?: string | null;
    display_name?: string | null;
}

export interface UseCollaboratorWatcherArgs {
    /** Cloud blob id of the canvas. Null = no sharing yet, no work. */
    blobId: string | null | undefined;
    /** True only when we're the owner (and the canvas is active in the UI).
     *  list-collaborators throws for non-owners (RLS), so we skip the IPC
     *  entirely rather than spam errors. */
    enabled: boolean;
    /** Fires once per newly-accepted collaborator (compared to the snapshot
     *  taken on mount + every subsequent poll). */
    onNewCollaborator: (row: CollaboratorRow) => void;
}

export function useCollaboratorWatcher({ blobId, enabled, onNewCollaborator }: UseCollaboratorWatcherArgs): void {
    const onNewRef = useRef(onNewCollaborator);
    onNewRef.current = onNewCollaborator;
    const seenRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (!blobId || !enabled) return;
        let cancelled = false;
        seenRef.current = new Set();

        const cloud: any = (window as any).electron?.cloud;
        if (!cloud?.listCollaborators) return;

        let primed = false;
        const tick = async () => {
            if (cancelled) return;
            try {
                const rows: CollaboratorRow[] = await cloud.listCollaborators(blobId);
                if (cancelled) return;
                if (!Array.isArray(rows)) return;
                // First successful fetch builds the baseline — every row at
                // mount time is "already known", so old collaborators don't
                // trigger a fake notification.
                if (!primed) {
                    for (const r of rows) seenRef.current.add(r.user_id);
                    primed = true;
                    return;
                }
                for (const r of rows) {
                    if (!seenRef.current.has(r.user_id)) {
                        seenRef.current.add(r.user_id);
                        try { onNewRef.current(r); } catch { /* swallow per-row */ }
                    }
                }
            } catch (err: any) {
                // Most likely: RLS denied because we're not the owner anymore,
                // or auth expired. Either way, stop spamming.
                const msg = err?.message || String(err);
                if (/not the canvas owner|Not authenticated|CLOUD_AUTH_REQUIRED/i.test(msg)) {
                    cancelled = true;
                }
            }
        };

        // Prime immediately, then poll on a cadence.
        void tick();
        const id = window.setInterval(tick, POLL_MS);
        return () => {
            cancelled = true;
            window.clearInterval(id);
        };
    }, [blobId, enabled]);
}
