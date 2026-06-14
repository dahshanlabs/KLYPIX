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
    const disconnectTimerRef = useRef<number | null>(null);
    // Whether we've already surfaced a 'disconnected' event for the CURRENT
    // disconnect episode. A flaky network makes the Realtime channel flap
    // (SUBSCRIBED → CHANNEL_ERROR → backoff retry → SUBSCRIBED → …); without
    // this guard EVERY flap re-fired a fresh 'disconnected' event, so the
    // canvas re-spawned the toast the moment after the user dismissed it —
    // the × looked broken. We emit ONE disconnected event per episode and
    // only re-arm after a genuine reconnect. This ref also drives the
    // reconnect decision instead of `event` — `event` is acknowledged to
    // null by the consumer ~50ms after showing, so the old `event`-based
    // check almost never fired a 'reconnected' notice.
    const surfacedDisconnectRef = useRef(false);
    const debounce = debounceDisconnectMs ?? DEFAULT_DEBOUNCE;

    useEffect(() => {
        if (!eligible) {
            setEvent(null);
            prevConnectedRef.current = null;
            surfacedDisconnectRef.current = false;
            if (disconnectTimerRef.current != null) {
                window.clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = null;
            }
            return;
        }
        const prev = prevConnectedRef.current;
        // First observation: just remember, don't toast.
        if (prev === null) {
            prevConnectedRef.current = connected;
            return;
        }
        if (prev && !connected) {
            // Just dropped. Arm the debounce only if we haven't already
            // surfaced THIS disconnect episode (and don't stack timers) —
            // repeated flaps must not re-spawn the toast. If it stays
            // disconnected past the debounce, fire once; a reconnect
            // arriving first cancels it.
            if (!surfacedDisconnectRef.current && disconnectTimerRef.current == null) {
                disconnectTimerRef.current = window.setTimeout(() => {
                    disconnectTimerRef.current = null;
                    surfacedDisconnectRef.current = true;
                    setEvent({ kind: 'disconnected', at: Date.now() });
                }, debounce);
            }
        } else if (!prev && connected) {
            // Just reconnected — cancel any pending (not-yet-fired) disconnect
            // notification, and only announce a 'reconnected' if we actually
            // told the user we'd dropped (otherwise it'd be noise for
            // first-time connects). Reset the episode so a future drop can
            // toast again.
            if (disconnectTimerRef.current != null) {
                window.clearTimeout(disconnectTimerRef.current);
                disconnectTimerRef.current = null;
            }
            if (surfacedDisconnectRef.current) {
                surfacedDisconnectRef.current = false;
                setEvent({ kind: 'reconnected', at: Date.now() });
            }
        }
        prevConnectedRef.current = connected;
    }, [connected, eligible, debounce]);

    const acknowledge = () => setEvent(null);
    return { event, acknowledge };
}
