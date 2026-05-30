// 2026-05-30: in-app pending-invitations inbox. Mirrors useSharedCanvases.
//
// Lists invitations addressed to the current user that they have NOT yet
// accepted or declined — both directed invites (bound to their user_id) and
// link invites whose invitee_email matches their confirmed email (so
// register-after-invite surfaces). Backed by the list_pending_invitations
// SECURITY DEFINER RPC, which omits token + key_b64.
//
// Accept/decline are optimistic: the row is dropped from local state
// immediately, then the RPC fires. On a "no longer valid" / "wrong account"
// failure we do NOT restore (the invite is genuinely dead); on a transient
// failure we restore so the user can retry.

import { useCallback, useEffect, useState } from 'react';

export interface PendingInvitation {
    invitation_id: string;
    blob_id: string;
    title_hint: string | null;
    created_at: string;
    expires_at: string;
    invited_by: {
        user_id: string | null;
        display_name: string | null;
        masked_email: string | null;
    } | null;
}

interface UsePendingInvitationsResult {
    invitations: PendingInvitation[];
    loading: boolean;
    error: string | null;
    refresh: () => void;
    /** Accept a directed invitation. Optimistically removes it, fires the
     *  RPC, and on success dispatches `klypix:shared-refresh` so the
     *  "Shared with you" list picks up the new canvas. Returns the accepted
     *  row's RPC payload (blob_id, title_hint, key_b64, inviter…) so callers
     *  can auto-open. Returns null on failure. */
    accept: (invitationId: string) => Promise<any | null>;
    /** Decline a directed invitation. Optimistic; permanent on success. */
    decline: (invitationId: string) => Promise<boolean>;
}

// Errors that mean the invite is genuinely gone — do NOT restore on these.
const PERMANENT_FAIL = /no longer valid|different account|already used|expired|declined|P0002|P0007/i;

export function usePendingInvitations(): UsePendingInvitationsResult {
    const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [tick, setTick] = useState(0);

    const refresh = useCallback(() => setTick(t => t + 1), []);

    // Re-fetch on the shared-refresh event (fired after accept anywhere),
    // on window focus (catches a web/other-device accept), and on a
    // dedicated invites-refresh event.
    useEffect(() => {
        const handler = () => refresh();
        window.addEventListener('klypix:shared-refresh', handler as EventListener);
        window.addEventListener('klypix:invites-refresh', handler as EventListener);
        window.addEventListener('focus', handler);
        return () => {
            window.removeEventListener('klypix:shared-refresh', handler as EventListener);
            window.removeEventListener('klypix:invites-refresh', handler as EventListener);
            window.removeEventListener('focus', handler);
        };
    }, [refresh]);

    const accept = useCallback(async (invitationId: string): Promise<any | null> => {
        const bridge: any = (window as any).electron?.cloud;
        if (!bridge?.acceptDirectedInvitation) {
            window.alert('Cloud IPC unavailable — cannot accept invitation.');
            return null;
        }
        let snapshot: PendingInvitation | undefined;
        setInvitations(prev => {
            snapshot = prev.find(i => i.invitation_id === invitationId);
            return prev.filter(i => i.invitation_id !== invitationId);
        });
        try {
            const res = await bridge.acceptDirectedInvitation(invitationId);
            // New canvas is now in 'Shared with you' — tell that list to refresh.
            // Do NOT self-refetch here (would race the optimistic drop).
            window.dispatchEvent(new CustomEvent('klypix:shared-refresh'));
            return res?.data ?? res ?? null;
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!PERMANENT_FAIL.test(msg) && snapshot) {
                setInvitations(prev => [snapshot!, ...prev]);
            }
            window.alert(`Couldn't accept invitation: ${msg}`);
            return null;
        }
    }, []);

    const decline = useCallback(async (invitationId: string): Promise<boolean> => {
        const bridge: any = (window as any).electron?.cloud;
        if (!bridge?.declineInvitation) {
            window.alert('Cloud IPC unavailable — cannot decline invitation.');
            return false;
        }
        let snapshot: PendingInvitation | undefined;
        setInvitations(prev => {
            snapshot = prev.find(i => i.invitation_id === invitationId);
            return prev.filter(i => i.invitation_id !== invitationId);
        });
        try {
            await bridge.declineInvitation(invitationId);
            return true;
        } catch (e: any) {
            const msg = e?.message || String(e);
            if (!PERMANENT_FAIL.test(msg) && snapshot) {
                setInvitations(prev => [snapshot!, ...prev]);
            }
            window.alert(`Couldn't decline invitation: ${msg}`);
            return false;
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        const bridge: any = (window as any).electron?.cloud;
        if (!bridge?.listPendingInvitations) {
            setLoading(false);
            // Not an error to surface — older preload without the bridge.
            return;
        }

        // 2026-05-31: POLL every 20s. usePendingInvitations previously only
        // fetched on mount + window 'focus' + events. On two SEPARATE physical
        // machines, PC2's window keeps focus the whole time the user looks at
        // PC1, so no 'focus' event ever fires and a freshly-created invite
        // never loads. A light poll makes invites appear on their own (humans
        // accept invitations at human cadence — 20s is plenty, and the RPC is
        // cheap + returns [] when signed out). first=true only on the initial
        // fetch so polls don't flash the loading state.
        const fetchInvites = async (first: boolean) => {
            if (cancelled) return;
            if (first) { setLoading(true); setError(null); }
            try {
                const rows = await bridge.listPendingInvitations();
                if (cancelled) return;
                setInvitations(Array.isArray(rows) ? rows as PendingInvitation[] : []);
            } catch (e: any) {
                if (cancelled) return;
                const msg = e?.message || String(e);
                if (/CLOUD_AUTH_REQUIRED|sign[-\s]?in|not authenticated/i.test(msg)) {
                    setInvitations([]);
                } else if (first) {
                    setError(msg);
                }
                // Transient poll errors are swallowed — don't surface mid-session.
            } finally {
                if (first && !cancelled) setLoading(false);
            }
        };

        void fetchInvites(true);
        const id = window.setInterval(() => void fetchInvites(false), 20_000);
        return () => { cancelled = true; window.clearInterval(id); };
    }, [tick]);

    return { invitations, loading, error, refresh, accept, decline };
}
