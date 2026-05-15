import { getSupabase, isConfigured } from './supabaseClient';
import { storeSession, getSession, clearSession, hasSession, markVerified, isWithinGracePeriod } from './tokenStore';
import { shell } from 'electron';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AuthUser {
    id: string;
    email: string;
    displayName: string;
    tier: 'free' | 'pro' | 'team' | 'enterprise' | 'admin';
    licenseKey: string | null;
    queriesToday: number;
    queriesTotal: number;
    avatarUrl: string | null;
}

export interface AuthResult {
    success: boolean;
    user?: AuthUser;
    error?: string;
    needsEmailConfirmation?: boolean;
}

export interface TierLimits {
    queriesPerDay: number;
    deepMode: boolean;
    agentMode: boolean;
    docGeneration: boolean;
    imageGeneration: boolean;
}

const TIER_LIMITS: Record<string, TierLimits> = {
    free:       { queriesPerDay: 50,  deepMode: false, agentMode: false, docGeneration: false, imageGeneration: false },
    pro:        { queriesPerDay: -1,  deepMode: true,  agentMode: true,  docGeneration: true,  imageGeneration: true  },
    team:       { queriesPerDay: -1,  deepMode: true,  agentMode: true,  docGeneration: true,  imageGeneration: true  },
    enterprise: { queriesPerDay: -1,  deepMode: true,  agentMode: true,  docGeneration: true,  imageGeneration: true  },
    admin:      { queriesPerDay: -1,  deepMode: true,  agentMode: true,  docGeneration: true,  imageGeneration: true  },
};

// ── Helper: Map Supabase user + profile to AuthUser ──────────────────────────

async function fetchProfile(userId: string, fallbackEmail?: string, fallbackName?: string): Promise<AuthUser | null> {
    const supabase = getSupabase();
    const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

    if (error || !data) {
        // Profile doesn't exist — trigger may have failed. Create it manually.
        if (fallbackEmail) {
            const { error: insertError } = await supabase
                .from('profiles')
                .insert({
                    id: userId,
                    email: fallbackEmail,
                    display_name: fallbackName || fallbackEmail.split('@')[0],
                });
            if (!insertError) {
                // Retry fetch after insert
                return fetchProfile(userId);
            }
        }
        return null;
    }

    return {
        id: data.id,
        email: data.email,
        displayName: data.display_name || data.email?.split('@')[0] || 'User',
        tier: data.tier || 'free',
        licenseKey: data.license_key,
        queriesToday: data.queries_today || 0,
        queriesTotal: data.queries_total || 0,
        avatarUrl: null,
    };
}

// ── Email/Password Auth ──────────────────────────────────────────────────────

export async function signUpWithEmail(email: string, password: string, displayName: string): Promise<AuthResult> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured. See setup instructions.' };

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
            data: { full_name: displayName },
        },
    });

    if (error) return { success: false, error: error.message };
    if (!data.user) return { success: false, error: 'Sign up failed' };

    // Supabase may require email confirmation
    if (data.user.identities?.length === 0) {
        return { success: false, error: 'An account with this email already exists.' };
    }

    if (!data.session) {
        return { success: true, needsEmailConfirmation: true };
    }

    // Store session
    storeSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: data.user,
    });
    markVerified();

    // Set session on client so RLS passes for fetchProfile
    await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
    });

    const profile = await fetchProfile(data.user.id, email, displayName);
    return { success: true, user: profile || undefined };
}

export async function signInWithEmail(email: string, password: string): Promise<AuthResult> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured. See setup instructions.' };

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return { success: false, error: error.message };
    if (!data.session || !data.user) return { success: false, error: 'Sign in failed' };

    storeSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: data.user,
    });
    markVerified();

    // Set session on client so RLS passes for fetchProfile
    await supabase.auth.setSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
    });

    // Update last_active
    await getSupabase().from('profiles').update({
        last_active_at: new Date().toISOString(),
    }).eq('id', data.user.id);

    const profile = await fetchProfile(data.user.id, email);
    return { success: true, user: profile || undefined };
}

// ── OAuth (Google / Microsoft) ───────────────────────────────────────────────

export async function signInWithOAuth(provider: 'google' | 'azure'): Promise<AuthResult> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured. See setup instructions.' };

    const supabase = getSupabase();
    const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
            redirectTo: 'klypix://auth/callback',
            skipBrowserRedirect: true,
        },
    });

    if (error) return { success: false, error: error.message };
    if (data.url) {
        // Open the OAuth URL in the user's default browser
        shell.openExternal(data.url);
        // The callback will be handled by the deep link handler in main.ts
        return { success: true };
    }

    return { success: false, error: 'Failed to get OAuth URL' };
}

// ── OAuth callback handler (called from deep link) ───────────────────────────

export async function handleOAuthCallback(url: string): Promise<AuthResult> {
    const supabase = getSupabase();

    // Extract tokens from the callback URL
    const urlObj = new URL(url);
    const hashParams = new URLSearchParams(urlObj.hash.substring(1));
    const accessToken = hashParams.get('access_token');
    const refreshToken = hashParams.get('refresh_token');

    if (!accessToken || !refreshToken) {
        // Try query params (some flows use these)
        const code = urlObj.searchParams.get('code');
        if (code) {
            const { data, error } = await supabase.auth.exchangeCodeForSession(code);
            if (error) return { success: false, error: error.message };
            if (!data.session || !data.user) return { success: false, error: 'OAuth failed' };

            storeSession({
                access_token: data.session.access_token,
                refresh_token: data.session.refresh_token,
                expires_at: data.session.expires_at,
                user: data.user,
            });
            markVerified();

            const profile = await fetchProfile(data.user.id);
            return { success: true, user: profile || undefined };
        }
        return { success: false, error: 'No tokens in callback URL' };
    }

    // Set session from tokens
    const { data, error } = await supabase.auth.setSession({
        access_token: accessToken,
        refresh_token: refreshToken,
    });

    if (error) return { success: false, error: error.message };
    if (!data.session || !data.user) return { success: false, error: 'OAuth session failed' };

    storeSession({
        access_token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: data.user,
    });
    markVerified();

    const profile = await fetchProfile(data.user.id);
    return { success: true, user: profile || undefined };
}

// ── License Key Activation ───────────────────────────────────────────────────

export async function activateLicenseKey(key: string): Promise<AuthResult> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured. See setup instructions.' };

    const supabase = getSupabase();

    // Check if key exists and is valid
    const { data: license, error: licError } = await supabase
        .from('licenses')
        .select('*')
        .eq('key', key)
        .single();

    if (licError || !license) return { success: false, error: 'Invalid license key' };
    if (license.revoked) return { success: false, error: 'This license key has been revoked' };
    if (license.expires_at && new Date(license.expires_at) < new Date()) {
        return { success: false, error: 'This license key has expired' };
    }
    if (license.current_activations >= license.max_activations) {
        return { success: false, error: `This license key has reached its maximum activations (${license.max_activations})` };
    }

    // Get current user session
    const session = getSession();
    if (!session) return { success: false, error: 'You must be signed in to activate a license key' };

    // Update the user's profile with the license key and tier
    const { error: updateError } = await supabase
        .from('profiles')
        .update({ license_key: key, tier: license.tier })
        .eq('id', session.user.id);

    if (updateError) return { success: false, error: 'Failed to activate license' };

    // Increment activation count
    await supabase
        .from('licenses')
        .update({ current_activations: license.current_activations + 1 })
        .eq('key', key);

    const profile = await fetchProfile(session.user.id);
    return { success: true, user: profile || undefined };
}

// ── Session Management ───────────────────────────────────────────────────────

export async function restoreSession(): Promise<AuthResult> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured' };

    const stored = getSession();
    if (!stored) return { success: false, error: 'No session' };

    const supabase = getSupabase();

    try {
        // Try to restore the session with the refresh token
        const { data, error } = await supabase.auth.setSession({
            access_token: stored.access_token,
            refresh_token: stored.refresh_token,
        });

        if (error) {
            // If online refresh fails, check offline grace period
            if (isWithinGracePeriod()) {
                const profile = await fetchProfile(stored.user.id).catch(() => null);
                if (profile) return { success: true, user: profile };
                // Can't reach Supabase but have cached user
                return {
                    success: true,
                    user: {
                        id: stored.user.id,
                        email: stored.user.email || '',
                        displayName: stored.user.user_metadata?.full_name || stored.user.email?.split('@')[0] || 'User',
                        tier: 'free',  // Conservative fallback
                        licenseKey: null,
                        queriesToday: 0,
                        queriesTotal: 0,
                        avatarUrl: null,
                    },
                };
            }
            clearSession();
            return { success: false, error: 'Session expired. Please sign in again.' };
        }

        if (!data.session || !data.user) {
            clearSession();
            return { success: false, error: 'Session invalid' };
        }

        // Update stored session with fresh tokens
        storeSession({
            access_token: data.session.access_token,
            refresh_token: data.session.refresh_token,
            expires_at: data.session.expires_at,
            user: data.user,
        });
        markVerified();

        const profile = await fetchProfile(data.user.id);
        return { success: true, user: profile || undefined };
    } catch {
        // Network error — check offline grace
        if (isWithinGracePeriod()) {
            return {
                success: true,
                user: {
                    id: stored.user.id,
                    email: stored.user.email || '',
                    displayName: stored.user.user_metadata?.full_name || stored.user.email?.split('@')[0] || 'User',
                    tier: 'free',
                    licenseKey: null,
                    queriesToday: 0,
                    queriesTotal: 0,
                    avatarUrl: null,
                },
            };
        }
        return { success: false, error: 'Cannot verify session offline. Please connect to the internet.' };
    }
}

export async function signOut(): Promise<void> {
    try {
        const supabase = getSupabase();
        await supabase.auth.signOut();
    } catch {
        // Ignore errors — we're clearing local state regardless
    }
    clearSession();
}

export async function getCurrentUser(): Promise<AuthUser | null> {
    const stored = getSession();
    if (!stored) return null;
    try {
        return await fetchProfile(stored.user.id);
    } catch {
        return null;
    }
}

// ── Tier Checks ──────────────────────────────────────────────────────────────

export function getTierLimits(tier: string): TierLimits {
    return TIER_LIMITS[tier] || TIER_LIMITS.free;
}

export function canUseFeature(tier: string, feature: keyof TierLimits): boolean {
    const limits = getTierLimits(tier);
    const value = limits[feature];
    if (typeof value === 'boolean') return value;
    return true;
}

export function isQueryAllowed(tier: string, queriesToday: number): boolean {
    const limits = getTierLimits(tier);
    if (limits.queriesPerDay === -1) return true;
    return queriesToday < limits.queriesPerDay;
}

// ── Usage Tracking ───────────────────────────────────────────────────────────

export async function trackUsage(event: {
    eventType: string;
    feature?: string;
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
}): Promise<void> {
    const stored = getSession();
    if (!stored) return;

    try {
        const supabase = getSupabase();
        await supabase.from('usage_events').insert({
            user_id: stored.user.id,
            event_type: event.eventType,
            feature: event.feature,
            model: event.model,
            tokens_in: event.tokensIn,
            tokens_out: event.tokensOut,
            duration_ms: event.durationMs,
        });

        // Increment query counters
        if (event.eventType === 'query') {
            await supabase.rpc('increment_query_count', { user_id: stored.user.id });
        }
    } catch {
        // Silent fail — usage tracking should never break the app
    }
}

// ── Password Reset ───────────────────────────────────────────────────────────

export async function resetPassword(email: string): Promise<{ success: boolean; error?: string }> {
    if (!isConfigured()) return { success: false, error: 'Supabase not configured' };

    const supabase = getSupabase();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: 'klypix://auth/reset-password',
    });

    if (error) return { success: false, error: error.message };
    return { success: true };
}
