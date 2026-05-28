import { ipcMain, BrowserWindow } from 'electron';
import {
    signInWithEmail,
    signUpWithEmail,
    signInWithOAuth,
    handleOAuthCallback,
    activateLicenseKey,
    restoreSession,
    signOut,
    getCurrentUser,
    getTierLimits,
    canUseFeature,
    isQueryAllowed,
    trackUsage,
    resetPassword,
} from './authService';
import type { AuthUser } from './authService';

let currentUser: AuthUser | null = null;

export function getCurrentAuthUser(): AuthUser | null {
    return currentUser;
}

export function setCurrentAuthUser(user: AuthUser | null): void {
    currentUser = user;
}

// ── Register all auth IPC handlers ───────────────────────────────────────────

export function registerAuthHandlers(getMainWindow: () => BrowserWindow | null) {

    // Restore session on app launch
    ipcMain.handle('auth:restore-session', async () => {
        const result = await restoreSession();
        if (result.success && result.user) {
            currentUser = result.user;
        }
        return result;
    });

    // Email/password sign in
    ipcMain.handle('auth:sign-in', async (_event, { email, password }: { email: string; password: string }) => {
        const result = await signInWithEmail(email, password);
        if (result.success && result.user) {
            currentUser = result.user;
        }
        return result;
    });

    // Email/password sign up
    ipcMain.handle('auth:sign-up', async (_event, { email, password, displayName }: { email: string; password: string; displayName: string }) => {
        const result = await signUpWithEmail(email, password, displayName);
        if (result.success && result.user) {
            currentUser = result.user;
        }
        return result;
    });

    // OAuth sign in (opens browser)
    ipcMain.handle('auth:sign-in-oauth', async (_event, { provider }: { provider: 'google' | 'azure' }) => {
        return signInWithOAuth(provider);
    });

    // Activate license key
    ipcMain.handle('auth:activate-license', async (_event, { key }: { key: string }) => {
        const result = await activateLicenseKey(key);
        if (result.success && result.user) {
            currentUser = result.user;
        }
        return result;
    });

    // Sign out
    ipcMain.handle('auth:sign-out', async () => {
        await signOut();
        currentUser = null;
        return { success: true };
    });

    // Get current user
    ipcMain.handle('auth:get-user', async () => {
        if (currentUser) return { success: true, user: currentUser };
        const user = await getCurrentUser();
        if (user) {
            currentUser = user;
            return { success: true, user };
        }
        return { success: false };
    });

    // Phase 12: surface the current Supabase access token to the renderer
    // so it can authenticate its own Realtime client. Used to gate the
    // collab channel under RLS once `private: true` mode is enabled
    // server-side (see supabase/migrations/20260519_realtime_rls_*.sql).
    // Returns null when signed out — the renderer-side caller is expected
    // to skip auth in that case (anonymous viewer flow still works).
    ipcMain.handle('auth:get-access-token', async () => {
        try {
            const { getSession } = await import('./tokenStore');
            const session: any = getSession?.();
            const token: string | null = session?.access_token ?? null;
            return { token };
        } catch {
            return { token: null };
        }
    });

    // Tier checks
    ipcMain.handle('auth:get-tier-limits', (_event, { tier }: { tier: string }) => {
        return getTierLimits(tier);
    });

    ipcMain.handle('auth:can-use-feature', (_event, { tier, feature }: { tier: string; feature: string }) => {
        return canUseFeature(tier, feature as any);
    });

    ipcMain.handle('auth:is-query-allowed', (_event, { tier, queriesToday }: { tier: string; queriesToday: number }) => {
        return isQueryAllowed(tier, queriesToday);
    });

    // Usage tracking
    ipcMain.handle('auth:track-usage', async (_event, event: any) => {
        await trackUsage(event);
    });

    // Password reset
    ipcMain.handle('auth:reset-password', async (_event, { email }: { email: string }) => {
        return resetPassword(email);
    });

    // Refresh user profile (after license activation, tier change, etc.)
    ipcMain.handle('auth:refresh-user', async () => {
        const user = await getCurrentUser();
        if (user) {
            currentUser = user;
            return { success: true, user };
        }
        return { success: false };
    });
}

// ── Deep Link Handler (for OAuth callbacks AND invite handoff) ──────────────

export async function handleDeepLink(url: string, mainWindow: BrowserWindow | null): Promise<void> {
    if (url.startsWith('klypix://auth/callback')) {
        const result = await handleOAuthCallback(url);
        if (result.success && result.user) {
            currentUser = result.user;
        }
        // Notify the renderer
        if (mainWindow) {
            mainWindow.webContents.send('auth:oauth-complete', result);
        }
        return;
    }

    // Desktop-first invite handoff. The web invite page (klypix.com/invite/
    // <token>) offers an "Open in Klypix Desktop" button that fires
    // klypix://invite/<token>. The OS routes that URL here. We extract the
    // token and hand it to the renderer, which calls the
    // accept_canvas_invitation RPC under the desktop's currently signed-in
    // session — guaranteeing the user accepts as the right identity (no
    // browser-vs-desktop mismatch possible).
    //
    // Token format: any URL-safe string (we don't validate the shape; the
    // RPC rejects invalid tokens with a clear error that bubbles back up
    // through the renderer's toast).
    if (url.startsWith('klypix://invite/')) {
        // Show + focus the window first so the user sees the toast/result.
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
        const rest = url.slice('klypix://invite/'.length);
        // Strip any query string / fragment so trailing "?utm=..." or "#"
        // don't end up in the token.
        const token = rest.split(/[?#]/)[0];
        if (token && mainWindow) {
            mainWindow.webContents.send('invite:handoff', { token });
        }
        return;
    }
}
