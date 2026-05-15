# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Quick Wins — Coding Agent Prompt (v5 — Hybrid Approach)

## Context

You are working on KLYPIX, an Electron 33 + React 19 + Vite 6 + TypeScript desktop app for Windows. It is a screen-aware AI assistant that uses Gemini Flash 2.5 API for intelligence.

### What Already Exists (DO NOT REBUILD):

**Main Process (Node.js):**
- `startPersistentPS()` — a persistent PowerShell process that stays alive for the app lifetime
- `sendPSCommand(command)` — sends commands to the persistent PS process, ~50ms latency
- `ENUM_WINDOWS` PowerShell command — returns all visible windows with: title, process name, PID, visibility, minimized state
- `getAllOpenFiles` IPC handler — calls ENUM_WINDOWS + UIA tabs + session files + CDP
- `eye:execute-action` IPC handler — executes local actions: `system_open`, `file_save`, `file_rename`, `file_move`, `file_create`, `file_delete`, `clipboard_copy`, `clipboard_save`, `system_type`, `system_screenshot`
- Screenshot capture via native Electron (`captureScreenRaw()`)
- Window detection via PowerShell UIAutomation
- Token encryption via Electron safeStorage
- All file extraction: pdf-parse, mammoth, xlsx, officeparser, Tesseract.js OCR
- `getContextInsight()` — On-Screen auto-analysis when user toggles KLYPIX
- `CONTEXT_INTELLIGENCE_PROMPT` — current generic prompt for On-Screen
- `windowCtx.activeWindowContext` — process name + window title of the app active before KLYPIX toggled
- Document generators: docx, exceljs, pptxgenjs, pdfkit

**Renderer (React + TailwindCSS):**
- Chat interface with multi-turn history
- Static button bar (Risk, Decision, Actions, Clarify, Extract, Summarize, Trading, Rewrite) — KEEP UNCHANGED
- On-Screen insight card with action buttons
- Input field with voice input

**Existing Flow (DO NOT CHANGE):**
1. Alt+Space → KLYPIX hides → screenshots → re-shows
2. Screenshot → Gemini → insight + actions
3. Insight card appears with buttons

---

## ARCHITECTURE CHANGES (Flaw Fixes)

### Fix for Flaw 5: Gemini Does NOT Choose Actions

**BEFORE (broken):** Gemini receives screenshot + context prompt → returns both insight AND suggested actions → actions parsed from Gemini response → unreliable, inconsistent formatting, invents actions not in the list.

**AFTER (fixed):** Two separate systems:
1. `detectContext(windowContext)` → returns a `ScreenContext` enum (local, instant, no AI)
2. `getContextPrompt(context)` → short prompt sent to Gemini → Gemini returns ONLY `{"insight": "..."}` (one sentence)
3. `getContextActions(context)` → returns HARDCODED action buttons (local, instant, no AI)

Gemini's job is ONLY to describe what it sees. The buttons are deterministic. This is faster, cheaper, and 100% predictable.

### Fix for Flaw 2: Input Handler Priority Chain

The input field handles multiple features. They MUST be checked in this order to avoid conflicts:

```typescript
// InputHandler priority chain — checked on every keystroke
function handleInputChange(text: string) {
  // PRIORITY 1: Calculator (fastest check, no side effects)
  const calcResult = tryCalculate(text);
  if (calcResult) {
    showCalcBar(calcResult);
    hideDropdown();
    return;
  }
  hideCalcBar();

  // PRIORITY 2: Command dropdown (trigger word detection)
  const trigger = detectTriggerWord(text);
  if (trigger) {
    showDropdown(trigger);
    return;
  }
  hideDropdown();

  // PRIORITY 3: Normal chat input (no special handling)
  // User presses Enter → goes to Gemini as normal chat
}

// On Enter key:
function handleEnter(text: string) {
  // If calc bar is showing → copy result to clipboard, clear input
  if (calcBarVisible) {
    copyCalcResult();
    return;
  }

  // If dropdown is showing AND an item is selected → execute that action
  if (dropdownVisible && selectedItem) {
    executeDropdownAction(selectedItem);
    return;
  }

  // If dropdown is showing but nothing selected → dismiss dropdown, send as chat
  if (dropdownVisible) {
    hideDropdown();
  }

  // Default: send to Gemini as normal chat message
  sendToGemini(text);
}
```

**Rules for trigger word detection (prevents false triggers):**
- Only trigger when input STARTS WITH a trigger word + space
- If text after trigger word is longer than 4 words (not characters), dismiss → it's a sentence
- Trigger words: "open ", "close ", "switch to ", "minimize ", "maximize ", "snap left ", "snap right ", "clipboard", "paste "

### Fix for Flaw 1: Context Detection Fallback Chain

Detection uses a 3-level fallback (in `contextIntelligence_v3.ts`):
1. **Process name** — most reliable (e.g., `excel.exe` → spreadsheet)
2. **Window title keywords** — catches browser sites and titled apps
3. **Generic fallback** — if nothing matches, return `'unknown'`

Also handles:
- Arabic window titles (detects Arabic Unicode range, adds Translate action)
- Browser detection separated into its own function for cleaner matching
- Google Sheets/Docs/Slides detected even when opened in browser

---

## Features to Build

### Feature 1: Window Close Action (1 hour)

**What:** Close any open window by name.

**Add `system_close` to `eye:execute-action`:**
```powershell
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*SEARCH_TERM*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($proc) { $proc.CloseMainWindow() }
```

**Error recovery UX (Flaw 3 fix):**
- Success → show toast: "✓ Closed [window title]"
- No match → show toast: "No window found matching '[search term]'"
- Window refused (unsaved dialog) → show toast: "⚠ [window title] has unsaved changes — close it manually"
- PowerShell timeout → show toast: "⚠ Action timed out — try again"

All errors appear as toast notifications (not chat messages). Toasts auto-dismiss after 3 seconds.

**Test:** Close Notepad → success toast. Close nonexistent → error toast. Close unsaved Word → warning toast.

---

### Feature 2: Window Snap/Minimize/Maximize/Switch (2 hours)

**Add to `eye:execute-action`:** `window_snap_left`, `window_snap_right`, `window_minimize`, `window_maximize`, `window_restore`, `window_focus`

**Win32 API setup (run ONCE on app startup via sendPSCommand):**
```powershell
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
```

**Snap logic — MULTI-MONITOR AWARE (v3 Flaw 9 fix):**

Do NOT use `PrimaryScreen`. Detect which monitor the target window is on and snap within THAT monitor:

```powershell
# Add MonitorFromWindow for multi-monitor support
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinAPI {
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int W, int H, bool repaint);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint dwFlags);
    
    public struct RECT { public int Left, Top, Right, Bottom; }
    
    [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO lpmi);
    
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }
}
"@

# Find the monitor the window is on (not always primary)
$proc = Get-Process | Where-Object { $_.MainWindowTitle -like '*TERM*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($proc) {
    $hMon = [WinAPI]::MonitorFromWindow($proc.MainWindowHandle, 2) # MONITOR_DEFAULTTONEAREST
    $mi = New-Object WinAPI+MONITORINFO
    $mi.cbSize = [System.Runtime.InteropServices.Marshal]::SizeOf($mi)
    [WinAPI]::GetMonitorInfo($hMon, [ref]$mi)
    
    $workArea = $mi.rcWork
    $x = $workArea.Left
    $y = $workArea.Top
    $w = $workArea.Right - $workArea.Left
    $h = $workArea.Bottom - $workArea.Top
    
    [WinAPI]::ShowWindow($proc.MainWindowHandle, 9)  # restore if minimized
    
    # Snap left: left half of the CURRENT monitor
    [WinAPI]::MoveWindow($proc.MainWindowHandle, $x, $y, [int]($w/2), $h, $true)
    
    # Snap right: right half of the CURRENT monitor
    # [WinAPI]::MoveWindow($proc.MainWindowHandle, $x + [int]($w/2), $y, [int]($w/2), $h, $true)
    
    [WinAPI]::SetForegroundWindow($proc.MainWindowHandle)
}
```

**Error recovery (same toast pattern as Feature 1):**
- Success → "✓ Snapped [title] to left"
- Not found → "No window matching '[term]'"
- Failed → "⚠ Could not arrange [title]"

---

### Feature 3: Enhanced On-Screen Analysis — Hybrid Approach (half day)

**IMPORTANT: The current On-Screen is already good.** Gemini already generates context-aware insights, extracts metadata (app name, file name, table titles, sender, subject), and creates relevant action buttons (like "Compare 2025 vs 2024" for spreadsheets, "Unsubscribe from emails" for newsletters). DO NOT break this.

**What we're adding, NOT replacing:**

1. **Context-specific focus area** injected into the existing prompt → makes Gemini's insight even sharper
2. **Action type enforcement** → each action button tagged as chat/clipboard/document for predictable behavior
3. **Context badge** → clickable label showing detected context, with override dropdown
4. **Insight caching** → avoid duplicate Gemini calls on repeated toggles
5. **Offline fallback** → hardcoded actions when Gemini is unavailable
6. **Preserve existing UI elements** → metadata bar (app, file name, dates, etc.), "Scan a document" button, green dots header — DO NOT REMOVE ANY OF THESE

**Import `contextIntelligence_v5.ts` (provided separately).**

**Architecture — enhance the existing flow, don't replace it:**

```typescript
import {
  detectContext, getContextFocus, getContextActions,
  getContextActionsWithTranslate, getInsightCacheKey,
  getCachedInsight, setCachedInsight, clearInsightCache,
  getContextDisplayLabel, getAllContextOptions,
  ScreenContext
} from './contextIntelligence_v5';

// Cache state
let lastContext: ScreenContext = 'unknown';
let lastScreenshot: string = '';
let lastWindowTitle: string = '';

async function onScreenAnalysis(screenshot: string, windowContext: WindowContext) {
  // Step 1: Detect context locally (instant, no AI)
  const context = detectContext(windowContext);
  lastContext = context;
  lastScreenshot = screenshot;
  lastWindowTitle = windowContext.title;

  trackEvent('context', context);

  // Step 2: Check cache
  const cacheKey = getInsightCacheKey(context, windowContext.title);
  const cached = getCachedInsight(cacheKey);
  if (cached) {
    trackEvent('cache_hit', '');
    showInsightCard(cached.insight, cached.metadata, cached.actions, context);
    return;
  }

  // Step 3: Build enhanced prompt
  // Take the EXISTING CONTEXT_INTELLIGENCE_PROMPT and inject the context-specific focus
  const contextFocus = getContextFocus(context);
  const enhancedPrompt = buildEnhancedPrompt(contextFocus);

  // Step 4: Call Gemini (same as today, but with enhanced prompt)
  try {
    const response = await callGemini(screenshot, enhancedPrompt);
    const parsed = JSON.parse(response);

    // Step 5: Process actions — enforce types on what Gemini returned
    const typedActions = enforceActionTypes(parsed.actions || [], context);

    // Step 6: Cache the result
    setCachedInsight(cacheKey, parsed.insight, parsed.metadata, typedActions);

    // Step 7: Display (same UI as today, but with context badge added)
    showInsightCard(parsed.insight, parsed.metadata, typedActions, context);

  } catch (err) {
    // OFFLINE FALLBACK — use hardcoded actions from contextIntelligence
    const fallbackActions = getContextActionsWithTranslate(context, windowContext.title);
    const displayLabel = getContextDisplayLabel(context);
    const fallbackInsight = `${displayLabel} detected — offline mode`;

    showInsightCard(fallbackInsight, null, fallbackActions, context);
    trackEvent('error', 'gemini_offline');
  }
}
```

**Step 3 detail — enhancing the existing prompt (NOT replacing it):**

```typescript
function buildEnhancedPrompt(contextFocus: string): string {
  // Take your existing CONTEXT_INTELLIGENCE_PROMPT and ADD the context focus
  // The existing prompt already works well — we're just making it sharper

  return `${EXISTING_CONTEXT_INTELLIGENCE_PROMPT}

CONTEXT FOCUS: ${contextFocus}

ADDITIONAL RULE FOR ACTIONS:
Each action you suggest must include a "type" field:
- "chat" — for actions where the user wants an explanation, analysis, or summary shown in chat
- "clipboard" — for actions where the user wants extracted text/data copied to clipboard (e.g., copy formula, copy reply, extract specs)
- "document" — for actions where the user wants a generated file (e.g., export report, generate summary document)

Return actions as:
"actions": [
  { "label": "...", "prompt": "...", "type": "chat|clipboard|document", "icon": "emoji" }
]`;
}
```

**This is minimal change to the existing prompt.** You're adding ~50 tokens of context focus + ~80 tokens of action type instruction. The rest of the prompt stays exactly the same.

**Step 5 detail — enforce action types on Gemini's response:**

```typescript
interface TypedAction {
  label: string;
  prompt: string;
  type: 'chat' | 'clipboard' | 'document';
  icon?: string;
  documentFormat?: 'docx' | 'xlsx' | 'pptx' | 'pdf';
}

function enforceActionTypes(actions: any[], context: ScreenContext): TypedAction[] {
  return actions.map(action => {
    // If Gemini returned a valid type, use it
    if (['chat', 'clipboard', 'document'].includes(action.type)) {
      return {
        label: action.label || 'Action',
        prompt: action.prompt || action.label,
        type: action.type,
        icon: action.icon || getDefaultIcon(action.type),
        documentFormat: action.type === 'document' ? guessDocFormat(context) : undefined,
      };
    }

    // If Gemini didn't return a type, infer it from the label
    const type = inferActionType(action.label || '');
    return {
      label: action.label || 'Action',
      prompt: action.prompt || action.label,
      type,
      icon: action.icon || getDefaultIcon(type),
      documentFormat: type === 'document' ? guessDocFormat(context) : undefined,
    };
  });
}

function inferActionType(label: string): 'chat' | 'clipboard' | 'document' {
  const lower = label.toLowerCase();
  // Clipboard signals
  if (['copy', 'extract to', 'grab', 'pull out'].some(w => lower.startsWith(w))) return 'clipboard';
  if (['to clipboard', 'to excel'].some(w => lower.includes(w))) return 'clipboard';
  // Document signals
  if (['export', 'generate report', 'create report', 'save as'].some(w => lower.startsWith(w))) return 'document';
  if (['report', 'document'].some(w => lower.includes(w))) return 'document';
  // Default to chat
  return 'chat';
}

function getDefaultIcon(type: string): string {
  if (type === 'clipboard') return '📋';
  if (type === 'document') return '📄';
  return '💬';
}

function guessDocFormat(context: ScreenContext): 'docx' | 'xlsx' {
  if (context === 'spreadsheet' || context === 'supply-chain') return 'xlsx';
  return 'docx';
}
```

**Action button click handler — same as before but handles all three types:**

```typescript
async function handleActionClick(action: TypedAction, screenshot: string) {
  trackEvent('action_click', action.label);
  trackEvent('action_type', action.type);

  try {
    switch (action.type) {
      case 'chat':
        // Same as current behavior — show response in chat
        const chatResult = await callGemini(screenshot, action.prompt);
        displayInChat(chatResult);
        break;

      case 'clipboard':
        // NEW — extract content and copy to clipboard
        const clipResult = await callGemini(screenshot,
          action.prompt + '\n\nReturn ONLY the requested content. No explanations, no markdown.');
        clipboard.writeText(clipResult);
        showToast('✓ Copied to clipboard');
        break;

      case 'document':
        // NEW — generate a downloadable document
        const docResult = await callGemini(screenshot,
          action.prompt + `\n\nGenerate structured content for a ${action.documentFormat} document.`);
        const filePath = await generateDocument(docResult, action.documentFormat || 'docx');
        showToast(`✓ Saved: ${path.basename(filePath)}`);
        break;
    }
  } catch (err) {
    trackEvent('error', `action_${action.type}_failed`);
    showToast(`✗ Failed: ${err.message || 'No internet connection'}`, 'error');
  }
}
```

**Context badge UI — add NEXT TO the existing "ON SCREEN" header:**

```
Current:   ● ● ON SCREEN                                    ✕
New:       ● ● ON SCREEN — 📊 Spreadsheet ▼                 ✕
                            ↑ clickable, shows override dropdown
```

When clicked, show dropdown of common contexts (from `getAllContextOptions()`). On selection:
```typescript
async function handleContextOverride(newContext: ScreenContext) {
  clearInsightCache(); // force fresh analysis
  trackEvent('context_override', `${lastContext}→${newContext}`);

  // Re-run analysis with the corrected context
  const contextFocus = getContextFocus(newContext);
  const enhancedPrompt = buildEnhancedPrompt(contextFocus);

  try {
    const response = await callGemini(lastScreenshot, enhancedPrompt);
    const parsed = JSON.parse(response);
    const typedActions = enforceActionTypes(parsed.actions || [], newContext);
    showInsightCard(parsed.insight, parsed.metadata, typedActions, newContext);
  } catch {
    // Fallback to hardcoded actions for the new context
    const fallbackActions = getContextActionsWithTranslate(newContext, lastWindowTitle);
    showInsightCard(lastInsight, null, fallbackActions, newContext);
  }
}
```

**UI elements to PRESERVE (do not modify or remove):**
- The metadata bar (APPLICATION, FILE NAME, TABLE TITLE, SENDER, SUBJECT, DATE, etc.) — Gemini generates this, keep it
- The green dots + "ON SCREEN" header — keep, add context badge next to it
- The "Scan a document" button below the insight card — separate feature, don't touch
- The "Search desktop items" button — separate feature, don't touch
- The static template buttons (Risk, Decision, Actions, etc.) — separate, don't touch

**Test:**
1. Excel with data → Alt+Space → insight mentions specific data → actions include smart ones like "Compare X vs Y" → each action tagged with type → clipboard actions copy to clipboard, document actions generate files
2. Outlook email → Alt+Space → insight mentions sender and subject → actions like "Summarize", "Draft Reply", "Unsubscribe" → types correctly assigned
3. Desktop → Alt+Space → metadata shows OS, time, weather → actions like "Launch application", "Summarize desktop"
4. Same screen toggled again → cached result, no Gemini call
5. No internet → hardcoded fallback actions appear, context badge shows "📊 Spreadsheet — offline"
6. Click context badge → override dropdown → select different context → re-analyzes with new focus
7. Arabic content on screen → Translate action auto-included

---

### Feature 4: Unified Command Dropdown (1-2 days)

**Scope limit (Flaw 8 fix):** v1 shows ONLY running windows for all commands. No file system scan. No app list. Keep it simple and reliable.

**v1 scope:**
- "close " → dropdown of running windows → click → close
- "switch to " → dropdown → click → focus
- "minimize " → dropdown → click → minimize
- "maximize " → dropdown → click → maximize
- "snap left " → dropdown → click → snap
- "snap right " → dropdown → click → snap
- "open " → dropdown of running windows ONLY (not files, not apps) → click → focus/restore

**v2 (later):** Add recent files and installed apps to "open".

#### 4a. Background Window Cache

```typescript
// main process
let cachedWindows: { pid: number; title: string; app: string; handle: string; minimized: boolean }[] = [];

async function refreshWindowCache() {
  try {
    const result = await sendPSCommand(`
      Get-Process | Where-Object { $_.MainWindowTitle -ne '' -and $_.MainWindowHandle -ne 0 } |
      Select-Object -First 50 |
      ForEach-Object {
        [PSCustomObject]@{
          pid = $_.Id
          title = $_.MainWindowTitle
          app = $_.ProcessName
          handle = $_.MainWindowHandle.ToString()
          minimized = [WinAPI]::IsIconic($_.MainWindowHandle)
        }
      } | ConvertTo-Json -Compress
    `, 2000); // 2 second timeout

    const parsed = JSON.parse(result);
    cachedWindows = Array.isArray(parsed) ? parsed : [parsed];
  } catch (err) {
    // Keep last known cache on failure — don't clear (Flaw 7 fix)
    console.error('Window cache refresh failed:', err);
  }
}

// Poll every 3 seconds
setInterval(refreshWindowCache, 3000);

// Performance limit: max 50 windows (Flaw 7 fix)
ipcMain.handle('get-cached-windows', () => cachedWindows.slice(0, 50));
```

#### 4b. PowerShell Health Check (Flaw 7 fix)

```typescript
let psHealthy = true;
let psFailCount = 0;

async function sendPSCommandSafe(command: string, timeout = 2000): Promise<string> {
  try {
    const result = await sendPSCommand(command, timeout);
    psFailCount = 0;
    psHealthy = true;
    return result;
  } catch (err) {
    psFailCount++;
    if (psFailCount >= 3) {
      psHealthy = false;
      // Notify user (v3 Flaw 4 fix)
      showToast('⚠ Reconnecting system commands...', 'warning');
      // Attempt to restart persistent PS process
      try {
        await restartPersistentPS();
        psFailCount = 0;
        psHealthy = true;
        showToast('✓ Reconnected', 'success');
      } catch {
        showToast('✗ System commands unavailable — restart KLYPIX', 'error');
        console.error('PowerShell restart failed');
      }
    }
    throw err;
  }
}

// Expose health status to renderer — disable dropdown when unhealthy
ipcMain.handle('get-ps-health', () => psHealthy);
```

#### 4c. Dropdown Component (renderer)

```typescript
const TRIGGERS: Record<string, { actionType: string }> = {
  'close ':      { actionType: 'close' },
  'switch to ':  { actionType: 'focus' },
  'minimize ':   { actionType: 'minimize' },
  'maximize ':   { actionType: 'maximize' },
  'snap left ':  { actionType: 'snapLeft' },
  'snap right ': { actionType: 'snapRight' },
  'open ':       { actionType: 'open' },
};

function detectTriggerWord(text: string): { trigger: string; filter: string } | null {
  const lower = text.toLowerCase();

  for (const trigger of Object.keys(TRIGGERS)) {
    if (lower.startsWith(trigger)) {
      const filter = lower.slice(trigger.length);

      // v3 Flaw 8 fix: Don't use word count for dismissal.
      // Instead, check if the filter matches ANY window.
      // If zero matches → dismiss (it's probably a sentence like "close the deal")
      // This is done in the component, not here. Just return the trigger + filter.
      // The component calls getFilteredWindows(filter) and hides if results.length === 0.

      return { trigger, filter };
    }
  }

  // Clipboard trigger (special — no filter)
  if (lower === 'clipboard' || lower.startsWith('clipboard ')) {
    return { trigger: 'clipboard', filter: '' };
  }

  return null;
}
```

**Dropdown dismissal logic (v3 Flaw 8 fix — match-based, not word-count):**

```typescript
// In the dropdown React component:
function CommandDropdown({ text, windows }) {
  const trigger = detectTriggerWord(text);
  if (!trigger) return null;

  // For clipboard trigger, show clipboard history
  if (trigger.trigger === 'clipboard') {
    return <ClipboardHistoryDropdown />;
  }

  // Filter windows by the search term
  const filtered = windows.filter(w =>
    w.title.toLowerCase().includes(trigger.filter) ||
    w.app.toLowerCase().includes(trigger.filter)
  );

  // v3 Flaw 8 fix: dismiss when ZERO matches, not based on word count
  // "close the deal" → no window titled "the deal" → filtered.length === 0 → hide
  // "close Microsoft Visual Studio Code" → matches VS Code → filtered.length > 0 → show
  if (trigger.filter.length > 0 && filtered.length === 0) return null;

  return <DropdownList items={filtered} actionType={trigger.actionType} />;
}
```

**Dropdown behavior:**
- Max 10 items visible (scrollable)
- Fuzzy match against window title AND process name
- Arrow keys to navigate, Enter to execute, Escape to dismiss
- On execute: run action, clear input, show success/error toast
- Dark theme matching KLYPIX UI

**Conflict resolution (Flaw 2 fix):**
- If dropdown is visible and user presses Enter with an item selected → execute dropdown action (NOT Gemini)
- If dropdown is visible and user presses Enter with NO item selected → dismiss dropdown, send to Gemini as chat
- If dropdown was dismissed (sentence too long) → send to Gemini as chat
- Dropdown and calculator are mutually exclusive (calculator has higher priority)

---

### Feature 5: Clipboard History (half day)

**Security considerations (Flaw 6 fix):**

```typescript
// clipboardHistory.ts — main process

interface ClipboardEntry {
  id: string;
  content: string;       // stored content (may be masked)
  displayContent: string; // what the user sees in dropdown
  timestamp: number;
  source: string;
}

let clipboardHistory: ClipboardEntry[] = [];
let lastClipboardContent = '';

// Apps to EXCLUDE from clipboard tracking (Flaw 6 fix)
const EXCLUDED_APPS = [
  'keepass', '1password', 'bitwarden', 'lastpass', 'dashlane',
  'keepassxc', 'enpass', 'roboform',
];

// Patterns that look like sensitive data (Flaw 6 fix)
const SENSITIVE_PATTERNS = [
  /^(?:\d{4}[\s-]?){4}$/,              // credit card numbers
  /^[A-Za-z0-9+/=]{40,}$/,             // API keys / tokens (long base64)
  /^(sk-|pk-|api[_-]key|bearer\s)/i,   // common API key prefixes
  /^-----BEGIN\s+(RSA\s+)?PRIVATE/,     // private keys
  /password\s*[:=]\s*.+/i,             // password assignments
];

function isSensitive(text: string): boolean {
  return SENSITIVE_PATTERNS.some(p => p.test(text.trim()));
}

function pollClipboard() {
  const current = clipboard.readText();
  if (!current || current === lastClipboardContent) return;
  lastClipboardContent = current;

  // Check if source app is a password manager
  const activeWindow = getActiveWindowTitle();
  const activeProcess = getActiveProcessName();
  if (EXCLUDED_APPS.some(app => activeProcess.toLowerCase().includes(app))) return;

  // Check for sensitive content
  const sensitive = isSensitive(current);

  clipboardHistory.unshift({
    id: Date.now().toString(),
    content: sensitive ? current : current,  // still stored (user might need it)
    displayContent: sensitive ? '🔒 Sensitive content (click to paste)' : current.slice(0, 100),
    timestamp: Date.now(),
    source: activeWindow,
  });

  // Keep last 50 entries
  if (clipboardHistory.length > 50) clipboardHistory.pop();
}

setInterval(pollClipboard, 2000);

ipcMain.handle('get-clipboard-history', () =>
  clipboardHistory.map(e => ({
    ...e,
    content: undefined, // never send raw content to renderer for display
  }))
);

ipcMain.handle('paste-from-history', (_, id: string) => {
  const entry = clipboardHistory.find(e => e.id === id);
  if (entry) {
    clipboard.writeText(entry.content);
    return true;
  }
  return false;
});

ipcMain.handle('clear-clipboard-history', () => {
  clipboardHistory = [];
  lastClipboardContent = '';
  return true;
});
```

**UI:**
- Show `displayContent` (truncated or masked), never raw content
- Sensitive entries show 🔒 icon — user can still click to paste
- "Clear History" button at bottom
- In-memory only — cleared on app close
- Show source app and relative timestamp ("2 min ago from Chrome")

**Known limitation (v3 Flaw 5 — accepted):** Polling every 2 seconds means if the user copies twice within 2 seconds (copy A, then immediately copy B), only B is captured. This is inherent to polling-based clipboard monitoring. A native Windows clipboard listener (`AddClipboardFormatListener`) would fix this but requires a native Node addon. Acceptable for v1 — revisit if users report missing clipboard entries.

---

### Feature 6: Calculator in Input (2 hours)

```typescript
import { evaluate } from 'mathjs';

function tryCalculate(text: string): string | null {
  // Too long → probably a sentence
  if (text.length > 60) return null;

  // Check currency conversion first
  const currencyResult = tryCurrencyConversion(text);
  if (currencyResult) return currencyResult;

  // Must contain at least one math operator or look like a number expression
  if (!/[\d]/.test(text)) return null;
  if (!/[+\-*/^%()]/.test(text) && !/^\d+\.?\d*$/.test(text.trim())) return null;

  // Must NOT look like a sentence (no 3+ letter words except math functions)
  const words = text.split(/\s+/);
  const mathFunctions = ['sin', 'cos', 'tan', 'log', 'sqrt', 'abs', 'ceil', 'floor', 'round', 'pow', 'mod'];
  for (const word of words) {
    if (/^[a-zA-Z]{3,}$/.test(word) && !mathFunctions.includes(word.toLowerCase())) {
      return null; // has a non-math word
    }
  }

  try {
    const result = evaluate(text);
    if (typeof result === 'number' && isFinite(result)) {
      return `= ${Number.isInteger(result) ? result.toLocaleString() : result.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
    }
    return null;
  } catch {
    return null;
  }
}

function tryCurrencyConversion(text: string): string | null {
  const regex = /^([\d,.]+)\s*(usd|sar|eur|gbp|aed|egp|inr|jpy|cny|krw|try|brl|cad|aud|chf|hkd|sgd|myr|thb|idr|pkr|bdt|kwd|bhd|omr|qar)\s*(to|in|=)\s*(usd|sar|eur|gbp|aed|egp|inr|jpy|cny|krw|try|brl|cad|aud|chf|hkd|sgd|myr|thb|idr|pkr|bdt|kwd|bhd|omr|qar)$/i;
  const match = text.trim().match(regex);
  if (!match) return null;

  const amount = parseFloat(match[1].replace(/,/g, ''));
  const from = match[2].toUpperCase();
  const to = match[4].toUpperCase();

  const rate = EXCHANGE_RATES[from] && EXCHANGE_RATES[to]
    ? amount / EXCHANGE_RATES[from] * EXCHANGE_RATES[to]
    : null;

  if (rate === null) return null;
  return `= ${rate.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${to}`;
}

// Rates relative to USD — FALLBACK values, refreshed on app startup
const EXCHANGE_RATES: Record<string, number> = {
  USD: 1, SAR: 3.75, EUR: 0.92, GBP: 0.79, AED: 3.67,
  EGP: 50.0, INR: 84.0, JPY: 150.0, CNY: 7.25, KRW: 1350,
  TRY: 34.0, BRL: 5.0, CAD: 1.37, AUD: 1.55, CHF: 0.88,
  HKD: 7.82, SGD: 1.35, MYR: 4.47, THB: 35.0, IDR: 15700,
  PKR: 278, BDT: 110, KWD: 0.31, BHD: 0.377, OMR: 0.385, QAR: 3.64,
};

let ratesLastUpdated: number = 0;

// v3 Flaw 6 fix: Refresh rates on app startup from free API
async function refreshExchangeRates() {
  try {
    // Free API, no key needed, 1500 requests/month
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await response.json();
    if (data.result === 'success' && data.rates) {
      for (const [currency, rate] of Object.entries(data.rates)) {
        if (currency in EXCHANGE_RATES) {
          EXCHANGE_RATES[currency] = rate as number;
        }
      }
      ratesLastUpdated = Date.now();
    }
  } catch {
    // Silently fall back to hardcoded rates
    console.log('Exchange rate refresh failed, using cached rates');
  }
}

// Call on app startup
refreshExchangeRates();
// Refresh every 6 hours
setInterval(refreshExchangeRates, 6 * 60 * 60 * 1000);
```

**UI:**
```
┌──────────────────────────────────┐
│  150 * 1.15                      │  ← input field
├──────────────────────────────────┤
│  = 172.5                  [Copy] │  ← subtle bar, auto-dismiss when input changes
└──────────────────────────────────┘

For currency conversions, show rate source indicator:
┌──────────────────────────────────┐
│  100 usd to sar                  │
├──────────────────────────────────┤
│  = 375.00 SAR  ⓘ rates ~2h ago  │  ← show how old rates are
└──────────────────────────────────┘
```
- Enter → copy result + clear input + show toast "✓ Copied"
- Calc bar and dropdown are mutually exclusive (calc has priority per Flaw 10)
- For currency results, show small "ⓘ" with age of rates ("~2h ago", "~1d ago")

---

## Feature 7: Local Analytics (Flaw 9 + v3 Flaw 10 fix) — implement LAST

Simple local counters to understand usage AND usefulness. No cloud. No personal data.

```typescript
// analytics.ts — main process
interface AnalyticsData {
  contextsDetected: Record<string, number>;   // how often each context is detected
  contextOverrides: Record<string, number>;   // "spreadsheet→browser-general" = detection was wrong (v3 Flaw 10)
  actionsClicked: Record<string, number>;     // how often each action button is clicked
  actionTypes: Record<string, number>;        // chat vs clipboard vs document usage
  actionFollowUps: Record<string, number>;    // did user DO something after action? (v3 Flaw 10)
  featuresUsed: Record<string, number>;       // dropdown, calculator, clipboard history usage
  insightCacheHits: number;                   // how often cache saved a Gemini call
  errorsOccurred: Record<string, number>;     // error counts by type
  lastReset: number;
}

let analytics: AnalyticsData = createEmptyAnalytics();

function trackEvent(category: string, action: string) {
  if (category === 'context') analytics.contextsDetected[action] = (analytics.contextsDetected[action] || 0) + 1;
  if (category === 'context_override') analytics.contextOverrides[action] = (analytics.contextOverrides[action] || 0) + 1;
  if (category === 'action_click') analytics.actionsClicked[action] = (analytics.actionsClicked[action] || 0) + 1;
  if (category === 'action_type') analytics.actionTypes[action] = (analytics.actionTypes[action] || 0) + 1;
  if (category === 'action_followup') analytics.actionFollowUps[action] = (analytics.actionFollowUps[action] || 0) + 1;
  if (category === 'feature') analytics.featuresUsed[action] = (analytics.featuresUsed[action] || 0) + 1;
  if (category === 'cache_hit') analytics.insightCacheHits++;
  if (category === 'error') analytics.errorsOccurred[action] = (analytics.errorsOccurred[action] || 0) + 1;

  // Save to localStorage every 10 events
  saveAnalytics();
}

// Never leaves the machine. User can view/reset from settings.
ipcMain.handle('get-analytics', () => analytics);
ipcMain.handle('reset-analytics', () => { analytics = createEmptyAnalytics(); saveAnalytics(); });
```

**Track these events:**
- `trackEvent('context', 'spreadsheet')` — every On-Screen analysis
- `trackEvent('context_override', 'spreadsheet→browser-general')` — user corrected wrong detection
- `trackEvent('action_click', 'Find Errors')` — every button click
- `trackEvent('action_type', 'clipboard')` — every action type used
- `trackEvent('feature', 'dropdown')` — every dropdown invocation
- `trackEvent('feature', 'calculator')` — every calc result shown
- `trackEvent('feature', 'clipboard_history')` — every clipboard paste
- `trackEvent('cache_hit', '')` — every time insight cache saved a Gemini call
- `trackEvent('error', 'ps_timeout')` — every PowerShell failure

**Usefulness tracking (v3 Flaw 10 fix):**

After an action button response appears in chat, track what the user does next:
```typescript
// After displaying an action result in chat:
let lastActionLabel = '';
let lastActionTimestamp = 0;

function onActionResultDisplayed(actionLabel: string) {
  lastActionLabel = actionLabel;
  lastActionTimestamp = Date.now();
}

// In the chat component, detect follow-up signals:
function onUserAction(actionType: string) {
  if (lastActionLabel && Date.now() - lastActionTimestamp < 60000) { // within 1 minute
    if (actionType === 'copy_from_chat') {
      trackEvent('action_followup', `${lastActionLabel}:copied`);  // user found it useful
    } else if (actionType === 'alt_space_again') {
      trackEvent('action_followup', `${lastActionLabel}:retried`); // user wasn't satisfied
    } else if (actionType === 'typed_new_message') {
      trackEvent('action_followup', `${lastActionLabel}:continued`); // user engaged further
    }
    lastActionLabel = ''; // reset after tracking
  }
}
```

This tells you: "Users click 'Find Errors' 50 times/week, copy the result 40 times (80% useful). Users click 'Check Reviews' 30 times/week, retry immediately 20 times (33% useful — needs improvement)."

---

## Error Recovery UX Standard (Flaw 3 fix — applies to ALL features)

Every action that can fail must show a toast notification:

```typescript
interface Toast {
  message: string;
  type: 'success' | 'warning' | 'error';
  duration: number; // ms
}

// Standard toast messages:
// Success: "✓ [what happened]" — green, 2 seconds
// Warning: "⚠ [what went wrong + what to do]" — yellow, 4 seconds
// Error:   "✗ [what failed]" — red, 4 seconds

function showToast(message: string, type: 'success' | 'warning' | 'error' = 'success') {
  const duration = type === 'success' ? 2000 : 4000;
  // Display toast at TOP of KLYPIX window (v3 Flaw 3 fix — NOT bottom)
  // This prevents toasts from covering the insight card or input field
  // Toast appears as a slim bar at the top, slides down, auto-dismisses
  // Max 1 toast visible at a time (new toast replaces old)
  // Toast has higher z-index than insight card but does NOT overlap it
}
```

**Toast positioning rules (v3 Flaw 3 fix):**
- Toasts render at the TOP of the KLYPIX window, below the title bar
- They slide down from the top edge and auto-dismiss
- They do NOT overlap the insight card (which is in the chat area)
- They do NOT overlap the input field (which is at the bottom)
- Layout: `[Title bar] → [Toast zone] → [Chat/Insight area] → [Calc bar] → [Input field]`
- If a toast is showing and another fires, the new one replaces the old instantly (no stacking)
```

---

## Performance Safeguards (Flaw 7 fix — applies to ALL features)

```typescript
// LIMITS
const MAX_CACHED_WINDOWS = 50;          // never process more than 50 windows
const MAX_CLIPBOARD_ENTRIES = 50;       // keep last 50 clipboard items
const WINDOW_POLL_INTERVAL = 3000;      // 3 seconds
const CLIPBOARD_POLL_INTERVAL = 2000;   // 2 seconds
const PS_COMMAND_TIMEOUT = 2000;        // 2 second timeout for all PS commands
const PS_MAX_FAILURES = 3;             // restart PS after 3 consecutive failures
const DROPDOWN_MAX_ITEMS = 10;          // show max 10 items in dropdown

// All PowerShell commands use sendPSCommandSafe() with timeout
// All setInterval polls have try/catch and continue on failure
// All JSON.parse calls have try/catch with fallback
```

---

## General Rules

1. **Features 1-2, 4-7: No Gemini API calls.** Feature 3 modifies the existing call (shorter prompt, does not add new calls).
2. **Performance: <100ms** for dropdown, calculator, and clipboard.
3. **Error handling:** Every action shows toast on success/failure. Never silent failures. Never frozen UI.
4. **Don't break existing features.** Chat, On-Screen, file reading, actions — all unchanged.
5. **Use existing infrastructure.** sendPSCommand, existing IPC, existing document generators.
6. **TailwindCSS only.** Match dark theme. No new CSS files.
7. **TypeScript strict mode.**
8. **Test each feature in isolation.**

## Build Order

```
Day 1:  Feature 1 (window close) → Feature 2 (snap with multi-monitor)
        Also: implement toast component (top-positioned) + PS health check with restart notification
Day 2:  Feature 3 (context-aware On-Screen) — import contextIntelligence_v5.ts
        Includes: insight caching, action reordering, context override badge, offline fallback
Day 3-4: Feature 4 (command dropdown — windows ONLY, match-based dismissal)
Day 5:  Feature 5 (clipboard history with security) → Feature 6 (calculator with live rates)
Day 6:  Feature 7 (local analytics with usefulness tracking) + integration testing
```

Commit after each: "feat: window close with toast feedback", "feat: context-aware on-screen with caching", etc.

## Files Provided

1. **`contextIntelligence_v5.ts`** — Complete context detection + prompts + hardcoded actions
   - `detectContext()` — classifies window into 49 contexts with fallback chain
   - `getContextPrompt()` — returns short Gemini prompt (insight + firstAction recommendation)
   - `getContextActions()` — returns hardcoded action buttons per context
   - `getContextActionsWithTranslate()` — adds Translate for Arabic content
   - `reorderActions()` — moves Gemini-recommended action to first position
   - `getInsightCacheKey()` — generates cache key to avoid duplicate Gemini calls
   - `getContextDisplayLabel()` — returns icon + label for context badge UI
   - `getAllContextOptions()` — returns all contexts for override dropdown
   - `CONTEXT_DISPLAY_LABELS` — icon + label map for all 49 contexts

2. **This prompt** — Build plan with all implementation details

Paste your `main.ts` relevant sections alongside these files so the agent can see the real function signatures.

## All Flaws Addressed in This Version

| # | Flaw | Fix | Where |
|---|------|-----|-------|
| v2-1 | Fragile window title detection | 3-level fallback: process → title → generic | contextIntelligence_v5.ts |
| v2-2 | Dropdown vs intent conflict | Input handler priority chain + match-based dismissal | Agent prompt Feature 4 |
| v2-3 | No error recovery UX | Toast notifications for all actions | Agent prompt Error Recovery section |
| v2-4 | On-Screen prompt too long | Short prompts (~80-100 tokens) + caching | contextIntelligence_v5.ts |
| v2-5 | Gemini ignoring action types | Hardcoded actions, Gemini only returns insight | contextIntelligence_v5.ts |
| v2-6 | Clipboard security | Excluded apps + sensitive pattern detection + masking | Agent prompt Feature 5 |
| v2-7 | No performance limits | Max 50 windows, 2s timeout, PS auto-restart | Agent prompt Performance section |
| v2-8 | Open command too ambitious | v1 = windows only, files/apps in v2 | Agent prompt Feature 4 |
| v2-9 | No analytics | Local counters for contexts, actions, features, errors | Agent prompt Feature 7 |
| v2-10 | Input handler conflicts | Priority: calc → dropdown → chat | Agent prompt Architecture section |
| v3-1 | Hardcoded actions feel stale | Gemini reorders actions (firstAction recommendation) | contextIntelligence_v5.ts |
| v3-2 | No context override | Clickable context badge with override dropdown | Agent prompt Feature 3 |
| v3-3 | Toast covers insight card | Toasts at TOP of window, not bottom | Agent prompt Error Recovery section |
| v3-4 | PS restart no notification | Toast during restart + disable dropdown | Agent prompt Feature 4 |
| v3-5 | Clipboard misses fast copies | Accepted limitation, documented | Agent prompt Feature 5 |
| v3-6 | Currency rates hardcoded | Refresh from free API on startup + every 6h | Agent prompt Feature 6 |
| v3-7 | No offline handling | Graceful fallback with "[context] — offline mode" | Agent prompt Feature 3 |
| v3-8 | Dropdown dismissal fragile | Match-based: dismiss when 0 windows match | Agent prompt Feature 4 |
| v3-9 | Multi-monitor snap broken | MonitorFromWindow API for correct screen | Agent prompt Feature 2 |
| v3-10 | Analytics miss usefulness | Track copy/retry/continue after action click | Agent prompt Feature 7 |
| v3-11 | No insight caching | Cache by context + title, skip Gemini on repeat | contextIntelligence_v5.ts |
