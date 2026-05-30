// 2026-05-30: recipient-side membership guard.
//
// Closes the worst LEGITIMATE case of the (still-open) public-Realtime-channel
// hole: a collaborator who has been removed by the owner keeps editing because
// nothing told their client. The full fix is server-side private channels
// (deferred — see security memo); this is the safe interim that introduces NO
// new attack surface.
//
// HOW: while a RECIPIENT (someone who accepted a share, i.e. cloudShare has an
// invitedBy) has the canvas open, poll their OWN shared-canvases list — which
// is RLS-correct (they can only see their own membership). If this canvas's
// blob_id disappears from that list, they were removed → fire onRevoked once.
//
// WHY NOT a channel broadcast: the channel is public, so a 'membership.revoked'
// broadcast could be SPOOFED by any peer to kick arbitrary users (including the
// owner). Polling the user's own server-side membership has no such vector.
//
// Owners are never recipients (no invitedBy) so the guard is inert for them —
// correct, since owners can't be removed.

import { useEffect, useRef } from 'react';

const POLL_MS = 30_000;

export interface UseMembershipGuardArgs {
    /** Cloud blob id of the canvas. Null = not shared → no work. */
    blobId: string | null | undefined;
    /** True only when the local user is a RECIPIENT (accepted someone else's
     *  share). Owners pass false — they can't be removed. */
    isRecipient: boolean;
    /** Canvas active in the UI. Don't poll for background tabs. */
    active: boolean;
    /** Fires ONCE when this canvas is confirmed gone from the user's shared
     *  list (i.e. their access was revoked). Never fires on a transient
     *  fetch error — only on a successful list that omits the blob. */
    onRevoked: () => void;
}

export function useMembershipGuard({ blobId, isRecipient, active, onRevoked }: UseMembershipGuardArgs): void {
    const onRevokedRef = useRef(onRevoked);
    onRevokedRef.current = onRevoked;

    useEffect(() => {
        if (!blobId || !isRecipient || !active) return;
        let cancelled = false;
        let fired = false;
        // Require the canvas to be PRESENT at least once before we trust an
        // absence — guards against a cold-start race where the first poll
        // beats the share list populating.
        let confirmedPresent = false;

        const cloud: any = (window as any).electron?.cloud;
        if (!cloud?.listShared) return;

        const tick = async () => {
            if (cancelled || fired) return;
            let rows: any;
            try {
                rows = await cloud.listShared();
            } catch {
                // Transient (network / auth blip) — do NOT treat as removal.
                return;
            }
            if (cancelled || fired) return;
            if (!Array.isArray(rows)) return;
            const present = rows.some((r: any) => r?.blob_id === blobId);
            if (present) {
                confirmedPresent = true;
                return;
            }
            // Absent. Only act if we'd previously seen it present this session
            // (so a first-poll race can't false-fire).
            if (confirmedPresent) {
                fired = true;
                try { onRevokedRef.current(); } catch { /* swallow */ }
            }
        };

        void tick();
        const id = window.setInterval(tick, POLL_MS);
        return () => { cancelled = true; window.clearInterval(id); };
    }, [blobId, isRecipient, active]);
}
