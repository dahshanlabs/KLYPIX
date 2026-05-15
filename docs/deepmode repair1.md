# ⚠️ SUPERSEDED — see CLAUDE.md

# Repair Plan: Deep Mode PDF Scanning & Duplicate Merging

This document outlines the technical plan to resolve issues with PDF detection in Deep Mode, specifically regarding duplicate entries and scanning restricted to visible windows.

## Issue Analysis (Refined)

Based on your latest feedback and the screenshots, the duplication is either resolved or secondary. The primary concern is the **"Global Silent Fetch"**—the ability to reliably see everything open without user interaction.

Analysis of the screenshots reveals a specific critical bug:

### 1. The "Active Tab Blindness" Bug
In Screenshot 3, the "Files" list shows background browser tabs (`ChatGPT on your desktop.pdf`, etc.) but **MISSED** the currently active tab (`FE-Electrical...`).
- **Diagnosis**: The current detection logic treats the active window separately from background tabs. If the active window's title encoding or structure doesn't match the "tab scanner" output exactly, it can be dropped or shadowed during deduplication.
- **Requirement**: A unified scanner that treats the active tab as just another entry in the global list, ensuring it is never missed.

### 3. Granular Selection vs. Bulk Auto-Select
The user observed that "pressing on the web" selects all tabs automatically.
- **Requirement**: Selection must be granular and intentional. Users should be able to pick specific tabs or files. 
- **UX Fix**: Update the Selection Manager to support toggle behavior per item. Category headers (e.g., "Web Tabs") should act as filters or optional "Select All" triggers, not as mandatory bulk selectors.

### 4. Background Shadow Fetching for Smart Suggestions
Currently, smart suggestions rely on the "active" context. If no file is selected, suggestions are limited to visual screen content.
- **Requirement**: "Silent Data Sync". To provide "Smart Suggestions" for open documents, the app must fetch metadata (and possibly brief summaries/excerpts) from all detected sources in the background.
- **Implementation**: The "Universal Sync" engine will perform a "Light Fetch" on all discovered items (titles, URLs, and first ~1000 chars of content) to feed the Gemini Suggestion API without requiring explicit user selection first.

---

## Proposed Solution: The "Universal Document Sync"

I will replace the fragmented enumeration logic with a consolidated **"Universal Sync"** engine:

- **Step 1: Deep Process Inspection**: Instead of just looking at windows, we will query the OS for all processes associated with document handlers (Browsers, PDF Readers, Office).
- **Step 2: Full Tab Strip Extraction**: Enhance the browser scanner to iterate through the entire tab container, ensuring the active tab and background tabs are captured in a single pass with identical metadata structures.
- **Step 3: Background URL & Shadow Fetching**: For background tabs, fetch the URL and performing a "Light Read" (shadow fetch) of the HTML/PDF content to populate the Suggestion Engine context.
- **Step 4: Silent Enumeration**: Explicitly include minimized and background windows by removing the `IsWindowVisible` constraint in PowerShell enumeration.
- **Step 5: Granular UI Controller**: Update the React "Files" dropdown to ensure checkbox interactions are independent and that "Web" category chips do not trigger intrusive auto-selection of all tabs.

---

## Proposed Changes

### 1. Robust Window & Tab Enumeration

- **Remove Visibility Filter**: Modify `altspace_enum_all.ps1` to remove the `IsWindowVisible` check. This will allow detection of minimized or background windows.
- **Deep Tab Scanning**: Enhance `altspace_uia_tabs.ps1` to iterate through all `TabItem` elements in browsers.
- **Local File URL Resolution**: For browser tabs, if the `Name` property ends in `.pdf`, attempt to extract the `Value` pattern from any nested `Edit` controls or parse the `Name` to identify if it's a `file:///` URL.

### 2. Intelligent Document Merging Service

Implement a `DocumentNormalizationService` with the following logic:

- **Filename Normalization**: Strip common application suffixes (e.g., " - Google Chrome", " - Adobe Acrobat Reader"), decode URL encoding, and convert to lowercase for comparison.
- **Entity Merging**: Use a `Map<string, DocumentEntry>` where the key is the normalized filename.
- **Source Aggregation**: Instead of a single `source` string, use a `sources` array (e.g., `["Browser (Edge)", "Local File (Acrobat)"]`).
- **Path Resolution**: If a browser tab points to a local file (`file:///C:/...`) and a standalone application title matches the same filename, merge them and prioritize the local path for content extraction.

### 3. IPC Layer Updates

- **Modify `get-all-open-files`**: Update the return structure to support merged entries with multiple sources and a verified local path.
- **Update UI Rendering**: Modify the frontend to display merged source information (e.g., "Detected in: Chrome, Adobe Reader").

---

## Implementation Details

### PowerShell Enhancements (`altspace_uia_tabs.ps1`)
```powershell
# Enhanced tab finding logic
foreach ($t in $tabs) {
    $tabName = $t.Current.Name
    if ($tabName -and $tabName -match "\.pdf") {
        # Attempt to find the URL even for background tabs 
        # (Some browsers expose this in the 'Value' property of the TabItem itself 
        # or a child element depending on the accessibility implementation)
        Write-Output "[TAB]|$tabName|$potentialUrl"
    }
}
```

### Normalization Logic (Node.js)
```javascript
function normalizeDocName(title) {
    return title
        .replace(/\s+[-–]\s+.*$/i, '') // Strip app names
        .replace(/\.(pdf|docx|xlsx|pptx).*$/i, '.$1') // Clean extension
        .trim().toLowerCase();
}
```

## Verification Plan

### Automated Tests
- Mock `EnumWindows` and `UIAutomation` outputs to verify merging logic in isolation.
- Test normalization function against various browser and PDF viewer title formats.

### Manual Verification
1. Open a PDF in Chrome and Adobe Reader simultaneously; verify a single entry appears in Deep Mode.
2. Minimize a PDF window; verify it is still detected.
3. Open multiple PDFs in different Chrome tabs; verify all are listed.
