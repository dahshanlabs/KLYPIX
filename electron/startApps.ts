// Phase 23 Day 4 — Windows Start menu app launcher for the palette.
//
// Calls `Get-StartApps | ConvertTo-Json` via PowerShell at most once per
// hour, caches the result. Returns a deduped list of app shortcuts the
// palette can fuzzy-match against. Launch happens via
// `start shell:AppsFolder\<AppID>` which routes through the Windows
// shell so UWP / Store / Win32 apps all work.

import { spawn, exec } from 'child_process';
import { ipcMain } from 'electron';

interface StartApp {
    name: string;
    appId: string;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { apps: StartApp[]; fetchedAt: number } | null = null;
let inFlight: Promise<StartApp[]> | null = null;

function loadStartApps(): Promise<StartApp[]> {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
        return Promise.resolve(cache.apps);
    }
    if (inFlight) return inFlight;
    inFlight = new Promise<StartApp[]>((resolve) => {
        // -NoProfile + -NonInteractive keeps PS startup fast (~300ms).
        // ExecutionPolicy Bypass avoids the user's policy interfering with
        // a built-in cmdlet. We don't use the persistent PS scanner
        // because Get-StartApps' first call is slow (~1.5s for the AppX
        // catalog) and we don't want it blocking other persistent-PS
        // jobs that need to be responsive (window enumeration).
        const ps = spawn('powershell', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', 'Get-StartApps | ConvertTo-Json -Compress',
        ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

        let out = '';
        ps.stdout.on('data', (d) => { out += d.toString(); });
        ps.on('error', () => {
            inFlight = null;
            resolve(cache?.apps ?? []);
        });
        ps.on('close', () => {
            inFlight = null;
            try {
                const trimmed = out.trim();
                if (!trimmed) {
                    resolve(cache?.apps ?? []);
                    return;
                }
                const parsed = JSON.parse(trimmed);
                const arr = Array.isArray(parsed) ? parsed : [parsed];
                // Dedupe + filter empties.
                const seen = new Set<string>();
                const apps: StartApp[] = [];
                for (const a of arr) {
                    const name: string = a?.Name ?? '';
                    const appId: string = a?.AppID ?? '';
                    if (!name || !appId) continue;
                    if (seen.has(appId)) continue;
                    seen.add(appId);
                    apps.push({ name, appId });
                }
                cache = { apps, fetchedAt: Date.now() };
                resolve(apps);
            } catch {
                resolve(cache?.apps ?? []);
            }
        });
    });
    return inFlight;
}

function launchApp(appId: string): void {
    // shell:AppsFolder\<AppID> opens the app via the shell — works for
    // UWP, Win32, and Store apps uniformly. `start` is a cmd.exe builtin
    // so we wrap in cmd /c. windowsHide:true prevents a console flash.
    const safeId = appId.replace(/"/g, '');
    exec(`cmd /c start "" "shell:AppsFolder\\${safeId}"`, { windowsHide: true });
}

export function registerStartAppsIpc(): void {
    ipcMain.handle('start-apps:list', async () => {
        const apps = await loadStartApps();
        return apps;
    });
    ipcMain.handle('start-apps:launch', (_e, appId: string) => {
        launchApp(appId);
        return true;
    });
}
