import { autoUpdater, UpdateInfo, ProgressInfo } from 'electron-updater';
import { BrowserWindow, ipcMain, app } from 'electron';
import { createHash } from 'crypto';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './auth/supabaseClient';

// ── Auto-Updater with Staged Rollout ─────────────────────────────────────────
//
// Flow:
// 1. App starts → check for updates after 10s delay
// 2. If update available → check staged rollout eligibility
// 3. If eligible → download in background
// 4. Notify renderer with progress → show toast
// 5. When downloaded → user clicks "Restart Now" or "Later"
// 6. On next quit → install automatically
//
// Rollout is controlled via the `releases` table in Supabase:
// - rollout_percentage: 0-100 (what % of users get this update)
// - is_mandatory: forces update regardless of rollout %
// - min_supported_version: versions below this MUST update

let mainWindow: BrowserWindow | null = null;

// ── Machine ID for deterministic rollout bucketing ───────────────────────────

function getMachineId(): string {
    // Use a combination of username + hostname as a stable machine identifier
    const os = require('os');
    return `${os.userInfo().username}@${os.hostname()}`;
}

function getRolloutBucket(): number {
    // Hash the machine ID to get a deterministic 0-99 value
    // Same machine always gets the same bucket → consistent rollout behavior
    const hash = createHash('sha256').update(getMachineId()).digest('hex');
    return parseInt(hash.substring(0, 8), 16) % 100;
}

// ── Staged Rollout Check ─────────────────────────────────────────────────────

async function checkRolloutEligibility(version: string): Promise<{ eligible: boolean; mandatory: boolean }> {
    // If Supabase isn't configured, allow all updates (no staged rollout)
    if (SUPABASE_URL === 'YOUR_SUPABASE_URL' || SUPABASE_ANON_KEY === 'YOUR_SUPABASE_ANON_KEY') {
        return { eligible: true, mandatory: false };
    }

    try {
        const res = await fetch(
            `${SUPABASE_URL}/rest/v1/releases?version=eq.${encodeURIComponent(version)}&select=*`,
            {
                headers: {
                    'apikey': SUPABASE_ANON_KEY,
                    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
                },
            }
        );

        if (!res.ok) return { eligible: true, mandatory: false };

        const releases = await res.json();
        if (!releases || releases.length === 0) return { eligible: true, mandatory: false };

        const release = releases[0];

        // Mandatory update — always eligible
        if (release.is_mandatory) return { eligible: true, mandatory: true };

        // Check minimum supported version
        if (release.min_supported_version) {
            const current = app.getVersion();
            if (compareVersions(current, release.min_supported_version) < 0) {
                return { eligible: true, mandatory: true };
            }
        }

        // Staged rollout: check if this machine's bucket is within the rollout percentage
        const bucket = getRolloutBucket();
        return { eligible: bucket < (release.rollout_percentage ?? 100), mandatory: false };
    } catch {
        // Network error — allow update (don't block updates due to Supabase issues)
        return { eligible: true, mandatory: false };
    }
}

// ── Version Comparison ───────────────────────────────────────────────────────

function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const va = pa[i] || 0;
        const vb = pb[i] || 0;
        if (va > vb) return 1;
        if (va < vb) return -1;
    }
    return 0;
}

// ── Initialize Auto-Updater ──────────────────────────────────────────────────

export function initAutoUpdater(window: BrowserWindow) {
    mainWindow = window;

    // Configuration
    autoUpdater.autoDownload = false;          // Don't download until rollout check passes
    autoUpdater.autoInstallOnAppQuit = true;   // Install on next quit if downloaded
    autoUpdater.autoRunAppAfterInstall = true;  // Relaunch after install

    // ── Events ───────────────────────────────────────────────────────────────

    autoUpdater.on('checking-for-update', () => {
        sendToRenderer('update:checking', {});
    });

    autoUpdater.on('update-available', async (info: UpdateInfo) => {
        const { eligible, mandatory } = await checkRolloutEligibility(info.version);

        if (!eligible) {
            console.log(`[Updater] Update ${info.version} available but not in rollout bucket (${getRolloutBucket()}%)`);
            return;
        }

        sendToRenderer('update:available', {
            version: info.version,
            releaseNotes: typeof info.releaseNotes === 'string'
                ? info.releaseNotes
                : Array.isArray(info.releaseNotes)
                    ? info.releaseNotes.map(n => n.note).join('\n')
                    : '',
            releaseDate: info.releaseDate,
            mandatory,
        });

        // Start downloading
        autoUpdater.downloadUpdate();
    });

    autoUpdater.on('update-not-available', (_info: UpdateInfo) => {
        sendToRenderer('update:not-available', {});
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
        sendToRenderer('update:progress', {
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond,
        });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
        sendToRenderer('update:downloaded', {
            version: info.version,
        });
    });

    autoUpdater.on('error', (err: Error) => {
        console.error('[Updater] Error:', err.message);
        sendToRenderer('update:error', { message: err.message });
    });

    // ── IPC Handlers ─────────────────────────────────────────────────────────

    ipcMain.handle('updater:check', async () => {
        try {
            const result = await autoUpdater.checkForUpdates();
            return { success: true, updateInfo: result?.updateInfo };
        } catch (err: any) {
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('updater:install', () => {
        // Quit and install the downloaded update
        autoUpdater.quitAndInstall(false, true);
    });

    ipcMain.handle('updater:get-version', () => {
        return app.getVersion();
    });

    // ── Auto-check on launch (10s delay to not block startup) ────────────────

    setTimeout(() => {
        autoUpdater.checkForUpdates().catch(() => {
            // Silent fail — don't crash on update check failure
        });
    }, 10_000);

    // ── Periodic check every 4 hours ─────────────────────────────────────────

    setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
    }, 4 * 60 * 60 * 1000);
}

// ── Helper ───────────────────────────────────────────────────────────────────

function sendToRenderer(channel: string, data: any) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, data);
    }
}
