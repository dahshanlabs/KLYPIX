import { useEffect, useRef, useState } from 'react';

// Phase 5: surface connection state changes for UI feedback. The chip
// strip already DIMS when disconnected (Phase 1). This hook turns the
// boolean into transient lifecycle events ("just disconnected",
// "just reconnected") so the canvas can flash a toast — useful so the
// user notices a 10s network blip and knows whether to retry an action.

export type HealthEvent =
    | { kind: 'disconnected'; at: number }
    | { kind: 'reconnected'; at: number };

export interface UseCollabHealthArgs {
    /** Current connected state from useCanvasCollab. */
    connected: boolean;
    /** Whether collab is even configured (false on never-shared canvases) —
     *  used to suppress lifecycle events on solo canvases. */
    eligible: boolean;
    /** Don't fire a 'disconnected' event for blips shorter than this. Most
     *  real production reconnects complete in 1-3s; not worth toasting. */
    debounceDisconnectMs?: number;
}

export interface UseCollabHealthResult {
    /** The most recent lifecycle event (or null if nothing has happened
     *  yet / collab isn't eligible). Stays until a new event replaces it
     *  OR autoClear fires. */
    event: HealthEvent | null;
    /** Call this after rendering the event so it doesn't persist forever. */
    acknowledge: () => void;
}

const DEFAULT_DEBOUNCE = 2500;

export function useCollabHealth({ connected, eligible, debounceDisconnectMs }: UseCollabHealthArgs): UseCollabHealthResult {
    const [event, setEvent] = useState<HealthEvent | null>(null);
    const prevConnectedRef = useRef<boolean | null>(null);
    const lastDisconnectRef = useRef<number>(0);
    const disconnectTimerRef = useRef<number | null>(null);
    const debounce = debounceDisconnectMs ?? DEFAULT_DEBOUNCE;

    useEffect(() => {
        if (!eligible) {
            setEvent(null);
            prevConnectedRef.current = null;
            return;
        }
        const prev = prevConnectedRef.current;
        // First observation: just remember, don't toast.
        if (prev === null) {
            prevConnectedRef.current = connected;
            return;
        }
        if (prev && !connected) {
            // Just disconnected — set the debounce timer. If it stays
            // disconnected past the debounce, fire the event; otherwise
            // the timer is cancelled by a reconnect arriving first.
            lastDisconnectRef.current = Date.now();
            if (disconnectTimerRef.current != null) {
                window.clearTimeout(disconnectTimerRef.current);
            }
            disconnectTimerRef.current = window.setTimeout(() => {
                disconnectTimerRef.current = null;
                setEvent({ kind: 'disconnected', at: Date.now() });
            }, debounce);
        } else if (!prev && connected) {
            // Just reconnected — cancel any pending disconnect notification
            // and only fire a 'reconnected' if we had previously surfaced a
            // disconnect (otherwise it'd be noise for first-time connects).
            if (disconnectTimerRef.current != null) {
                window.clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = null;
            }
            if (event && event.kind === 'disconnected') {
                setEvent({ kind: 'reconnected', at: Date.now() });
            }
        }
        prevConnectedRef.current = connected;
    }, [connected, eligible, debounce, event]);

    const acknowledge = () => setEvent(null);
    return { event, acknowledge };
}
