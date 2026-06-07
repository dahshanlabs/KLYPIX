import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Renderer-side Supabase client — dedicated to Realtime channels for live
// collaboration. The main process has its own client for blob storage /
// auth / RPC; we keep them separate because Realtime is WebSocket-based
// and works best in browser context (the main process would have to
// forward every event through IPC, which is awkward at ~60Hz cursor
// rates). The anon key is public by design (RLS protects sensitive
// operations server-side); duplicating it here is safe.
//
// Keep these in sync with electron/auth/supabaseClient.ts. Both should
// be replaced with environment variables for production builds.
const SUPABASE_URL = 'https://hiqwovwavlczlbuzzbel.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpcXdvdndhdmxjemxidXp6YmVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxODQ1MjEsImV4cCI6MjA4OTc2MDUyMX0.D38pbmA7HeH-it9Lyx1SGwafDIhkk35Grd5h0ze4Lko';

let client: SupabaseClient | null = null;
let lastAuthToken: string | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

/** Decode a JWT's `exp` (unix seconds) without verifying — just to schedule a
 *  proactive refresh before it lapses. */
function decodeJwtExpSec(token: string): number | null {
    try {
        const part = token.split('.')[1];
        if (!part) return null;
        const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
        return typeof json.exp === 'number' ? json.exp : null;
    } catch { return null; }
}

/** Pull a freshly-refreshed token from the main process (which runs
 *  autoRefreshToken) and re-apply it to the Realtime client. */
async function refreshRealtimeToken(): Promise<void> {
    try {
        const res = await (window as any).electron?.auth?.getAccessToken?.();
        setRealtimeAuth(res?.token ?? null); // applies + reschedules
    } catch {
        scheduleTokenRefresh(lastAuthToken); // IPC hiccup → retry on the old schedule
    }
}

/** Keep a VALID token applied across a long (multi-hour) session so a PRIVATE
 *  channel doesn't silently die when the ~1h JWT expires (the stale-token bug
 *  class). Re-primes at ~80% of remaining lifetime and reschedules each time.
 *  No-op for a null token — public channels need no auth. */
function scheduleTokenRefresh(token: string | null): void {
    if (refreshTimer) { clearTimeout(refreshTimer); refreshTimer = null; }
    if (!token) return;
    const exp = decodeJwtExpSec(token);
    if (!exp) return;
    const remainingMs = exp * 1000 - Date.now();
    // 80% of remaining life; clamp [10s, 55m] so we neither busy-loop on a
    // near-expired token nor wait longer than a typical token lifetime.
    const delay = Math.min(Math.max(remainingMs * 0.8, 10_000), 55 * 60_000);
    refreshTimer = setTimeout(() => { refreshTimer = null; void refreshRealtimeToken(); }, delay);
}

/** Phase 12: set (or clear) the auth token the Realtime client uses to
 *  authenticate channel joins. Required once the server-side channel
 *  policy flips to `private: true` mode. No-op when called with the same
 *  token we've already applied (avoids reconnect churn). Applying a token
 *  also (re)arms the proactive refresh so long sessions stay authenticated. */
export function setRealtimeAuth(token: string | null): void {
    if (token === lastAuthToken) { if (token) scheduleTokenRefresh(token); return; }
    lastAuthToken = token;
    try {
        getRealtimeClient().realtime.setAuth(token);
    } catch (err) {
        console.warn('[realtime] setAuth failed:', err);
    }
    scheduleTokenRefresh(token);
}

/**
 * Phase C — private-channel mode. OFF by default so live collab keeps working
 * exactly as today (public channel). Flip via:
 *     localStorage['klypix:collab:privateChannels'] = '1'
 * ONLY AFTER (1) applying the realtime.messages RLS migration
 * (supabase/migrations/20260519120000_realtime_channel_rls.sql) and
 * (2) handling the anonymous web viewer (it joins without a JWT and will be
 * denied on a private channel). See docs/COLLAB_PRIVATE_CHANNELS.md. This
 * closes the P0 hole (revoked/anon users can no longer eavesdrop or inject
 * ops on the live channel) but MUST be verified with a real 2-machine test
 * before being trusted — a mismatch silently breaks all collab.
 */
export function isCollabPrivateChannels(): boolean {
    try { return localStorage.getItem('klypix:collab:privateChannels') === '1'; }
    catch { return false; }
}

/** Best-effort: pull the signed-in user's JWT from the main process and apply
 *  it to the Realtime client. Returns true if a token was applied. Call this
 *  BEFORE subscribing to a private channel so RLS sees auth.uid(). */
export async function primeRealtimeAuth(): Promise<boolean> {
    try {
        const res = await (window as any).electron?.auth?.getAccessToken?.();
        const token = res?.token ?? null;
        setRealtimeAuth(token);
        return !!token;
    } catch {
        return false;
    }
}

/** Get (or lazily create) the renderer's Realtime-only Supabase client. */
export function getRealtimeClient(): SupabaseClient {
    if (!client) {
        client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                // We don't use this client for auth — main process owns the
                // session. Disable session persistence so it doesn't fight
                // with main's storage.
                autoRefreshToken: false,
                persistSession: false,
                detectSessionInUrl: false,
            },
            realtime: {
                // Send-rate cap. One active peer can emit cursor + selection +
                // viewport + ops; at the old 30 it self-throttled and silently
                // DROPPED its own outbound at 2+ peers. 100 (Supabase's default)
                // gives real headroom — paired with cursor min-delta + coalesce
                // so it's a safety net, not the load-bearing limiter. (Op
                // batching, the structural fix, is the staged next step.)
                params: { eventsPerSecond: 100 },
            },
        });
    }
    return client;
}
