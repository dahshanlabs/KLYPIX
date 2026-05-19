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

/** Phase 12: set (or clear) the auth token the Realtime client uses to
 *  authenticate channel joins. Required once the server-side channel
 *  policy flips to `private: true` mode. No-op when called with the same
 *  token we've already applied (avoids reconnect churn). */
export function setRealtimeAuth(token: string | null): void {
    if (token === lastAuthToken) return;
    lastAuthToken = token;
    try {
        getRealtimeClient().realtime.setAuth(token);
    } catch (err) {
        console.warn('[realtime] setAuth failed:', err);
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
                // Smaller cap than the 100 default — typical canvas op
                // bursts are well under this and we're cost-conscious.
                params: { eventsPerSecond: 30 },
            },
        });
    }
    return client;
}
