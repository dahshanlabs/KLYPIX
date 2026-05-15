# ⚠️ SUPERSEDED — see CLAUDE.md

# Deep Mode Discovery: Senior Architectural Revision (v2.0)

This revision overhauls the discovery engine to eliminate "ghost entries" and ensure 100% real-time accuracy for open documents and browser tabs.

## 1. Core Paradigm Shift: Window Handle Authority (HWND-Auth)

The previous logic suffered from "Session Lag" (relying on append-only Chromium binary files). We are moving to a model where **OS Window Handles (HWNDs)** are the source of truth for liveness.

### Layer A: The Real-Time Scanner (Authoritative)
- **Engine**: Enhanced UI Automation (UIA) + `User32.dll`.
- **Scope**: Every top-level window handle is enumerated.
- **Chromium Deep Scan**: Chrome and Edge are no longer excluded. For every browser window, the engine recursively finds all `TabItem` components.
- **Extraction**: Each `TabItem` must resolve to either a URL (via the Address Bar `ValuePattern`) or a verified Window Title.

### Layer B: Discovery Overlay (Auxiliary)
- **Engine**: Chromium SNSS Session File Parser.
- **Role**: Provides background URLs for tabs that UIA cannot easily reach (e.g. background tabs).
- **Validation**: Every item found in a session file **must** be cross-referenced with a live `HWND`. If a session tab belongs to a window that is no longer in the OS window list, it is pruned immediately.

### Layer C: The "Universal Merge" & Deduplication
- **Logic**: Use a `Map<NormalizedName, Entry>`.
- **Priority**: A real-time UIA-detected tab always overwrites a session-file tab.
- **Ghosts**: Any item in the "Visible" state that fails an `IsWindow(hwnd)` check or is not found in the latest UIA pass is dropped from the cache.

## 2. Technical Implementation Roadmap

### [Electron Main Process]
- **`main.ts`**:
    - **Re-enable Chromium UIA**: Remove the exclusion for `chrome.exe` and `msedge.exe`.
    - **Tab-to-HWND Binding**: Store the Parent HWND for every tab found.
    - **Aggressive Pruning**: If a browser window is closed, all associated tabs in the discovery list are removed in the next refresh cycle (max 2s).
    - **Title Sanitization**: Improve title extraction to handle dynamic shifts (e.g. "Loading...", "Facebook (1)").

### [React Frontend]
- **`App.tsx`**:
    - **Real-time Sync**: The frontend will poll `get-all-open-files` every time the UI is toggled or focus is regained.
    - **UI Indicators**: Clear visual distinction between "Active/Focused", "Live/Open", and "Background Context".

## 3. Auditing & Compliance (Senior Standards)
- **Memory Safety**: Temporary PowerShell scripts are cleaned up using `fs.unlinkSync` and strict `try/catch`.
- **Zero Ghost Tolerance**: If a user closes a tab, it must disappear from the next scan.
- **Privacy First**: Screen snippets are ONLY taken when requested; local file discovery respects the "Privacy Mode" toggle.
