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

// ── Deep Link Handler (for OAuth callbacks) ──────────────────────────────────

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
    }
}
