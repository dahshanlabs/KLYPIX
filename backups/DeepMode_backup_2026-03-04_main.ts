import { app, BrowserWindow, globalShortcut, Tray, Menu, ipcMain, screen, session, shell, clipboard, nativeImage } from 'electron';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
// @ts-ignore
import screenshot from 'screenshot-desktop';
const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const execAsync = promisify(exec);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let currentShortcut = 'Alt+Space';

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 550,
        height: 380, // Increased height to allow the dropdown to appear downwards without clipping
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    const url = isDev ? 'http://localhost:5173' : `file://${path.join(__dirname, '../dist/index.html')}`;
    mainWindow.loadURL(url);

    mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
    mainWindow.setVisibleOnAllWorkspaces(true);
}

function createTray() {
    const iconPath = isDev
        ? path.join(__dirname, '../public/logo.png')
        : path.join(__dirname, '../dist/logo.png');

    tray = new Tray(iconPath);
    const contextMenu = Menu.buildFromTemplate([
        { label: 'Show ALT+Space', click: () => toggleWindow() },
        { type: 'separator' },
        { label: 'Quit', click: () => app.quit() },
    ]);
    tray.setToolTip('ALT+Space AI Assistant');
    tray.setContextMenu(contextMenu);
    tray.on('click', () => toggleWindow());
}

function toggleWindow() {
    if (mainWindow?.isVisible()) {
        mainWindow.hide();
    } else {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width, height } = primaryDisplay.workAreaSize;

        // Default position on the right side, middle height
        const windowWidth = 550;
        const windowHeight = 180;
        const x = Math.floor(width - windowWidth - 2); // 2px padding from right
        const y = Math.floor((height - windowHeight) / 2);

        // Only set default position if window is hidden
        mainWindow?.setPosition(x, y);
        mainWindow?.show();
        mainWindow?.focus();
    }
}

app.whenReady().then(() => {
    createWindow();
    createTray();

    globalShortcut.register(currentShortcut, () => {
        toggleWindow();
    });

    ipcMain.handle('get-shortcut', () => currentShortcut);

    ipcMain.handle('set-shortcut', (_event, shortcut: string) => {
        try {
            globalShortcut.unregister(currentShortcut);
            const success = globalShortcut.register(shortcut, () => {
                toggleWindow();
            });
            if (success) {
                currentShortcut = shortcut;
                return { success: true, shortcut };
            } else {
                // Rollback if failed
                globalShortcut.register(currentShortcut, () => {
                    toggleWindow();
                });
                return { success: false, error: 'Could not register shortcut. It might be in use.' };
            }
        } catch (error: any) {
            return { success: false, error: error.message };
        }
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });

    // Handle microphone permissions
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') {
            callback(true);
        } else {
            callback(false);
        }
    });

    session.defaultSession.setPermissionCheckHandler((webContents, permission, origin) => {
        if (permission === 'media') {
            return true;
        }
        return false;
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('capture-screen', async () => {
    try {
        mainWindow?.hide();
        await new Promise(resolve => setTimeout(resolve, 150));
        const buffer = await screenshot({ format: 'png' });
        mainWindow?.show();

        // Optimize image for Gemini (JPEG + Resizing)
        const image = nativeImage.createFromBuffer(buffer);
        const { width, height } = image.getSize();
        const maxWidth = 1280;
        let finalImage = image;

        if (width > maxWidth) {
            finalImage = image.resize({ width: maxWidth });
        }

        // JPEG 80% is much smaller than PNG for faster upload
        return finalImage.toJPEG(80).toString('base64');
    } catch (err) {
        console.error('Failed to capture screen:', err);
        mainWindow?.show();
        return null;
    }
});

ipcMain.handle('capture-screen-raw', async () => {
    try {
        const buffer = await screenshot({ format: 'png' });
        const image = nativeImage.createFromBuffer(buffer);
        const { width } = image.getSize();
        const maxWidth = 1280;
        let finalImage = image;

        if (width > maxWidth) {
            finalImage = image.resize({ width: maxWidth });
        }

        return finalImage.toJPEG(80).toString('base64');
    } catch (err) {
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
    } catch (err) {
        console.error('Failed to launch native snipping:', err);
        mainWindow?.show();
        return null;
    }
});

ipcMain.on('minimize-window', () => {
    mainWindow?.hide();
});

ipcMain.on('set-ignore-mouse-events', (event, ignore, options) => {
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

ipcMain.on('toggle-maximize', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow?.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on('copy-to-clipboard', (event, { text, html }) => {
    clipboard.write({
        text: text,
        html: html
    });
});

ipcMain.on('resize-window', (event, newHeight: number, newWidth?: number) => {
    if (mainWindow) {
        const primaryDisplay = screen.getPrimaryDisplay();
        const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

        const currentWidth = newWidth || mainWindow.getSize()[0];
        const [currentX, currentY] = mainWindow.getPosition();

        // If it's a small height, it's likely a reset/toggle, so we pin to right
        if (newHeight <= 380 && !newWidth) {
            const x = Math.floor(screenWidth - currentWidth - 2);
            const y = Math.floor((screenHeight - newHeight) / 2);
            mainWindow.setBounds({ x, y, width: currentWidth, height: newHeight }, true);
        } else {
            // Otherwise preserve position (important for snipping mode)
            mainWindow.setBounds({ x: currentX, y: currentY, width: currentWidth, height: newHeight }, true);
        }
    }
});

// ─── Deep File Mode ────────────────────────────────────────────────────────
ipcMain.handle('read-active-file', async () => {
    try {
        // Write a temp PS1 script to avoid ANY quoting/escaping issues
        const os = require('os');
        // We need the ACTUAL foreground window, not just any process window
        const tmpScript = path.join(os.tmpdir(), 'altspace_enum.ps1');
        fs.writeFileSync(tmpScript,
            `
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
            `,
            'utf8');

        // Give the OS a tiny moment if the user just clicked away from our app
        await new Promise(r => setTimeout(r, 100));

        const { stdout } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`);

        try { fs.unlinkSync(tmpScript); } catch (_) { }

        let windowTitle = stdout.trim();
        const supportedExts = ['.pdf', '.docx', '.doc', '.xlsx', '.xls', '.csv', '.txt', '.pptx'];
        const fileExtPattern = /\.(?:pdf|docx?|xlsx?|csv|txt|pptx)/i;
        const browserNames = ['Google Chrome', 'Microsoft Edge', 'Mozilla Firefox', 'Brave', 'Opera'];
        const isBrowser = browserNames.some(b => windowTitle.includes(b));

        // --- NEW BROWSER INTEGRATION ---
        // If it's a browser, we use UIAutomation to find the exact URL or local file path
        if (isBrowser) {
            // Extract the URL using UIAutomation
            const uiaScript = path.join(os.tmpdir(), 'altspace_uia.ps1');
            fs.writeFileSync(uiaScript, `
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$getForeground = @'
using System;
using System.Runtime.InteropServices;
public class WinTest {
   [DllImport("user32.dll")]
   public static extern IntPtr GetForegroundWindow();
}
'@
Add-Type -TypeDefinition $getForeground
$hwnd = [WinTest]::GetForegroundWindow()

if ($hwnd -ne [IntPtr]::Zero) {
    try {
        $windowElement = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

        function FindUrl($el, $depth) {
            if ($depth -gt 10 -or $el -eq $null) { return $null }
            
            $ctrlType = $el.Current.ControlType
            $name = $el.Current.Name
            
            # Do not traverse into the actual web page DOM!
            if ($ctrlType -eq [System.Windows.Automation.ControlType]::Document) { return $null }
            if ($name -match "Chrome Legacy Window") { return $null }
            
            if ($ctrlType -eq [System.Windows.Automation.ControlType]::Edit) {
                $patternObj = $null
                if ($el.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObj)) {
                    $val = $patternObj.Current.Value
                    # Typical browser address bar value
                    if ($val -notmatch "\\s" -or $val -match "^(https?|file)://") {
                        # Ignore common non-url edit boxes
                        if ($val -ne "" -and $val -ne "Search") {
                            return $val
                        }
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

        $url = FindUrl $windowElement 0
        if ($url) {
            # Normalize missing protocols
            if ($url -match "^[a-zA-Z]:/|\\") { $url = "file:///" + $url -replace "\\\\", "/" }
            elseif ($url -notmatch "^(https?|file)://") { $url = "https://" + $url }
            Write-Output $url
        }
    } catch { }
}
            `, 'utf8');

            const { stdout: urlOut } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${uiaScript}"`);
            try { fs.unlinkSync(uiaScript); } catch (_) { }

            const targetUrl = urlOut.trim();
            if (!targetUrl || (!targetUrl.startsWith('http') && !targetUrl.startsWith('file:///'))) {
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
                        const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
                        pdfjsLib.GlobalWorkerOptions.workerSrc = false;
                        const buffer = fs.readFileSync(localPath);
                        const uint8Array = new Uint8Array(buffer);
                        const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;

                        let pageCount = pdfDoc.numPages;
                        const pageTexts: string[] = [];
                        for (let i = 1; i <= pdfDoc.numPages; i++) {
                            const page = await pdfDoc.getPage(i);
                            const textContent = await page.getTextContent();
                            const pageText = textContent.items.map((item: any) => item.str).join(' ');
                            pageTexts.push(pageText);
                        }

                        let content = pageTexts.join('\n\n').replace(/\s+/g, ' ').trim();
                        const MAX_CHARS = 60000;
                        const truncated = content.length > MAX_CHARS;
                        if (truncated) content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';

                        let fileName = path.basename(localPath);
                        return { fileName, pageCount, content, truncated };
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
                    const uint8Array = new Uint8Array(arrayBuffer);

                    const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
                    pdfjsLib.GlobalWorkerOptions.workerSrc = false;
                    const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;

                    let pageCount = pdfDoc.numPages;
                    const pageTexts: string[] = [];
                    for (let i = 1; i <= pdfDoc.numPages; i++) {
                        const page = await pdfDoc.getPage(i);
                        const textContent = await page.getTextContent();
                        const pageText = textContent.items.map((item: any) => item.str).join(' ');
                        pageTexts.push(pageText);
                    }

                    let content = pageTexts.join('\n\n').replace(/\s+/g, ' ').trim();

                    const MAX_CHARS = 60000;
                    const truncated = content.length > MAX_CHARS;
                    if (truncated) content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';

                    let fileName = targetUrl.split('/').pop() || targetUrl;
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
                if (truncated) content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';

                // We fake "pageCount" as an abstract metric (1 page per 500 words)
                const wordCount = content.split(' ').length;
                const pageCount = Math.max(1, Math.ceil(wordCount / 500));

                // Extract a clean filename from title (remove application name)
                let browserTabName = windowTitle;
                for (const b of browserNames) {
                    browserTabName = browserTabName.replace(new RegExp(`\\s+[-–]\\s+${b}.*$`, 'i'), '');
                }

                return { fileName: browserTabName.trim() || targetUrl, pageCount, content, truncated };

            } catch (err: any) {
                return { error: `Error extracting webpage content`, windowTitle };
            }
        }

        // If the focused window is somehow ALT+Space itself, or doesn't have an extension
        // and IS NOT a browser, we fallback to getting the most recently active document.
        if (!windowTitle || windowTitle.includes('ALT+Space') || !fileExtPattern.test(windowTitle)) {
            const fallbackScript = path.join(os.tmpdir(), 'altspace_fallback.ps1');
            fs.writeFileSync(fallbackScript,
                'Get-Process | Where-Object { $_.MainWindowTitle -ne [string]::Empty -and $_.MainWindowTitle -match "\\.(pdf|docx?|xlsx?|csv|txt|pptx)" -and $_.MainWindowTitle -notmatch "ALT\\+Space" } | Sort-Object id -Descending | Select-Object -First 1 -ExpandProperty MainWindowTitle',
                'utf8');
            const { stdout: fallbackOut } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${fallbackScript}"`);
            try { fs.unlinkSync(fallbackScript); } catch (_) { }
            windowTitle = fallbackOut.trim();
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
                /\s+[-–]\s+Excel$/i,
                /\s+[-–]\s+Word$/i,
                /\s+[-–]\s+PowerPoint$/i,
                /\s+[-–]\s+Google Chrome$/i,
                /\s+[-–]\s+Microsoft​ Edge$/i, // Includes zero-width space some Edge versions use
                /\s+[-–]\s+Microsoft Edge$/i,
                /\s+[-–]\s+Mozilla Firefox$/i,
                /\s+[-–]\s+Adobe Acrobat.*$/i,
                /\s+[-–]\s+Foxit.*$/i
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
            } else {
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
                        const lnkScript = path.join(require('os').tmpdir(), 'altspace_lnk.ps1');
                        fs.writeFileSync(lnkScript,
                            `$f = Get-ChildItem -Path "$env:APPDATA\\Microsoft\\Windows\\Recent" -Filter "${candidateName}.lnk" -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { $sh = (New-Object -COM WScript.Shell).CreateShortcut($f.FullName); $sh.TargetPath }`,
                            'utf8');
                        const { stdout: target } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${lnkScript}"`);
                        try { fs.unlinkSync(lnkScript); } catch (_) { }
                        const resolved = target.trim();
                        if (resolved && fs.existsSync(resolved)) {
                            detectedPath = resolved;
                        }
                    } catch (_) { /* Not found in recents */ }
                }

                // Strategy 2c: Scan all drive letters for the file
                if (!detectedPath) {
                    try {
                        const searchScript = path.join(require('os').tmpdir(), 'altspace_search.ps1');
                        const safeName = candidateName.replace(/'/g, "''").replace(/\[/g, '`[').replace(/\]/g, '`]');
                        fs.writeFileSync(searchScript,
                            `$drives = Get-PSDrive -PSProvider FileSystem | Select-Object -ExpandProperty Root; foreach ($d in $drives) { $f = Get-ChildItem -Path $d -Filter '${safeName.replace(/[.*+?^${}()|\\\]]/g, '\\$&')}' -Recurse -ErrorAction SilentlyContinue -File | Select-Object -First 1; if ($f) { $f.FullName; break } }`,
                            'utf8');
                        const { stdout: foundPath } = await execAsync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${searchScript}"`, { timeout: 20000 });
                        try { fs.unlinkSync(searchScript); } catch (_) { }
                        const resolved = foundPath.trim();
                        if (resolved && fs.existsSync(resolved)) {
                            detectedPath = resolved;
                        }
                    } catch (_) { /* Search failed */ }
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
            const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
            pdfjsLib.GlobalWorkerOptions.workerSrc = false; // disable worker in Node
            const buffer = fs.readFileSync(detectedPath);
            const uint8Array = new Uint8Array(buffer);
            const pdfDoc = await pdfjsLib.getDocument({ data: uint8Array, useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
            pageCount = pdfDoc.numPages;
            const pageTexts: string[] = [];
            for (let i = 1; i <= pdfDoc.numPages; i++) {
                const page = await pdfDoc.getPage(i);
                const textContent = await page.getTextContent();
                const pageText = textContent.items.map((item: any) => item.str).join(' ');
                pageTexts.push(pageText);
            }
            content = pageTexts.join('\n\n');
        } else if (ext === '.docx' || ext === '.doc') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ path: detectedPath });
            content = result.value;
            pageCount = Math.ceil(content.split('\n').length / 30); // approx
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
                officeParser.parseOffice(detectedPath, (data: string, err: any) => {
                    if (err) reject(err); else resolve(data);
                });
            });
            pageCount = (content.match(/\n{3,}/g) || []).length + 1; // rough slide count
        }

        // Trim to avoid giant prompts (max ~60k chars)
        const MAX_CHARS = 60000;
        const truncated = content.length > MAX_CHARS;
        if (truncated) content = content.slice(0, MAX_CHARS) + '\n\n[... content truncated for length ...]';

        return { fileName, pageCount, content, truncated };
    } catch (error: any) {
        console.error('read-active-file error:', error);
        return { error: error.message || 'Unknown error reading file.' };
    }
});
