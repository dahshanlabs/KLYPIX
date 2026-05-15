import { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, session, shell, clipboard, nativeImage, dialog, desktopCapturer, safeStorage } from 'electron';
import path from 'path';
import { exec, spawn } from 'child_process';
import { MCPClientManager } from './mcpClient';
import { promisify } from 'util';
import fs from 'fs';
import * as os from 'os';
// Prevent EPIPE and other uncaught errors from showing error dialogs
process.on('uncaughtException', (err: any) => {
    if (err.message.includes('EPIPE') || err.message.includes('broken pipe')) {
        console.error('[Process] EPIPE caught, PS pipe broken — will auto-recover');
        return; // Don't crash
    }
    console.error('[Process] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason: any) => {
    console.error('[Process] Unhandled rejection:', reason);
});
import { registerAuthHandlers, handleDeepLink } from './auth/authGuard';
import { registerCloudHandlers } from './cloudHandlers';
import { initAutoUpdater } from './updater';
import { storeApiKey, getApiKey, clearApiKey } from './auth/tokenStore';
// Imports below MUST stay at top level. TypeScript compiles each `import`
// to a `require()` at the line it appears; top-level function calls earlier
// in the file would TDZ on these otherwise (broke Alt+Space + embed events
// in a prior session).
import * as agentConfig from './agentConfig';
import { SandboxManager } from './sandbox/sandboxManager';
import { CommandExecutor, type ApprovalRequest } from './sandbox/commandExecutor';
import { FileManager } from './sandbox/fileManager';
import { FallbackExecutor } from './sandbox/fallbackExecutor';
import { generateXLSX, generateDOCX, generatePPTX, generatePDF } from './generators/index';
import { saveAnyFile, loadAnyFile, listAnyVersions, loadAnyVersion, readAssetBytes, evictZipCache } from './canvas/anyFileHandler';
import { saveKlypixFile, loadKlypixFile, detectKlypixFormat } from './canvas/klypixFileHandler';
import { openAndWatch as embedOpenAndWatch, stopWatching as embedStopWatching, cleanupCanvas as embedCleanupCanvas, setEmbedEventSink } from './canvas/embedWatcher';
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const execAsync = promisify(exec);
// ── Deep Link Protocol (for OAuth callbacks) ─────────────────────────────────
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('klypix', process.execPath, [path.resolve(process.argv[1])]);
    }
}
else {
    app.setAsDefaultProtocolClient('klypix');
}
// ─── Persistent PowerShell Scanner ────────────────────────────────────────
// Keeps a single PS process alive with Add-Type pre-compiled.
// Commands are sent via stdin markers, responses collected via stdout markers.
// This eliminates the 2-3s Add-Type compilation overhead on every scan cycle.
const PS_SCRIPT_CONTENT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;

public class ScanAPI {
    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc enumProc, IntPtr lParam);
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder strText, int maxCount);
    [DllImport("user32.dll")]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    public static List<string[]> GetAllWindows() {
        List<string[]> windows = new List<string[]>();
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            int length = GetWindowTextLength(hWnd);
            if (length > 0) {
                StringBuilder builder = new StringBuilder(length + 1);
                GetWindowText(hWnd, builder, builder.Capacity);
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                string procName = "";
                try { procName = Process.GetProcessById((int)pid).ProcessName; } catch {}
                bool visible = IsWindowVisible(hWnd);
                bool minimized = IsIconic(hWnd);
                windows.Add(new string[] { builder.ToString(), procName, visible.ToString(), minimized.ToString(), hWnd.ToString() });
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }

    public static List<IntPtr> GetWindowsForPid(int pid) {
        var handles = new List<IntPtr>();
        EnumWindows((hWnd, lParam) => {
            uint wPid;
            GetWindowThreadProcessId(hWnd, out wPid);
            if (wPid == (uint)pid) {
                int len = GetWindowTextLength(hWnd);
                if (len > 0) handles.Add(hWnd);
            }
            return true;
        }, IntPtr.Zero);
        return handles;
    }
}
"@

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function FindUrl($el, $depth) {
    if ($depth -gt 20 -or $el -eq $null) { return $null }
    $ctrlType = $el.Current.ControlType
    $name = $el.Current.Name
    $autoId = $el.Current.AutomationId
    if ($ctrlType -eq [System.Windows.Automation.ControlType]::Edit -and ($name -match "Address" -or $name -match "URL" -or $name -match "search bar" -or $name -match "omnibox" -or $autoId -match "addressEditBox" -or $autoId -match "urlbar" -or $autoId -match "view_10")) {
        $patternObj = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
            $val = $patternObj.Current.Value
            if ($val -and $val.Length -gt 3) {
                if ($val -match '^[A-Za-z]:[/\\]') {
                    $val = "file:///$val"
                } elseif ($val -notmatch '^https?://' -and $val -notmatch '^file://' -and $val -match '\\.') {
                    $val = "https://$val"
                }
                return $val
            }
        }
    }
    $child = $walker.GetFirstChild($el)
    while ($child -ne $null) {
        $res = FindUrl $child ($depth + 1)
        if ($res) { return $res }
        $child = $walker.GetNextSibling($child)
    }
    return $null
}

# Command loop: read commands from stdin, execute, return results between markers
while ($true) {
    $cmd = [Console]::In.ReadLine()
    if ($cmd -eq $null -or $cmd -eq "EXIT") { break }

    if ($cmd -eq "GET_FOREGROUND") {
        Write-Output "<<BEGIN_RESULT>>"
        try {
            $hwnd = [ScanAPI]::GetForegroundWindow()
            $pid = 0
            [ScanAPI]::GetWindowThreadProcessId($hwnd, [ref]$pid)
            $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
            $title = ""
            $len = [ScanAPI]::GetWindowTextLength($hwnd)
            if ($len -gt 0) {
                $sb = New-Object System.Text.StringBuilder($len + 1)
                [ScanAPI]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
                $title = $sb.ToString()
            }
            $pName = if ($proc) { $proc.ProcessName } else { "Unknown" }
            Write-Output "$title|$pName"
        } catch {
            Write-Output "Unknown|Unknown"
        }
        Write-Output "<<END_RESULT>>"
        [Console]::Out.Flush()
    }
    elseif ($cmd -eq "ENUM_WINDOWS") {
        Write-Output "<<BEGIN_RESULT>>"
        try {
            [ScanAPI]::GetAllWindows() | ForEach-Object {
                Write-Output "$($_[0])|$($_[1])|$($_[2])|$($_[3])|$($_[4])"
            }
        } catch {
            Write-Output "ERROR: $_"
        }
        Write-Output "<<END_RESULT>>"
        [Console]::Out.Flush()
    }
    elseif ($cmd -eq "UIA_TABS") {
        Write-Output "<<BEGIN_RESULT>>"
        try {
            $browsers = Get-Process | Where-Object { $_.Name -match "^(chrome|msedge|brave|opera|firefox)$" }
            foreach ($b in $browsers) {
                try {
                    $handles = [ScanAPI]::GetWindowsForPid($b.Id)
                    foreach ($h in $handles) {
                        try {
                            $win = [System.Windows.Automation.AutomationElement]::FromHandle($h)
                            if ($win -eq $null) { continue }
                            $activeUrl = FindUrl $win 0
                            $tabCond = New-Object System.Windows.Automation.PropertyCondition(
                                [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                                [System.Windows.Automation.ControlType]::TabItem)
                            $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
                            if ($tabs.Count -gt 0) {
                                $activeTabName = $null
                                foreach ($t in $tabs) {
                                    try {
                                        $selPattern = $null
                                        if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selPattern)) {
                                            if ($selPattern.Current.IsSelected) {
                                                $activeTabName = $t.Current.Name
                                                break
                                            }
                                        }
                                    } catch { }
                                }
                                foreach ($t in $tabs) {
                                    $tabName = $t.Current.Name
                                    if ($tabName -and $tabName -notmatch "^New Tab$") {
                                        if ($tabName -eq $activeTabName -and $activeUrl) {
                                            Write-Output "[TAB]|$tabName|$activeUrl|$($b.Name)"
                                        } else {
                                            Write-Output "[TAB]|$tabName||$($b.Name)"
                                        }
                                    }
                                }
                            } else {
                                $title = $win.Current.Name
                                if ($title -and $activeUrl) {
                                    Write-Output "[TAB]|$title|$activeUrl|$($b.Name)"
                                }
                            }
                        } catch { }
                    }
                } catch { }
            }
        } catch {
            Write-Output "ERROR: $_"
        }
        Write-Output "<<END_RESULT>>"
        [Console]::Out.Flush()
    }
    elseif ($cmd -eq "ACROBAT_FILES") {
        Write-Output "<<BEGIN_RESULT>>"
        try {
            $paths = @(
                'HKCU:\\Software\\Adobe\\Adobe Acrobat\\DC\\AVGeneral\\cRecentFiles',
                'HKCU:\\Software\\Adobe\\Acrobat Reader\\DC\\AVGeneral\\cRecentFiles'
            )
            $acrobatProcs = Get-Process -Name 'Acrobat','AcroRd32' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }
            if ($acrobatProcs) {
                foreach ($p in $paths) {
                    if (Test-Path $p) {
                        Get-ChildItem $p | ForEach-Object {
                            $filePath = $_.GetValue('tDIText')
                            if ($filePath) {
                                # Convert /C/path to C:\\path
                                $filePath = $filePath -replace '^/', ''
                                $filePath = $filePath.Substring(0,1) + ':' + $filePath.Substring(1) -replace '/', '\\'
                                if (Test-Path $filePath) {
                                    Write-Output "ACROBAT_FILE|$filePath"
                                }
                            }
                        }
                    }
                }
            }
        } catch {
            Write-Output "ERROR: $_"
        }
        Write-Output "<<END_RESULT>>"
        [Console]::Out.Flush()
    }
}
`.trim();
let psProcess: any = null;
let psReady = false;
let psScriptPath = '';
function startPersistentPS() {
    const os = require('os');
    psScriptPath = path.join(os.tmpdir(), 'klypix_scanner.ps1');
    fs.writeFileSync(psScriptPath, '\ufeff' + PS_SCRIPT_CONTENT, 'utf8');
    psProcess = spawn('powershell', [
        '-NoProfile', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-File', psScriptPath
    ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    psReady = true;
    psProcess.on('exit', (code: any) => {
        console.log(`[PersistentPS] Exited with code ${code}`);
        psReady = false;
        psProcess = null;
    });
    psProcess.on('error', (err: any) => {
        console.error('[PersistentPS] Error:', err.message);
        psReady = false;
        psProcess = null;
    });
    psProcess.stderr?.on('data', (data: any) => {
        const msg = data.toString().trim();
        if (msg)
            console.warn('[PersistentPS stderr]', msg);
    });
    console.log('[PersistentPS] Started');
}
function sendPSCommand(command: string, timeoutMs = 12000): Promise<string[]> {
    return new Promise((resolve, reject) => {
        if (!psProcess || !psReady || !psProcess.stdin || !psProcess.stdout) {
            reject(new Error('PS process not ready'));
            return;
        }
        let output = '';
        let collecting = false;
        let done = false;
        const timer = setTimeout(() => {
            if (!done) {
                done = true;
                cleanup();
                reject(new Error('PS command timeout'));
            }
        }, timeoutMs);
        const onData = (data: any) => {
            const text = data.toString();
            output += text;
            if (!collecting && output.includes('<<BEGIN_RESULT>>')) {
                collecting = true;
            }
            if (collecting && output.includes('<<END_RESULT>>')) {
                done = true;
                clearTimeout(timer);
                cleanup();
                const startIdx = output.indexOf('<<BEGIN_RESULT>>') + '<<BEGIN_RESULT>>'.length;
                const endIdx = output.indexOf('<<END_RESULT>>');
                const resultBlock = output.substring(startIdx, endIdx).trim();
                resolve(resultBlock ? resultBlock.split('\n').map(l => l.trim()).filter(Boolean) : []);
            }
        };
        const cleanup = () => {
            psProcess?.stdout?.removeListener('data', onData);
        };
        psProcess.stdout.on('data', onData);
        try {
            psProcess.stdin.write(command + '\n');
        }
        catch (writeErr: any) {
            done = true;
            cleanup();
            // EPIPE = PS process died, try to restart it
            console.error('[PersistentPS] Write failed, restarting:', writeErr.message);
            psReady = false;
            startPersistentPS();
            reject(new Error('PS process pipe broken, restarting'));
        }
    });
}
function stopPersistentPS() {
    if (psProcess && psProcess.stdin) {
        try {
            psProcess.stdin.write('EXIT\n');
        }
        catch (_) { }
        setTimeout(() => {
            if (psProcess) {
                try {
                    psProcess.kill();
                }
                catch (_) { }
            }
        }, 2000);
    }
    psReady = false;
}
// ─── Tab Cache (persists tabs across minimized states) ────────────────────
// Key: browser name (e.g. "Google Chrome"), Value: array of cached tab entries
const tabCache = new Map();
// ─── Scan debounce guard ──────────────────────────────────────────────────
let scanInProgress = false;
let lastScanResult: any = null;
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentShortcut = 'Alt+Space';
let savedBounds: any = null;
// Disk-persisted window bounds. Previously `savedBounds` was in-memory
// only, so any app restart reset the window to the default top-right
// position. The user's report (spec D1) — "toggle off, toggle back on,
// window appears on left side" — turns out to reproduce on cold restarts
// (or when the OS clamps an off-screen bounds to display edges). Fix
// here: persist to userData on change, reload on app ready, and clamp
// against the display's workArea before applying.
const WINDOW_BOUNDS_FILENAME = 'window-bounds.json';
function getWindowBoundsPath(): string {
    try {
        return path.join(app.getPath('userData'), WINDOW_BOUNDS_FILENAME);
    } catch {
        return '';
    }
}
function loadWindowBoundsFromDisk(): { x: number; y: number; width: number; height: number } | null {
    try {
        const p = getWindowBoundsPath();
        if (!p || !fs.existsSync(p)) return null;
        const raw = fs.readFileSync(p, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number'
            && typeof parsed?.width === 'number' && typeof parsed?.height === 'number'
            && parsed.width > 0 && parsed.height > 0) {
            return { x: parsed.x, y: parsed.y, width: parsed.width, height: parsed.height };
        }
    } catch (e: any) {
        console.warn('[windowBounds] load failed:', e?.message || e);
    }
    return null;
}
let saveWindowBoundsTimer: NodeJS.Timeout | null = null;
function saveWindowBoundsToDisk(bounds: { x: number; y: number; width: number; height: number }) {
    // Throttle disk writes so a resize-drag doesn't hammer the FS.
    if (saveWindowBoundsTimer) clearTimeout(saveWindowBoundsTimer);
    saveWindowBoundsTimer = setTimeout(() => {
        try {
            const p = getWindowBoundsPath();
            if (!p) return;
            fs.writeFileSync(p, JSON.stringify(bounds), 'utf8');
        } catch (e: any) {
            console.warn('[windowBounds] save failed:', e?.message || e);
        }
    }, 400);
}
/** Clamp a bounds rect so it's fully inside the workArea of the nearest
 *  display. Defends against "saved bounds are off-screen because the user
 *  unplugged a monitor" — without this, setBounds lets Windows drop the
 *  window at x=0 (the left-edge symptom in spec D1). */
function clampBoundsToDisplay(b: { x: number; y: number; width: number; height: number }) {
    try {
        const display = screen.getDisplayMatching(b) || screen.getPrimaryDisplay();
        const wa = display.workArea;
        // Clamp width/height first so a saved 2000×2000 window fits on a
        // smaller monitor. Then clamp x/y so the window stays fully visible.
        const width = Math.max(300, Math.min(b.width, wa.width));
        const height = Math.max(200, Math.min(b.height, wa.height));
        const x = Math.max(wa.x, Math.min(b.x, wa.x + wa.width - width));
        const y = Math.max(wa.y, Math.min(b.y, wa.y + wa.height - height));
        return { x, y, width, height };
    } catch {
        return b;
    }
}
let isManualResizeActive = false;
let lastActiveWindow = { title: "Unknown", process: "Unknown" };
let lastSetWidth = 700;
let lastSetHeight = 400;
let lastToggleTime = 0;
let resizeTimer: any = null;
async function getActiveWindowInfo() {
    try {
        // Use ENUM_WINDOWS instead of GET_FOREGROUND — much more reliable.
        // GET_FOREGROUND uses GetForegroundWindow() which returns KLYPIX itself
        // (the global hotkey activates the Electron app even before show()).
        // ENUM_WINDOWS lists ALL windows by Z-order — we pick the first visible
        // non-KLYPIX window, which is what was actually on screen.
        const lines = await sendPSCommand('ENUM_WINDOWS', 3000);
        for (const line of lines) {
            const parts = line.split('|');
            if (parts.length < 5) continue;
            const handle = parts[parts.length - 1];
            const minimized = parts[parts.length - 2] === 'True';
            const visible = parts[parts.length - 3] === 'True';
            const proc = (parts[parts.length - 4] || '').trim();
            const title = parts.slice(0, parts.length - 4).join('|').trim();
            // Skip our own window, invisible windows, and minimized windows
            if (!visible || minimized) continue;
            if (title === 'KLYPIX' || proc.toLowerCase() === 'electron') continue;
            if (!title || title === 'Program Manager') continue; // Skip empty/desktop shell
            lastActiveWindow = { title, process: proc };
            console.log(`[getActiveWindowInfo] Found: "${title.substring(0, 50)}" proc=${proc}`);
            break;
        }
        return lastActiveWindow;
    }
    catch (e) {
        // PS not ready yet — fallback to one-shot PowerShell
        try {
            const { stdout } = await execAsync(
                `powershell -NoProfile -Command "Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowTitle -ne 'KLYPIX' -and $_.ProcessName -ne 'Electron' } | Sort-Object -Property @{Expression={$_.MainWindowHandle}; Descending=$true} | Select-Object -First 1 | ForEach-Object { $_.MainWindowTitle + '|' + $_.ProcessName }"`,
                { timeout: 3000 }
            );
            const parts = stdout.trim().split('|');
            if (parts.length >= 2 && parts[0] && parts[0] !== 'KLYPIX') {
                lastActiveWindow = { title: parts[0], process: parts[1] };
                console.log(`[getActiveWindowInfo] Fallback found: "${parts[0].substring(0, 50)}" proc=${parts[1]}`);
            }
        } catch {}
        return lastActiveWindow;
    }
}
function createWindow() {
    mainWindow = new BrowserWindow({
        title: "KLYPIX",
        width: 700,
        height: 400, // Massive base height for final safe zone
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: true,
        maxWidth: 750,
        maxHeight: 980,
        minWidth: 450,
        minHeight: 320,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });
    const url = isDev ? 'http://localhost:5173' : `file://${path.join(__dirname, '../dist/index.html')}`;
    mainWindow.loadURL(url);
    mainWindow.webContents.on('did-fail-load', (_e: any, code: number, desc: string) => {
        console.error('[Window] Failed to load:', code, desc);
    });
    mainWindow.webContents.on('did-finish-load', () => {
        console.log('[Window] Page loaded successfully');
    });
    mainWindow.webContents.on('console-message', (_e: any, level: number, message: string) => {
        if (level >= 2) console.log('[Renderer]', message);
    });
    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    mainWindow.setVisibleOnAllWorkspaces(true);
    // Hardware-level limits — must match maxWidth/maxHeight in BrowserWindow config
    mainWindow.setMaximumSize(750, 1200);
    mainWindow.setMinimumSize(450, 320);
    // Keep keyboard focus wired to the renderer every time the window
    // gains focus. transparent+alwaysOnTop windows can have their
    // Win32 window handle foregrounded without Chromium's render widget
    // receiving keyboard focus — typing vanishes. Explicitly re-calling
    // webContents.focus() here closes that gap.
    mainWindow.on('focus', () => {
        try { mainWindow?.webContents.focus(); } catch { /* no-op */ }
        startClipboardPolling();
    });
    mainWindow.on('blur', () => {
        stopClipboardPolling();
    });
    // OS-level fallback: if the window is resized by the user dragging edges
    mainWindow.on('resize', () => {
        if (!mainWindow)
            return;
        const [w, h] = mainWindow.getSize();
        // Title-bar drag must NEVER change size. The drag poll re-asserts
        // size on every tick via setBounds, so the resize-during-drag case
        // is already self-correcting; this branch just suppresses the
        // "manual resize" side-effects below so we don't flag drag as a
        // user resize, kill auto-fit, or spam window-resizing events.
        if (dragAnchor) {
            return;
        }
        // Detect even a 1px difference as a manual move
        const isAuto = w === lastSetWidth && h === lastSetHeight;
        if (!isAuto && !isTogglingMaximize) {
            isManualResizeActive = true;
            // If maximized and user manually resizes, treat as unmaximized
            if (preMaximizeBounds) {
                preMaximizeBounds = null;
                mainWindow.webContents.send('maximize-state-changed', false);
            }
            // Signal resizing start to frontend for performance mode
            mainWindow.webContents.send('window-resizing', true);
            if (resizeTimer)
                clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
                if (mainWindow)
                    mainWindow.webContents.send('window-resizing', false);
            }, 200); // 200ms of inactivity counts as "not resizing"
        }
        // Always save bounds so position/size persists across toggle AND
        // across app restarts (written to userData/window-bounds.json with
        // a 400ms throttle so a continuous drag doesn't hammer the FS).
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
            savedBounds = mainWindow.getBounds();
            saveWindowBoundsToDisk(savedBounds);
        }
    });
    // Save bounds when window is moved by the user
    mainWindow.on('moved', () => {
        if (!mainWindow || isTogglingMaximize)
            return;
        if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
            savedBounds = mainWindow.getBounds();
            saveWindowBoundsToDisk(savedBounds);
            // If window was maximized and user drags it, treat as unmaximized
            if (preMaximizeBounds) {
                preMaximizeBounds = null;
                mainWindow.webContents.send('maximize-state-changed', false);
            }
        }
    });
    // Cold start: seed savedBounds from disk so the first toggle reopens
    // where the user last left the window (size + Y position). X is
    // anchored to the right edge of the work area so every fresh launch
    // shows up on the right regardless of where the user left it.
    // savedCanvasFullscreen is not persisted to disk so cold start is
    // never the fullscreen-restore path; safe to override X here.
    if (!savedBounds) {
        const disk = loadWindowBoundsFromDisk();
        if (disk) {
            const clamped = clampBoundsToDisplay(disk);
            const wa = screen.getPrimaryDisplay().workArea;
            clamped.x = wa.x + wa.width - clamped.width - 2;
            savedBounds = clamped;
        }
    }
}
function createTray() {
    const iconPath = isDev
        ? path.join(__dirname, '../public/logo.png')
        : path.join(__dirname, '../dist/logo.png');
    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show Klypix', click: () => toggleWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setToolTip('Klypix AI Assistant');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => toggleWindow());
}
// Remember whether the last-hidden state was canvas fullscreen, so we can
// reopen the window at full size instead of stranding it as a tiny overlay.
let savedCanvasFullscreen = false;

async function toggleWindow() {
    if (!mainWindow)
        return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        // If canvas was in fullscreen, remember it AND save the pre-canvas
        // small bounds separately so re-opening goes back to full size,
        // exiting canvas keeps the small position.
        if (preCanvasFullscreenBounds) {
            savedCanvasFullscreen = true;
            savedBounds = mainWindow.getBounds();   // remember the fullscreen bounds to restore
        } else {
            savedCanvasFullscreen = false;
            savedBounds = mainWindow.getBounds();
        }
        mainWindow.hide();
    }
    else {
        // Capture context BEFORE showing our window (browser is still foreground)
        await getActiveWindowInfo();
        const browserTitleHints = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave', 'Opera', 'Vivaldi'];
        const isBrowserFg = isBrowserProcess(lastActiveWindow.process || '')
            || browserTitleHints.some(b => (lastActiveWindow.title || '').includes(b));
        try {
            // Step 1: Screenshot + URL extraction in PARALLEL (both need foreground window)
            const [captureResult, urlResult] = await Promise.allSettled([
                captureScreenDirect(),
                isBrowserFg ? extractBrowserUrl() : Promise.resolve(null),
            ]);
            const buffer = captureResult.status === 'fulfilled' ? captureResult.value : null;
            let browserUrl = urlResult.status === 'fulfilled' ? urlResult.value : null;
            let base64 = '';
            if (buffer) {
                const image = nativeImage.createFromBuffer(buffer);
                const resized = image.resize({ width: Math.min(image.getSize().width, 1280) });
                base64 = resized.toJPEG(75).toString('base64');
            }

            // Step 2: ALWAYS try session files + CDP for URL (even when process detection fails)
            // Session files don't need process info — they return ALL open browser tabs.
            // We match by checking if ANY session tab's URL is a real webpage.
            // This is the SAME approach deep mode uses — proven reliable.
            if (!browserUrl) {
                const title = lastActiveWindow.title || '';
                const normTitle = title.replace(/\s+/g, ' ').trim().toLowerCase();
                const stripped = normTitle
                    .replace(/\s*[-\u2013\u2014]\s*(google chrome|microsoft edge|mozilla firefox|brave|opera|vivaldi)\s*$/i, '')
                    .trim();
                console.log(`[PreCapture] Looking for URL. Title: "${stripped.substring(0, 60)}" isBrowserFg: ${isBrowserFg}`);

                // Session files — parse Chrome/Edge session data from disk
                try {
                    const tabs = getBrowserTabsFromSessionFiles();
                    console.log(`[PreCapture] Session files: ${tabs?.length || 0} tabs`);
                    if (tabs && tabs.length > 0) {
                        // If we know the title, match by title
                        if (stripped && stripped !== 'unknown' && stripped.length > 5) {
                            for (const tab of tabs) {
                                const normTab = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                                if (normTab === stripped || stripped.includes(normTab) || normTab.includes(stripped)) {
                                    browserUrl = tab.url;
                                    console.log(`[PreCapture] Session title match: ${tab.url?.substring(0, 80)}`);
                                    break;
                                }
                            }
                        }
                        // Only use "most recent tab" fallback if we have evidence it's a browser
                        // (prevents desktop/Office apps from picking up minimized browser tabs)
                        if (!browserUrl && isBrowserFg && tabs.length > 0) {
                            const httpTab = tabs.find((t: any) => t.url?.startsWith('http'));
                            if (httpTab) {
                                browserUrl = httpTab.url;
                                console.log(`[PreCapture] Using most recent session tab: ${browserUrl?.substring(0, 80)}`);
                            }
                        }
                    }
                } catch (e: any) { console.log(`[PreCapture] Session lookup failed: ${e.message}`); }

                // CDP tabs — query debug ports for open tab URLs
                if (!browserUrl) {
                    try {
                        const ports = await discoverCDPPorts();
                        for (const port of ports) {
                            const cdpTabs = await cdpListTabs(port);
                            console.log(`[PreCapture] CDP port ${port}: ${cdpTabs.length} tabs`);
                            if (stripped && stripped !== 'unknown' && stripped.length > 5) {
                                for (const tab of cdpTabs) {
                                    if (!tab.title || !tab.url) continue;
                                    if (tab.url.startsWith('chrome://') || tab.url.startsWith('edge://')) continue;
                                    const normTab = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                                    if (stripped.includes(normTab) || normTab.includes(stripped)) {
                                        browserUrl = tab.url;
                                        console.log(`[PreCapture] CDP title match: ${tab.url?.substring(0, 80)}`);
                                        break;
                                    }
                                }
                            }
                            // Only use "first real tab" fallback if we have evidence it's a browser
                            if (!browserUrl && isBrowserFg && cdpTabs.length > 0) {
                                const realTabs = cdpTabs.filter((t: any) => t.url && t.url.startsWith('http') && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://'));
                                console.log(`[PreCapture] CDP real tabs: ${realTabs.length} (types: ${cdpTabs.map((t: any) => t.type).join(',')})`);
                                if (realTabs.length > 0) {
                                    browserUrl = realTabs[0].url;
                                    console.log(`[PreCapture] CDP active tab: ${browserUrl?.substring(0, 80)}`);
                                }
                            }
                            if (browserUrl) break;
                        }
                    } catch (e: any) { console.log(`[PreCapture] CDP lookup failed: ${e.message}`); }
                }
            }

            // Step 3: Pre-fetch content — web OR file, in parallel where possible
            let webContent: { content: string | null; method: string } | null = null;
            let fileContent: { fileName?: string; content?: string; pageCount?: number; truncated?: boolean; error?: string } | null = null;

            const title = lastActiveWindow.title || '';
            const fileExtPattern = /\.(?:pdf|docx?|xlsx?|csv|txt|pptx)/i;
            const isFileWindow = fileExtPattern.test(title);

            if (browserUrl && browserUrl.startsWith('http')) {
                // Web content fetch
                console.log(`[PreCapture] Pre-fetching web content: ${browserUrl.substring(0, 80)}`);
                try {
                    webContent = await readWebPageContent(browserUrl, title, 40000);
                    if (webContent?.content) {
                        console.log(`[PreCapture] Web content fetched: ${webContent.content.length} chars via ${webContent.method}`);
                    }
                } catch (e: any) { console.log(`[PreCapture] Web fetch failed: ${e.message}`); }
            }

            if (isFileWindow && !isBrowserFg) {
                // File content fetch — Excel, Word, PDF, etc.
                console.log(`[PreCapture] Pre-fetching file content for: "${title.substring(0, 60)}"`);
                try {
                    fileContent = await readFileByTitle(title);
                    if (fileContent?.content) {
                        console.log(`[PreCapture] File content fetched: ${fileContent.content.length} chars (${fileContent.fileName})`);
                    } else if (fileContent?.error) {
                        console.log(`[PreCapture] File fetch failed: ${fileContent.error}`);
                    }
                } catch (e: any) { console.log(`[PreCapture] File fetch error: ${e.message}`); }
            }

            mainWindow?.webContents.send('pre-capture', {
                screenshot: base64,
                windowContext: {
                    title: lastActiveWindow.title || '',
                    process: lastActiveWindow.process || '',
                },
                browserUrl,
                webContent: webContent?.content || null,
                webMethod: webContent?.method || null,
                // NEW: pre-fetched file content
                fileContent: fileContent?.content || null,
                fileName: fileContent?.fileName || null,
                filePageCount: fileContent?.pageCount || null,
            });
        } catch (err) {
            console.error('[PreCapture] Failed:', err);
        }
        // NOW show the window (pre-capture data already delivered)
        if (savedBounds && savedCanvasFullscreen) {
            // Restore canvas fullscreen verbatim — no clamp. We also have to
            // lift the max-size cap first (same trick as canvas:set-fullscreen).
            mainWindow.setMaximumSize(0, 0);
            lastSetWidth = savedBounds.width;
            lastSetHeight = savedBounds.height;
            mainWindow.setBounds({ x: savedBounds.x, y: savedBounds.y, width: savedBounds.width, height: savedBounds.height }, true);
            // Reinstate the canvas-fullscreen tracking flag so is-fullscreen IPC
            // and the restore-to-small flow still work.
            preCanvasFullscreenBounds = preCanvasFullscreenBounds || { x: savedBounds.x, y: savedBounds.y, width: 700, height: 400 };
        } else if (savedBounds) {
            // Restore with overlay width/height caps AND a display-bounds
            // clamp so a bounds rect whose x/y lands off-screen (stale saved
            // position after a monitor unplug, or negative coords from
            // multi-display edge cases) doesn't get dropped onto the left
            // edge by Windows' silent OS clamp (spec D1 symptom).
            const clampedWidth = Math.min(savedBounds.width, 750);
            const clampedHeight = Math.min(savedBounds.height, 980);
            const visible = clampBoundsToDisplay({
                x: savedBounds.x,
                y: savedBounds.y,
                width: clampedWidth,
                height: clampedHeight,
            });
            // Always re-anchor X to the right edge on every show, matching
            // the cold-start behavior. Without this, hide-via-(-) followed
            // by Alt+Space sometimes lands the window on the left edge:
            // DWM stray move events on transparent+alwaysOnTop frameless
            // windows can poison savedBounds.x with off-screen coordinates
            // that survive the isVisible guard. Preserves Y and size so a
            // user who dragged the window vertically or resized it keeps
            // those choices.
            const wa = screen.getPrimaryDisplay().workArea;
            visible.x = wa.x + wa.width - visible.width - 2;
            lastSetWidth = visible.width;
            lastSetHeight = visible.height;
            mainWindow.setBounds(visible);
        }
        else {
            // First launch: use default position (top-right area)
            const primaryDisplay = screen.getPrimaryDisplay();
            const { width, height } = primaryDisplay.workAreaSize;
            const windowWidth = 700;
            const windowHeight = 400;
            const x = Math.floor(width - windowWidth - 2);
            const y = Math.floor((height - windowHeight) / 2);
            lastSetWidth = windowWidth;
            lastSetHeight = windowHeight;
            mainWindow.setBounds({ x, y, width: windowWidth, height: windowHeight });
        }
        // Smooth fade-in: show at 0 opacity, then ramp up
        mainWindow.setOpacity(0);
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        else {
            mainWindow.show();
        }
        // Overlay-mode flags: canvas-fullscreen needs them OFF so Win+D /
        // show-desktop can minimize the big window and it lives in the
        // taskbar. The small overlay re-enters alwaysOnTop / skipTaskbar.
        if (savedCanvasFullscreen) {
            mainWindow.setAlwaysOnTop(false);
            mainWindow.setSkipTaskbar(false);
        } else {
            mainWindow.setAlwaysOnTop(true, 'screen-saver');
            mainWindow.setSkipTaskbar(true);
        }
        mainWindow.focus();
        // Explicit renderer focus: mainWindow.focus() gives the Win32 window
        // foreground, but Chromium's input-dispatch doesn't always propagate
        // to the webContents on a frameless+transparent+alwaysOnTop window —
        // which surfaces as "cursor is visible but keystrokes go nowhere
        // until I click another app". Forcing webContents.focus() here fixes
        // the first-show case.
        mainWindow.webContents.focus();
        // Fade in over ~150ms (5 steps)
        let opacity = 0;
        const fadeIn = setInterval(() => {
            opacity += 0.2;
            if (opacity >= 1) {
                opacity = 1;
                clearInterval(fadeIn);
            }
            if (mainWindow)
                mainWindow.setOpacity(opacity);
        }, 30);
    }
}
// ── MCP Client Manager ──────────────────────────────────────────────────
const mcpManager = new MCPClientManager();

app.whenReady().then(() => {
    createWindow();
    createTray();
    // Register auth IPC handlers
    registerAuthHandlers(() => mainWindow);
    // Register canvas-cloud:* IPC handlers (encrypted blob upload/download).
    registerCloudHandlers(ipcMain);
    // Initialize MCP servers (auto-connect enabled ones)
    mcpManager.initialize().catch(err =>
        console.error('[Main] MCP initialization error:', err)
    );
    // Initialize auto-updater (checks after 10s, then every 4 hours)
    if (!isDev) {
        initAutoUpdater(mainWindow!);
    }
    else {
        // Register stub handlers in dev mode so renderer doesn't crash
        ipcMain.handle('updater:get-version', () => app.getVersion());
        ipcMain.handle('updater:check', () => ({ updateAvailable: false }));
        ipcMain.handle('updater:install', () => {});
    }
    // Start persistent PowerShell scanner (pre-compiles Add-Type once)
    startPersistentPS();
    // Initialize WSL2 sandbox (non-blocking)
    initSandbox().catch(err => console.warn('[Sandbox] Init error:', err));
    // Auto-discover CDP debug ports (if user launched browser with --remote-debugging-port)
    (async () => {
        const activePorts = await discoverCDPPorts();
        if (activePorts.length > 0) {
            console.log(`[CDP] Active on ports: ${activePorts.join(', ')}`);
        }
        else {
            console.log('[CDP] No active debug ports found. Server-side fetch will be used for web content.');
        }
    })();
    globalShortcut.register(currentShortcut, () => {
        const now = Date.now();
        if (now - lastToggleTime < 300)
            return;
        lastToggleTime = now;
        toggleWindow();
    });
    ipcMain.handle('get-shortcut', () => currentShortcut);
    ipcMain.handle('set-shortcut', (_event: any, shortcut: string) => {
        try {
            globalShortcut.unregister(currentShortcut);
            const success = globalShortcut.register(shortcut, () => {
                const now = Date.now();
                if (now - lastToggleTime < 300)
                    return;
                lastToggleTime = now;
                toggleWindow();
            });
            if (success) {
                currentShortcut = shortcut;
                return { success: true, shortcut };
            }
            else {
                // Rollback if failed
                globalShortcut.register(currentShortcut, () => {
                    toggleWindow();
                });
                return { success: false, error: 'Could not register shortcut. It might be in use.' };
            }
        }
        catch (error: any) {
            return { success: false, error: error.message };
        }
    });
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
    // Handle deep links (OAuth callbacks: klypix://auth/callback)
    app.on('open-url', (_event: any, url: string) => {
        handleDeepLink(url, mainWindow);
    });
    // Windows: deep links arrive via second-instance (protocol handler)
    const gotTheLock = app.requestSingleInstanceLock();
    if (!gotTheLock) {
        app.quit();
    }
    else {
        app.on('second-instance', (_event: any, argv: string[]) => {
            // On Windows the deep link URL is the last argv element
            const deepLinkUrl = argv.find(arg => arg.startsWith('klypix://'));
            if (deepLinkUrl) {
                handleDeepLink(deepLinkUrl, mainWindow);
            }
            // File association: double-click launched us with a path. Accept
            // both .klypix (current brand) and .any (legacy alias) so existing
            // user files keep opening as before.
            const canvasPath = argv.find(arg => {
                const lower = arg.toLowerCase();
                return lower.endsWith('.klypix') || lower.endsWith('.any');
            });
            if (canvasPath && mainWindow) {
                mainWindow.webContents.send('canvas:file-opened', canvasPath);
            }
            // Focus the existing window
            if (mainWindow) {
                if (mainWindow.isMinimized())
                    mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        });
    }
    // Handle microphone permissions
    session.defaultSession.setPermissionRequestHandler((webContents: any, permission: string, callback: any) => {
        if (permission === 'media') {
            callback(true);
        }
        else {
            callback(false);
        }
    });
    session.defaultSession.setPermissionCheckHandler((webContents: any, permission: string, origin: string) => {
        if (permission === 'media') {
            return true;
        }
        return false;
    });
});
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        app.quit();
});
app.on('will-quit', () => {
    stopPersistentPS();
    mcpManager.shutdown().catch(err => console.error('[MCP] Shutdown error:', err));
});
// Direct screenshot capture — bypasses the broken .bat wrapper in screenshot-desktop
// and calls screenCapture_1.3.2.exe directly (which works perfectly)
async function captureScreenDirect() {
    const os = require('os');
    const screenCapDir = path.join(os.tmpdir(), 'screenCapture');
    const exePath = path.join(screenCapDir, 'screenCapture_1.3.2.exe');
    // Ensure the exe exists (copy from node_modules if missing)
    if (!fs.existsSync(exePath)) {
        if (!fs.existsSync(screenCapDir))
            fs.mkdirSync(screenCapDir, { recursive: true });
        const srcDir = path.join(__dirname, '../node_modules/screenshot-desktop/lib/win32');
        const srcBat = path.join(srcDir, 'screenCapture_1.3.2.bat');
        const srcManifest = path.join(srcDir, 'app.manifest');
        // The bat self-compiles the exe on first run via csc.exe — we need to trigger that once
        // But since direct bat execution is broken, compile manually if exe doesn't exist
        if (fs.existsSync(srcBat))
            fs.copyFileSync(srcBat, path.join(screenCapDir, 'screenCapture_1.3.2.bat'));
        if (fs.existsSync(srcManifest))
            fs.copyFileSync(srcManifest, path.join(screenCapDir, 'app.manifest'));
        // Try to compile the exe from the bat/cs source
        if (!fs.existsSync(exePath)) {
            try {
                await execAsync(`cd /d "${screenCapDir}" && for /r "%SystemRoot%\\Microsoft.NET\\Framework\\" %f in ("csc.exe") do @"%f" /nologo /r:"Microsoft.VisualBasic.dll" /win32manifest:"app.manifest" /out:"screenCapture_1.3.2.exe" "screenCapture_1.3.2.bat" 2>nul && exit /b 0`, { timeout: 15000 });
            }
            catch (_) {
                throw new Error('Could not compile screenCapture exe');
            }
        }
    }
    // Capture to a temp PNG file, then read and delete
    const tmpFile = path.join(os.tmpdir(), `klypix_cap_${Date.now()}.png`);
    await execAsync(`"${exePath}" "${tmpFile}"`, { timeout: 10000, windowsHide: true });
    const buffer = fs.readFileSync(tmpFile);
    try {
        fs.unlinkSync(tmpFile);
    }
    catch (_) { }
    return buffer;
}
ipcMain.handle('capture-screen', async () => {
    try {
        mainWindow?.hide();
        await new Promise(resolve => setTimeout(resolve, 150));
        const buffer = await captureScreenDirect();
        mainWindow?.show();
        // Optimize image for Gemini (JPEG + Resizing)
        const image = nativeImage.createFromBuffer(buffer);
        const { width } = image.getSize();
        const maxWidth = 1280;
        let finalImage = image;
        if (width > maxWidth) {
            finalImage = image.resize({ width: maxWidth });
        }
        // JPEG 80% is much smaller than PNG for faster upload
        return finalImage.toJPEG(80).toString('base64');
    }
    catch (err) {
        console.error('Failed to capture screen:', err);
        mainWindow?.show();
        return null;
    }
});
ipcMain.handle('capture-screen-raw', async () => {
    try {
        const buffer = await captureScreenDirect();
        const image = nativeImage.createFromBuffer(buffer);
        const { width } = image.getSize();
        const maxWidth = 1280;
        let finalImage = image;
        if (width > maxWidth) {
            finalImage = image.resize({ width: maxWidth });
        }
        return finalImage.toJPEG(80).toString('base64');
    }
    catch (err) {
        console.error('Failed to capture screen raw:', err);
        return null;
    }
});
ipcMain.on('hide-window', () => {
    mainWindow?.hide();
});
ipcMain.on('show-window', () => {
    mainWindow?.show();
});
// Ensure the renderer has OS keyboard focus. Needed because Windows won't
// grant foreground focus to a `transparent: true` + `alwaysOnTop: true`
// overlay window on a plain click — the DOM gets the click, but keystrokes
// go to whatever app IS foreground.
//
// `app.focus({ steal: true })` is the Electron-blessed escape hatch: it
// explicitly opts into aggressive focus, bypassing Windows' focus-stealing
// prevention. Plain `BrowserWindow.focus()` alone isn't enough for the
// transparent+alwaysOnTop combo; we need app-level steal first, then
// reinforce with window + webContents focus so the actual render widget
// is wired to keyboard input.
ipcMain.handle('focus-window', async () => {
    if (!mainWindow) return false;
    try {
        if (mainWindow.isMinimized()) mainWindow.restore();
        // Order matters: app-level steal first (macOS only, but harmless
        // on Windows), then window focus, then webContents focus.
        app.focus({ steal: true });
        mainWindow.focus();
        mainWindow.webContents.focus();
        return true;
    } catch { return false; }
});
ipcMain.handle('launch-native-snipping', async () => {
    try {
        mainWindow?.hide();
        // Clear clipboard before launching to ensure we catch a NEW image
        clipboard.clear();
        // ms-screenclip: is the URI for the Windows Screen Sketch / Snipping Tool
        await shell.openExternal('ms-screenclip:');
        // Poll clipboard for a new image
        return new Promise((resolve) => {
            const startTimestamp = Date.now();
            const timeout = 60000; // 1 minute timeout
            const checkClipboard = setInterval(() => {
                const formats = clipboard.availableFormats();
                if (formats.includes('image/png') || formats.includes('image/jpeg')) {
                    const img = clipboard.readImage();
                    if (!img.isEmpty()) {
                        clearInterval(checkClipboard);
                        mainWindow?.show();
                        // Optimize snip as well
                        const { width } = img.getSize();
                        const maxWidth = 1280;
                        let finalImage = img;
                        if (width > maxWidth) {
                            finalImage = img.resize({ width: maxWidth });
                        }
                        resolve(finalImage.toJPEG(80).toString('base64'));
                    }
                }
                if (Date.now() - startTimestamp > timeout) {
                    clearInterval(checkClipboard);
                    mainWindow?.show();
                    resolve(null);
                }
            }, 500);
        });
    }
    catch (err) {
        console.error('Failed to launch native snipping:', err);
        mainWindow?.show();
        return null;
    }
});
ipcMain.on('minimize-window', () => {
    mainWindow?.hide();
});
let preMaximizeBounds: any = null;
let isTogglingMaximize = false; // Flag to prevent moved/resize events from clearing preMaximizeBounds

// Option A: when the window goes large (chat-max or canvas-fullscreen), drop
// alwaysOnTop + skipTaskbar so show-desktop / Win+D minimizes it like a
// normal app and it appears in the taskbar. Restore overlay behavior (pinned
// + hidden from taskbar) when going back to the small Alt+Space overlay size.
function applyOverlayMode(overlay: boolean) {
    if (!mainWindow) return;
    if (overlay) {
        mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
        mainWindow.setSkipTaskbar(true);
    } else {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setSkipTaskbar(false);
    }
}

ipcMain.handle('toggle-maximize', () => {
    if (!mainWindow)
        return false;
    isTogglingMaximize = true;
    setTimeout(() => { isTogglingMaximize = false; }, 200); // Clear after events settle
    const { workArea } = screen.getPrimaryDisplay();
    if (preMaximizeBounds) {
        // Restore to the bounds we had before maximizing
        lastSetWidth = preMaximizeBounds.width;
        lastSetHeight = preMaximizeBounds.height;
        mainWindow.setBounds(preMaximizeBounds, true);
        preMaximizeBounds = null;
        applyOverlayMode(true);
        return false; // not maximized
    }
    else {
        // Save current bounds, then fill the right side of screen
        preMaximizeBounds = mainWindow.getBounds();
        const targetWidth = Math.min(workArea.width, 750);
        const targetHeight = workArea.height;
        lastSetWidth = targetWidth;
        lastSetHeight = targetHeight;
        const x = workArea.x + workArea.width - targetWidth;
        mainWindow.setBounds({ x, y: workArea.y, width: targetWidth, height: targetHeight }, true);
        applyOverlayMode(false);
        return true; // maximized
    }
});
ipcMain.handle('is-maximized', () => {
    return !!preMaximizeBounds;
});

// Manual window drag. The title bar deliberately does NOT use CSS drag
// regions (those suppress click/dblclick events, which blocks our
// dblclick-to-maximize handler). Instead the renderer sends start on
// pointerdown and end on pointerup; while active, main process polls the
// cursor at ~120fps and repositions the window by the delta.
let dragPoll: NodeJS.Timeout | null = null;
let dragAnchor: { cursor: { x: number; y: number }; win: { x: number; y: number }; size: { width: number; height: number } } | null = null;
ipcMain.on('window:drag-start', () => {
    if (!mainWindow) return;
    if (preMaximizeBounds || preCanvasFullscreenBounds) return; // never drag while maximized
    if (dragPoll) { clearInterval(dragPoll); dragPoll = null; }
    const [wx, wy] = mainWindow.getPosition();
    const [ww, wh] = mainWindow.getSize();
    dragAnchor = { cursor: screen.getCursorScreenPoint(), win: { x: wx, y: wy }, size: { width: ww, height: wh } };
    dragPoll = setInterval(() => {
        if (!dragAnchor || !mainWindow) return;
        const cur = screen.getCursorScreenPoint();
        const dx = cur.x - dragAnchor.cursor.x;
        const dy = cur.y - dragAnchor.cursor.y;
        // setBounds (not setPosition) — re-asserts the locked size every
        // tick so Windows DWM can't sneak a resize in between frames.
        // WM_SIZE only fires when the size actually changes, so a constant
        // width/height here is as cheap as setPosition for the resize handler.
        mainWindow.setBounds({
            x: dragAnchor.win.x + dx,
            y: dragAnchor.win.y + dy,
            width: dragAnchor.size.width,
            height: dragAnchor.size.height,
        });
    }, 8);
});
ipcMain.on('window:drag-end', () => {
    if (dragPoll) { clearInterval(dragPoll); dragPoll = null; }
    dragAnchor = null;
});

// --- Canvas fullscreen ---
// The regular max is 750x980 (overlay size). Canvas needs the full work area
// to be usable. These handlers temporarily lift the size cap so the window can
// fill the screen, then restore the cap + prior bounds on exit.
let preCanvasFullscreenBounds: any = null;
ipcMain.handle('canvas:set-fullscreen', (_evt: any, enable: boolean) => {
    if (!mainWindow) return false;
    const { workArea } = screen.getPrimaryDisplay();
    if (enable) {
        if (preCanvasFullscreenBounds) return true; // already on
        preCanvasFullscreenBounds = mainWindow.getBounds();
        // Lift the max-size cap so setBounds isn't clamped back to 750x980.
        // Passing 0,0 means "no limit" per Electron docs.
        mainWindow.setMaximumSize(0, 0);
        lastSetWidth = workArea.width;
        lastSetHeight = workArea.height;
        mainWindow.setBounds({ x: workArea.x, y: workArea.y, width: workArea.width, height: workArea.height }, true);
        applyOverlayMode(false);
        return true;
    } else {
        if (!preCanvasFullscreenBounds) return false;
        mainWindow.setBounds(preCanvasFullscreenBounds, true);
        // Re-apply the overlay max-size cap that lives alongside the BrowserWindow
        // constructor options (750x1200 per the init code ~line 450).
        mainWindow.setMaximumSize(750, 1200);
        lastSetWidth = preCanvasFullscreenBounds.width;
        lastSetHeight = preCanvasFullscreenBounds.height;
        preCanvasFullscreenBounds = null;
        applyOverlayMode(true);
        return false;
    }
});
ipcMain.handle('canvas:is-fullscreen', () => !!preCanvasFullscreenBounds);

// Open a file at its original path via the OS default handler.
ipcMain.handle('canvas:open-path', async (_evt: any, filePath: string) => {
    try {
        const err = await shell.openPath(filePath);
        return { ok: !err, error: err || undefined };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

// Read a file from the sandbox workspace as base64. Used by canvas agent
// tools (pin_file, pin_image) that want to pin a file the agent produced via
// run_code. Route: sandbox saves the file to its shared folder (a Windows
// path), then we read that path and return bytes. Keeps the executor renderer-
// side while respecting that sandbox files can be binary (so we can't use
// sandbox:readFile which uses `cat`).
ipcMain.handle('canvas:read-sandbox-file-bytes', async (_evt: any, sandboxPath: string) => {
    try {
        if (!sandboxFileManager || !sandboxManager) {
            return { ok: false, error: 'Sandbox not available' };
        }
        if (!sandboxPath || sandboxPath.includes('..')) {
            return { ok: false, error: 'Invalid sandbox path' };
        }
        // Copy the sandbox file to the shared Windows folder under a unique name.
        const name = sandboxPath.split('/').pop() || 'pinned';
        const stem = `_pin_${Date.now().toString(36)}_${name}`;
        const windowsPath = `${sandboxManager.getSharedFolderWindows()}\\${stem}`;
        const copy = await sandboxFileManager.copyToWindows(sandboxPath, windowsPath);
        if (!copy.success) return { ok: false, error: copy.error || 'copy failed' };
        const buf = await fs.promises.readFile(windowsPath);
        // Clean up the transfer file — bytes are already in hand.
        fs.promises.unlink(windowsPath).catch(() => {});
        return { ok: true, base64: buf.toString('base64'), fileName: name, size: buf.length };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

// Scrape Open Graph / HTML metadata for a URL so the canvas can turn a
// pasted link into a preview card. Returns what we found; empty fields on
// failure. Kept deliberately small and tolerant — the card renders fine
// with just the URL even when scraping fails.
ipcMain.handle('canvas:fetch-link-metadata', async (_evt: any, url: string) => {
    try {
        if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        let html: string;
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal: controller.signal,
            });
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
            html = await res.text();
        } finally {
            clearTimeout(timer);
        }
        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        const pick = (sel: string, attr = 'content'): string | undefined => {
            const v = $(sel).attr(attr);
            return v ? String(v).trim() : undefined;
        };
        const title =
            pick('meta[property="og:title"]') ||
            pick('meta[name="twitter:title"]') ||
            $('title').first().text().trim() ||
            undefined;
        const description =
            pick('meta[property="og:description"]') ||
            pick('meta[name="twitter:description"]') ||
            pick('meta[name="description"]') ||
            undefined;
        const image =
            pick('meta[property="og:image"]') ||
            pick('meta[name="twitter:image"]') ||
            undefined;
        const siteName = pick('meta[property="og:site_name"]') || undefined;
        const iconHref =
            pick('link[rel="icon"]', 'href') ||
            pick('link[rel="shortcut icon"]', 'href') ||
            pick('link[rel="apple-touch-icon"]', 'href');
        // Resolve relative URLs against the original.
        const base = new URL(url);
        const absolutize = (href?: string) => {
            if (!href) return undefined;
            try { return new URL(href, base).toString(); } catch { return undefined; }
        };
        return {
            ok: true,
            title,
            description: description && description.length > 300 ? description.slice(0, 300) + '…' : description,
            imageUrl: absolutize(image),
            siteName: siteName || base.hostname,
            favicon: absolutize(iconHref) || `${base.origin}/favicon.ico`,
        };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

// Extract asset bytes to a temp file and open with the OS default handler.
// Used by FileItem "Open externally" when the original path is gone (e.g.
// the .any file was shared to another machine). Files are written under a
// single per-session temp dir so they get cleaned up by the OS eventually;
// we overwrite on repeat opens of the same asset so we don't pile copies.
const CANVAS_ASSET_TMP_DIR = path.join(os.tmpdir(), 'klypix-canvas-assets');
ipcMain.handle('canvas:open-asset-bytes', async (_evt: any, args: { fileName: string; base64: string }) => {
    try {
        if (!args?.fileName || !args?.base64) return { ok: false, error: 'missing fileName or base64' };
        if (!fs.existsSync(CANVAS_ASSET_TMP_DIR)) fs.mkdirSync(CANVAS_ASSET_TMP_DIR, { recursive: true });
        // Sanitize filename — keep the extension but strip path separators so a
        // malicious item can't escape the temp dir.
        const safeName = args.fileName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'asset';
        const outPath = path.join(CANVAS_ASSET_TMP_DIR, safeName);
        await fs.promises.writeFile(outPath, Buffer.from(args.base64, 'base64'));
        const err = await shell.openPath(outPath);
        return { ok: !err, path: outPath, error: err || undefined };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

// --- Canvas .any file I/O ---
// See docs/CLAUDE-KLYPIX-CANVAS.md §10 for the .any format.
//
// Asset payload contract (Slice 4.1+):
//   args.assets?: Array<{ path: string; base64: string }>
// path is a forward-slash ZIP-relative path, e.g. "assets/img_xyz.png".
// Renderer encodes bytes to base64 before sending across IPC; we decode here.
function decodeAssets(raw?: Array<{ path: string; base64: string }>): Array<{ path: string; bytes: Buffer }> | undefined {
    if (!raw || raw.length === 0) return undefined;
    return raw.map(a => ({ path: a.path, bytes: Buffer.from(a.base64, 'base64') }));
}

ipcMain.handle('canvas:save', async (_evt: any, args: { filePath: string; json: string; assets?: Array<{ path: string; base64: string }> }) => {
    try {
        const assets = decodeAssets(args.assets);
        console.log('[canvas:save] writing', args.filePath, 'json length:', args.json.length, 'assets:', assets?.length || 0);
        await saveAnyFile(args.filePath, { json: args.json, assets });
        console.log('[canvas:save] ok');
        return { ok: true, filePath: args.filePath };
    } catch (err: any) {
        console.error('[canvas:save] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:save-as', async (_evt: any, args: { json: string; defaultName?: string; assets?: Array<{ path: string; base64: string }> }) => {
    if (!mainWindow) return { ok: false, error: 'no window' };
    try {
        console.log('[canvas:save-as] opening dialog, default:', args.defaultName);
        const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
            // New canvases save as .klypix going forward. The codec writes the
            // same on-disk bytes either way today — only the extension changes.
            defaultPath: args.defaultName || 'untitled.klypix',
            // List .klypix first so the Save dialog shows the new extension as
            // the default; .any stays selectable for users who want to
            // overwrite an existing legacy file in place without auto-rename.
            filters: [{ name: 'KLYPIX Canvas', extensions: ['klypix', 'any'] }],
        });
        if (canceled || !filePath) {
            console.log('[canvas:save-as] cancelled');
            return { ok: false, cancelled: true };
        }
        const assets = decodeAssets(args.assets);
        await saveAnyFile(filePath, { json: args.json, assets });
        console.log('[canvas:save-as] wrote', filePath, 'assets:', assets?.length || 0);
        return { ok: true, filePath };
    } catch (err: any) {
        console.error('[canvas:save-as] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

// Crash-recovery autosave: write canvas.json to APPDATA/klypix/autosave/ so we
// can offer to restore on next launch if the app was killed mid-session.
const AUTOSAVE_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'klypix', 'autosave');
// New autosaves write to .klypix; the old .any path is checked at startup as a
// fallback so any in-flight autosave from a pre-rebrand session still recovers.
const AUTOSAVE_FILE = path.join(AUTOSAVE_DIR, 'untitled.klypix');
const LEGACY_AUTOSAVE_FILE = path.join(AUTOSAVE_DIR, 'untitled.any');

ipcMain.handle('canvas:autosave', async (_evt: any, args: { json: string; assets?: Array<{ path: string; base64: string }> }) => {
    try {
        if (!fs.existsSync(AUTOSAVE_DIR)) fs.mkdirSync(AUTOSAVE_DIR, { recursive: true });
        const assets = decodeAssets(args.assets);
        await saveAnyFile(AUTOSAVE_FILE, { json: args.json, assets });
        return { ok: true };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:check-autosave', async () => {
    try {
        // Prefer the new .klypix autosave; fall back to legacy .any so a crash
        // recovery from a pre-rebrand session still works.
        if (fs.existsSync(AUTOSAVE_FILE)) {
            const stat = fs.statSync(AUTOSAVE_FILE);
            return { exists: true, mtime: stat.mtimeMs, path: AUTOSAVE_FILE };
        }
        if (fs.existsSync(LEGACY_AUTOSAVE_FILE)) {
            const stat = fs.statSync(LEGACY_AUTOSAVE_FILE);
            return { exists: true, mtime: stat.mtimeMs, path: LEGACY_AUTOSAVE_FILE };
        }
        return { exists: false };
    } catch {
        return { exists: false };
    }
});

ipcMain.handle('canvas:clear-autosave', async () => {
    try {
        if (fs.existsSync(AUTOSAVE_FILE)) fs.unlinkSync(AUTOSAVE_FILE);
        if (fs.existsSync(LEGACY_AUTOSAVE_FILE)) fs.unlinkSync(LEGACY_AUTOSAVE_FILE);
        return { ok: true };
    }
    catch (err: any) { return { ok: false, error: err?.message || String(err) }; }
});

// Save decrypted shared-canvas bytes to a known local path so the existing
// openByPath flow can pick them up. Used by "Open shared canvas" in the
// dashboard — the renderer has the decrypted bytes (from
// syncClient.pull()), and we just need to write them to disk so the rest
// of the canvas system can treat them like any other .klypix file.
ipcMain.handle('canvas-shared:write-to-disk', async (_evt: any, args: { blobId: string; bytesBase64: string; preferredName?: string }) => {
    try {
        const dir = path.join(app.getPath('userData'), 'shared-canvases');
        await fs.promises.mkdir(dir, { recursive: true });
        const safeName = (args.preferredName || `klypix-shared-${args.blobId.slice(0, 8)}`)
            .replace(/[\\/:*?"<>|]+/g, '_')
            .slice(0, 64);
        const filePath = path.join(dir, `${safeName}.klypix`);
        const buf = Buffer.from(args.bytesBase64, 'base64');
        await fs.promises.writeFile(filePath, buf);
        return { ok: true, filePath };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:open-by-path', async (_evt: any, filePath: string) => {
    try {
        // Detect format from the file's manifest (or absence thereof) and
        // dispatch to the matching codec. v4 (.klypix new format) and v3
        // (.any legacy) return differently-shaped payloads — the renderer
        // discriminates on `formatVersion`.
        const fmt = await detectKlypixFormat(filePath);
        if (fmt === 'v4') {
            const loaded = await loadKlypixFile(filePath);
            return {
                ok: true,
                filePath,
                formatVersion: 'v4' as const,
                manifest: loaded.manifest,
                canvasJson: loaded.canvasJson,
                items: loaded.items,
                assetPaths: loaded.assetPaths,
                assets: loaded.assets,
            };
        }
        // Legacy v1/v2/v3 .any path. Same shape the renderer has handled forever.
        const loaded = await loadAnyFile(filePath);
        return {
            ok: true,
            filePath,
            formatVersion: 'v3' as const,
            json: loaded.json,
            assetPaths: loaded.assetPaths,
            assets: loaded.assets,
        };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:list-versions', async (_evt: any, filePath: string) => {
    try {
        if (!filePath) return { ok: false, versions: [] };
        const versions = await listAnyVersions(filePath);
        return { ok: true, versions };
    } catch (err: any) {
        return { ok: false, versions: [], error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:load-version', async (_evt: any, args: { filePath: string; versionPath: string }) => {
    try {
        const json = await loadAnyVersion(args.filePath, args.versionPath);
        if (!json) return { ok: false, error: 'version not found' };
        return { ok: true, json };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:open', async () => {
    if (!mainWindow) return { ok: false, error: 'no window' };
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            // Open dialog accepts both extensions so users with legacy .any files
            // see them in the picker without changing the filter.
            filters: [{ name: 'KLYPIX Canvas', extensions: ['klypix', 'any'] }],
        });
        if (result.canceled || result.filePaths.length === 0) return { ok: false, cancelled: true };
        const filePath = result.filePaths[0];
        // Reuse the same format-detection + dispatch logic as open-by-path.
        const fmt = await detectKlypixFormat(filePath);
        if (fmt === 'v4') {
            const loaded = await loadKlypixFile(filePath);
            return {
                ok: true,
                filePath,
                formatVersion: 'v4' as const,
                manifest: loaded.manifest,
                canvasJson: loaded.canvasJson,
                items: loaded.items,
                assetPaths: loaded.assetPaths,
                assets: loaded.assets,
            };
        }
        const loaded = await loadAnyFile(filePath);
        return {
            ok: true,
            filePath,
            formatVersion: 'v3' as const,
            json: loaded.json,
            assetPaths: loaded.assetPaths,
            assets: loaded.assets,
        };
    } catch (err: any) {
        console.error('[canvas:open] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

// ── v4 .klypix save handlers ──────────────────────────────────────────
// Separate IPC channels from canvas:save / canvas:save-as because the payload
// shape is fundamentally different (per-item JSON map vs single canvas.json).
// Renderer dispatches to these for new saves and Save-As operations targeting
// .klypix; existing .any files continue using the v3 save path until the user
// explicitly Save-As's them to .klypix.

ipcMain.handle('canvas:save-klypix', async (_evt: any, args: {
    filePath: string;
    manifestJson: string;
    canvasJson: string;
    items: Record<string, string>;
    assets?: Array<{ path: string; base64: string }>;
}) => {
    try {
        const assets = (args.assets || []).map(a => ({ path: a.path, bytes: Buffer.from(a.base64, 'base64') }));
        await saveKlypixFile(args.filePath, {
            manifestJson: args.manifestJson,
            canvasJson: args.canvasJson,
            items: args.items,
            assets,
        });
        return { ok: true };
    } catch (err: any) {
        console.error('[canvas:save-klypix] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.handle('canvas:save-klypix-as', async (_evt: any, args: {
    defaultName?: string;
    manifestJson: string;
    canvasJson: string;
    items: Record<string, string>;
    assets?: Array<{ path: string; base64: string }>;
}) => {
    if (!mainWindow) return { ok: false, error: 'no window' };
    try {
        const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: args.defaultName || 'untitled.klypix',
            filters: [{ name: 'KLYPIX Canvas', extensions: ['klypix', 'any'] }],
        });
        if (canceled || !filePath) return { ok: false, cancelled: true };
        const assets = (args.assets || []).map(a => ({ path: a.path, bytes: Buffer.from(a.base64, 'base64') }));
        await saveKlypixFile(filePath, {
            manifestJson: args.manifestJson,
            canvasJson: args.canvasJson,
            items: args.items,
            assets,
        });
        return { ok: true, filePath };
    } catch (err: any) {
        console.error('[canvas:save-klypix-as] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

// ── Embed subsystem v0 — extract + launch + watch + re-pack ───────────
// The feature that makes the .klypix "one file workspace" promise mean
// something. Drop a Word doc → click open → edit in Word → save → change
// lands back inside the .klypix automatically.

// Wire watcher events to the renderer so the per-item sync badge can update.
// Set once on app boot; replaced if mainWindow changes (e.g. after reload).
function wireEmbedEventBridge(): void {
    setEmbedEventSink((evt) => {
        try { mainWindow?.webContents.send('canvas:embed:sync-state', evt); } catch { /* ignore */ }
    });
}
wireEmbedEventBridge();

ipcMain.handle('canvas:embed:open-and-watch', async (_evt: any, args: {
    canvasFilePath: string;
    itemId: string;
    assetPath: string;
    fileName: string;
    base64: string;
}) => {
    return embedOpenAndWatch(args);
});

ipcMain.handle('canvas:embed:stop-watching', async (_evt: any, args: { workingPath: string }) => {
    embedStopWatching(args.workingPath);
    return { ok: true };
});

ipcMain.handle('canvas:embed:cleanup-canvas', async (_evt: any, args: { canvasFilePath: string; deleteWorkingDir?: boolean }) => {
    await embedCleanupCanvas(args.canvasFilePath, args.deleteWorkingDir);
    return { ok: true };
});

/**
 * Read the raw bytes of a saved canvas (.klypix or .any). Used by cloud share
 * to feed the encryption + upload pipeline — pushNew expects the full ZIP byte
 * payload, and we'd rather hand it the existing on-disk bytes than re-serialize
 * from in-memory state and risk drift between "what got saved" and "what got
 * shared". Returns base64 because IPC across the context bridge serializes
 * everything to JSON-safe shapes.
 */
ipcMain.handle('canvas:read-raw-bytes', async (_evt: any, args: { filePath: string }) => {
    try {
        if (!args?.filePath) return { ok: false, error: 'no filePath' };
        const buf = await fs.promises.readFile(args.filePath);
        return { ok: true, bytesBase64: buf.toString('base64'), sizeBytes: buf.length };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

ipcMain.on('set-ignore-mouse-events', (event: any, ignore: boolean, options: any) => {
    mainWindow?.setIgnoreMouseEvents(ignore, options);
});
ipcMain.handle('get-cursor-position', () => {
    return screen.getCursorScreenPoint();
});
ipcMain.handle('get-primary-display-size', () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.size; // Use screen size for snipping, not work area
    return { width, height };
});
ipcMain.handle('get-work-area-size', () => {
    const primaryDisplay = screen.getPrimaryDisplay();
    const { width, height } = primaryDisplay.workAreaSize;
    return { width, height };
});
ipcMain.on('copy-to-clipboard', (event: any, { text, html }: { text: string, html: string }) => {
    // Any caller using this IPC is doing an external-style copy (toolbar,
    // transcription card, code-block copy etc.) — NOT a canvas-clipboard
    // coherent copy. Release canvas ownership so the next paste reads
    // OS clipboard fresh instead of short-circuiting to stale in-memory
    // canvas items. Also disarm the "absorb" flag so this write doesn't
    // get swallowed by a leftover canvas:claim-clipboard.
    canvasOwnsClipboard = false;
    canvasClaimAbsorbNextChange = false;
    clipboard.write({
        text: text,
        html: html
    });
});
ipcMain.on('open-external', (_event: any, url: string) => {
    shell.openExternal(url);
});
ipcMain.on('resize-window', (event: any, newHeight: number, newWidth: number) => {
    if (mainWindow) {
        // If the user has manually touched the window size, stop automatic updates
        if (isManualResizeActive)
            return;
        const maxWidth = 750;
        const maxHeight = 980;
        const minWidth = 450;
        const minHeight = 320;
        // Clamp new height and width to max/min limits
        let finalHeight = Math.min(newHeight, maxHeight);
        finalHeight = Math.max(finalHeight, minHeight);
        let finalWidth = Math.min(newWidth || mainWindow.getSize()[0], maxWidth);
        finalWidth = Math.max(finalWidth, minWidth);
        const [currentX, currentY] = mainWindow.getPosition();
        // Update tracking variables BEFORE setting the size
        lastSetWidth = finalWidth;
        lastSetHeight = finalHeight;
        mainWindow.setBounds({ x: currentX, y: currentY, width: finalWidth, height: finalHeight }, true);
    }
});
ipcMain.handle('get-active-window-context', () => {
    return lastActiveWindow;
});
// ── Clipboard read for Smart Paste ──────────────────────────────────────
// Track which clipboard format was written most recently. The Windows
// clipboard doesn't expose "last format" directly — apps that copy text
// (Excel, Word, browsers) often put BOTH text AND a bitmap on the board,
// and we can't tell from a single snapshot which was the user's intent.
// Solution: poll the clipboard while the window is focused, fingerprint
// both text and image, and whichever fingerprint flipped most recently
// is the "last copy" by user intent.
let lastClipboardTextHash = '';
let lastClipboardImageHash = '';
let lastClipboardFilesHash = '';
let lastClipboardFormat: 'text' | 'image' | 'files' | 'none' = 'none';
// Canvas copy/paste coherence. When the renderer does a canvas-item copy it
// calls `canvas:claim-clipboard`; the flag stays true until pollClipboard
// observes an EXTERNAL clipboard change. One self-change (renderer writing
// its own text via navigator.clipboard.writeText) is absorbed so it doesn't
// flip ownership. This lets the renderer's paste handler trust a simple
// flag instead of racing the 400ms clipboard poll.
let canvasOwnsClipboard = false;
let canvasClaimAbsorbNextChange = false;

function fingerprintImage(): string {
    try {
        const img = clipboard.readImage();
        if (!img || img.isEmpty()) return '';
        const size = img.getSize();
        // PNG of a full image is slow if we do it on every poll — just use
        // size + a tiny slice of the bitmap buffer as a fingerprint.
        const bmp = img.toBitmap();
        const tail = bmp.length > 256 ? bmp.subarray(bmp.length - 128, bmp.length) : bmp;
        return `${size.width}x${size.height}:${bmp.length}:${tail.toString('base64')}`;
    } catch { return ''; }
}

function pollClipboard() {
    const text = (() => { try { return clipboard.readText() || ''; } catch { return ''; } })();
    const imgFp = fingerprintImage();
    const textChanged = text !== lastClipboardTextHash;
    const imageChanged = imgFp !== lastClipboardImageHash;
    if (textChanged && text) lastClipboardFormat = 'text';
    else if (imageChanged && imgFp) lastClipboardFormat = 'image';
    // Don't stomp a 'files' format here — the read-clipboard IPC sets it
    // after its PS call, and this poll doesn't fingerprint files (spawning
    // PowerShell every 400ms would be awful).
    if (!text && !imgFp && lastClipboardFormat !== 'files') lastClipboardFormat = 'none';
    if (textChanged || imageChanged) {
        if (canvasClaimAbsorbNextChange) {
            canvasClaimAbsorbNextChange = false;
        } else if (canvasOwnsClipboard) {
            canvasOwnsClipboard = false;
        }
    }
    lastClipboardTextHash = text;
    lastClipboardImageHash = imgFp;
}

// Poll every 400ms while KLYPIX is the focused app. Stopping the timer
// when unfocused means no CPU cost when the user is in another app, but
// we still catch the transition via the `focus` event below.
let clipboardPollTimer: NodeJS.Timeout | null = null;
function startClipboardPolling() {
    if (clipboardPollTimer) return;
    pollClipboard(); // seed immediately
    clipboardPollTimer = setInterval(pollClipboard, 400);
}
function stopClipboardPolling() {
    if (!clipboardPollTimer) return;
    clearInterval(clipboardPollTimer);
    clipboardPollTimer = null;
}

// Read paths of files copied to the Windows clipboard (Ctrl+C on an Explorer
// file). Electron's `clipboard.readBuffer('CF_HDROP')` does NOT work here —
// Chromium's clipboard abstraction treats the format string as a custom
// registered format, so it silently reads an empty buffer for standard
// Windows formats like CF_HDROP. PowerShell's `Get-Clipboard -Format
// FileDropList` is the reliable path (same PS reliance as the rest of the
// app's Windows-specific clipboard/window code). Async, ~200-400ms cost —
// only called from the read-clipboard IPC on paste, never from the 400ms
// poll.
async function readClipboardFilePathsAsync(): Promise<string[]> {
    try {
        const { stdout } = await execAsync(
            `powershell -NoProfile -NoLogo -Command "Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }"`,
            { timeout: 3000, windowsHide: true, encoding: 'utf8' },
        );
        if (!stdout) return [];
        return stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
    } catch { return []; }
}

ipcMain.handle('read-clipboard', async () => {
    // Fresh text/image fingerprints first (sync, fast).
    pollClipboard();
    const text = clipboard.readText();
    const html = clipboard.readHTML();
    let imageBase64: string | null = null;
    try {
        const img = clipboard.readImage();
        if (img && !img.isEmpty()) {
            imageBase64 = img.toPNG().toString('base64');
        }
    } catch { /* no-op */ }
    // File paths via PowerShell. Async (~200-400ms). Only pays this cost
    // on actual paste, not on every 400ms poll tick.
    const filePaths = await readClipboardFilePathsAsync();
    const filesFp = filePaths.join('|');
    const filesChanged = filesFp !== lastClipboardFilesHash;
    lastClipboardFilesHash = filesFp;
    // If the file list changed since the last IPC check AND the canvas
    // was claiming ownership, that's an external file copy — release
    // ownership so the renderer's paste handler sees the fresh file list
    // instead of short-circuiting to stale canvas items.
    if (filesChanged && filesFp) {
        lastClipboardFormat = 'files';
        if (canvasClaimAbsorbNextChange) canvasClaimAbsorbNextChange = false;
        else if (canvasOwnsClipboard) canvasOwnsClipboard = false;
    } else if (filesChanged && !filesFp && lastClipboardFormat === 'files') {
        // Files were cleared without text/image taking their place.
        lastClipboardFormat = text ? 'text' : (imageBase64 ? 'image' : 'none');
    }
    return { text, html, imageBase64, filePaths, lastFormat: lastClipboardFormat, canvasOwnsClipboard };
});

// Read an arbitrary file as raw bytes, returned base64-encoded. Used by
// canvas paste: when the OS clipboard holds CF_HDROP paths (files copied
// from Explorer), the renderer needs the bytes — not a UTF-8 string — so
// it can reconstruct File objects and route them through the same
// fileToItem pipeline drag-and-drop uses. 500MB cap matches MAX_MEDIA_BYTES
// in dropHandler.ts so paste and drop behave consistently.
ipcMain.handle('read-file-bytes', async (_event: any, opts: { filePath: string }) => {
    try {
        const stat = fs.statSync(opts.filePath);
        if (!stat.isFile()) return { success: false, error: 'Not a file' };
        const MAX = 500 * 1024 * 1024;
        if (stat.size > MAX) return { success: false, error: 'File too large (>500MB)' };
        const bytes = fs.readFileSync(opts.filePath);
        return {
            success: true,
            name: path.basename(opts.filePath),
            size: stat.size,
            base64: bytes.toString('base64'),
            path: opts.filePath,
        };
    } catch (err: any) { return { success: false, error: err.message }; }
});
ipcMain.handle('get-clipboard-formats', () => {
    return clipboard.availableFormats();
});
// Renderer calls this right before a canvas-originated copy (Ctrl+C on
// canvas items). `willWriteText` tells us whether the renderer is about
// to call navigator.clipboard.writeText — if so, one upcoming change is
// our own and should be absorbed. If not (image-only canvas copy), no
// self-change is expected and any subsequent change is external.
ipcMain.handle('canvas:claim-clipboard', (_e: any, willWriteText: boolean) => {
    canvasOwnsClipboard = true;
    canvasClaimAbsorbNextChange = !!willWriteText;
    return { ok: true };
});
// ── Encrypted API Key Storage ───────────────────────────────────────────
ipcMain.handle('api-key:store', (_event: any, key: string) => {
    storeApiKey(key);
    return { success: true };
});
ipcMain.handle('api-key:get', () => {
    return getApiKey();
});
ipcMain.handle('api-key:clear', () => {
    clearApiKey();
    return { success: true };
});

// ── Agent Engine: IPC Handlers ───────────────────────────────────────────

// -- Shell Command (secured, async) --
ipcMain.handle('run-shell-command', async (_event: any, opts: { command: string; timeout?: number }) => {
    const { command, timeout = 30000 } = opts;
    console.log('[Agent] Shell:', command.substring(0, 100));

    const blockedPatterns = [
        /del\s+\/[sfq]/i, /format\s+[a-z]:/i, /rm\s+-rf\s+\//,
        /shutdown\s+\/s/i, /taskkill\s+\/f/i, /bcdedit/i, /reg\s+delete/i,
        /Remove-Item.*-Recurse.*-Force/i, /Stop-Computer/i, /Restart-Computer/i,
        /Set-ExecutionPolicy/i, /Invoke-Expression/i, /Invoke-WebRequest.*\|\s*iex/i,
        /Start-Process.*-Verb\s+RunAs/i, /netsh\s+advfirewall/i, /cipher\s+\/[eE]/i,
    ];

    for (const pattern of blockedPatterns) {
        if (pattern.test(command)) {
            console.warn('[Agent] BLOCKED:', command.substring(0, 80));
            return { success: false, stdout: '', stderr: `Command blocked by security policy`, code: -1, blocked: true };
        }
    }

    try {
        const result = await Promise.race([
            execAsync(command, { shell: 'powershell.exe', maxBuffer: 1024 * 1024 * 5, encoding: 'utf8', timeout }),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Shell timeout: 30s exceeded')), timeout)),
        ]);
        const { stdout, stderr } = result as { stdout: string; stderr: string };
        return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
    } catch (err: any) {
        return { success: false, stdout: err.stdout?.trim() || '', stderr: err.stderr?.trim() || err.message, code: err.code };
    }
});

// -- Read File at Path --
ipcMain.handle('read-file-at-path', async (_event: any, opts: { filePath: string; maxChars?: number }) => {
    try {
        const stat = fs.statSync(opts.filePath);
        if (stat.size > 10 * 1024 * 1024) return { success: false, error: 'File too large (>10MB)' };
        const content = fs.readFileSync(opts.filePath, 'utf-8');
        const limit = opts.maxChars || 100000;
        return {
            success: true,
            content: content.length > limit ? content.slice(0, limit) + '\n[...truncated]' : content,
            size: content.length, path: opts.filePath,
        };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- Write File at Path --
ipcMain.handle('write-file-at-path', async (_event: any, opts: { filePath: string; content: string }) => {
    try {
        const dir = path.dirname(opts.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(opts.filePath, opts.content, 'utf-8');
        return { success: true, path: opts.filePath, size: opts.content.length };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- Edit File Content (find-and-replace) --
ipcMain.handle('edit-file-content', async (_event: any, opts: { filePath: string; oldText: string; newText: string }) => {
    try {
        let content = fs.readFileSync(opts.filePath, 'utf-8');
        if (!content.includes(opts.oldText)) return { success: false, error: 'oldText not found in file' };
        content = content.replace(opts.oldText, opts.newText);
        fs.writeFileSync(opts.filePath, content, 'utf-8');
        return { success: true, path: opts.filePath };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- List Directory --
ipcMain.handle('list-directory', async (_event: any, opts: { dirPath: string }) => {
    try {
        const entries = fs.readdirSync(opts.dirPath, { withFileTypes: true });
        return {
            success: true,
            entries: entries.slice(0, 200).map(e => ({
                name: e.name,
                type: e.isDirectory() ? 'directory' : 'file',
                size: e.isFile() ? fs.statSync(path.join(opts.dirPath, e.name)).size : undefined,
            })),
            total: entries.length,
        };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- Claude Key Storage (safeStorage) --
ipcMain.handle('claude-key:store', async (_event: any, key: string) => {
    try {
        const encPath = path.join(app.getPath('userData'), 'claude-key.enc');
        if (safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(key);
            fs.writeFileSync(encPath, encrypted);
        } else {
            fs.writeFileSync(encPath, key, 'utf-8');
        }
        return { success: true };
    } catch (err: any) { return { success: false, error: err.message }; }
});

ipcMain.handle('claude-key:get', async () => {
    try {
        const encPath = path.join(app.getPath('userData'), 'claude-key.enc');
        if (!fs.existsSync(encPath)) return null;
        const raw = fs.readFileSync(encPath);
        if (safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(raw);
        }
        return raw.toString('utf-8');
    } catch { return null; }
});

ipcMain.handle('claude-key:clear', async () => {
    try {
        const encPath = path.join(app.getPath('userData'), 'claude-key.enc');
        if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
        return { success: true };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- DeepSeek Key Storage (safeStorage) --
ipcMain.handle('deepseek-key:store', async (_event: any, key: string) => {
    try {
        const encPath = path.join(app.getPath('userData'), 'deepseek-key.enc');
        if (safeStorage.isEncryptionAvailable()) {
            const encrypted = safeStorage.encryptString(key);
            fs.writeFileSync(encPath, encrypted);
        } else {
            fs.writeFileSync(encPath, key, 'utf-8');
        }
        return { success: true };
    } catch (err: any) { return { success: false, error: err.message }; }
});

ipcMain.handle('deepseek-key:get', async () => {
    try {
        const encPath = path.join(app.getPath('userData'), 'deepseek-key.enc');
        if (!fs.existsSync(encPath)) return null;
        const raw = fs.readFileSync(encPath);
        if (safeStorage.isEncryptionAvailable()) {
            return safeStorage.decryptString(raw);
        }
        return raw.toString('utf-8');
    } catch { return null; }
});

ipcMain.handle('deepseek-key:clear', async () => {
    try {
        const encPath = path.join(app.getPath('userData'), 'deepseek-key.enc');
        if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
        return { success: true };
    } catch (err: any) { return { success: false, error: err.message }; }
});

// -- File existence (used by eval harness for artifact checks) --
ipcMain.handle('file:exists', async (_e: any, opts: { filePath: string }) => {
    try { return { exists: fs.existsSync(opts.filePath) }; }
    catch { return { exists: false }; }
});

// -- Agent Settings --
ipcMain.handle('agent:get-budget', async () => agentConfig.getConfig('budget', 5.0));
ipcMain.handle('agent:set-budget', async (_e: any, opts: { value: number }) => {
    agentConfig.setConfig('budget', opts.value); return { success: true };
});
ipcMain.handle('agent:get-daily-spend', async () => agentConfig.getTodaySpend());
ipcMain.handle('agent:add-daily-spend', async (_e: any, opts: { amount: number }) => {
    agentConfig.addTodaySpend(opts.amount); return { success: true };
});
ipcMain.handle('agent:reset-daily-spend', async () => {
    const today = new Date().toISOString().split('T')[0];
    agentConfig.setConfig(today, 0); return { success: true };
});
ipcMain.handle('agent:get-cost-history', async () => agentConfig.getSpendHistory());
ipcMain.handle('agent:get-enabled', async () => agentConfig.getConfig('enabled', true));
ipcMain.handle('agent:set-enabled', async (_e: any, opts: { value: boolean }) => {
    agentConfig.setConfig('enabled', opts.value); return { success: true };
});

// ── WSL2 Sandbox ────────────────────────────────────────────────────────

let sandboxManager: SandboxManager | null = null;
let sandboxExecutor: CommandExecutor | null = null;
let sandboxFileManager: FileManager | null = null;
let sandboxFallback: FallbackExecutor | null = null;
let sandboxReady = false;

// Pending approval resolver (set when agent requests approval, resolved by renderer)
let pendingApprovalResolve: ((approved: boolean) => void) | null = null;

async function initSandbox() {
    try {
        sandboxManager = new SandboxManager();
        const status = await sandboxManager.initialize();
        sandboxReady = status.available;

        if (sandboxReady) {
            const bridge = sandboxManager.getBridge();
            const config = sandboxManager.getConfig();
            sandboxFileManager = new FileManager(bridge, config);
            sandboxExecutor = new CommandExecutor(
                bridge, config,
                async (request: ApprovalRequest) => {
                    // Send approval request to renderer, wait for response
                    if (mainWindow) {
                        mainWindow.webContents.send('sandbox:approval-request', request);
                        return new Promise<boolean>((resolve) => {
                            pendingApprovalResolve = resolve;
                            // Auto-deny after 60s if no response
                            setTimeout(() => { if (pendingApprovalResolve === resolve) { resolve(false); pendingApprovalResolve = null; } }, 60000);
                        });
                    }
                    return false;
                },
                // Stream callback — forward live stdout/stderr events to renderer
                (event) => {
                    if (mainWindow) mainWindow.webContents.send('sandbox:stream', event);
                },
            );
            console.log('[Sandbox] WSL2 sandbox initialized successfully');
        } else {
            // Fallback to Windows-native execution
            sandboxFallback = new FallbackExecutor(sandboxManager.getConfig());
            console.log('[Sandbox] WSL2 not available, using Windows fallback');
        }

        if (mainWindow) {
            mainWindow.webContents.send('sandbox:status', status);
        }
    } catch (err) {
        console.warn('[Sandbox] Initialization failed:', err);
    }
}

ipcMain.handle('sandbox:status', async () => {
    if (sandboxManager) return sandboxManager.getStatus();
    return { available: false, distro: null, running: false, workspaceReady: false, diskUsageMB: 0, error: 'Not initialized' };
});

ipcMain.handle('sandbox:execute', async (_e: any, request: any) => {
    if (sandboxExecutor) return sandboxExecutor.execute(request);
    if (sandboxFallback) return sandboxFallback.executeCommand(request.command);
    return { exitCode: 1, stdout: '', stderr: 'Sandbox not available', durationMs: 0, truncated: false, timedOut: false, command: request.command };
});

ipcMain.handle('sandbox:readFile', async (_e: any, filePath: string) => {
    if (sandboxFileManager) return sandboxFileManager.readFile(filePath);
    if (sandboxFallback) return sandboxFallback.readFile(filePath);
    return { success: false, error: 'Sandbox not available', path: filePath };
});

ipcMain.handle('sandbox:writeFile', async (_e: any, filePath: string, content: string) => {
    if (sandboxFileManager) return sandboxFileManager.writeFile(filePath, content);
    if (sandboxFallback) return sandboxFallback.writeFile(filePath, content);
    return { success: false, error: 'Sandbox not available', path: filePath };
});

ipcMain.handle('sandbox:listDir', async (_e: any, dirPath: string) => {
    if (sandboxFileManager) return sandboxFileManager.listDirectory(dirPath);
    if (sandboxFallback) return sandboxFallback.listDirectory(dirPath);
    return { success: false, error: 'Sandbox not available', path: dirPath, entries: [] };
});

ipcMain.handle('sandbox:deleteFile', async (_e: any, filePath: string) => {
    if (sandboxFileManager) return sandboxFileManager.deleteFile(filePath);
    return { success: false, error: 'Sandbox not available', path: filePath };
});

ipcMain.handle('sandbox:copyFromShared', async (_e: any, filename: string, destination?: string) => {
    if (sandboxFileManager) {
        const dest = destination || `data/${filename}`;
        return sandboxFileManager.copyFile(`shared/${filename}`, dest);
    }
    return { success: false, error: 'Sandbox not available', path: filename };
});

ipcMain.handle('sandbox:saveToShared', async (_e: any, sourcePath: string, filename?: string) => {
    if (sandboxFileManager && sandboxManager) {
        const destName = filename || sourcePath.split('/').pop() || 'output';
        const windowsPath = `${sandboxManager.getSharedFolderWindows()}\\${destName}`;
        const result = await sandboxFileManager.copyToWindows(sourcePath, windowsPath);
        return { ...result, windowsPath };
    }
    return { success: false, error: 'Sandbox not available', path: sourcePath };
});

ipcMain.handle('sandbox:resetWorkspace', async () => {
    if (sandboxManager) { await sandboxManager.resetWorkspace(); return { success: true }; }
    return { success: false, error: 'Sandbox not available' };
});

ipcMain.handle('sandbox:approvalResponse', async (_e: any, approved: boolean) => {
    if (pendingApprovalResolve) {
        pendingApprovalResolve(approved);
        pendingApprovalResolve = null;
    }
    return { success: true };
});

// ── MCP (Model Context Protocol) ────────────────────────────────────────
ipcMain.handle('mcp:list-tools', async () => {
    try {
        return { success: true, tools: mcpManager.getAllTools() };
    } catch (err: any) {
        return { success: false, error: err.message, tools: [] };
    }
});

ipcMain.handle('mcp:execute-tool', async (_e: any, opts: { serverName: string; toolName: string; args: Record<string, any> }) => {
    try {
        const result = await mcpManager.executeTool(opts.serverName, opts.toolName, opts.args);
        return { success: true, result };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:get-servers', async () => {
    try {
        return { success: true, servers: mcpManager.getServerStatus() };
    } catch (err: any) {
        return { success: false, error: err.message, servers: [] };
    }
});

ipcMain.handle('mcp:connect-server', async (_e: any, config: any) => {
    try {
        const tools = await mcpManager.connectServer(config);
        return { success: true, toolCount: tools.length };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:disconnect-server', async (_e: any, opts: { name: string }) => {
    try {
        await mcpManager.disconnectServer(opts.name);
        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:add-server', async (_e: any, config: any) => {
    try {
        mcpManager.addServer(config);
        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:remove-server', async (_e: any, opts: { name: string }) => {
    try {
        await mcpManager.removeServer(opts.name);
        return { success: true };
    } catch (err: any) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('mcp:get-config-path', async () => {
    return { path: mcpManager.getConfigPath() };
});

ipcMain.handle('mcp:get-configs', async () => {
    return { servers: mcpManager.loadConfigs() };
});

ipcMain.handle('eye:execute-action', async (_event: any, intent: any) => {
    console.log('[Main] Executing Action:', intent.type, intent.parameters);
    const ts = new Date().toISOString();
    try {
        switch (intent.type) {
            // ── System ──────────────────────────────────────────
            case 'system_open': {
                const appName = intent.parameters.appName || intent.parameters.appPath;
                if (appName) {
                    shell.openPath(appName);
                    exec(`start "" "${appName}"`, (err) => {
                        if (err)
                            console.error("Exec open failed:", err);
                    });
                    return { success: true, intentType: 'system_open', message: `Opened ${appName}`, executedAt: ts };
                }
                break;
            }
            case 'system_type': {
                const text = intent.parameters.text;
                if (text) {
                    // SendKeys via PowerShell — types text into the focused window
                    const escaped = text.replace(/[+^%~(){}[\]]/g, '{$&}');
                    const ps = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait("${escaped.replace(/"/g, '`"')}")`;
                    await new Promise<void>((resolve, reject) => {
                        exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err) => err ? reject(err) : resolve());
                    });
                    return { success: true, intentType: 'system_type', message: `Typed: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`, executedAt: ts };
                }
                break;
            }
            case 'system_screenshot': {
                // Reuse existing capture-screen handler
                if (mainWindow) {
                    mainWindow.hide();
                    await new Promise(r => setTimeout(r, 300));
                    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
                    mainWindow.show();
                    if (sources.length > 0) {
                        const img = sources[0].thumbnail.toPNG();
                        const dest = intent.parameters.destination || path.join(app.getPath('desktop'), `screenshot_${Date.now()}.png`);
                        fs.writeFileSync(dest, img);
                        return { success: true, intentType: 'system_screenshot', message: `Screenshot saved to ${dest}`, executedAt: ts };
                    }
                }
                break;
            }
            case 'system_click': {
                // Attempt UIAutomation InvokePattern via PowerShell
                const target = intent.parameters.targetDescription;
                if (target) {
                    const ps = `
                        Add-Type -AssemblyName UIAutomationClient
                        Add-Type -AssemblyName UIAutomationTypes
                        $root = [System.Windows.Automation.AutomationElement]::RootElement
                        $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, "${target.replace(/"/g, '`"')}")
                        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
                        if ($el) {
                            $pattern = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                            $pattern.Invoke()
                            Write-Output "CLICKED"
                        } else { Write-Output "NOT_FOUND" }
                    `.trim();
                    const result = await new Promise<string>((resolve) => {
                        exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, (err, stdout) => resolve(err ? 'ERROR' : stdout.trim()));
                    });
                    if (result === 'CLICKED') {
                        return { success: true, intentType: 'system_click', message: `Clicked "${target}"`, executedAt: ts };
                    }
                    return { success: false, intentType: 'system_click', message: `Could not find button "${target}"`, executedAt: ts };
                }
                break;
            }
            case 'system_close': {
                const appName = intent.parameters.appName || intent.parameters.targetDescription;
                if (appName) {
                    const safeName = appName.replace(/"/g, '');
                    await new Promise<void>((resolve) => {
                        exec(`powershell -NoProfile -Command "Get-Process | Where-Object { $_.ProcessName -like '*${safeName}*' -or $_.MainWindowTitle -like '*${safeName}*' } | ForEach-Object { $_.CloseMainWindow() | Out-Null }"`, () => resolve());
                    });
                    return { success: true, intentType: 'system_close', message: `Closing ${appName}`, executedAt: ts };
                }
                break;
            }
            // ── File System ─────────────────────────────────────
            case 'file_save': {
                const dest = intent.parameters.destination;
                const pathStr = intent.parameters.sourcePath;
                if (dest && pathStr && fs.existsSync(pathStr)) {
                    const finalDest = fs.lstatSync(dest).isDirectory() ? path.join(dest, path.basename(pathStr)) : dest;
                    fs.copyFileSync(pathStr, finalDest);
                    return { success: true, intentType: 'file_save', message: `Saved to ${finalDest}`, undoPayload: { type: 'delete', path: finalDest }, executedAt: ts };
                }
                break;
            }
            case 'file_rename': {
                const src = intent.parameters.sourcePath;
                const newName = intent.parameters.newName;
                if (src && newName && fs.existsSync(src)) {
                    const dir = path.dirname(src);
                    const newPath = path.join(dir, newName);
                    const oldName = path.basename(src);
                    fs.renameSync(src, newPath);
                    return { success: true, intentType: 'file_rename', message: `Renamed to ${newName}`, undoPayload: { type: 'rename', from: newPath, originalName: oldName }, executedAt: ts };
                }
                break;
            }
            case 'file_move': {
                const src = intent.parameters.sourcePath;
                const dest = intent.parameters.destination;
                if (src && dest && fs.existsSync(src)) {
                    const finalDest = fs.lstatSync(dest).isDirectory() ? path.join(dest, path.basename(src)) : dest;
                    fs.renameSync(src, finalDest);
                    return { success: true, intentType: 'file_move', message: `Moved to ${finalDest}`, undoPayload: { type: 'move', from: finalDest, to: src }, executedAt: ts };
                }
                break;
            }
            case 'file_create': {
                const dest = intent.parameters.destination || intent.parameters.newName;
                const content = intent.parameters.content || '';
                if (dest) {
                    let filePath;
                    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
                        // dest is a directory — need a filename
                        const name = intent.parameters.newName || `new_file_${Date.now()}.txt`;
                        filePath = path.join(dest, name);
                    }
                    else if (path.isAbsolute(dest)) {
                        filePath = dest;
                    }
                    else {
                        filePath = path.join(app.getPath('desktop'), dest);
                    }
                    fs.writeFileSync(filePath, content, 'utf-8');
                    return { success: true, intentType: 'file_create', message: `Created ${path.basename(filePath)}`, undoPayload: { type: 'delete', path: filePath }, executedAt: ts };
                }
                break;
            }
            case 'file_delete': {
                const src = intent.parameters.sourcePath;
                if (src && fs.existsSync(src)) {
                    // Move to Recycle Bin (reversible)
                    await shell.trashItem(src);
                    return { success: true, intentType: 'file_delete', message: `Moved to Recycle Bin: ${path.basename(src)}`, executedAt: ts };
                }
                break;
            }
            // ── Clipboard ───────────────────────────────────────
            case 'clipboard_copy': {
                const text = intent.parameters.text;
                if (text) {
                    const previous = clipboard.readText();
                    clipboard.writeText(text);
                    return { success: true, intentType: 'clipboard_copy', message: "Copied to clipboard", undoPayload: { type: 'clipboard_restore', text: previous }, executedAt: ts };
                }
                break;
            }
            case 'clipboard_save': {
                const text = clipboard.readText();
                if (text) {
                    const filename = intent.parameters.filename || `clipboard_${Date.now()}.txt`;
                    const dest = intent.parameters.destination || app.getPath('desktop');
                    let filePath;
                    if (fs.existsSync(dest) && fs.statSync(dest).isDirectory()) {
                        filePath = path.join(dest, filename);
                    }
                    else if (path.isAbsolute(dest) && path.extname(dest)) {
                        filePath = dest; // dest is a full file path
                    }
                    else {
                        filePath = path.join(app.getPath('desktop'), filename);
                    }
                    fs.writeFileSync(filePath, text, 'utf-8');
                    return { success: true, intentType: 'clipboard_save', message: `Clipboard saved to ${path.basename(filePath)}`, undoPayload: { type: 'delete', path: filePath }, executedAt: ts };
                }
                return { success: false, intentType: 'clipboard_save', message: 'Clipboard is empty', executedAt: ts };
            }
            // ── Browser ─────────────────────────────────────────
            case 'browser_navigate': {
                const url = intent.parameters.url;
                if (url) {
                    shell.openExternal(url.startsWith('http') ? url : `https://${url}`);
                    return { success: true, intentType: 'browser_navigate', message: `Opening ${url}`, executedAt: ts };
                }
                break;
            }
            case 'browser_fill':
            case 'browser_click':
            case 'browser_scroll': {
                // CDP-based browser automation with SendKeys fallback
                const cdpResult = await tryBrowserCdpAction(intent);
                if (cdpResult)
                    return { ...cdpResult, executedAt: ts };
                // Fallback: SendKeys for basic operations
                if (intent.type === 'browser_scroll') {
                    const direction = (intent.parameters.value || 'down').toLowerCase();
                    const key = direction === 'up' ? '{PGUP}' : '{PGDN}';
                    await new Promise<void>((resolve) => {
                        exec(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')"`, () => resolve());
                    });
                    return { success: true, intentType: 'browser_scroll', message: `Scrolled ${direction}`, executedAt: ts };
                }
                return { success: false, intentType: intent.type, message: 'CDP not available and no SendKeys fallback for this action. Restart browser with debug port enabled.', executedAt: ts };
            }
        }
        return { success: false, intentType: intent.type || 'unknown', message: "Missing required parameters.", executedAt: ts };
    }
    catch (err: any) {
        console.error('[Main] Action execution error:', err);
        return { success: false, intentType: intent.type || 'unknown', message: err.message, executedAt: ts };
    }
});
// ── CDP browser automation helper ───────────────────────────────────────
async function tryBrowserCdpAction(intent: any) {
    try {
        // Try known CDP ports
        const ports = [9222, 9223, 9224, 9225, 9226];
        for (const port of ports) {
            try {
                const resp = await fetch(`http://127.0.0.1:${port}/json`);
                if (!resp.ok)
                    continue;
                const tabs = await resp.json();
                const activeTab = tabs.find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
                if (!activeTab)
                    continue;
                const WebSocket = require('ws');
                const ws = new WebSocket(activeTab.webSocketDebuggerUrl);
                return await new Promise((resolve) => {
                    const timeout = setTimeout(() => { ws.close(); resolve(null); }, 5000);
                    ws.on('open', () => {
                        let jsCode = '';
                        if (intent.type === 'browser_click') {
                            const sel = intent.parameters.selector || '';
                            const desc = intent.parameters.targetDescription || '';
                            jsCode = sel
                                ? `document.querySelector('${sel.replace(/'/g, "\\'")}')?.click(); 'CLICKED'`
                                : `(() => { const els = [...document.querySelectorAll('button, a, [role=button], input[type=submit]')]; const el = els.find(e => e.textContent.trim().toLowerCase().includes('${desc.toLowerCase().replace(/'/g, "\\'")}')); if (el) { el.click(); return 'CLICKED'; } return 'NOT_FOUND'; })()`;
                        }
                        else if (intent.type === 'browser_fill') {
                            const sel = intent.parameters.selector || '';
                            const val = (intent.parameters.value || '').replace(/'/g, "\\'");
                            const desc = intent.parameters.targetDescription || '';
                            jsCode = sel
                                ? `(() => { const el = document.querySelector('${sel.replace(/'/g, "\\'")}'); if (el) { el.value = '${val}'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'FILLED'; } return 'NOT_FOUND'; })()`
                                : `(() => { const els = [...document.querySelectorAll('input, textarea, select')]; const el = els.find(e => (e.placeholder||'').toLowerCase().includes('${desc.toLowerCase().replace(/'/g, "\\'")}') || (e.name||'').toLowerCase().includes('${desc.toLowerCase().replace(/'/g, "\\'")}')); if (el) { el.value = '${val}'; el.dispatchEvent(new Event('input', {bubbles:true})); return 'FILLED'; } return 'NOT_FOUND'; })()`;
                        }
                        else if (intent.type === 'browser_scroll') {
                            const dir = (intent.parameters.value || 'down').toLowerCase();
                            const px = dir === 'up' ? -600 : 600;
                            jsCode = `window.scrollBy(0, ${px}); 'SCROLLED'`;
                        }
                        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: jsCode } }));
                        ws.on('message', (data: any) => {
                            clearTimeout(timeout);
                            try {
                                const msg = JSON.parse(data.toString());
                                const val = msg?.result?.result?.value;
                                ws.close();
                                if (val === 'CLICKED' || val === 'FILLED' || val === 'SCROLLED') {
                                    resolve({ success: true, intentType: intent.type, message: `${val.charAt(0) + val.slice(1).toLowerCase()} via CDP` });
                                }
                                else {
                                    resolve({ success: false, intentType: intent.type, message: val === 'NOT_FOUND' ? 'Element not found on page' : 'CDP action failed' });
                                }
                            }
                            catch {
                                ws.close();
                                resolve(null);
                            }
                        });
                    });
                    ws.on('error', () => { clearTimeout(timeout); resolve(null); });
                });
            }
            catch {
                continue;
            }
        }
    }
    catch { /* fall through */ }
    return null;
}
// IPC: Read PDF with password (for password-protected PDFs)
ipcMain.handle('read-pdf-with-password', async (_event: any, filePath: string, password: string) => {
    try {
        const result = await readPdfFromDisk(filePath, { password });
        if (result.needsPassword) {
            return { error: 'Incorrect password', needsPassword: true };
        }
        return { content: result.content, pageCount: result.pageCount };
    }
    catch (err: any) {
        return { error: err.message };
    }
});
/**
 * Resolve a file from a window title and read its content.
 * Used by both pre-capture (before overlay shows) and the read-active-file IPC handler.
 * Returns { fileName, content, pageCount, truncated } or { error }.
 */
async function readFileByTitle(windowTitle: string): Promise<{ fileName?: string; content?: string; pageCount?: number; truncated?: boolean; error?: string; needsPassword?: boolean; localPath?: string }> {
    if (!windowTitle) return { error: 'No window title provided' };

    const supportedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.pptx'];
    const fileExtPattern = /\.(?:pdf|docx?|xlsx?|csv|txt|pptx)/i;

    // Skip browser windows — those are handled by web content fetching
    const browserNames = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave', 'Opera'];
    if (browserNames.some(b => windowTitle.includes(b))) return { error: 'Browser window — use web content fetch' };

    // Skip known non-file apps
    const procName = lastActiveWindow.process?.toLowerCase() || '';
    const isKnownNonFileApp = ['code', 'windowsterminal', 'cmd', 'powershell', 'wt',
        'discord', 'slack', 'spotify', 'steam', 'explorer', 'whatsapp', 'telegram',
        'figma', 'photoshop', 'illustrator', 'teams', 'zoom'].some(p => procName.includes(p));
    if (isKnownNonFileApp && !fileExtPattern.test(windowTitle)) {
        return { error: `Active window (${lastActiveWindow.process}) is not a document viewer.` };
    }

    // Extract filename from window title
    let candidateName = windowTitle;
    const appSuffixes = [
        /\s+[-\u2013]\s+Excel$/i, /\s+[-\u2013]\s+Word$/i, /\s+[-\u2013]\s+PowerPoint$/i,
        /\s+[-\u2013]\s+Google Chrome$/i, /\s+[-\u2013]\s+Microsoft\u200b? ?Edge$/i,
        /\s+[-\u2013]\s+Mozilla Firefox$/i, /\s+[-\u2013]\s+Adobe Acrobat.*$/i, /\s+[-\u2013]\s+Foxit.*$/i,
        /\s+[•\u2022]\s+Saved\s+to\s+.*$/i, /\s+[•\u2022]\s+AutoSaved.*$/i,
        /\s+\[Compatibility Mode\]$/i, /\s+\(Protected View\)$/i,
    ];
    for (const suffix of appSuffixes) candidateName = candidateName.replace(suffix, '');

    // Extract filename with extension
    const fileExtRegex = /(.+\.(?:pdf|docx?|xlsx?|csv|txt|pptx))/i;
    const nameMatch = candidateName.match(fileExtRegex);
    if (nameMatch) candidateName = decodeURIComponent(nameMatch[1].trim());
    else candidateName = decodeURIComponent(candidateName.trim());

    if (!candidateName || candidateName.length < 2) return { error: 'Could not extract filename from title' };

    console.log(`[readFileByTitle] Looking for: "${candidateName}" from title: "${windowTitle.substring(0, 60)}"`);

    // Search for the file on disk
    let detectedPath: string | null = null;

    // Check full path in title first
    const fullPathMatch = windowTitle.match(/([A-Za-z]:\\[^"*?<>|]+\.(?:pdf|docx?|xlsx?|csv|txt|pptx))/i);
    if (fullPathMatch && fs.existsSync(fullPathMatch[1])) {
        detectedPath = fullPathMatch[1];
    }

    // Search common folders + all available drives
    if (!detectedPath) {
        const userProfile = process.env?.USERPROFILE || 'C:\\Users\\HP';
        const searchDirs = [
            `${userProfile}\\Desktop`,
            `${userProfile}\\Documents`,
            `${userProfile}\\Downloads`,
            `${userProfile}\\OneDrive\\Desktop`,
            `${userProfile}\\OneDrive\\Documents`,
            // Also check other drives root + common folders
            'E:\\',
            'D:\\',
        ].filter(Boolean) as string[];
        for (const dir of searchDirs) {
            const candidate = path.join(dir, candidateName);
            if (fs.existsSync(candidate)) { detectedPath = candidate; break; }
        }
    }

    // Search Windows Recent shortcuts
    if (!detectedPath) {
        try {
            const lnkScript = path.join(require('os').tmpdir(), 'klypix_lnk2.ps1');
            const safeLnkFilter = candidateName.replace(/'/g, "''") + ".lnk";
            fs.writeFileSync(lnkScript, '\ufeff' + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $f = Get-ChildItem -Path "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter '${safeLnkFilter}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $sh = (New-Object -COM WScript.Shell).CreateShortcut($f.FullName); $sh.TargetPath }`, 'utf8');
            const { stdout: target } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${lnkScript}"`, { encoding: 'utf8', timeout: 5000 });
            try { fs.unlinkSync(lnkScript); } catch {}
            const resolved = target.trim();
            if (resolved && fs.existsSync(resolved)) detectedPath = resolved;
        } catch {}
    }

    // Strategy 3: Excel COM automation — read from running Excel instance (cloud files)
    if (!detectedPath && /\.xlsx?$/i.test(candidateName)) {
        console.log(`[readFileByTitle] File not on disk, trying Excel COM automation for "${candidateName}"`);
        try {
            const comScript = path.join(require('os').tmpdir(), 'klypix_excel_com.ps1');
            const safeWorkbookName = candidateName.replace(/'/g, "''");
            // PowerShell script that connects to running Excel and exports all sheets as CSV
            fs.writeFileSync(comScript, '\ufeff' + [
                '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
                'try {',
                '  $excel = [System.Runtime.InteropServices.Marshal]::GetActiveObject("Excel.Application")',
                `  $wb = $null; foreach ($w in $excel.Workbooks) { if ($w.Name -like '${safeWorkbookName}*') { $wb = $w; break } }`,
                '  if (-not $wb) { foreach ($w in $excel.Workbooks) { $wb = $w; break } }', // fallback: first open workbook
                '  if (-not $wb) { Write-Output "ERROR:No open workbook found"; exit 1 }',
                '  $output = ""',
                '  foreach ($sheet in $wb.Sheets) {',
                '    $output += "=== Sheet: " + $sheet.Name + " ===" + [Environment]::NewLine',
                '    $range = $sheet.UsedRange',
                '    if ($range -and $range.Rows.Count -gt 0) {',
                '      for ($r = 1; $r -le [Math]::Min($range.Rows.Count, 200); $r++) {',
                '        $row = @()',
                '        for ($c = 1; $c -le [Math]::Min($range.Columns.Count, 30); $c++) {',
                '          $cell = $range.Cells.Item($r, $c)',
                '          $val = if ($cell.Value2 -ne $null) { $cell.Value2.ToString() } else { "" }',
                '          $row += $val',
                '        }',
                '        $output += ($row -join ",") + [Environment]::NewLine',
                '      }',
                '    }',
                '    $output += [Environment]::NewLine',
                '  }',
                '  Write-Output $output',
                '} catch { Write-Output ("ERROR:" + $_.Exception.Message) }',
            ].join('\n'), 'utf8');
            const { stdout: comOutput } = await execAsync(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${comScript}"`,
                { timeout: 15000, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024 },
            );
            try { fs.unlinkSync(comScript); } catch {}

            if (comOutput && !comOutput.startsWith('ERROR:')) {
                const content = comOutput.trim();
                const sheetCount = (content.match(/=== Sheet:/g) || []).length;
                console.log(`[readFileByTitle] Excel COM: ${content.length} chars, ${sheetCount} sheets`);
                const MAX_CHARS = 60000;
                const truncated = content.length > MAX_CHARS;
                return {
                    fileName: candidateName,
                    pageCount: sheetCount,
                    content: truncated ? content.slice(0, MAX_CHARS) + '\n\n[... truncated]' : content,
                    truncated,
                };
            } else {
                console.log(`[readFileByTitle] Excel COM failed: ${comOutput?.substring(0, 100)}`);
            }
        } catch (err: any) {
            console.log(`[readFileByTitle] Excel COM error: ${err.message}`);
        }
    }

    if (!detectedPath) return { error: `Could not locate "${candidateName}" on disk.` };

    console.log(`[readFileByTitle] Found: ${detectedPath}`);

    // Parse file content
    const ext = path.extname(detectedPath).toLowerCase();
    const fileName = path.basename(detectedPath);
    if (!supportedExts.includes(ext)) return { error: `Unsupported file type: ${ext}`, fileName };

    try {
        let content = '';
        let pageCount = 0;
        if (ext === '.pdf') {
            const pdfResult = await readPdfFromDisk(detectedPath);
            if (pdfResult.needsPassword) return { error: 'Password-protected PDF', needsPassword: true, localPath: detectedPath, fileName };
            content = pdfResult.content; pageCount = pdfResult.pageCount;
        } else if (ext === '.docx' || ext === '.doc') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: detectedPath });
            content = result.value; pageCount = Math.ceil(content.split('\n').length / 30);
        } else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(detectedPath);
            pageCount = workbook.SheetNames.length;
            const parts: string[] = [];
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
            }
            content = parts.join('\n\n');
        } else if (ext === '.txt') {
            content = fs.readFileSync(detectedPath, 'utf-8');
            pageCount = Math.ceil(content.split('\n').length / 50);
        } else if (ext === '.pptx') {
            const officeParser = require('officeparser');
            content = await new Promise((resolve, reject) => {
                officeParser.parseOffice(detectedPath, (data: any, err: any) => { if (err) reject(err); else resolve(data); });
            });
            pageCount = (content.match(/\n{3,}/g) || []).length + 1;
        }
        const MAX_CHARS = 60000;
        const truncated = content.length > MAX_CHARS;
        if (truncated) content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';
        return { fileName, pageCount, content, truncated };
    } catch (err: any) {
        return { error: `Failed to read ${fileName}: ${err.message}` };
    }
}

ipcMain.handle('read-active-file', async () => {
    try {
        // Write a temp PS1 script to avoid ANY quoting/escaping issues
        const os = require('os');
        // We need the ACTUAL foreground window, not just any process window
        const tmpScript = path.join(os.tmpdir(), 'klypix_enum.ps1');
        fs.writeFileSync(tmpScript, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public class Win32 {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  }
"@
$hwnd = [Win32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 1024
$len = [Win32]::GetWindowText($hwnd, $sb, 1024)
if ($len -gt 0) {
    Write-Output $sb.ToString()
}
            `, 'utf8');
        // Give the OS a tiny moment if the user just clicked away from our app
        await new Promise(r => setTimeout(r, 100));
        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`);
        try {
            fs.unlinkSync(tmpScript);
        }
        catch (_) { }
        let windowTitle = stdout.trim();
        const supportedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.pptx'];
        const fileExtPattern = /\.(?:pdf|docx?|xlsx?|csv|txt|pptx)/i;

        // ALWAYS prefer pre-captured lastActiveWindow title — GetForegroundWindow returns KLYPIX
        // because Alt+Space activates the overlay before this handler runs.
        // The persistent PS scanner captures the REAL foreground window BEFORE overlay shows.
        const isOurWindow = !windowTitle || windowTitle === 'KLYPIX' || windowTitle.toLowerCase() === 'electron';
        if (isOurWindow || (lastActiveWindow.title && lastActiveWindow.title !== 'Unknown' && fileExtPattern.test(lastActiveWindow.title))) {
            if (lastActiveWindow.title && lastActiveWindow.title !== 'Unknown') {
                console.log(`[read-active-file] Using pre-captured title: "${lastActiveWindow.title}" (foreground was: "${windowTitle}")`);
                windowTitle = lastActiveWindow.title;
            }
        }
        const browserNames = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave', 'Opera'];
        const isBrowser = browserNames.some(b => windowTitle.includes(b));
        // --- NEW BROWSER INTEGRATION ---
        // If it's a browser, we use UIAutomation to find the exact URL or local file path
        if (isBrowser) {
            // Extract the URL using reusable UIAutomation helper
            const targetUrl = await extractBrowserUrl();
            if (!targetUrl) {
                return { error: 'Could not extract a valid URL or File path from the active browser tab.', windowTitle };
            }
            try {
                // If it's a local file URL
                if (targetUrl.startsWith('file:///')) {
                    // Extract the authentic path
                    let localPath = targetUrl.replace('file:///', '');
                    localPath = decodeURIComponent(localPath);
                    // Handle windows drive lettering (file:///C:/... vs file:///C|/...)
                    if (localPath.match(/^[a-zA-Z]\|/)) {
                        localPath = localPath.replace('|', ':');
                    }
                    if (!localPath.match(/^[a-zA-Z]:/)) {
                        localPath = localPath.replace(/^\//, ''); // strip leading slash if C:/...
                    }
                    if (fs.existsSync(localPath) && localPath.toLowerCase().endsWith('.pdf')) {
                        const pdfResult = await readPdfFromDisk(localPath);
                        if (pdfResult.needsPassword) {
                            return { fileName: path.basename(localPath), pageCount: 0, content: '', error: 'Password-protected PDF', needsPassword: true, localPath };
                        }
                        return { fileName: path.basename(localPath), pageCount: pdfResult.pageCount, content: pdfResult.content, truncated: pdfResult.content.length >= 60000 };
                    }
                    // If it's another local file type inside browser, we fall through to the main logic below
                    // by artificially updating detectedPath to localPath and returning it directly.
                    // But first, let's just abort this branch and let the fallback mechanism catch it
                    // if that's safer, OR we could just return early here.
                    // Let's break out so the fallback takes over with the detected window title.
                }
                // If the URL is directly to a network PDF in the browser
                if (targetUrl.toLowerCase().endsWith('.pdf') && targetUrl.startsWith('http')) {
                    const response = await fetch(targetUrl, {
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
                    });
                    if (!response.ok) {
                        return { error: `Failed to fetch PDF: HTTP ${response.status}`, windowTitle };
                    }
                    const arrayBuffer = await response.arrayBuffer();
                    // Save to temp file and use centralized reader (handles password + OCR)
                    const tmpPdf = path.join(os.tmpdir(), `klypix_dl_${Date.now()}.pdf`);
                    fs.writeFileSync(tmpPdf, Buffer.from(arrayBuffer));
                    const pdfResult = await readPdfFromDisk(tmpPdf);
                    try {
                        fs.unlinkSync(tmpPdf);
                    }
                    catch (_) { }
                    if (pdfResult.needsPassword) {
                        return { error: 'This PDF is password-protected.', windowTitle, needsPassword: true };
                    }
                    let content = pdfResult.content;
                    let pageCount = pdfResult.pageCount;
                    const truncated = content.length >= 60000;
                    let fileName: string = targetUrl.split('/').pop() || targetUrl;
                    fileName = decodeURIComponent(fileName);
                    return { fileName, pageCount, content, truncated };
                }
                // Normal webpage extraction
                const response = await fetch(targetUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
                });
                if (!response.ok) {
                    return { error: `Failed to fetch webpage: HTTP ${response.status}`, windowTitle };
                }
                const html = await response.text();
                // Parse HTML to raw text using cheerio
                const cheerio = require('cheerio');
                const $ = cheerio.load(html);
                // Remove noisy elements
                $('script, style, noscript, nav, footer, header, svg, iframe, .ads, .advertisement').remove();
                // Extract clean text
                let content = $('body').text().replace(/\s+/g, ' ').trim();
                // Trim to max length
                const MAX_CHARS = 60000;
                const truncated = content.length > MAX_CHARS;
                if (truncated)
                    content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';
                // We fake "pageCount" as an abstract metric (1 page per 500 words)
                const wordCount = content.split(' ').length;
                const pageCount = Math.max(1, Math.ceil(wordCount / 500));
                // Extract a clean filename from title (remove application name)
                let browserTabName = windowTitle;
                for (const b of browserNames) {
                    browserTabName = browserTabName.replace(new RegExp(`\\s+[-\u2013]\\s+${b}.*$`, 'i'), '');
                }
                return { fileName: browserTabName.trim() || targetUrl, pageCount, content, truncated };
            }
            catch (err) {
                return { error: `Error extracting webpage content`, windowTitle };
            }
        }
        // If the title has no file extension, check if we should scan background processes.
        // ONLY scan when title is empty/KLYPIX (we truly don't know what's foreground).
        // Do NOT scan when we know the foreground app (VS Code, terminal, etc.) — it would
        // pick up minimized PDFs/Excel files that have nothing to do with the current screen.
        if (!fileExtPattern.test(windowTitle)) {
            const knownProcess = lastActiveWindow.process?.toLowerCase() || '';
            const isKnownNonFileApp = ['code', 'windowsterminal', 'cmd', 'powershell', 'wt',
                'discord', 'slack', 'spotify', 'steam', 'explorer', 'whatsapp', 'telegram',
                'figma', 'photoshop', 'illustrator', 'teams', 'zoom'].some(p => knownProcess.includes(p));
            if (isKnownNonFileApp) {
                return { error: `Active window (${lastActiveWindow.process}) is not a document viewer.`, windowTitle };
            }
            // Only scan background processes if we truly don't know what's foreground
            if (!windowTitle || windowTitle === 'KLYPIX') {
                const fallbackScript = path.join(os.tmpdir(), 'klypix_fallback.ps1');
                fs.writeFileSync(fallbackScript, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Get-Process | Where-Object { $_.MainWindowTitle -ne [string]::Empty -and $_.MainWindowTitle -match "\\.(pdf|docx?|xlsx?|csv|txt|pptx)" -and $_.MainWindowTitle -notmatch "ALT\\+Space" } | Sort-Object id -Descending | Select-Object -First 1 -ExpandProperty MainWindowTitle`, 'utf8');
                const { stdout: fallbackOut } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${fallbackScript}"`);
                try { fs.unlinkSync(fallbackScript); } catch (_) { }
                windowTitle = fallbackOut.trim();
            }
        }
        if (!windowTitle) {
            return { error: 'No active document or browser tab found. Make sure a supported file or webpage is open and visible.' };
        }
        let detectedPath: string | null = null;
        // Strategy 1: Try to find a full path mentioned directly in title (rare but some apps do it)
        const fullPathMatch = windowTitle.match(/([A-Za-z]:\\[^"*?<>|]+\.(?:pdf|docx?|xlsx?|csv|txt|pptx))/i);
        if (fullPathMatch) {
            detectedPath = fullPathMatch[1];
        }
        // Strategy 2: Extract filename robustly from application window titles
        if (!detectedPath) {
            let candidateName = windowTitle;
            // Microsoft Office often appends " - Excel", " - Word", " - PowerPoint"
            // Browsers often append " - Google Chrome", " - Edge"
            // We just strip the known application suffixes to get the raw document name
            const appSuffixes = [
                /\s+[-\u2013]\s+Excel$/i,
                /\s+[-\u2013]\s+Word$/i,
                /\s+[-\u2013]\s+PowerPoint$/i,
                /\s+[-\u2013]\s+Google Chrome$/i,
                /\s+[-\u2013]\s+Microsoft\u200b Edge$/i, // Includes zero-width space some Edge versions use
                /\s+[-\u2013]\s+Microsoft Edge$/i,
                /\s+[-\u2013]\s+Mozilla Firefox$/i,
                /\s+[-\u2013]\s+Adobe Acrobat.*$/i,
                /\s+[-\u2013]\s+Foxit.*$/i,
                // Excel 365 / new Office uses "• Saved to..." suffix instead of " - Excel"
                /\s+[•\u2022]\s+Saved\s+to\s+.*$/i,
                /\s+[•\u2022]\s+AutoSaved.*$/i,
            ];
            for (const suffix of appSuffixes) {
                candidateName = candidateName.replace(suffix, '');
            }
            // In some cases (like Chrome PDFs), the format might be "RealFileName.pdf - Some internal browser title"
            // To be safe, if we still have a " - " after stripping the app name, we'll try to find the extension part
            // Match basically anything until the known extensions
            const fileExtRegex = /(.+\.(?:pdf|docx?|xlsx?|csv|txt|pptx))/i;
            const match = candidateName.match(fileExtRegex);
            if (match) {
                candidateName = decodeURIComponent(match[1].trim());
            }
            else {
                candidateName = decodeURIComponent(candidateName.trim());
            }
            if (candidateName) {
                // Strategy 2a: Search common local folders
                const searchDirs = [
                    process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Desktop` : null,
                    process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Documents` : null,
                    process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Downloads` : null,
                ].filter(Boolean) as string[];
                for (const dir of searchDirs) {
                    const candidate = path.join(dir, candidateName);
                    if (fs.existsSync(candidate)) {
                        detectedPath = candidate;
                        break;
                    }
                }
                // Strategy 2b: Search Windows Recent .lnk shortcuts (covers any location)
                if (!detectedPath) {
                    try {
                        const lnkScript = path.join(require('os').tmpdir(), 'klypix_lnk.ps1');
                        const safeLnkFilter = candidateName.replace(/'/g, "''") + ".lnk";
                        fs.writeFileSync(lnkScript, '\ufeff' + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $f = Get-ChildItem -Path "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter '${safeLnkFilter}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $sh = (New-Object -COM WScript.Shell).CreateShortcut($f.FullName); $sh.TargetPath }`, 'utf8');
                        const { stdout: target } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${lnkScript}"`, { encoding: 'utf8' });
                        try {
                            fs.unlinkSync(lnkScript);
                        }
                        catch (_) { }
                        const resolved = target.trim();
                        if (resolved && fs.existsSync(resolved)) {
                            detectedPath = resolved;
                        }
                    }
                    catch (_) { }
                }
                // Strategy 2c: Last resort - full drive scan
                if (!detectedPath) {
                    try {
                        const searchScript = path.join(require('os').tmpdir(), 'klypix_search.ps1');
                        const safeFilter = candidateName.replace(/'/g, "''");
                        fs.writeFileSync(searchScript, '\ufeff' + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $drives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root; foreach ($d in $drives) { $f = Get-ChildItem -Path $d -Filter '${safeFilter}' -Recurse -ErrorAction SilentlyContinue -File | Select-Object -First 1; if ($f) { $f.FullName; break } }`, 'utf8');
                        const { stdout: foundPath } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${searchScript}"`, { timeout: 20000, encoding: 'utf8' });
                        try {
                            fs.unlinkSync(searchScript);
                        }
                        catch (_) { }
                        const resolved = foundPath.trim();
                        if (resolved && fs.existsSync(resolved)) {
                            detectedPath = resolved;
                        }
                    }
                    catch (_) { /* Search failed */ }
                }
                if (!detectedPath) {
                    return { error: `Could not locate "${candidateName}" on disk. Try saving it to Desktop or Documents first.`, windowTitle };
                }
            }
        }
        if (!detectedPath) {
            return { error: `Could not detect an open file in: "${windowTitle}"`, windowTitle };
        }
        const ext = path.extname(detectedPath).toLowerCase();
        const fileName = path.basename(detectedPath);
        if (!supportedExts.includes(ext)) {
            return { error: `Unsupported file type: ${ext}`, fileName };
        }
        // ── Parse file content ──────────────────────────────────────────────
        let content = '';
        let pageCount = 0;
        if (ext === '.pdf') {
            const pdfResult = await readPdfFromDisk(detectedPath);
            if (pdfResult.needsPassword) {
                return { error: 'Password-protected PDF', needsPassword: true, localPath: detectedPath, fileName: path.basename(detectedPath) };
            }
            content = pdfResult.content;
            pageCount = pdfResult.pageCount;
        }
        else if (ext === '.docx' || ext === '.doc') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: detectedPath });
            content = result.value;
            pageCount = Math.ceil(content.split('\n').length / 30); // approx
        }
        else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
            const XLSX = require('xlsx');
            const workbook = XLSX.readFile(detectedPath);
            pageCount = workbook.SheetNames.length;
            const parts: string[] = [];
            for (const sheetName of workbook.SheetNames) {
                const sheet = workbook.Sheets[sheetName];
                const csv = XLSX.utils.sheet_to_csv(sheet);
                parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
            }
            content = parts.join('\n\n');
        }
        else if (ext === '.txt') {
            content = fs.readFileSync(detectedPath, 'utf-8');
            pageCount = Math.ceil(content.split('\n').length / 50);
        }
        else if (ext === '.pptx') {
            const officeParser = require('officeparser');
            content = await new Promise((resolve, reject) => {
                officeParser.parseOffice(detectedPath, (data: any, err: any) => {
                    if (err)
                        reject(err);
                    else
                        resolve(data);
                });
            });
            pageCount = (content.match(/\n{3,}/g) || []).length + 1; // rough slide count
        }
        // Trim to avoid giant prompts (max ~60k chars)
        const MAX_CHARS = 60000;
        const truncated = content.length > MAX_CHARS;
        if (truncated)
            content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';
        return { fileName, pageCount, content, truncated };
    }
    catch (error: any) {
        console.error('read-active-file error:', error);
        return { error: error.message || 'Unknown error reading file.' };
    }
});
// ── Read file by window title (agent fallback when read-active-file fails) ──
// Bypasses the foreground window check — takes a title from get-all-open-files
// and runs readFileByTitle directly. Enables: get_all_open_files → read_file_by_title.
ipcMain.handle('read-file-by-title', async (_event: any, windowTitle: string) => {
    try {
        if (!windowTitle) return { error: 'No window title provided' };
        console.log(`[read-file-by-title] Reading by title: "${windowTitle.substring(0, 80)}"`);
        // Temporarily override lastActiveWindow so readFileByTitle skips the non-file-app check
        const savedProcess = lastActiveWindow.process;
        lastActiveWindow.process = 'excel'; // trick: pretend it's Excel so the process check passes
        const result = await readFileByTitle(windowTitle);
        lastActiveWindow.process = savedProcess; // restore
        return result;
    } catch (error: any) {
        console.error('read-file-by-title error:', error);
        return { error: error.message || 'Unknown error' };
    }
});

/**
 * Find all Chrome and Edge user profile directories on the system.
 */
function findBrowserProfiles() {
    const profiles: { browser: string, profilePath: string }[] = [];
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData)
        return profiles;
    const browserRoots = [
        { browser: 'Google Chrome', root: path.join(localAppData, 'Google', 'Chrome', 'User Data') },
        { browser: 'Microsoft Edge', root: path.join(localAppData, 'Microsoft', 'Edge', 'User Data') },
    ];
    for (const { browser, root } of browserRoots) {
        if (!fs.existsSync(root))
            continue;
        try {
            // Check Default profile
            const defaultSessions = path.join(root, 'Default', 'Sessions');
            if (fs.existsSync(defaultSessions)) {
                profiles.push({ browser, profilePath: path.join(root, 'Default') });
            }
            // Check numbered profiles (Profile 1, Profile 2, etc.)
            const entries = fs.readdirSync(root, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && /^Profile \d+$/i.test(entry.name)) {
                    const sessDir = path.join(root, entry.name, 'Sessions');
                    if (fs.existsSync(sessDir)) {
                        profiles.push({ browser, profilePath: path.join(root, entry.name) });
                    }
                }
            }
        }
        catch (_) { /* permission denied, etc. */ }
    }
    return profiles;
}
/**
 * Parse a Chromium SNSS session file to extract tab navigation entries.
 * Format: "SNSS" signature (4 bytes) + version (4 bytes) + repeated commands.
 * Each command: size (uint16 LE) + command_id (uint8) + payload (size-1 bytes).
 * Command ID 6 = kCommandUpdateTabNavigation: contains a Pickle with tab_id, index, url, title.
 */
function parseSNSSFile(filePath: string) {
    const tabMap = new Map(); // latest nav per tab_id
    try {
        // Copy to temp to avoid file locking issues with running browser
        const tmpCopy = filePath + '.klypix_tmp';
        try {
            fs.copyFileSync(filePath, tmpCopy);
        }
        catch (_) { /* try reading original */ }
        const readPath = fs.existsSync(tmpCopy) ? tmpCopy : filePath;
        const buffer = fs.readFileSync(readPath);
        try {
            if (readPath === tmpCopy)
                fs.unlinkSync(tmpCopy);
        }
        catch (_) { }
        if (buffer.length < 8)
            return [];
        // Validate signature
        const sig = buffer.toString('ascii', 0, 4);
        if (sig !== 'SNSS')
            return [];
        let offset = 8; // skip signature + version
        while (offset + 2 < buffer.length) {
            // Read command size (uint16 LE) — includes the command ID byte
            let cmdSize;
            if (offset + 2 > buffer.length)
                break;
            cmdSize = buffer.readUInt16LE(offset);
            offset += 2;
            if (cmdSize < 1 || offset + cmdSize > buffer.length)
                break;
            const cmdId = buffer.readUInt8(offset);
            const payloadStart = offset + 1;
            const payloadEnd = offset + cmdSize;
            // kCommandUpdateTabNavigation = 6
            if (cmdId === 6 && cmdSize > 20) {
                try {
                    const payload = buffer.subarray(payloadStart, payloadEnd);
                    let p = 0;
                    // Pickle header: payload_size (int32)
                    if (p + 4 > payload.length) {
                        offset = payloadEnd;
                        continue;
                    }
                    p += 4; // skip pickle payload size
                    // tab_id (int32)
                    if (p + 4 > payload.length) {
                        offset = payloadEnd;
                        continue;
                    }
                    const tabId = payload.readInt32LE(p);
                    p += 4;
                    // index (int32)
                    if (p + 4 > payload.length) {
                        offset = payloadEnd;
                        continue;
                    }
                    p += 4; // skip navigation index
                    // URL: Pickle string = int32 length + UTF-8 data + padding to 4-byte boundary
                    if (p + 4 > payload.length) {
                        offset = payloadEnd;
                        continue;
                    }
                    const urlLen = payload.readInt32LE(p);
                    p += 4;
                    if (urlLen <= 0 || urlLen > 10000 || p + urlLen > payload.length) {
                        offset = payloadEnd;
                        continue;
                    }
                    const url = payload.toString('utf-8', p, p + urlLen);
                    p += urlLen;
                    p = Math.ceil(p / 4) * 4; // align to 4 bytes
                    // Title: Pickle string16 = int32 length (in chars) + UTF-16LE data + padding
                    let title = '';
                    if (p + 4 <= payload.length) {
                        const titleCharLen = payload.readInt32LE(p);
                        p += 4;
                        const titleBytes = titleCharLen * 2;
                        if (titleCharLen > 0 && titleCharLen < 5000 && p + titleBytes <= payload.length) {
                            title = payload.toString('utf16le', p, p + titleBytes);
                        }
                    }
                    // Filter out internal browser pages
                    if (url && !url.startsWith('chrome://') && !url.startsWith('edge://') &&
                        !url.startsWith('chrome-extension://') && !url.startsWith('about:') &&
                        !url.startsWith('devtools://')) {
                        tabMap.set(tabId, { tabId, url, title: title || url });
                    }
                }
                catch (_) { /* skip corrupt command */ }
            }
            // kCommandTabClosed — remove tab from map (covers IDs 12, 16 across Chrome versions)
            if ((cmdId === 12 || cmdId === 16) && cmdSize >= 5) {
                try {
                    const payload = buffer.subarray(payloadStart, payloadEnd);
                    // Pickle: 4 bytes payload_size + 4 bytes tab_id
                    if (payload.length >= 8) {
                        const closedTabId = payload.readInt32LE(4);
                        tabMap.delete(closedTabId);
                    }
                }
                catch (_) { }
            }
            // kCommandWindowClosed — remove all tabs for that window (covers IDs 17, 11)
            // Note: window close commands contain a window_id, not tab_ids directly.
            // Since we track by tab_id not window_id, we can't precisely remove tabs here.
            // Instead, liveness validation below handles stale windows.
            offset = payloadEnd;
        }
    }
    catch (_) { /* file read error */ }
    return Array.from(tabMap.values());
}
/**
 * Get all open browser tabs by reading session files directly from disk.
 * This bypasses UIA and gives 100% accurate results even for minimized/background windows.
 */
function getBrowserTabsFromSessionFiles() {
    const results: { title: string, url: string, browser: string }[] = [];
    const seenUrls = new Set();
    // Lightweight liveness check: use fs.existsSync on the lock file in the profile dir
    // instead of the expensive execSync('tasklist') which blocks for 1-2s
    const browserLockFiles: Record<string, string> = {
        'Google Chrome': 'lockfile',
        'Microsoft Edge': 'lockfile',
    };
    const profiles = findBrowserProfiles();
    for (const { browser, profilePath } of profiles) {
        // Quick liveness check: browser creates a lockfile when running
        const lockFile = path.join(profilePath, browserLockFiles[browser] || 'lockfile');
        const parentLock = path.join(path.dirname(profilePath), 'lockfile');
        if (!fs.existsSync(lockFile) && !fs.existsSync(parentLock)) {
            // Double-check with SingletonLock (Linux-style, also used on Windows sometimes)
            const singletonLock = path.join(path.dirname(profilePath), 'SingletonLock');
            if (!fs.existsSync(singletonLock)) {
                continue; // Browser likely not running
            }
        }
        const sessDir = path.join(profilePath, 'Sessions');
        if (!fs.existsSync(sessDir))
            continue;
        try {
            // Read Current Tabs (checkpoint) first, then Current Session (journal) to get latest state
            const filesToRead: string[] = [];
            const currentTabs = path.join(sessDir, 'Current Tabs');
            const currentSession = path.join(sessDir, 'Current Session');
            if (fs.existsSync(currentTabs))
                filesToRead.push(currentTabs);
            if (fs.existsSync(currentSession))
                filesToRead.push(currentSession);
            // Also check for Session_* and Tabs_* files (newer Chrome versions)
            try {
                const sessFiles = fs.readdirSync(sessDir);
                for (const f of sessFiles) {
                    if (/^(Tabs_|Session_)\d+/i.test(f)) {
                        filesToRead.push(path.join(sessDir, f));
                    }
                }
            }
            catch (_) { }
            // Parse all session files, latest entries win per tab_id
            const profileTabMap = new Map();
            for (const file of filesToRead) {
                try {
                    const tabs = parseSNSSFile(file);
                    for (const tab of tabs) {
                        profileTabMap.set(tab.tabId, tab);
                    }
                }
                catch (_) { }
            }
            for (const tab of profileTabMap.values()) {
                if (!seenUrls.has(tab.url)) {
                    seenUrls.add(tab.url);
                    results.push({ title: tab.title, url: tab.url, browser });
                }
            }
        }
        catch (_) { }
    }
    return results;
}
// ─── Web Page Content Reader ──────────────────────────────────────────────
// ─── Browser URL Extraction via UIAutomation ─────────────────────────────────
// Extracts the current URL from the foreground browser's address bar.
// MUST be called while the browser is still the foreground window (before KLYPIX shows).
async function extractBrowserUrl(): Promise<string | null> {
    try {
        const os = require('os');
        const uiaScript = path.join(os.tmpdir(), 'klypix_url.ps1');
        fs.writeFileSync(uiaScript, `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WinUrl {
   [DllImport("user32.dll")]
   public static extern IntPtr GetForegroundWindow();
}
'@
$hwnd = [WinUrl]::GetForegroundWindow()
if ($hwnd -ne [IntPtr]::Zero) {
    try {
        $el = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        function FindUrl($e, $d) {
            if ($d -gt 10 -or $e -eq $null) { return $null }
            $ct = $e.Current.ControlType
            $nm = $e.Current.Name
            if ($ct -eq [System.Windows.Automation.ControlType]::Document) { return $null }
            if ($nm -match "Chrome Legacy Window") { return $null }
            if ($ct -eq [System.Windows.Automation.ControlType]::Edit) {
                $p = $null
                if ($e.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$p)) {
                    $v = $p.Current.Value
                    if ($v -notmatch "\\s" -or $v -match "^(https?|file)://") {
                        if ($v -ne "" -and $v -ne "Search") { return $v }
                    }
                }
            }
            $c = $walker.GetFirstChild($e)
            while ($c -ne $null) {
                $r = FindUrl $c ($d + 1)
                if ($r) { return $r }
                $c = $walker.GetNextSibling($c)
            }
            return $null
        }
        $url = FindUrl $el 0
        if ($url) {
            if ($url -match "^[a-zA-Z]:/|\\\\") { $url = "file:///" + ($url -replace "\\\\", "/") }
            elseif ($url -notmatch "^(https?|file)://") { $url = "https://" + $url }
            Write-Output $url
        }
    } catch { }
}
        `, 'utf8');
        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${uiaScript}"`, { timeout: 3000 });
        try { fs.unlinkSync(uiaScript); } catch (_) {}
        const url = stdout.trim();
        if (url && (url.startsWith('http') || url.startsWith('file:///'))) {
            console.log(`[extractBrowserUrl] Got URL: ${url.substring(0, 80)}`);
            return url;
        }
        return null;
    } catch (err: any) {
        console.log(`[extractBrowserUrl] Failed: ${err.message}`);
        return null;
    }
}

// ─── Browser process detection helper ────────────────────────────────────────
const BROWSER_PROCESS_NAMES = ['chrome', 'firefox', 'msedge', 'brave', 'opera', 'vivaldi', 'arc', 'waterfox', 'floorp'];
function isBrowserProcess(processName: string): boolean {
    const p = processName.toLowerCase();
    return BROWSER_PROCESS_NAMES.some(b => p.includes(b));
}

// Reads page content from browser tabs using multiple strategies:
// 1. Server-side fetch (fast, works for public pages)
// 2. CDP if user has enabled it (instant, works on authenticated/JS pages)
// 3. Clipboard injection (last resort, needs focus)
const CDP_PORTS = [9222, 9223, 9224, 9225, 9226];
/**
 * Auto-discover CDP ports by scanning common debug ports.
 * Returns list of active ports. Works if user launched browser with
 * --remote-debugging-port=XXXX or if a debug port is active.
 */
async function discoverCDPPorts() {
    const activePorts: number[] = [];
    const checks = CDP_PORTS.map(async (port) => {
        if (await isCDPAvailable(port))
            activePorts.push(port);
    });
    await Promise.all(checks);
    return activePorts;
}
/** Check if CDP is available for a browser on its port */
async function isCDPAvailable(port: number) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
            signal: AbortSignal.timeout(1000),
        });
        return response.ok;
    }
    catch (_) {
        return false;
    }
}
/** List all open tabs via CDP */
async function cdpListTabs(port: number) {
    try {
        const response = await fetch(`http://127.0.0.1:${port}/json`, {
            signal: AbortSignal.timeout(2000),
        });
        if (!response.ok)
            return [];
        const tabs = await response.json();
        return tabs
            .filter((t: any) => t.type === 'page')
            .map((t: any) => ({
            title: t.title || '',
            url: t.url || '',
            wsUrl: t.webSocketDebuggerUrl || '',
            id: t.id || '',
        }));
    }
    catch (_) {
        return [];
    }
}
/** Read page content from a specific tab via CDP WebSocket */
async function cdpReadPageContent(wsUrl: string, maxChars = 40000) {
    if (!wsUrl)
        return null;
    return new Promise((resolve) => {
        const WS = require('ws');
        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                ws.close();
                resolve(null);
            }
        }, 5000);
        const ws = new WS(wsUrl);
        ws.on('open', () => {
            // Extract text content from the page
            ws.send(JSON.stringify({
                id: 1,
                method: 'Runtime.evaluate',
                params: {
                    expression: `
                        (function() {
                            // Remove noise elements
                            const remove = document.querySelectorAll('script, style, noscript, nav, footer, header, svg, iframe, .ads, .advertisement');
                            const texts = [];
                            remove.forEach(el => el.remove());

                            // Get clean text
                            const body = document.body;
                            if (!body) return '';
                            return body.innerText || body.textContent || '';
                        })()
                    `,
                    returnByValue: true,
                },
            }));
        });
        ws.on('message', (data: any) => {
            try {
                const msg = JSON.parse(data.toString());
                if (msg.id === 1 && msg.result?.result?.value) {
                    let content = msg.result.result.value;
                    content = content.replace(/\s+/g, ' ').trim();
                    if (content.length > maxChars) {
                        content = content.slice(0, maxChars) + '\n\n[... content truncated for length ...]';
                    }
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        ws.close();
                        resolve(content);
                    }
                }
                else {
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        ws.close();
                        resolve(null);
                    }
                }
            }
            catch (_) {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    ws.close();
                    resolve(null);
                }
            }
        });
        ws.on('error', () => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(null);
            }
        });
    });
}
/**
 * Find a CDP tab matching a given URL or title.
 * Returns the page content if found, null otherwise.
 */
async function cdpReadTabContent(url: string, title: string, maxChars = 40000) {
    const normTitle = title.replace(/\s+/g, ' ').trim().toLowerCase();
    const normUrl = url?.toLowerCase() || '';
    for (const port of CDP_PORTS) {
        if (!(await isCDPAvailable(port)))
            continue;
        const tabs = await cdpListTabs(port);
        // Match by URL first (exact), then by title (fuzzy)
        let match = tabs.find((t: any) => t.url && t.url.toLowerCase() === normUrl);
        if (!match && normTitle) {
            match = tabs.find((t: any) => t.title.toLowerCase().includes(normTitle) || normTitle.includes(t.title.toLowerCase()));
        }
        if (match?.wsUrl) {
            const content = await cdpReadPageContent(match.wsUrl, maxChars);
            if (content && (content as string).length > 50)
                return content;
        }
    }
    return null;
}
/**
 * Clipboard fallback: bring browser tab to focus, Ctrl+A, Ctrl+C, read clipboard.
 * Only used when CDP is unavailable AND the tab is focusable.
 */
async function clipboardReadFallback(windowTitle: string) {
    try {
        const os = require('os');
        const clipScript = path.join(os.tmpdir(), 'klypix_clip_read.ps1');
        const safeTitle = windowTitle.replace(/'/g, "''").replace(/\[/g, '`[').replace(/\]/g, '`]');
        const scriptContent = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ClipHelper {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
}
"@

# Save current clipboard
$savedClip = Get-Clipboard -ErrorAction SilentlyContinue

# Find and focus the window
$procs = Get-Process | Where-Object { $_.MainWindowTitle -like '*${safeTitle}*' -and $_.MainWindowTitle -ne '' }
if (-not $procs) { Write-Output "WINDOW_NOT_FOUND"; exit }
$hwnd = $procs[0].MainWindowHandle
[ClipHelper]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 200

# Select all and copy
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 150
[System.Windows.Forms.SendKeys]::SendWait("^c")
Start-Sleep -Milliseconds 200

# Read clipboard
$content = Get-Clipboard -ErrorAction SilentlyContinue
if ($content) { [Console]::Write($content -join "\`n") }

# Restore previous clipboard
if ($savedClip) { Set-Clipboard -Value $savedClip -ErrorAction SilentlyContinue }

# Return focus to Klypix
$klypix = Get-Process | Where-Object { $_.MainWindowTitle -like '*Klypix*' } | Select-Object -First 1
if ($klypix) { [ClipHelper]::SetForegroundWindow($klypix.MainWindowHandle) | Out-Null }
`.trim();
        fs.writeFileSync(clipScript, scriptContent, 'utf8');
        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${clipScript}"`, { timeout: 8000, encoding: 'utf8' });
        try {
            fs.unlinkSync(clipScript);
        }
        catch (_) { }
        const result = stdout.trim();
        if (result === 'WINDOW_NOT_FOUND' || !result)
            return null;
        return result;
    }
    catch (_) {
        return null;
    }
}
/**
 * Unified page content reader with fallback chain:
 * 1. Server-side fetch (fast, no side effects, public pages)
 * 2. CDP (if available — works on authenticated/JS-rendered pages)
 * 3. Clipboard injection (last resort, needs window focus)
 */
// ── Centralized PDF Reader ─────────────────────────────────────────────────
// Handles: normal PDFs, password-protected PDFs, scanned/image-only PDFs (OCR)
// Safe file read — if file is locked by another process (Word, Excel), copy to temp first
function safeReadFileSync(filePath: string, encoding?: BufferEncoding): any {
    try {
        return encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
    }
    catch (err: any) {
        if (err.code === 'EBUSY' || err.code === 'EACCES' || err.code === 'EPERM') {
            // File is locked — copy to temp and read from there
            const tmpPath = path.join(require('os').tmpdir(), `klypix_locked_${Date.now()}_${path.basename(filePath)}`);
            try {
                fs.copyFileSync(filePath, tmpPath);
                const result = encoding ? fs.readFileSync(tmpPath, encoding) : fs.readFileSync(tmpPath);
                try {
                    fs.unlinkSync(tmpPath);
                }
                catch (_) { }
                return result;
            }
            catch (copyErr) {
                try {
                    fs.unlinkSync(tmpPath);
                }
                catch (_) { }
                throw copyErr;
            }
        }
        throw err;
    }
}
async function readPdfFromDisk(filePath: string, options?: any): Promise<any> {
    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = false;
    const buffer = safeReadFileSync(filePath);
    const uint8Array = new Uint8Array(buffer);
    const maxChars = options?.maxChars || 60000;
    try {
        const loadOpts: any = { data: uint8Array, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true };
        if (options?.password)
            loadOpts.password = options.password;
        const pdfDoc = await pdfjsLib.getDocument(loadOpts).promise;
        let fullText = '';
        const pageCount = pdfDoc.numPages;
        for (let p = 1; p <= pageCount; p++) {
            const page = await pdfDoc.getPage(p);
            const tc = await page.getTextContent();
            const pageText = tc.items.map((item: any) => item.str).join(' ');
            fullText += pageText + '\n\n';
            if (fullText.length > maxChars) {
                fullText = fullText.slice(0, maxChars) + '\n\n[... content truncated ...]';
                break;
            }
        }
        // Check if PDF is scanned (image-only) — very little text extracted
        const wordCount = fullText.trim().split(/\s+/).length;
        if (wordCount < 20 && pageCount > 0) {
            // Likely a scanned PDF — try OCR with Tesseract
            console.log(`[PDF] Only ${wordCount} words extracted from ${pageCount} pages — attempting OCR`);
            try {
                // Check if canvas is available (native dependency, may not be installed)
                let createCanvas;
                try {
                    createCanvas = require('canvas').createCanvas;
                }
                catch (_) {
                    console.log('[PDF] canvas module not available — OCR skipped. This PDF appears to be scanned/image-only.');
                    return { content: fullText.trim() || '[Scanned PDF — text extraction not available. Try using screenshot mode instead.]', pageCount, isScanned: true };
                }
                const { createWorker } = require('tesseract.js');
                const worker = await createWorker('eng+ara');
                let ocrText = '';
                // Render each page as image and OCR (max 10 pages to avoid timeout)
                const pagesToOcr = Math.min(pageCount, 10);
                for (let p = 1; p <= pagesToOcr; p++) {
                    const page = await pdfDoc.getPage(p);
                    const viewport = page.getViewport({ scale: 2.0 }); // 2x for better OCR quality
                    // Create a canvas-like buffer using pdfjs
                    const canvas = createCanvas(viewport.width, viewport.height);
                    const ctx = canvas.getContext('2d');
                    await page.render({ canvasContext: ctx, viewport }).promise;
                    const pngBuffer = canvas.toBuffer('image/png');
                    const { data } = await worker.recognize(pngBuffer);
                    ocrText += data.text + '\n\n';
                    if (ocrText.length > maxChars)
                        break;
                }
                await worker.terminate();
                if (ocrText.trim().length > fullText.trim().length) {
                    return { content: ocrText.trim(), pageCount, isScanned: true };
                }
            }
            catch (ocrErr: any) {
                console.log(`[PDF] OCR failed: ${ocrErr.message} — returning minimal text`);
                // OCR failed (canvas not available), return what we have
            }
        }
        return { content: fullText.trim(), pageCount };
    }
    catch (err: any) {
        // Check if it's a password error
        if (err.name === 'PasswordException' || err.message?.includes('password') || err.message?.includes('Password')) {
            return { content: '', pageCount: 0, needsPassword: true };
        }
        throw err;
    }
}
async function readWebPageContent(url: string, title: string, maxChars = 40000) {
    // Normalize URL — Chrome strips protocol from address bar
    if (url && !url.match(/^https?:\/\//) && !url.startsWith('file://') && url.includes('.')) {
        url = 'https://' + url;
    }
    console.log(`[readWebPageContent] Attempting to read: "${title}" url=${url}`);
    // 1. Try server-side fetch first (fast, works for most public pages)
    if (url && !url.startsWith('file://')) {
        try {
            console.log(`[readWebPageContent] Trying server-side fetch for ${url}`);
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                signal: AbortSignal.timeout(10000),
                redirect: 'follow',
            });
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
                    const html = await response.text();
                    const cheerio = require('cheerio');
                    const $ = cheerio.load(html);
                    $('script, style, noscript, nav, footer, header, svg, iframe, .ads, .advertisement, .cookie-banner, .popup').remove();
                    let content = $('article, main, [role="main"], .content, .post, .article-body').text();
                    if (!content || content.trim().length < 100) {
                        content = $('body').text();
                    }
                    content = content.replace(/\s+/g, ' ').trim();
                    if (content.length > maxChars)
                        content = content.slice(0, maxChars) + '\n\n[... content truncated for length ...]';
                    if (content.length > 50) {
                        console.log(`[readWebPageContent] Fetch success: ${content.length} chars`);
                        return { content, method: 'fetch' };
                    }
                }
            }
            else {
                console.log(`[readWebPageContent] Fetch returned status ${response.status}`);
            }
        }
        catch (fetchErr: any) {
            console.log(`[readWebPageContent] Fetch failed: ${fetchErr.message}`);
        }
    }
    // 2. Try CDP (if user has browser with debug port open)
    try {
        console.log(`[readWebPageContent] Trying CDP...`);
        const cdpContent = await cdpReadTabContent(url, title, maxChars);
        if (cdpContent) {
            console.log(`[readWebPageContent] CDP success: ${(cdpContent as string).length} chars`);
            return { content: cdpContent, method: 'cdp' };
        }
    }
    catch (_) { }
    // 3. Last resort: clipboard injection (needs focusable window — skipped for minimized)
    if (title) {
        try {
            console.log(`[readWebPageContent] Trying clipboard fallback for "${title}"`);
            const clipContent = await clipboardReadFallback(title);
            if (clipContent && clipContent.length > 50) {
                let content = clipContent.replace(/\s+/g, ' ').trim();
                if (content.length > maxChars)
                    content = content.slice(0, maxChars) + '\n\n[... content truncated for length ...]';
                console.log(`[readWebPageContent] Clipboard success: ${content.length} chars`);
                return { content, method: 'clipboard' };
            }
        }
        catch (_) { }
    }
    console.log(`[readWebPageContent] All methods failed for "${title}"`);
    return { content: null, method: 'none' };
}
// ─── On-Screen Web Content Reading ────────────────────────────────────────────
// Fetch webpage content via fetch→CDP chain (no clipboard — that's manual via separate handler)
ipcMain.handle('read-web-content', async (_event: any, { url, title, maxChars }: { url: string; title: string; maxChars?: number }) => {
    console.log(`[read-web-content] url=${url?.substring(0, 80)} title="${title?.substring(0, 40)}"`);
    if (!url) return { content: null, method: 'none', url: null };
    // Normalize
    if (!url.match(/^https?:\/\//) && !url.startsWith('file://') && url.includes('.')) {
        url = 'https://' + url;
    }
    const limit = maxChars || 40000;
    // 1. If it's a local file:/// URL → read from disk
    if (url.startsWith('file:///') || url.startsWith('file://')) {
        try {
            let localPath = url.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
            localPath = decodeURIComponent(localPath).replace(/\//g, path.sep);
            if (!localPath.match(/^[a-zA-Z]:/)) localPath = localPath.replace(/^\\/, '');
            if (fs.existsSync(localPath)) {
                const ext = path.extname(localPath).toLowerCase();
                if (ext === '.pdf') {
                    const pdfResult = await readPdfFromDisk(localPath);
                    if (pdfResult.content) {
                        const content = pdfResult.content.length > limit
                            ? pdfResult.content.slice(0, limit) + '\n\n[... truncated ...]'
                            : pdfResult.content;
                        return { content, method: 'file', url, fileName: path.basename(localPath), pageCount: pdfResult.pageCount };
                    }
                } else {
                    // txt, html, etc.
                    const content = fs.readFileSync(localPath, 'utf-8').slice(0, limit);
                    return { content, method: 'file', url, fileName: path.basename(localPath) };
                }
            }
        } catch (err: any) {
            console.log(`[read-web-content] file:// read failed: ${err.message}`);
        }
    }
    // 2. Server-side fetch (fast, no auth)
    if (url.startsWith('http')) {
        try {
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                signal: AbortSignal.timeout(10000),
                redirect: 'follow',
            });
            if (response.ok) {
                const contentType = response.headers.get('content-type') || '';
                // Handle PDF URLs
                if (contentType.includes('application/pdf') || url.toLowerCase().endsWith('.pdf')) {
                    const arrayBuffer = await response.arrayBuffer();
                    const tmpPdf = path.join(require('os').tmpdir(), `klypix_web_${Date.now()}.pdf`);
                    fs.writeFileSync(tmpPdf, Buffer.from(arrayBuffer));
                    const pdfResult = await readPdfFromDisk(tmpPdf);
                    try { fs.unlinkSync(tmpPdf); } catch (_) {}
                    if (pdfResult.content) {
                        const content = pdfResult.content.length > limit
                            ? pdfResult.content.slice(0, limit) + '\n\n[... truncated ...]'
                            : pdfResult.content;
                        return { content, method: 'fetch', url, pageCount: pdfResult.pageCount };
                    }
                }
                // Handle HTML
                if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
                    const html = await response.text();
                    const cheerio = require('cheerio');
                    const $ = cheerio.load(html);
                    $('script, style, noscript, nav, footer, header, svg, iframe, .ads, .advertisement, .cookie-banner, .popup').remove();
                    let content = $('article, main, [role="main"], .content, .post, .article-body').text();
                    if (!content || content.trim().length < 100) content = $('body').text();
                    content = content.replace(/\s+/g, ' ').trim();
                    if (content.length > limit) content = content.slice(0, limit) + '\n\n[... truncated ...]';
                    if (content.length > 50) {
                        console.log(`[read-web-content] Fetch OK: ${content.length} chars`);
                        return { content, method: 'fetch', url };
                    }
                }
            }
        } catch (err: any) {
            console.log(`[read-web-content] Fetch failed: ${err.message}`);
        }
    }
    // 3. Try CDP (if user enabled debug ports)
    try {
        const cdpContent = await cdpReadTabContent(url, title, limit);
        if (cdpContent) {
            console.log(`[read-web-content] CDP OK: ${(cdpContent as string).length} chars`);
            return { content: cdpContent, method: 'cdp', url };
        }
    } catch (_) {}
    // 4. No clipboard here — renderer shows "Read full page" button instead
    console.log(`[read-web-content] All auto methods failed`);
    return { content: null, method: 'none', url };
});

// Manual clipboard fallback — triggered by user clicking "Read full page"
ipcMain.handle('read-web-content-clipboard', async (_event: any, { title }: { title: string }) => {
    console.log(`[read-web-content-clipboard] title="${title?.substring(0, 50)}"`);
    try {
        const clipContent = await clipboardReadFallback(title);
        if (clipContent && clipContent.length > 50) {
            let content = clipContent.replace(/\s+/g, ' ').trim();
            if (content.length > 40000) content = content.slice(0, 40000) + '\n\n[... truncated ...]';
            console.log(`[read-web-content-clipboard] OK: ${content.length} chars`);
            return { content, method: 'clipboard' };
        }
    } catch (_) {}
    return { content: null, method: 'none' };
});

// Also expose extractBrowserUrl as IPC for fallback when pre-capture misses it
ipcMain.handle('extract-browser-url', async () => {
    return await extractBrowserUrl();
});

// Fast URL lookup from session files — no UIA needed, no timing dependency
// Uses the same session file parsing that deep mode uses for discovery
ipcMain.handle('lookup-browser-url', async (_event: any, { title }: { title: string }) => {
    const normTitle = title.replace(/\s+/g, ' ').trim().toLowerCase();
    // Strip browser suffix from title for matching
    const stripped = normTitle
        .replace(/\s*[-\u2013\u2014]\s*(google chrome|microsoft edge|mozilla firefox|brave|opera|vivaldi)\s*$/i, '')
        .trim();
    console.log(`[lookup-browser-url] Looking up: "${stripped.substring(0, 60)}"`);

    // Strategy 1: Session files (disk-based, instant, same as deep mode)
    try {
        const tabs = getBrowserTabsFromSessionFiles();
        if (tabs && tabs.length > 0) {
            console.log(`[lookup-browser-url] Session files: ${tabs.length} tabs found`);
            // Exact match
            for (const tab of tabs) {
                const normTab = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                if (normTab === stripped || normTab === normTitle) {
                    console.log(`[lookup-browser-url] Exact match: ${tab.url?.substring(0, 80)}`);
                    return tab.url;
                }
            }
            // Fuzzy: one contains the other
            for (const tab of tabs) {
                const normTab = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                if (stripped.length > 10 && (stripped.includes(normTab) || normTab.includes(stripped))) {
                    console.log(`[lookup-browser-url] Fuzzy match: ${tab.url?.substring(0, 80)}`);
                    return tab.url;
                }
            }
        }
    } catch (e: any) {
        console.log(`[lookup-browser-url] Session file lookup failed: ${e.message}`);
    }

    // Strategy 2: CDP tab listing (works if CDP is enabled — no timing needed)
    try {
        const ports = await discoverCDPPorts();
        for (const port of ports) {
            const cdpTabs = await cdpListTabs(port);
            for (const tab of cdpTabs) {
                if (!tab.title || !tab.url) continue;
                const normTab = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                if (normTab === stripped || stripped.includes(normTab) || normTab.includes(stripped)) {
                    console.log(`[lookup-browser-url] CDP match on port ${port}: ${tab.url?.substring(0, 80)}`);
                    return tab.url;
                }
            }
        }
    } catch (e: any) {
        console.log(`[lookup-browser-url] CDP lookup failed: ${e.message}`);
    }

    console.log(`[lookup-browser-url] No URL found for: "${stripped.substring(0, 40)}"`);
    return null;
});

// CDP status IPC — lets the renderer check if CDP is available
ipcMain.handle('get-cdp-status', async () => {
    const activePorts = await discoverCDPPorts();
    return {
        cdpAvailable: activePorts.length > 0,
        activePorts,
        needsRestart: activePorts.length === 0,
        // Per-browser CDP status
        chromeAvailable: activePorts.some(p => p === 9222),
        edgeAvailable: activePorts.some(p => p === 9223 || p === 9224),
    };
});
// Enable CDP by setting registry keys for Chrome/Edge debug ports
ipcMain.handle('enable-cdp', async () => {
    try {
        // Set registry keys for Chrome and Edge to enable remote debugging
        const regCommands = [
            // Chrome: HKCU\Software\Google\Chrome\Flags → --remote-debugging-port=9222
            `reg add "HKCU\\Software\\Policies\\Google\\Chrome" /v CommandLineFlagSecurityWarningsEnabled /t REG_DWORD /d 0 /f`,
            // Set Chrome shortcut to include debug flag
            `$chromeShortcut = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk"; ` +
                `if (Test-Path $chromeShortcut) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($chromeShortcut); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9222'; $s.Save() } }`,
            // Edge: similar approach
            `$edgeShortcut = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Microsoft Edge.lnk"; ` +
                `if (Test-Path $edgeShortcut) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($edgeShortcut); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9223'; $s.Save() } }`,
        ];
        for (const cmd of regCommands) {
            try {
                await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '\\"')}"`);
            }
            catch (_) { }
        }
        return { success: true, message: 'CDP debug ports configured. Please restart your browser for changes to take effect.' };
    }
    catch (err: any) {
        return { success: false, message: err.message };
    }
});
// Check which browsers need CDP restart — returns list of browsers running without debug port
ipcMain.handle('check-browsers-need-cdp', async () => {
    const needsRestart: string[] = [];
    const activePorts = await discoverCDPPorts();
    const chromeHasCdp = activePorts.some(p => p === 9222);
    const edgeHasCdp = activePorts.some(p => p === 9223 || p === 9224);
    // Check if Chrome is running
    try {
        const { stdout: chromeCheck } = await execAsync('tasklist /FI "IMAGENAME eq chrome.exe" /NH');
        if (chromeCheck.includes('chrome.exe') && !chromeHasCdp) {
            needsRestart.push('chrome');
        }
    }
    catch (_) { }
    // Check if Edge is running
    try {
        const { stdout: edgeCheck } = await execAsync('tasklist /FI "IMAGENAME eq msedge.exe" /NH');
        if (edgeCheck.includes('msedge.exe') && !edgeHasCdp) {
            needsRestart.push('edge');
        }
    }
    catch (_) { }
    return { needsRestart, chromeHasCdp, edgeHasCdp };
});
// Auto-restart all browsers that need CDP — called after user confirms
ipcMain.handle('auto-restart-browsers-for-cdp', async () => {
    const results: string[] = [];
    // Enable CDP registry/shortcut first
    try {
        const regCommands = [
            `reg add "HKCU\\Software\\Policies\\Google\\Chrome" /v CommandLineFlagSecurityWarningsEnabled /t REG_DWORD /d 0 /f`,
            `$chromeShortcut = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Google Chrome.lnk"; ` +
                `if (Test-Path $chromeShortcut) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($chromeShortcut); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9222'; $s.Save() } }`,
            `$edgeShortcut = "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs\\Microsoft Edge.lnk"; ` +
                `if (Test-Path $edgeShortcut) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($edgeShortcut); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9223'; $s.Save() } }`,
            // Also modify desktop shortcuts
            `$chromeDesktop = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'Google Chrome.lnk'); ` +
                `if (Test-Path $chromeDesktop) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($chromeDesktop); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9222'; $s.Save() } }`,
            `$edgeDesktop = [System.IO.Path]::Combine([System.Environment]::GetFolderPath('Desktop'), 'Microsoft Edge.lnk'); ` +
                `if (Test-Path $edgeDesktop) { $ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut($edgeDesktop); ` +
                `if ($s.Arguments -notmatch 'remote-debugging-port') { $s.Arguments = $s.Arguments + ' --remote-debugging-port=9223'; $s.Save() } }`,
        ];
        for (const cmd of regCommands) {
            try {
                await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "${cmd.replace(/"/g, '\\"')}"`);
            }
            catch (_) { }
        }
    }
    catch (_) { }
    // Restart Chrome if running without CDP
    try {
        const { stdout: chromeCheck } = await execAsync('tasklist /FI "IMAGENAME eq chrome.exe" /NH');
        if (chromeCheck.includes('chrome.exe')) {
            const activePorts = await discoverCDPPorts();
            if (!activePorts.includes(9222)) {
                await execAsync('taskkill /IM chrome.exe /F').catch(() => { });
                await new Promise(r => setTimeout(r, 1500));
                const { exec: execChild } = require('child_process');
                execChild('start "" "chrome.exe" --remote-debugging-port=9222 --restore-last-session', { shell: 'cmd.exe' });
                results.push('chrome');
            }
        }
    }
    catch (_) { }
    // Restart Edge if running without CDP
    try {
        const { stdout: edgeCheck } = await execAsync('tasklist /FI "IMAGENAME eq msedge.exe" /NH');
        if (edgeCheck.includes('msedge.exe')) {
            const activePorts = await discoverCDPPorts();
            if (!activePorts.includes(9223) && !activePorts.includes(9224)) {
                await execAsync('taskkill /IM msedge.exe /F').catch(() => { });
                await new Promise(r => setTimeout(r, 1500));
                const { exec: execChild } = require('child_process');
                execChild('start "" "msedge.exe" --remote-debugging-port=9223 --restore-last-session', { shell: 'cmd.exe' });
                results.push('edge');
            }
        }
    }
    catch (_) { }
    return { restarted: results };
});
// Restart browser (close and reopen)
ipcMain.handle('restart-browser', async (_event: any, browser: string) => {
    try {
        const exe = browser === 'chrome' ? 'chrome.exe' : 'msedge.exe';
        const port = browser === 'chrome' ? 9222 : 9223;
        // Kill the browser process
        await execAsync(`taskkill /IM ${exe} /F`).catch(() => { });
        // Wait a moment for cleanup
        await new Promise(r => setTimeout(r, 1500));
        // Relaunch with debug flag
        const { exec: execChild } = require('child_process');
        execChild(`start "" "${exe}" --remote-debugging-port=${port}`, { shell: 'cmd.exe' });
        return { success: true, message: `${browser} restarted with debug port ${port}` };
    }
    catch (err: any) {
        return { success: false, message: err.message };
    }
});
// ─── Document Generation ──────────────────────────────────────────────────

// Lazy per-asset read (spec §23 L1). Renderer items that need asset bytes
// on-demand (without re-opening the whole .any) call this. Returns base64
// bytes + mime. The underlying JSZip is cached per filePath so repeat reads
// from the same file skip the parse cost. File size is reported too so
// callers can decide to bail on very large ones (future L10 budget).
ipcMain.handle('canvas:read-asset', async (_e: any, args: { filePath: string; assetPath: string }) => {
    try {
        if (!args?.filePath || !args?.assetPath) return { ok: false, error: 'missing filePath or assetPath' };
        if (!args.assetPath.startsWith('assets/')) return { ok: false, error: 'assetPath must start with assets/' };
        const bytes = await readAssetBytes(args.filePath, args.assetPath);
        if (!bytes) return { ok: false, error: 'asset not found' };
        const idx = args.assetPath.lastIndexOf('.');
        const ext = idx >= 0 ? args.assetPath.slice(idx + 1).toLowerCase() : '';
        // Minimal MIME resolver — matches what loadAnyFile uses. Keeping it
        // inline here avoids exporting it solely for this one call site.
        const mime = (() => {
            switch (ext) {
                case 'png': return 'image/png';
                case 'jpg': case 'jpeg': return 'image/jpeg';
                case 'gif': return 'image/gif';
                case 'webp': return 'image/webp';
                case 'bmp': return 'image/bmp';
                case 'svg': return 'image/svg+xml';
                case 'pdf': return 'application/pdf';
                case 'mp4': return 'video/mp4';
                case 'webm': return 'video/webm';
                case 'mp3': return 'audio/mpeg';
                case 'wav': return 'audio/wav';
                default: return 'application/octet-stream';
            }
        })();
        return { ok: true, base64: bytes.toString('base64'), mime, size: bytes.length };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    }
});

// Called by the renderer when a canvas tab closes — lets us free the
// cached JSZip for that file. No-op if the path isn't cached.
ipcMain.handle('canvas:evict-asset-cache', (_e: any, filePath: string) => {
    try { if (filePath) evictZipCache(filePath); } catch { /* no-op */ }
    return { ok: true };
});

// Canvas /compile entry point. Unlike `generate-file` (which prompts the user
// with a save dialog), this one just returns the rendered bytes so the
// renderer can register the file as a canvas asset and pin it as a FileItem.
ipcMain.handle('canvas:compile-bytes', async (_evt: any, args: { format: 'pdf' | 'docx' | 'pptx' | 'xlsx'; spec?: any; content?: string; fileName?: string }) => {
    try {
        let buffer: Buffer;
        switch (args.format) {
            case 'xlsx': buffer = await generateXLSX(args.spec); break;
            case 'docx': buffer = await generateDOCX(args.spec); break;
            case 'pptx': buffer = await generatePPTX(args.spec); break;
            case 'pdf':  buffer = await generatePDF(args.content || '', { title: args.spec?.metadata?.title }); break;
            default: return { ok: false, error: `unsupported format: ${args.format}` };
        }
        const fileName = (args.fileName || `compiled.${args.format}`).replace(/[\\/:*?"<>|]+/g, '_');
        return { ok: true, base64: buffer.toString('base64'), fileName, mime: mimeForFormat(args.format) };
    } catch (err: any) {
        console.error('[canvas:compile-bytes] failed:', err);
        return { ok: false, error: err?.message || String(err) };
    }
});

function mimeForFormat(format: string): string {
    switch (format) {
        case 'pdf':  return 'application/pdf';
        case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        case 'pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
        case 'xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        default: return 'application/octet-stream';
    }
}

ipcMain.handle('generate-file', async (_event: any, { format, spec, content }: any) => {
    if (!mainWindow)
        return { success: false, reason: 'No window' };
    try {
        let buffer: any;
        let defaultExt = format;
        let filterName = format.toUpperCase();
        switch (format) {
            case 'xlsx':
                buffer = await generateXLSX(spec);
                filterName = 'Excel Spreadsheet';
                break;
            case 'docx':
                buffer = await generateDOCX(spec);
                filterName = 'Word Document';
                break;
            case 'pptx':
                buffer = await generatePPTX(spec);
                filterName = 'PowerPoint Presentation';
                break;
            case 'pdf':
                buffer = await generatePDF(content || '');
                filterName = 'PDF Document';
                break;
            default:
                // Plain text formats: md, txt, csv, json, code
                buffer = Buffer.from(content || '', 'utf-8');
                filterName = `${format.toUpperCase()} File`;
                break;
        }
        const filename = spec?.filename || `generated.${defaultExt}`;
        const { filePath } = await dialog.showSaveDialog(mainWindow, {
            defaultPath: filename,
            filters: [{ name: filterName, extensions: [defaultExt] }],
        });
        if (!filePath)
            return { success: false, reason: 'cancelled' };
        fs.writeFileSync(filePath, buffer);
        return { success: true, path: filePath };
    }
    catch (err: any) {
        console.error('[DocGen] Error generating file:', err);
        return { success: false, reason: err.message || 'Generation failed' };
    }
});
// ─── File Attach Dialog ───────────────────────────────────────────────────
const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'csv', 'rtf', 'epub', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILE_COUNT = 5;
ipcMain.handle('open-file-dialog', async () => {
    if (!mainWindow)
        return [];
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile', 'multiSelections'],
        filters: [
            { name: 'Documents', extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'txt', 'md', 'json', 'xml', 'html', 'htm', 'csv', 'rtf', 'epub'] },
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
            { name: 'All Supported', extensions: ALLOWED_EXTENSIONS },
        ],
    });
    if (result.canceled || result.filePaths.length === 0)
        return [];
    return result.filePaths.slice(0, MAX_FILE_COUNT);
});
ipcMain.handle('validate-dropped-files', async (_event: any, filePaths: string[]) => {
    const fs = require('fs');
    const path = require('path');
    const results: any[] = [];
    for (const fp of filePaths.slice(0, MAX_FILE_COUNT)) {
        const ext = path.extname(fp).toLowerCase().replace('.', '');
        const name = path.basename(fp);
        try {
            const stats = fs.statSync(fp);
            if (!ALLOWED_EXTENSIONS.includes(ext)) {
                results.push({ path: fp, name, size: stats.size, ext, valid: false, error: `Unsupported file type: .${ext}` });
            }
            else if (stats.size > MAX_FILE_SIZE) {
                results.push({ path: fp, name, size: stats.size, ext, valid: false, error: `File too large (${(stats.size / 1024 / 1024).toFixed(1)}MB, max 10MB)` });
            }
            else {
                results.push({ path: fp, name, size: stats.size, ext, valid: true });
            }
        }
        catch {
            results.push({ path: fp, name, size: 0, ext, valid: false, error: 'File not accessible' });
        }
    }
    return results;
});
// ─── Multiple Files Feature ───────────────────────────────────────────────
// Shared constants for discovery
const SUPPORTED_EXT_PATTERN = /\.(pdf|docx?|xlsx?|csv|txt|md|rtf|pptx?|json|xml|html?|epub)/i;
const APP_SUFFIXES = [
    'Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave Browser', 'Brave', 'Opera',
    'Adobe Acrobat Reader', 'Adobe Acrobat', 'Foxit Reader', 'Foxit PhantomPDF', 'Foxit',
    'Microsoft Word', 'Word', 'Microsoft Excel', 'Excel', 'Microsoft PowerPoint', 'PowerPoint',
    'Notepad\\+\\+', 'Notepad', 'Visual Studio Code', 'Code',
    'LibreOffice Writer', 'LibreOffice Calc', 'LibreOffice Impress', 'LibreOffice',
    'WPS Writer', 'WPS Spreadsheets', 'WPS Presentation', 'WPS Office',
    'SumatraPDF', 'PDF-XChange', 'Nitro Pro'
];
const appSuffixRegex = new RegExp(`\\s+[-\u2013\u2014]\\s+(?:${APP_SUFFIXES.join('|')})\\s*$`, 'i');
const NOISE_TITLES = /^(new tab|loading|untitled|about:blank|blank page|start page)$/i;
const BROWSER_UI_NOISE = /^(discover|watch|play|collections|shopping|copilot|drop|games|tools|extensions|history|downloads|bookmarks|reading list|favorites|settings|sidebar|feeds|outlook|bing|msn|tab-\d+)$/i;
const WIDGET_NOISE = /widget/i;
const MIN_TITLE_LEN = 3;
const BROWSER_NAMES = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave', 'Opera'];
const OFFICE_NAMES = ['Word', 'Excel', 'PowerPoint', 'Adobe Acrobat', 'Foxit', 'Notepad++', 'Notepad', 'Visual Studio Code', 'LibreOffice', 'WPS Office', 'SumatraPDF'];
const processToApp: Record<string, string> = {
    'msedge': 'Microsoft Edge', 'chrome': 'Google Chrome', 'firefox': 'Mozilla Firefox',
    'brave': 'Brave', 'opera': 'Opera', 'winword': 'Microsoft Word', 'excel': 'Microsoft Excel',
    'powerpnt': 'Microsoft PowerPoint', 'acrord32': 'Adobe Acrobat Reader', 'acrobat': 'Adobe Acrobat',
    'foxitreader': 'Foxit Reader', 'foxitphantompdf': 'Foxit PhantomPDF',
    'notepad++': 'Notepad++', 'notepad': 'Notepad', 'code': 'VS Code',
    'swriter': 'LibreOffice Writer', 'scalc': 'LibreOffice Calc', 'simpress': 'LibreOffice Impress',
    'sumatrapdf': 'SumatraPDF', 'wps': 'WPS Office',
};
const uiaProcessToApp: Record<string, string> = {
    'chrome': 'Google Chrome', 'msedge': 'Microsoft Edge',
    'brave': 'Brave', 'opera': 'Opera', 'firefox': 'Mozilla Firefox',
};
function normalizeDocName(title: string) {
    let name = title.replace(appSuffixRegex, '');
    const extMatch = name.match(/(.+\.(?:pdf|docx?|xlsx?|csv|txt|md|rtf|pptx?|json|xml|html?|epub))/i);
    if (extMatch)
        name = extMatch[1];
    try {
        name = decodeURIComponent(name.trim());
    }
    catch (_) {
        name = name.trim();
    }
    return name.replace(/\s+/g, ' ').toLowerCase();
}
function fileUrlToPath(url: string) {
    if (!url || !url.startsWith('file:///'))
        return null;
    try {
        const parsed = new URL(url);
        let p = decodeURIComponent(parsed.pathname);
        if (p.startsWith('/') && /^\/[A-Za-z]:/.test(p))
            p = p.slice(1);
        return p.replace(/\//g, '\\');
    }
    catch (_) {
        return null;
    }
}
function isNoiseTab(title: string) {
    if (title.length < MIN_TITLE_LEN)
        return true;
    if (NOISE_TITLES.test(title))
        return true;
    if (BROWSER_UI_NOISE.test(title))
        return true;
    if (WIDGET_NOISE.test(title))
        return true;
    return false;
}
// Fallback: spawn a one-shot PS for EnumWindows when persistent PS is down
async function fallbackEnumWindows() {
    const os = require('os');
    const script = path.join(os.tmpdir(), 'klypix_enum_fallback.ps1');
    const content = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Text; using System.Collections.Generic; using System.Diagnostics;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc e, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    public static List<string[]> GetAll() {
        var w = new List<string[]>();
        EnumWindows((h, l) => {
            int len = GetWindowTextLength(h); if (len > 0) {
                var sb = new StringBuilder(len+1); GetWindowText(h, sb, sb.Capacity);
                uint pid; GetWindowThreadProcessId(h, out pid); string pn = "";
                try { pn = Process.GetProcessById((int)pid).ProcessName; } catch {}
                w.Add(new string[] { sb.ToString(), pn, IsWindowVisible(h).ToString(), IsIconic(h).ToString(), h.ToString() });
            } return true;
        }, IntPtr.Zero); return w;
    }
}
"@
[WinAPI]::GetAll() | ForEach-Object { [Console]::WriteLine("$($_[0])|$($_[1])|$($_[2])|$($_[3])|$($_[4])") }`;
    fs.writeFileSync(script, content, 'utf8');
    try {
        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`, { timeout: 10000, encoding: 'utf8' });
        return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    }
    finally {
        try {
            fs.unlinkSync(script);
        }
        catch (_) { }
    }
}
// Fallback: spawn a one-shot PS for UIA tabs when persistent PS is down
async function fallbackUIATabs() {
    const os = require('os');
    const script = path.join(os.tmpdir(), 'klypix_uia_fallback.ps1');
    // Reuse the same UIA script content from the persistent PS
    const content = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System; using System.Runtime.InteropServices; using System.Collections.Generic;
public class WH {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc e, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    public static List<IntPtr> GetWins(int pid) {
        var r = new List<IntPtr>();
        EnumWindows((h, l) => { uint wp; GetWindowThreadProcessId(h, out wp); if (wp == (uint)pid) { int len = GetWindowTextLength(h); if (len > 0) r.Add(h); } return true; }, IntPtr.Zero);
        return r;
    }
}
"@
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function FindUrl($el, $depth) {
    if ($depth -gt 20 -or $el -eq $null) { return $null }
    $ct = $el.Current.ControlType; $nm = $el.Current.Name; $ai = $el.Current.AutomationId
    if ($ct -eq [System.Windows.Automation.ControlType]::Edit -and ($nm -match "Address" -or $nm -match "URL" -or $nm -match "search bar" -or $nm -match "omnibox" -or $ai -match "addressEditBox" -or $ai -match "urlbar" -or $ai -match "view_10")) {
        $po = $null
        if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$po)) {
            $v = $po.Current.Value
            if ($v -and $v.Length -gt 3) { if ($v -match '^[A-Za-z]:[/\\\\]') { $v = "file:///$v" } elseif ($v -notmatch '^https?://' -and $v -notmatch '^file://' -and $v -match '\\.') { $v = "https://$v" }; return $v }
        }
    }
    $c = $walker.GetFirstChild($el)
    while ($c -ne $null) { $r = FindUrl $c ($depth+1); if ($r) { return $r }; $c = $walker.GetNextSibling($c) }
    return $null
}
$browsers = Get-Process | Where-Object { $_.Name -match "^(chrome|msedge|brave|opera|firefox)$" }
foreach ($b in $browsers) {
    try {
        $handles = [WH]::GetWins($b.Id)
        foreach ($h in $handles) {
            try {
                $win = [System.Windows.Automation.AutomationElement]::FromHandle($h)
                if ($win -eq $null) { continue }
                $activeUrl = FindUrl $win 0
                $tabCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::TabItem)
                $tabs = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $tabCond)
                if ($tabs.Count -gt 0) {
                    $activeTabName = $null
                    foreach ($t in $tabs) { try { $sp = $null; if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sp)) { if ($sp.Current.IsSelected) { $activeTabName = $t.Current.Name; break } } } catch { } }
                    foreach ($t in $tabs) { $tn = $t.Current.Name; if ($tn -and $tn -notmatch "^New Tab$") { if ($tn -eq $activeTabName -and $activeUrl) { Write-Output "[TAB]|$tn|$activeUrl|$($b.Name)" } else { Write-Output "[TAB]|$tn||$($b.Name)" } } }
                } else { $title = $win.Current.Name; if ($title -and $activeUrl) { Write-Output "[TAB]|$title|$activeUrl|$($b.Name)" } }
            } catch { }
        }
    } catch { }
}`;
    fs.writeFileSync(script, content, 'utf8');
    try {
        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${script}"`, { timeout: 15000, encoding: 'utf8' });
        return stdout.trim().split('\n').map(l => l.trim()).filter(Boolean);
    }
    finally {
        try {
            fs.unlinkSync(script);
        }
        catch (_) { }
    }
}
ipcMain.handle('get-all-open-files', async () => {
    // Debounce: if a scan is already in progress, return the last result
    if (scanInProgress && lastScanResult) {
        return lastScanResult;
    }
    scanInProgress = true;
    try {
        // ─── PARALLEL SCAN: EnumWindows + UIA + Session Files + Acrobat ───────
        // EnumWindows + Acrobat: use persistent PS (fast, no hanging risk)
        // UIA: ALWAYS use one-shot PS (can hang on minimized windows, needs killable timeout)
        const enumPromise = psReady
            ? sendPSCommand('ENUM_WINDOWS', 8000).catch(() => fallbackEnumWindows())
            : fallbackEnumWindows();
        // UIA is unreliable in a persistent process — tree traversal can hang.
        // Always spawn a fresh one-shot PS that can be killed on timeout.
        const uiaPromise = fallbackUIATabs();
        const acrobatPromise = psReady
            ? sendPSCommand('ACROBAT_FILES', 5000).catch(() => [])
            : Promise.resolve([]);
        // Session files are synchronous and fast — run concurrently with PS commands
        const sessionPromise = new Promise<any>((resolve) => {
            try {
                resolve(getBrowserTabsFromSessionFiles());
            }
            catch (_) {
                resolve([]);
            }
        });
        // CDP tab discovery — works even when browser is minimized (UIA blind spot)
        // Try known debug ports for Chrome (9222) and Edge (9223)
        const cdpDiscoveryPromise = (async () => {
            const cdpTabs: any[] = [];
            const ports = [9222, 9223, 9224, 9225, 9226];
            for (const port of ports) {
                try {
                    const tabs = await cdpListTabs(port);
                    const browserName = port <= 9222 ? 'Google Chrome' : 'Microsoft Edge';
                    for (const tab of tabs) {
                        if (tab.title && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('edge://') && !tab.url.startsWith('about:')) {
                            cdpTabs.push({ title: tab.title, url: tab.url, browser: browserName });
                        }
                    }
                }
                catch (_) { /* port not open */ }
            }
            return cdpTabs;
        })();
        // Acrobat COM automation — get exact file path of open PDF (more reliable than registry MRU)
        const acrobatComPromise = (async () => {
            const acrobatRunning = (await enumPromise).some((l: any) => l.toLowerCase().includes('acrobat'));
            if (!acrobatRunning)
                return [];
            try {
                const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; try { $acrobat = [System.Runtime.InteropServices.Marshal]::GetActiveObject('AcroExch.App'); $numDocs = $acrobat.GetNumAVDocs(); for ($i = 0; $i -lt $numDocs; $i++) { $avDoc = $acrobat.GetAVDoc($i); if ($avDoc) { $pddoc = $avDoc.GetPDDoc(); $numPages = $pddoc.GetNumPages(); $filePath = $pddoc.GetFileName(); $title = $avDoc.GetTitle(); Write-Output ('ACROBAT_COM|' + $filePath + '|' + $numPages + '|' + $title) } } } catch { }"`);
                const results: any[] = [];
                for (const line of stdout.split('\n')) {
                    if (line.startsWith('ACROBAT_COM|')) {
                        const parts = line.split('|');
                        let filePath = parts[1]?.trim();
                        const title = parts[3]?.trim();
                        // GetFileName may return just the name or full path depending on Acrobat version
                        if (filePath && fs.existsSync(filePath)) {
                            results.push({ path: filePath, name: path.basename(filePath) });
                        }
                        else if (filePath) {
                            // Try to find the file on common locations using the filename
                            const fileName = path.basename(filePath);
                            const searchDirs = [
                                path.join(require('os').homedir(), 'Desktop'),
                                path.join(require('os').homedir(), 'Documents'),
                                path.join(require('os').homedir(), 'Downloads'),
                            ];
                            for (const dir of searchDirs) {
                                const candidate = path.join(dir, fileName);
                                if (fs.existsSync(candidate)) {
                                    results.push({ path: candidate, name: fileName });
                                    break;
                                }
                            }
                            // Also try the title as filename (may contain the original Arabic name)
                            if (title && title !== fileName) {
                                for (const dir of searchDirs) {
                                    const candidate = path.join(dir, title.endsWith('.pdf') ? title : title + '.pdf');
                                    if (fs.existsSync(candidate)) {
                                        results.push({ path: candidate, name: title });
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
                return results;
            }
            catch (_) {
                return [];
            }
        })();
        const [enumLines, uiaLines, acrobatLines, rawSessionTabs, cdpTabs, acrobatComFiles] = await Promise.all([
            enumPromise, uiaPromise, acrobatPromise, sessionPromise, cdpDiscoveryPromise, acrobatComPromise
        ]);
        const windowEntries: any[] = [];
        const supportedFileTitles: string[] = [];
        const browserProcessSet = new Set(); // track running browser processes
        for (const line of enumLines) {
            // Format: title|processName|visible|minimized|handle
            // Title can contain '|', so parse the last 4 fields from the end
            const parts = line.split('|');
            if (parts.length < 5)
                continue;
            const handle = parts[parts.length - 1];
            const minimized = parts[parts.length - 2] === 'True';
            const visible = parts[parts.length - 3] === 'True';
            const proc = (parts[parts.length - 4] || '').toLowerCase();
            const title = parts.slice(0, parts.length - 4).join('|');
            windowEntries.push({ title, process: proc, visible, minimized });
            if (SUPPORTED_EXT_PATTERN.test(title) && !title.includes('Klypix')) {
                supportedFileTitles.push(title);
            }
            // Track browsers with visible windows
            if (visible && (proc === 'chrome' || proc === 'msedge' || proc === 'brave' || proc === 'firefox' || proc === 'opera' || proc === 'vivaldi' || proc === 'waterfox' || proc === 'arc' || proc === 'operagx' || proc === 'floorp')) {
                browserProcessSet.add(proc);
            }
        }
        // Map browser process names to friendly names for session trust
        const browsersWithWindows = new Set<string>();
        const browsersMinimized = new Set<string>(); // browsers that are minimized (not fully visible)
        const browserProcessToFriendly: Record<string, string> = {
            chrome: 'Google Chrome', msedge: 'Microsoft Edge', brave: 'Brave',
            firefox: 'Firefox', opera: 'Opera', vivaldi: 'Vivaldi',
            waterfox: 'Waterfox', arc: 'Arc', operagx: 'Opera GX', floorp: 'Floorp',
        };
        for (const entry of windowEntries) {
            const friendly = browserProcessToFriendly[entry.process];
            if (friendly && entry.visible) {
                browsersWithWindows.add(friendly);
                if (entry.minimized)
                    browsersMinimized.add(friendly);
            }
        }
        console.log(`[DeepMode] EnumWin: ${enumLines.length} windows, ${supportedFileTitles.length} files, browsers: ${[...browsersWithWindows].join(',')} minimized: ${[...browsersMinimized].join(',')}`);
        // ─── Parse Acrobat files from registry ───────────────────────────────
        const acrobatFiles: any[] = [];
        for (const line of acrobatLines) {
            if (line.startsWith('ACROBAT_FILE|')) {
                const filePath = line.substring('ACROBAT_FILE|'.length).trim();
                if (filePath) {
                    acrobatFiles.push({ path: filePath, name: path.basename(filePath) });
                }
            }
        }
        // ─── Session file trust logic ────────────────────────────────────────
        const sessionTabs = rawSessionTabs.filter((st: any) => browsersWithWindows.has(st.browser));
        const sessionUrlMap = new Map();
        for (const st of sessionTabs) {
            const normTitle = st.title.replace(/\s+/g, ' ').trim().toLowerCase();
            if (st.url)
                sessionUrlMap.set(normTitle, st.url);
        }
        // ─── Merge CDP-discovered tabs into session tabs (fills minimized browser gap) ──
        // IMPORTANT: Only include CDP tabs for browsers that have visible windows.
        // Chrome runs background processes even when "closed" — CDP may still respond
        // on the debug port, returning stale tabs from the last session.
        if (cdpTabs.length > 0) {
            const cdpFiltered = cdpTabs.filter((ct: any) => browsersWithWindows.has(ct.browser));
            console.log(`[DeepMode] CDP discovery found ${cdpTabs.length} tabs, ${cdpFiltered.length} from browsers with visible windows`);
            for (const ct of cdpFiltered) {
                const normTitle = ct.title.replace(/\s+/g, ' ').trim().toLowerCase();
                // Only add if not already in session tabs (avoid duplicates)
                if (!sessionUrlMap.has(normTitle)) {
                    sessionUrlMap.set(normTitle, ct.url);
                    sessionTabs.push(ct);
                }
            }
        }
        // ─── Merge Acrobat COM files into acrobatFiles (more reliable than registry MRU) ──
        if (acrobatComFiles.length > 0) {
            console.log(`[DeepMode] Acrobat COM found ${acrobatComFiles.length} open files`);
            for (const af of acrobatComFiles) {
                // Add if not already found by registry MRU
                if (!acrobatFiles.some((f: any) => f.path.toLowerCase() === af.path.toLowerCase())) {
                    acrobatFiles.push(af);
                }
            }
        }
        // ─── Parse UIA results ───────────────────────────────────────────────
        const uiaTabs: any[] = [];
        const additionalFileTitles: string[] = [];
        for (const line of uiaLines) {
            if (line.startsWith('[TAB]|')) {
                // Format: [TAB]|title|url|process — but title can contain '|'
                // Parse from the END: process is last, url is second-to-last, title is everything between
                const withoutPrefix = line.substring('[TAB]|'.length);
                const lastPipe = withoutPrefix.lastIndexOf('|');
                if (lastPipe < 0)
                    continue;
                const proc = withoutPrefix.substring(lastPipe + 1).trim();
                const beforeProc = withoutPrefix.substring(0, lastPipe);
                const secondLastPipe = beforeProc.lastIndexOf('|');
                let title, url;
                if (secondLastPipe >= 0) {
                    title = beforeProc.substring(0, secondLastPipe).trim();
                    url = beforeProc.substring(secondLastPipe + 1).trim();
                }
                else {
                    title = beforeProc.trim();
                    url = '';
                }
                if (isNoiseTab(title) && !url)
                    continue;
                uiaTabs.push({ title, url: url || '', process: proc });
            }
            else if (line.startsWith('[FILE]|')) {
                additionalFileTitles.push(line.substring('[FILE]|'.length).trim());
            }
        }
        console.log(`[DeepMode] UIA raw: ${uiaLines.length} lines, parsed: ${uiaTabs.length} tabs, ${additionalFileTitles.length} files`);
        if (uiaTabs.length > 0) {
            for (const t of uiaTabs)
                console.log(`[DeepMode]   UIA tab: "${t.title}" url="${t.url?.substring(0, 60)}" proc=${t.process}`);
        }
        // ─── Tab Cache: handle minimized browsers ────────────────────────────
        // For each browser: if UIA found tabs, update cache.
        // If browser is minimized and UIA found fewer tabs than cached, merge cached tabs back.
        // If browser is closed (no visible windows), clear cache.
        // Group UIA tabs by browser
        const uiaTabsByBrowser = new Map();
        for (const tab of uiaTabs) {
            const browser = uiaProcessToApp[tab.process.toLowerCase()] || '';
            if (!browser)
                continue;
            if (!uiaTabsByBrowser.has(browser))
                uiaTabsByBrowser.set(browser, []);
            uiaTabsByBrowser.get(browser).push(tab);
        }
        // Update cache and merge
        for (const browserName of BROWSER_NAMES) {
            const hasWindow = browsersWithWindows.has(browserName);
            const isMinimized = browsersMinimized.has(browserName);
            const uiaForBrowser = uiaTabsByBrowser.get(browserName) || [];
            if (!hasWindow) {
                // Browser closed — clear cache
                tabCache.delete(browserName);
                continue;
            }
            if (uiaForBrowser.length > 0) {
                if (!isMinimized || uiaForBrowser.length >= (tabCache.get(browserName)?.length || 0)) {
                    // Browser is visible OR UIA found more/equal tabs — update cache
                    tabCache.set(browserName, [...uiaForBrowser]);
                }
                else {
                    // Browser is minimized and UIA found fewer — merge cached tabs back into uiaTabs
                    const currentTitles = new Set(uiaForBrowser.map((t: any) => t.title.toLowerCase().trim()));
                    const cached = tabCache.get(browserName) || [];
                    for (const cachedTab of cached) {
                        if (!currentTitles.has(cachedTab.title.toLowerCase().trim())) {
                            uiaTabs.push(cachedTab); // Re-add missing cached tab
                        }
                    }
                }
            }
            else if (isMinimized) {
                // UIA returned 0 tabs but browser is minimized — use entire cache
                const cached = tabCache.get(browserName) || [];
                for (const cachedTab of cached) {
                    uiaTabs.push(cachedTab);
                }
            }
        }
        // ─── Build desktop file entries (non-browser) ────────────────────────
        const browserNamePatterns = BROWSER_NAMES.map(b => b.toLowerCase());
        const allFileTitles = Array.from(new Set([...supportedFileTitles, ...additionalFileTitles]));
        const nonBrowserFileTitles = allFileTitles.filter(title => {
            const lower = title.toLowerCase();
            return !browserNamePatterns.some(bp => lower.includes(bp));
        });
        const filesList: any[] = [];
        for (const title of nonBrowserFileTitles) {
            let cleanName = title;
            const windowEntry = windowEntries.find((e: any) => e.title === title);
            let sourceApp = 'Document Viewer';
            if (windowEntry?.process && processToApp[windowEntry.process]) {
                sourceApp = processToApp[windowEntry.process];
            }
            else {
                for (const b of [...BROWSER_NAMES, ...OFFICE_NAMES]) {
                    if (title.toLowerCase().includes(b.toLowerCase())) {
                        sourceApp = b;
                        break;
                    }
                }
            }
            cleanName = title.replace(appSuffixRegex, '');
            const match = cleanName.match(/(.+\.(?:pdf|docx?|xlsx?|csv|txt|md|rtf|pptx?|json|xml|html?|epub))/i);
            if (match) {
                try {
                    cleanName = decodeURIComponent(match[1].trim());
                }
                catch (_) {
                    cleanName = match[1].trim();
                }
            }
            else {
                try {
                    cleanName = decodeURIComponent(cleanName.trim());
                }
                catch (_) {
                    cleanName = cleanName.trim();
                }
            }
            filesList.push({
                id: encodeURIComponent(cleanName),
                originalTitle: title,
                name: path.basename(cleanName),
                source: sourceApp,
                type: 'file',
                url: undefined,
                localPath: undefined,
                status: 'title-only',
            });
        }
        // ─── Add Acrobat PDFs (detected via registry) ────────────────────────
        for (const af of acrobatFiles) {
            const normKey = normalizeDocName(af.name);
            const alreadyFound = filesList.some((f: any) => normalizeDocName(f.name) === normKey);
            if (!alreadyFound) {
                filesList.push({
                    id: encodeURIComponent(af.name),
                    originalTitle: af.name,
                    name: af.name,
                    source: 'Adobe Acrobat',
                    type: 'file',
                    url: undefined,
                    localPath: af.path,
                    status: 'linked',
                });
            }
        }
        // ─── Build browser tab entries with session enrichment ───────────────
        const uiaNormTitles = new Set(uiaTabs.map((t: any) => t.title.replace(/\s+/g, ' ').trim().toLowerCase()));
        // Session-only tabs: fill gaps for minimized browsers
        // Build a set of CDP-confirmed tab titles for ghost tab filtering
        const cdpConfirmedTitles = new Set();
        for (const ct of cdpTabs.filter((t: any) => browsersWithWindows.has(t.browser))) {
            cdpConfirmedTitles.add(ct.title.replace(/\s+/g, ' ').trim().toLowerCase());
        }
        const sessionOnlyTabs = sessionTabs
            .filter((st: any) => {
            const normTitle = st.title.replace(/\s+/g, ' ').trim().toLowerCase();
            if (uiaNormTitles.has(normTitle))
                return false; // UIA already has it
            if (isNoiseTab(st.title))
                return false;
            // If browser is NOT minimized but UIA didn't find this tab → stale, skip it
            const isMin = browsersMinimized.has(st.browser);
            if (!isMin)
                return false;
            // If CDP is active and CDP doesn't list this tab → ghost/stale tab, skip it
            if (cdpConfirmedTitles.size > 0 && !cdpConfirmedTitles.has(normTitle))
                return false;
            return true;
        });
        const allBrowserTabs = [
            ...uiaTabs.map((t: any) => ({
                title: t.title, url: t.url,
                browser: uiaProcessToApp[t.process.toLowerCase()] || ''
            })),
            ...sessionOnlyTabs,
        ];
        const tabIdCounts = new Map();
        const tabsList = allBrowserTabs.map((tab: any) => {
            let cleanName = tab.title.replace(appSuffixRegex, '').trim();
            let sourceApp = tab.browser || 'Web Browser';
            if (!tab.browser) {
                for (const b of BROWSER_NAMES) {
                    if (tab.title.toLowerCase().includes(b.toLowerCase())) {
                        sourceApp = b;
                        break;
                    }
                }
            }
            // Enrich URL from session files
            let enrichedUrl = tab.url;
            if (!enrichedUrl || enrichedUrl.length === 0) {
                const normTitle = tab.title.replace(/\s+/g, ' ').trim().toLowerCase();
                enrichedUrl = sessionUrlMap.get(normTitle) || '';
                if (!enrichedUrl) {
                    const strippedTitle = normTitle
                        .replace(/\s*[-\u2013\u2014]\s*(google chrome|microsoft edge|mozilla firefox|brave|opera)\s*$/i, '')
                        .trim();
                    if (strippedTitle !== normTitle)
                        enrichedUrl = sessionUrlMap.get(strippedTitle) || '';
                }
                if (!enrichedUrl) {
                    for (const [sessTitle, sessUrl] of sessionUrlMap) {
                        if (normTitle.includes(sessTitle) || sessTitle.includes(normTitle)) {
                            enrichedUrl = sessUrl;
                            break;
                        }
                    }
                }
            }
            const hasUrl = enrichedUrl && enrichedUrl.length > 0;
            const localPath = hasUrl ? fileUrlToPath(enrichedUrl) : null;
            let tabId;
            if (hasUrl) {
                tabId = encodeURIComponent(enrichedUrl);
            }
            else {
                const baseKey = encodeURIComponent(cleanName);
                const count = tabIdCounts.get(baseKey) || 0;
                tabIdCounts.set(baseKey, count + 1);
                tabId = count > 0 ? `${baseKey}__${count}` : baseKey;
            }
            const status = localPath ? 'linked' : hasUrl ? 'web-only' : 'title-only';
            return {
                id: tabId,
                originalTitle: tab.title,
                url: hasUrl ? enrichedUrl : undefined,
                name: localPath ? path.basename(localPath) : cleanName,
                source: sourceApp,
                type: (localPath ? 'file' : 'web'),
                localPath: localPath || undefined,
                status,
            };
        });
        const mergeMap = new Map();
        for (const item of [...filesList, ...tabsList]) {
            const normKey = normalizeDocName(item.name);
            const existing = mergeMap.get(normKey);
            if (!existing) {
                mergeMap.set(normKey, item);
            }
            else {
                if (item.type === 'file' && existing.type === 'web') {
                    item.url = item.url || existing.url;
                    item.status = item.localPath ? 'linked' : item.url ? 'web-only' : 'title-only';
                    mergeMap.set(normKey, item);
                }
                else if (item.localPath && !existing.localPath) {
                    existing.localPath = item.localPath;
                    existing.type = 'file';
                    existing.status = 'linked';
                }
                else if (item.url && !existing.url) {
                    existing.url = item.url;
                    if (existing.status === 'title-only')
                        existing.status = 'web-only';
                }
            }
        }
        const uniqueItems = Array.from(mergeMap.values()).map((item: any) => ({
            id: item.id, originalTitle: item.originalTitle, name: item.name,
            source: item.source, type: item.type, url: item.url,
            localPath: item.localPath, status: item.status,
        }));
        console.log(`[DeepMode] Discovery: ${filesList.length} files, ${tabsList.length} tabs, ${acrobatFiles.length} acrobat → ${uniqueItems.length} unique`);
        lastScanResult = { files: uniqueItems };
        return lastScanResult;
    }
    catch (e: any) {
        console.error('get-all-open-files error:', e);
        return { error: e.message };
    }
    finally {
        scanInProgress = false;
    }
});
// ─── Light Fetch: background excerpt extraction for Smart Suggestions ─────
ipcMain.handle('light-fetch-all', async (_event: any, filesData: any[]) => {
    const EXCERPT_LIMIT = 1000;
    const TIMEOUT_PER_ITEM = 5000;
    const results: any[] = [];
    const fetchOne = async (item: any) => {
        try {
            // Local file: read first N chars
            if (item.localPath && fs.existsSync(item.localPath)) {
                const ext = path.extname(item.localPath).toLowerCase();
                const textExts = ['.txt', '.md', '.json', '.xml', '.html', '.htm', '.rtf', '.csv'];
                if (textExts.includes(ext)) {
                    const buf = Buffer.alloc(EXCERPT_LIMIT);
                    const fd = fs.openSync(item.localPath, 'r');
                    const bytesRead = fs.readSync(fd, buf, 0, EXCERPT_LIMIT, 0);
                    fs.closeSync(fd);
                    return { id: item.id, excerpt: buf.toString('utf-8', 0, bytesRead) };
                }
                if (ext === '.pdf') {
                    try {
                        const pdfResult = await readPdfFromDisk(item.localPath, { maxChars: EXCERPT_LIMIT });
                        if (pdfResult.needsPassword) {
                            return { id: item.id, excerpt: `[Password-protected PDF]` };
                        }
                        if (pdfResult.content.length > 20) {
                            return { id: item.id, excerpt: pdfResult.content.slice(0, EXCERPT_LIMIT) };
                        }
                    }
                    catch (_) { }
                }
                // For docx/xlsx/pptx — too heavy for light fetch, just return title
                return { id: item.id, excerpt: `[${path.basename(item.localPath)}]` };
            }
            // Web tab: try server-side fetch first (fast), then CDP if available
            if (item.type === 'web' && item.url && !item.url.startsWith('file://')) {
                // 1. Server-side fetch (fast, no side effects)
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), TIMEOUT_PER_ITEM);
                try {
                    const response = await fetch(item.url, {
                        signal: controller.signal,
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        },
                        redirect: 'follow',
                    });
                    clearTimeout(timer);
                    if (response.ok) {
                        const html = await response.text();
                        const cheerio = require('cheerio');
                        const $ = cheerio.load(html);
                        $('script, style, noscript, nav, footer, header, svg, iframe').remove();
                        let text = $('article, main, [role="main"], .content, .post').text();
                        if (!text || text.trim().length < 50)
                            text = $('body').text();
                        text = text.replace(/\s+/g, ' ').trim();
                        if (text.length > 20) {
                            return { id: item.id, excerpt: text.slice(0, EXCERPT_LIMIT) };
                        }
                    }
                }
                catch (_) {
                    clearTimeout(timer);
                }
                // 2. CDP fallback (skip clipboard for light fetch — too intrusive)
                try {
                    const cdpText = await cdpReadTabContent(item.url, item.name || '', EXCERPT_LIMIT * 2);
                    if (cdpText && (cdpText as string).length > 20) {
                        return { id: item.id, excerpt: (cdpText as string).slice(0, EXCERPT_LIMIT) };
                    }
                }
                catch (_) { }
            }
            // Fallback: just the name
            return { id: item.id, excerpt: `[${item.name}]` };
        }
        catch (_) {
            return null;
        }
    };
    // Fetch all in parallel with a concurrency cap
    const CONCURRENCY = 5;
    for (let i = 0; i < filesData.length; i += CONCURRENCY) {
        const batch = filesData.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(fetchOne));
        for (const r of batchResults) {
            if (r)
                results.push(r);
        }
    }
    return { excerpts: results };
});
ipcMain.handle('read-multiple-files', async (event: any, filesData: any[]) => {
    try {
        const os = require('os');
        const results: any[] = [];
        const supportedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.md', '.rtf', '.pptx', '.ppt', '.json', '.xml', '.html', '.htm', '.epub'];
        for (const fileObj of filesData) {
            // If the entry has a resolved local path (e.g. from file:/// merge), use it directly
            if (fileObj.localPath && fs.existsSync(fileObj.localPath)) {
                fileObj.type = 'file';
                fileObj.originalTitle = fileObj.originalTitle || fileObj.localPath;
                // Fall through to the file reading logic below
            }
            // --- WEBPAGE CONTENT: CDP → Server-side fetch → Clipboard ---
            else if (fileObj.type === 'web') {
                try {
                    const tabUrl = fileObj.url || '';
                    const tabTitle = fileObj.originalTitle || fileObj.name || '';
                    console.log(`[read-multiple-files] Web tab: title="${tabTitle}" url="${tabUrl}" status="${fileObj.status}"`);
                    // CRITICAL: If this is a file:/// URL, read directly from disk instead of web extraction
                    if (tabUrl.startsWith('file:///') || tabUrl.startsWith('file://')) {
                        let localFilePath = tabUrl.replace(/^file:\/\/\//, '').replace(/^file:\/\//, '');
                        localFilePath = decodeURIComponent(localFilePath);
                        if (!localFilePath.match(/^[a-zA-Z]:/))
                            localFilePath = '/' + localFilePath;
                        // Normalize forward slashes to OS path
                        localFilePath = localFilePath.replace(/\//g, path.sep);
                        console.log(`[read-multiple-files] file:// URL detected, reading from disk: ${localFilePath}`);
                        if (fs.existsSync(localFilePath)) {
                            // Route to local file reading logic by changing type
                            fileObj.localPath = localFilePath;
                            fileObj.type = 'file';
                            fileObj.originalTitle = fileObj.originalTitle || path.basename(localFilePath);
                            // Don't continue — fall through to file reading logic below
                        }
                        else {
                            console.log(`[read-multiple-files] file:// path not found on disk: ${localFilePath}`);
                            // Continue with web extraction as fallback
                        }
                    }
                    // If we converted to file type, fall through to file reading logic below
                    if (fileObj.type === 'file') {
                        // Don't continue — let it fall through to the file reading section
                    }
                    else {
                        let webContent: string | null = null;
                        let method = 'none';
                        if (tabUrl) {
                            // Has URL — use full fallback chain
                            const result = await readWebPageContent(tabUrl, tabTitle, 40000);
                            webContent = result.content;
                            method = result.method;
                        }
                        else {
                            // No URL (title-only tab) — try clipboard fallback using window title
                            console.log(`[read-multiple-files] No URL for "${tabTitle}", trying clipboard fallback`);
                            const clipContent = await clipboardReadFallback(tabTitle);
                            if (clipContent && clipContent.length > 50) {
                                webContent = clipContent.replace(/\s+/g, ' ').trim();
                                if (webContent.length > 40000)
                                    webContent = webContent.slice(0, 40000) + '\n\n[... content truncated ...]';
                                method = 'clipboard';
                            }
                        }
                        if (webContent && webContent.length > 50) {
                            const wordCount = webContent.split(' ').length;
                            const pageCount = Math.max(1, Math.ceil(wordCount / 500));
                            console.log(`[read-multiple-files] Web content via ${method}: ${webContent.length} chars`);
                            results.push({ ...fileObj, content: webContent, pageCount, truncated: webContent.length >= 40000 });
                        }
                        else {
                            results.push({ ...fileObj, error: `Could not extract page content (no URL detected for this tab, and clipboard fallback failed)` });
                        }
                        continue;
                    }
                }
                catch (err: any) {
                    results.push({ ...fileObj, error: `Content extraction error: ${err.message}` });
                    continue;
                }
            }
            let windowTitle = fileObj.originalTitle || fileObj.name || '';
            let detectedPath: string | null = null;
            // Strategy 0: Use localPath if provided by merge logic
            if (fileObj.localPath && fs.existsSync(fileObj.localPath)) {
                detectedPath = fileObj.localPath;
                console.log(`[read-multiple-files] Found path via localPath: ${detectedPath}`);
            }
            // Strategy 1: Direct path in window title (also handle URL-encoded paths)
            if (!detectedPath && windowTitle) {
                const decoded = decodeURIComponent(windowTitle);
                const fullPathMatch = decoded.match(/([A-Za-z]:\\[^"*?<>|]+\.(?:pdf|docx?|xlsx?|csv|txt|md|rtf|pptx?|json|xml|html?|epub))/i);
                if (fullPathMatch) {
                    detectedPath = fullPathMatch[1];
                    console.log(`[read-multiple-files] Found path via windowTitle match: ${detectedPath}`);
                }
            }
            // Strategy 2: Extract filename robustly
            if (!detectedPath) {
                let candidateName = windowTitle;
                const appSuffixesRead = [
                    /\s+[-\u2013\u2014]\s+(?:Google Chrome|Microsoft Edge|Mozilla Firefox|Brave|Opera)\s*$/i,
                    /\s+[-\u2013\u2014]\s+(?:Adobe Acrobat|Foxit|SumatraPDF|PDF-XChange|Nitro Pro).*$/i,
                    /\s+[-\u2013\u2014]\s+(?:Microsoft\s+)?(?:Word|Excel|PowerPoint)\s*$/i,
                    /\s+[-\u2013\u2014]\s+(?:Notepad\+\+|Notepad|Visual Studio Code|Code)\s*$/i,
                    /\s+[-\u2013\u2014]\s+(?:LibreOffice|WPS Office).*$/i,
                ];
                for (const suffix of appSuffixesRead) {
                    candidateName = candidateName.replace(suffix, '');
                }
                const fileExtRegex = /(.+\.(?:pdf|docx?|xlsx?|csv|txt|md|rtf|pptx?|json|xml|html?|epub))/i;
                const match = candidateName.match(fileExtRegex);
                if (match) {
                    try {
                        candidateName = decodeURIComponent(match[1].trim());
                    }
                    catch (_) {
                        candidateName = match[1].trim();
                    }
                }
                else {
                    try {
                        candidateName = decodeURIComponent(candidateName.trim());
                    }
                    catch (_) {
                        candidateName = candidateName.trim();
                    }
                }
                if (candidateName) {
                    // Strategy 2a: Common local folders
                    const searchDirs = [
                        process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Desktop` : null,
                        process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Documents` : null,
                        process.env.USERPROFILE ? `${process.env.USERPROFILE}\\Downloads` : null,
                    ].filter(Boolean) as string[];
                    for (const dir of searchDirs) {
                        const candidate = path.join(dir, candidateName);
                        if (fs.existsSync(candidate)) {
                            detectedPath = candidate;
                            console.log(`[read-multiple-files] Found path via Desktop/Documents/Downloads search: ${detectedPath}`);
                            break;
                        }
                    }
                    // Strategy 2b: Windows Recent
                    if (!detectedPath) {
                        try {
                            const lnkScript = path.join(os.tmpdir(), 'klypix_lnk.ps1');
                            const safeLnkFilter = candidateName.replace(/'/g, "''") + ".lnk";
                            fs.writeFileSync(lnkScript, '\ufeff' + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $f = Get-ChildItem -Path "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter '${safeLnkFilter}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $sh = (New-Object -COM WScript.Shell).CreateShortcut($f.FullName); $sh.TargetPath }`, 'utf8');
                            const { stdout: target } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${lnkScript}"`, { encoding: 'utf8' });
                            try {
                                fs.unlinkSync(lnkScript);
                            }
                            catch (_) { }
                            const resolved = target.trim();
                            if (resolved && fs.existsSync(resolved)) {
                                detectedPath = resolved;
                            }
                        }
                        catch (_) { }
                    }
                    // Strategy 2c: Drive Scan
                    if (!detectedPath) {
                        try {
                            const searchScript = path.join(os.tmpdir(), 'klypix_search.ps1');
                            const safeFilter = candidateName.replace(/'/g, "''");
                            fs.writeFileSync(searchScript, '\ufeff' + `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $drives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root; foreach ($d in $drives) { $f = Get-ChildItem -Path $d -Filter '${safeFilter}' -Recurse -ErrorAction SilentlyContinue -File | Select-Object -First 1; if ($f) { $f.FullName; break } }`, 'utf8');
                            const { stdout: foundPath } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${searchScript}"`, { timeout: 20000, encoding: 'utf8' });
                            try {
                                fs.unlinkSync(searchScript);
                            }
                            catch (_) { }
                            const resolved = foundPath.trim();
                            if (resolved && fs.existsSync(resolved)) {
                                detectedPath = resolved;
                            }
                        }
                        catch (_) { }
                    }
                }
            }
            if (!detectedPath) {
                results.push({ ...fileObj, error: `Could not locate file on disk` });
                continue;
            }
            const ext = path.extname(detectedPath).toLowerCase();
            const fileName = path.basename(detectedPath);
            if (!supportedExts.includes(ext)) {
                results.push({ ...fileObj, error: `Unsupported file type: ${ext}` });
                continue;
            }
            let content = '';
            let pageCount = 0;
            try {
                if (ext === '.pdf') {
                    const pdfResult = await readPdfFromDisk(detectedPath);
                    if (pdfResult.needsPassword) {
                        results.push({ ...fileObj, name: fileObj.name || path.basename(detectedPath), error: 'Password-protected PDF', needsPassword: true, localPath: detectedPath });
                        continue;
                    }
                    content = pdfResult.content;
                    pageCount = pdfResult.pageCount;
                    if (pdfResult.isScanned) {
                        console.log(`[read-multiple-files] OCR used for scanned PDF: ${detectedPath}`);
                    }
                }
                else if (ext === '.docx' || ext === '.doc') {
                    const mammoth = require('mammoth');
                    // Copy to temp first — Word may have an exclusive lock
                    let readPath = detectedPath;
                    let tmpCopy: string | null = null;
                    try {
                        await mammoth.extractRawText({ path: detectedPath });
                    }
                    catch (lockErr: any) {
                        if (lockErr.code === 'EBUSY' || lockErr.code === 'EACCES' || lockErr.code === 'EPERM') {
                            tmpCopy = path.join(os.tmpdir(), `klypix_locked_${Date.now()}_${path.basename(detectedPath)}`);
                            fs.copyFileSync(detectedPath, tmpCopy);
                            readPath = tmpCopy;
                        }
                        else {
                            throw lockErr;
                        }
                    }
                    const result = await mammoth.extractRawText({ path: readPath });
                    content = result.value;
                    pageCount = Math.ceil(content.split('\n').length / 30);
                    if (tmpCopy)
                        try {
                            fs.unlinkSync(tmpCopy);
                        }
                        catch (_) { }
                }
                else if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
                    const XLSX = require('xlsx');
                    // Copy to temp first — Excel may have an exclusive lock
                    let readPath = detectedPath;
                    let tmpCopy: string | null = null;
                    try {
                        fs.accessSync(detectedPath, fs.constants.R_OK);
                    }
                    catch (_) {
                        tmpCopy = path.join(os.tmpdir(), `klypix_locked_${Date.now()}_${path.basename(detectedPath)}`);
                        fs.copyFileSync(detectedPath, tmpCopy);
                        readPath = tmpCopy;
                    }
                    const workbook = XLSX.readFile(readPath);
                    pageCount = workbook.SheetNames.length;
                    if (tmpCopy)
                        try {
                            fs.unlinkSync(tmpCopy);
                        }
                        catch (_) { }
                    const parts: string[] = [];
                    for (const sheetName of workbook.SheetNames) {
                        const sheet = workbook.Sheets[sheetName];
                        const csv = XLSX.utils.sheet_to_csv(sheet);
                        parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
                    }
                    content = parts.join('\n\n');
                }
                else if (ext === '.txt' || ext === '.md' || ext === '.json' || ext === '.xml' || ext === '.htm' || ext === '.html') {
                    content = safeReadFileSync(detectedPath, 'utf-8');
                    pageCount = Math.ceil(content.split('\n').length / 50);
                }
                else if (ext === '.rtf') {
                    // Basic RTF text extraction: strip RTF control words
                    const raw = safeReadFileSync(detectedPath, 'utf-8');
                    content = raw.replace(/\{\\[^{}]*\}/g, '').replace(/\\[a-z]+\d*\s?/gi, '').replace(/[{}]/g, '').trim();
                    pageCount = Math.ceil(content.split('\n').length / 50);
                }
                else if (ext === '.pptx' || ext === '.ppt') {
                    const officeParser = require('officeparser');
                    content = await new Promise((resolve, reject) => {
                        officeParser.parseOffice(detectedPath, (data: any, err: any) => {
                            if (err)
                                reject(err);
                            else
                                resolve(data);
                        });
                    });
                    pageCount = (content.match(/\n{3,}/g) || []).length + 1;
                }
                else if (ext === '.epub') {
                    // EPUB is a zip of XHTML files — extract text via officeparser or fallback
                    try {
                        const officeParser = require('officeparser');
                        content = await new Promise((resolve, reject) => {
                            officeParser.parseOffice(detectedPath, (data: any, err: any) => {
                                if (err)
                                    reject(err);
                                else
                                    resolve(data);
                            });
                        });
                    }
                    catch (_) {
                        content = '[EPUB content extraction not available]';
                    }
                    pageCount = Math.ceil(content.split('\n').length / 50);
                }
                const MAX_CHARS = 40000; // slightly smaller per file to fit multiple
                const truncated = content.length > MAX_CHARS;
                if (truncated)
                    content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';
                results.push({ ...fileObj, fileName, pageCount, content, truncated });
            }
            catch (err: any) {
                results.push({ ...fileObj, error: err.message });
            }
        }
        return { results };
    }
    catch (e: any) {
        console.error('read-multiple-files error:', e);
        return { error: e.message };
    }
});
