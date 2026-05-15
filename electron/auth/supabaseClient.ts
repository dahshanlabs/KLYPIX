import { createClient, SupabaseClient } from '@supabase/supabase-js';

// ── Configuration ────────────────────────────────────────────────────────────
// Set these in your environment or replace with your Supabase project values.
// NEVER commit real keys — use environment variables in production builds.
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://hiqwovwavlczlbuzzbel.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhpcXdvdndhdmxjemxidXp6YmVsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxODQ1MjEsImV4cCI6MjA4OTc2MDUyMX0.D38pbmA7HeH-it9Lyx1SGwafDIhkk35Grd5h0ze4Lko';

let supabase: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
    if (!supabase) {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                autoRefreshToken: true,
                persistSession: false,  // We handle persistence ourselves via safeStorage
                detectSessionInUrl: false,
            },
        });
    }
    return supabase;
}

export function isConfigured(): boolean {
    return SUPABASE_URL !== 'YOUR_SUPABASE_URL' && SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY';
}

export { SUPABASE_URL, SUPABASE_ANON_KEY };
