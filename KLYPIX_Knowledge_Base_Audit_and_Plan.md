# KLYPIX Knowledge Base — Codebase Audit + Implementation Plan

**Date:** April 6, 2026
**Input Documents Audited:**
- `KLYPIX-Knowledge-Base-Full-Plan.md` (1,019 lines — architecture, UX, phased delivery, performance budgets)
- `klypix-file-indexing-reference.md` (520 lines — 40+ file types, extraction methods, npm packages, practicality ratings)
- `klypix-mixed-content-reference.md` (349 lines — recursive content decomposition, mixed content detection, unified index schema)

**Purpose:** Audit all 3 documents against the actual KLYPIX codebase, identify what already exists, what conflicts, what's missing, what's wrong, and produce a corrected implementation plan with exact file paths, integration points, and dependency resolution.

---

## SECTION 1: WHAT THE PLAN GETS RIGHT

The three documents together form a thorough and well-researched KB feature design. The core architecture is sound: chokidar file watcher, recursive content extraction, chunk + embed + vector search, RAG injection into Gemini prompts, lazy vision for Pro tier. The file-type coverage is exhaustive and the practicality ratings are honest.

The phased delivery (4 phases over 8 weeks) is realistic. The UX mockups are clear. The cost analysis shows KB adds negligible API cost ($0.01-0.05/month for free tier). The performance budgets are reasonable for the target hardware.

---

## SECTION 2: CODEBASE AUDIT — WHAT ALREADY EXISTS

### 2.1 Dependencies Already Installed

The plan lists ~25 npm packages needed. **6 are already in package.json:**

| Package | Plan Says | Actual Version | Status |
|---------|-----------|----------------|--------|
| `pdf-parse` | ^1.1.1 | ^2.4.5 (NEWER) | Already installed |
| `mammoth` | ^1.8.0 | ^1.11.0 (NEWER) | Already installed |
| `xlsx` (SheetJS) | ^0.18.5 | ^0.18.5 (EXACT) | Already installed |
| `pdfjs-dist` | Phase 3 | ^2.16.105 | Already installed (plan says Phase 3, actually Phase 1 ready) |
| `tesseract.js` | Phase 3 | ^7.0.0 | Already installed (plan says Phase 3, actually Phase 1 ready) |
| `marked` | Not mentioned | ^17.0.3 | Already installed (useful for Markdown parsing) |

**Correction 1:** The plan's Phase 1 npm dependency list includes `pdf-parse`, `mammoth`, `xlsx` — these are already installed. Do NOT re-install or change versions. The plan also puts `pdfjs-dist` and `tesseract.js` in Phase 3, but they're already in the project. Move PDF page rendering and OCR capabilities to Phase 1 since the libraries are already there.

**Correction 2:** The plan lists `exceljs` for chart data extraction. The codebase already has `exceljs` ^4.4.0 AND `xlsx` ^0.18.5 (SheetJS). Two Excel libraries. The plan should use `xlsx` (SheetJS) for KB reading (lighter, faster for data extraction) and keep `exceljs` for the existing document generator. Do NOT add a third Excel library.

### 2.2 File Reading Infrastructure Already Built

The plan designs a content extraction pipeline from scratch. But `electron/main.ts` already has substantial file reading:

**`read-active-file` handler (line 1546-2423):**
- Detects active window via PowerShell Win32 API
- Extracts filename from window title
- Searches Desktop, Documents, Downloads, Recent shortcuts, and full drive scan
- Reads: `.pdf`, `.docx`, `.doc`, `.xlsx`, `.xls`, `.csv`, `.txt`, `.pptx`
- PDF: uses `readPdfFromDisk()` which already handles password-protected PDFs AND auto-detects scanned pages for OCR via tesseract.js (lines 2459-2498)
- Limits output to 60KB

**`read-multiple-files` handler (line 3735-3850+):**
- Batch reads 40+ file types: `.pdf, .docx, .doc, .xlsx, .xls, .csv, .txt, .md, .rtf, .pptx, .ppt, .json, .xml, .html, .htm, .epub`
- Handles web tabs (file:// URLs, HTTP URLs, CDP fallback)
- PDF extraction with password support and OCR
- DOCX/XLSX/PPTX extraction via built-in libraries
- HTML parsing with cheerio

**`read-file-at-path` handler (line 1076-1088):**
- Raw text file reading, 10MB limit, returns first 100KB

**Correction 3:** The KB plan designs a `extractContent()` function that duplicates 70% of what `read-multiple-files` already does. The KB extractor should REUSE the existing extraction functions, not rebuild them. Create a thin wrapper that calls existing handlers and adds: chunking, metadata extraction, and richness profiling on top. The recursive extraction for nested files (ZIP → DOCX → embedded XLSX) is genuinely new work.

### 2.3 Context Injection Point Already Exists

The plan describes how KB chunks should be injected into Gemini prompts. This integration point already exists:

**`src/api/gemini.ts` line 104:**
```typescript
if (sessionContextSummary) {
    prompt += `\n\nSESSION CONTEXT:\n${sessionContextSummary}`;
}
```

**`askGeminiStreaming()` signature (line 122-128):**
```typescript
askGeminiStreaming(
    prompt, imageBase64, history, activeWindowContext,
    isPrivacyMode, sessionContextSummary  // ← KB chunks go here
)
```

**`src/core/sessionContext.ts`** already manages:
- `analyzedFiles[]` — file summaries from deep mode
- `screenAnalyses[]` — recent screenshots
- `generatedDocs[]` — generated files
- `getContextSummary()` — formats all context for injection

**Correction 4:** The plan suggests creating a new context injection pathway. Wrong — use the existing `sessionContextSummary` parameter. KB chunks should be formatted into the same `getContextSummary()` output. Add a new section like `[Knowledge Base — from indexed files]` alongside the existing `[Session Files]` section. This is a ~20-line change to `sessionContext.ts`, not a new system.

### 2.4 Tier Gating System

**`electron/auth/authService.ts` lines 25-39:**
```typescript
interface TierLimits {
    queriesPerDay: number;
    deepMode: boolean;
    agentMode: boolean;
    docGeneration: boolean;
    imageGeneration: boolean;
}
```

Free tier: `deepMode: false, agentMode: false, docGeneration: false`
Pro/Team/Enterprise: all features enabled.

**Correction 5:** The plan suggests KB indexing for free tier with vision as Pro. But the current tier system is boolean flags — there's no concept of "limited KB" or file count caps. To implement KB tiers properly, extend `TierLimits` with:
```typescript
knowledgeBase: boolean;       // free: true (basic), pro: true (full)
kbMaxFiles: number;           // free: 50, pro: -1 (unlimited)
kbLazyVision: boolean;        // free: false, pro: true
kbAdvancedOCR: boolean;       // free: false (use local tesseract), pro: true (API OCR)
```
This requires changes to `authService.ts` (add fields), `TIER_LIMITS` constant (add values per tier), and the renderer's feature gating logic.

### 2.5 IPC Channel Namespace

**`electron/preload.ts`** exposes channels under:
- Window: `capture-screen`, `hide-window`, `resize-window`, etc.
- Files: `read-active-file`, `read-file-at-path`, `write-file-at-path`, `list-directory`, `read-multiple-files`
- Auth: `auth:*` (11 channels)
- Agent: `agent:*`, `eye:execute-action`, `run-shell-command`
- MCP: `mcp:*`

**No `kb:*` namespace exists.** Safe to add without conflicts. The plan's suggested IPC channels are correct.

### 2.6 App Data Storage

- Electron `app.getPath('userData')` → `%APPDATA%/Klypix`
- Already stores: `agent-config.json`, `claude-key.enc`
- Renderer uses `localStorage` for: memory, persona, API keys, agent permissions

**Correction 6:** The plan puts KB data in `~/AppData/KLYPIX/kb/`. The actual app data path is `%APPDATA%/Klypix` (note: capital K, no "KLYPIX" all-caps). Use `app.getPath('userData')` + `/kb/` to be consistent with existing storage. The plan should use the Electron API, not a hardcoded path.

### 2.7 Document Generation Libraries

**`electron/generators/`** already uses:
- `docx` (npm) — for DOCX generation
- `exceljs` — for XLSX generation
- `pptxgenjs` — for PPTX generation
- `pdfkit` — for PDF generation

These are WRITE libraries. The KB needs READ libraries. No conflict, but note that `exceljs` can both read and write — the KB should use `xlsx` (SheetJS) for reading since it's lighter and already installed.

### 2.8 No File Watcher Exists

No `chokidar` or `fs.watch()` usage found anywhere. This is entirely new infrastructure.

### 2.9 No Embedding or Vector DB Exists

No `@xenova/transformers`, no `vectordb`/`@lancedb/lancedb`, no embedding code. This is the core new work.

### 2.10 Build Configuration

**`package.json` build key:**
```json
"build": {
  "appId": "com.dahshanlabs.klypix",
  "files": ["dist/**/*", "dist-electron/**/*"],
  "win": { "target": "nsis" }
}
```

**Correction 7:** The plan says installer is ~200MB currently. The build config includes `dist/` and `dist-electron/` only. Adding `@xenova/transformers` (~15MB) + ONNX model (~80MB) + LanceDB (~5MB) will significantly increase the bundle. The embedding model should be downloaded on first KB activation, NOT bundled in the installer. Add a `models/` directory to `.gitignore` and download `all-MiniLM-L6-v2` on first use via `@xenova/transformers`' built-in download mechanism (it caches to `~/.cache/huggingface/` by default, but should be redirected to `%APPDATA%/Klypix/models/`).

**Correction 8:** `better-sqlite3` requires native compilation (node-gyp, C++ toolchain). This is a known pain point with Electron. If using LanceDB as the primary store, `better-sqlite3` may not be needed in Phase 1. Defer it to Phase 2 for SQLite file reading only.

---

## SECTION 3: WHAT THE PLAN GETS WRONG

### 3.1 Duplicate Extraction Pipeline

The plan designs `extractContent()` from scratch with handlers for PDF, DOCX, XLSX, PPTX, etc. But `read-multiple-files` in `main.ts` already does most of this. Building a second extraction pipeline creates maintenance burden — two places to fix bugs, two places to add file types.

**Fix:** Create `electron/kb/extractor.ts` that imports and wraps the existing extraction functions from `main.ts`. Factor the extraction logic out of the IPC handler into reusable functions first (refactor, not rewrite), then call them from both the IPC handler and the KB extractor.

### 3.2 Embedding Model Choice May Not Support Arabic

The plan picks `all-MiniLM-L6-v2` (384 dims, ~80MB) as the embedding model. It mentions `multilingual-e5-small` as an alternative for Arabic. Given that the developer (Abdullah) likely works with Arabic content, and KLYPIX targets a potentially Arabic-speaking market, **the default should be multilingual from day one.**

**Fix:** Use `multilingual-e5-small` (384 dims, ~120MB) as the default. It handles English just as well and adds Arabic, Turkish, and other languages. The 40MB size difference is negligible. If performance is a concern, offer `all-MiniLM-L6-v2` as a "faster English-only" option in KB settings.

### 3.3 LanceDB vs Simpler Alternatives

The plan picks LanceDB for vector storage. LanceDB is good but adds a native dependency. For Phase 1 with <50K chunks, a simpler approach works: store embeddings as Float32Arrays in a JSON file, use brute-force cosine similarity. This avoids native compilation issues entirely.

**Recommendation:** Start with in-memory vector search (brute-force cosine, store embeddings in a binary file). When chunk count exceeds 50K, migrate to LanceDB. This lets you ship Phase 1 faster without native dependency headaches.

### 3.4 Missing `adm-zip` for Office Files

The plan lists `adm-zip` as a new dependency for ZIP handling. But Office files (DOCX, XLSX, PPTX) are ZIP archives, and the plan's chart XML extraction requires unzipping them. The existing extraction pipeline uses `mammoth` and `xlsx` which handle this internally. For direct XML access (chart data extraction), you DO need `adm-zip`. This is correct — it's genuinely missing.

### 3.5 `@xenova/transformers` Version

The plan lists `@xenova/transformers: ^2.17.0`. This package was renamed to `@huggingface/transformers` in late 2024. Check which is current at implementation time.

### 3.6 Missing from the Plan: main.ts Bloat

Adding KB handlers to `electron/main.ts` (already 4,052 lines) is not viable. The plan mentions "Changes to electron/main.ts" and lists new IPC handlers to add there. This contradicts the roadmap's #2 priority: break up the monoliths.

**Fix:** KB code must be a SEPARATE module: `electron/kb/` directory with its own files. Register IPC handlers from `electron/kb/index.ts`, imported in `main.ts` with a single line: `initKnowledgeBase(ipcMain)`. This is non-negotiable.

### 3.7 Missing: Conflict with Deep Mode

The plan doesn't address how KB interacts with the existing Deep Mode. Currently, Deep Mode lets users select a file → KLYPIX reads it → user asks questions about it. KB does the same thing but automatically for a whole folder. If both are active, the user could get duplicate context: the same file's content from KB chunks AND from Deep Mode's `activeDocContent`.

**Fix:** When a file is both in the KB index AND currently open in Deep Mode, prefer Deep Mode's full content (it's more complete for the active file). KB chunks should be deduplicated against `activeDocContent`. Add a check in `getContextSummary()`: if a KB chunk's source file matches the current `activeDocContent` file, skip it.

### 3.8 Missing: Conflict with Agent Mode

The agent's orchestrator already has `gatherAmbientContext()` which reads the active file and clipboard before planning. If KB is active, the agent should also query KB for relevant context. The plan doesn't mention agent integration at all.

**Fix:** In `orchestrator.ts gatherAmbientContext()`, add a KB query step: embed the user's prompt, search KB, include top 3 chunks in the ambient context. This gives the agent grounded knowledge without requiring the user to be in a specific file.

---

## SECTION 4: CORRECTED ARCHITECTURE

### 4.1 File Structure

```
electron/
  kb/                              ← NEW directory (all KB code here)
    index.ts                       ← IPC handler registration + init
    extractor.ts                   ← Content extraction (wraps existing readers)
    chunker.ts                     ← Text chunking with semantic boundaries
    embedder.ts                    ← Embedding model loader + embed function
    vectorStore.ts                 ← Vector storage + search (brute-force Phase 1, LanceDB Phase 2)
    fileWatcher.ts                 ← chokidar wrapper with debouncing
    kbConfig.ts                    ← Config management (watched folders, settings)
    types.ts                       ← KB-specific types (ContentChunk, RichnessProfile, etc.)
    extractors/                    ← File-type-specific extractors
      pdfExtractor.ts              ← PDF text + form fields + page density detection
      officeExtractor.ts           ← DOCX/XLSX/PPTX chart XML + embedded objects
      textExtractor.ts             ← TXT/MD/JSON/XML/YAML/CSV/code files
      emailExtractor.ts            ← EML/MSG parsing
      archiveExtractor.ts          ← ZIP/TAR recursive extraction
      cadExtractor.ts              ← DXF/DWG/IFC (Phase 2)
  main.ts                          ← Add 1 line: initKnowledgeBase(ipcMain)

src/
  components/
    KBSettings.tsx                 ← Settings panel (watched folders, status, rebuild)
    KBStatus.tsx                   ← Toolbar status indicator
    KBSourceCitation.tsx           ← Source citation display in chat
  hooks/
    useKnowledgeBase.ts            ← React hook for KB state + IPC calls
  core/
    sessionContext.ts              ← MODIFY: add KB chunks to getContextSummary()
  api/
    gemini.ts                      ← NO CHANGES needed (sessionContextSummary already works)

electron/preload.ts                ← ADD: kb:* IPC channel declarations
```

### 4.2 New Dependencies (Corrected)

**Phase 1 — Must Install:**
```json
{
  "@huggingface/transformers": "^3.x",    // Embedding model runtime
  "chokidar": "^3.6.0",                    // File watching
  "adm-zip": "^0.5.10",                    // ZIP/Office XML access for chart extraction
  "fast-xml-parser": "^4.3.0",             // Chart XML parsing
  "js-yaml": "^4.1.0"                      // YAML file support
}
```
**Total new: 5 packages, ~20MB to node_modules.**

**Phase 2 — Engineering Files:**
```json
{
  "dxf-parser": "^1.1.2",                  // CAD DXF files
  "mailparser": "^3.7.0",                  // EML email parsing
  "better-sqlite3": "^11.0.0"              // SQLite file reading
}
```

**Phase 3 — Already installed, just needs wiring:**
- `pdfjs-dist` (page rendering for lazy vision) — ALREADY IN package.json
- `tesseract.js` (OCR for scanned PDFs) — ALREADY IN package.json

**NOT needed in Phase 1:**
- `vectordb` / `@lancedb/lancedb` — use brute-force cosine similarity first
- `sharp` — not needed for KB (EXIF extraction can use simpler lib)
- `web-ifc` / `libredwg-web` — Phase 2 only
- `music-metadata` / `fluent-ffmpeg` — Phase 3/4 only

### 4.3 IPC Channels

```typescript
// electron/preload.ts — add to contextBridge
kb: {
  addFolder: (path: string) => ipcRenderer.invoke('kb:add-folder', path),
  removeFolder: (path: string) => ipcRenderer.invoke('kb:remove-folder', path),
  addFile: (path: string) => ipcRenderer.invoke('kb:add-file', path),
  query: (text: string, topK: number) => ipcRenderer.invoke('kb:query', text, topK),
  getStatus: () => ipcRenderer.invoke('kb:get-status'),
  getConfig: () => ipcRenderer.invoke('kb:get-config'),
  updateConfig: (config: any) => ipcRenderer.invoke('kb:update-config', config),
  openSource: (path: string) => ipcRenderer.invoke('kb:open-source', path),
  rebuild: () => ipcRenderer.invoke('kb:rebuild'),
  clear: () => ipcRenderer.invoke('kb:clear'),
  onProgress: (cb: Function) => ipcRenderer.on('kb:progress', cb),
  onFileIndexed: (cb: Function) => ipcRenderer.on('kb:file-indexed', cb),
}
```

### 4.4 Integration Points (Exact Code Locations)

**1. `electron/main.ts` — Add 1 import + 1 init call:**
```
Location: Near line 1, after other imports
Add: import { initKnowledgeBase } from './kb';
Location: Inside app.whenReady(), after tray/window setup
Add: initKnowledgeBase(ipcMain, mainWindow);
```

**2. `electron/preload.ts` — Add kb namespace to contextBridge:**
```
Location: Inside contextBridge.exposeInMainWorld('electron', { ... })
Add: kb: { ... } (see 4.3 above)
```

**3. `src/core/sessionContext.ts` — Add KB section to getContextSummary():**
```
Location: Inside getContextSummary() function
Add: Query KB via window.electron.kb.query(), format results as:
  [Knowledge Base — from indexed files]
  source_file (location): chunk_text
Deduplicate against activeDocContent to avoid repeating the same file.
```

**4. `src/hooks/useChat.ts` — Pass KB context:**
```
Location: Where sessionContextSummary is built before calling askGeminiStreaming
Add: Merge KB query results into sessionContextSummary
```

**5. `electron/auth/authService.ts` — Extend TierLimits:**
```
Location: TierLimits interface (line 25) and TIER_LIMITS constant (line 33)
Add: knowledgeBase, kbMaxFiles, kbLazyVision fields
```

**6. `src/App.tsx` — Add KB UI components:**
```
Location: Settings panel section
Add: <KBSettings /> component
Location: Toolbar area
Add: <KBStatus /> indicator
Location: Chat message rendering
Add: <KBSourceCitation /> for responses with KB sources
```

**7. `src/core/agent/orchestrator.ts` — KB-aware ambient context:**
```
Location: gatherAmbientContext() (line 101)
Add: 6th parallel call — query KB with the user prompt, include top chunks
```

---

## SECTION 5: CORRECTED PHASED DELIVERY

### Phase 1 — Core Pipeline (Week 1-2)

**Goal:** User adds a folder, text files get indexed, chat answers reference their files with citations.

**Week 1 — Backend:**
- Create `electron/kb/` directory structure (8 files)
- Factor existing extraction logic from `main.ts read-multiple-files` into reusable functions
- Build `extractor.ts` wrapping existing readers + adding metadata extraction
- Build `chunker.ts` (512-token chunks, semantic boundaries, 50-token overlap, parent section context)
- Build `embedder.ts` (load `multilingual-e5-small` via `@huggingface/transformers`, download model on first use to `%APPDATA%/Klypix/models/`)
- Build `vectorStore.ts` Phase 1: in-memory Float32Array storage, brute-force cosine similarity, persist to `%APPDATA%/Klypix/kb/vectors.bin` + `%APPDATA%/Klypix/kb/metadata.json`
- Build `fileWatcher.ts` (chokidar, debounced, exclude patterns)
- Build `kbConfig.ts` (watched folders, settings, stored in `%APPDATA%/Klypix/kb/config.json`)
- Register all IPC handlers in `electron/kb/index.ts`
- Add `initKnowledgeBase()` call in `main.ts`

**Supported file types Week 1:** TXT, MD, JSON, XML, YAML, CSV, PDF (text + OCR), DOCX (text + tables), XLSX (cell data), code files, HTML, RTF

**Week 2 — Frontend + Integration:**
- Add `kb:*` channels to `preload.ts`
- Build `useKnowledgeBase.ts` hook
- Build `KBSettings.tsx` (add/remove folders, status display, settings)
- Build `KBStatus.tsx` (toolbar indicator: file count, indexing progress)
- Build `KBSourceCitation.tsx` (clickable source links under chat responses)
- Modify `sessionContext.ts` to include KB chunks in `getContextSummary()`
- Add drag-and-drop handler on main window for quick file add
- Extend `TierLimits` in `authService.ts`
- Test with 50+ real documents

**Deliverable:** Text documents are searchable. Chat answers cite sources. Files open on click.

### Phase 2 — Rich Content + Engineering (Week 3-4)

**Goal:** Chart data extraction, recursive content, CAD files.

**Week 3:**
- Install `adm-zip` + `fast-xml-parser`
- Build `officeExtractor.ts`: unzip DOCX/XLSX/PPTX → parse chart XML for source data (the key differentiator — actual numbers behind charts, 100% local)
- PPTX speaker notes extraction
- DOCX comments, tracked changes, embedded images catalog
- Recursive extraction: ZIP → contained files → process each
- Embedded OLE objects: detect type, extract .xlsx/.pptx if present
- Content richness profile generation per file
- File hash tracking for change detection (skip re-index if unchanged)

**Week 4:**
- Install `dxf-parser`, `mailparser`
- Build `cadExtractor.ts` (DXF text, layers, block attributes, dimensions)
- Build `emailExtractor.ts` (EML headers, body, attachment recursion)
- EPUB parsing (unzip + HTML chapter text + TOC + metadata)
- SVG text extraction (XML parse)
- Magic bytes file type detection (don't trust extensions)
- PDF page density analysis (text-rich vs scanned vs mixed)
- File modification re-indexing via watcher

**Deliverable:** Chart data extracted without vision AI. Engineering drawings searchable by text/layers. Email attachments recursively indexed.

### Phase 3 — Intelligence + Pro Features (Week 5-6)

**Goal:** Visual content analysis, structural intelligence, Pro gating.

**Week 5:**
- Lazy vision pipeline: render PDF page → send to Gemini Vision on demand
- PDF page rendering via `pdfjs-dist` (already installed)
- "Analyze Now (Pro)" button in chat for visual content
- Enhanced OCR via `tesseract.js` (already installed) for scanned PDFs
- Text density auto-detection (digital vs scanned pages)
- Content richness indicator in UI (percentage coverage bar)
- Pro tier gating: free gets text-only, Pro gets vision + advanced OCR
- Migrate vector store to LanceDB if chunk count warrants it

**Week 6:**
- Cross-document entity matching (same entity, different files)
- Basic contradiction detection (same metric, different numbers)
- Date/expiry extraction and alerting
- Version detection (same document name, different dates)
- "Indexed Files" browser panel
- Index rebuild and clear functions
- Error handling for corrupted/password-protected files
- Background worker for batch indexing (don't block UI)

### Phase 4 — Polish (Week 7-8)

- Windows context menu integration ("Add to KLYPIX Knowledge Base")
- Agent mode integration (KB-aware ambient context in orchestrator)
- Multi-language embedding model toggle (Arabic optimization)
- Network/shared drive support
- Storage management (cleanup when folder removed)
- Onboarding tutorial for KB feature
- Edge cases: very large files, mixed Arabic/English, empty files
- Performance tuning: batch embedding, streaming extraction

---

## SECTION 6: RISK REGISTER

| Risk | Severity | Mitigation |
|------|----------|------------|
| `@huggingface/transformers` model download fails on user's network | High | Ship a tiny fallback (TF-IDF keyword matching) that works without embeddings. Download model in background with retry + progress bar |
| main.ts grows even larger with KB code | High | Non-negotiable: ALL KB code in `electron/kb/`. Only 1 line added to main.ts |
| Embedding model uses 150MB+ RAM on 8GB machines | Medium | Lazy-load: only load when KB is enabled. Unload after 10 minutes idle. Show memory warning in settings |
| `better-sqlite3` native compilation fails in Electron | Medium | Defer to Phase 2. Use prebuild binaries. Test on clean Windows install before shipping |
| KB context overwhelms Gemini token limit alongside screen context + history | Medium | Cap KB injection at 1500 tokens max. Prioritize: if screen context is active, reduce KB to 500 tokens |
| Duplicate content from KB + Deep Mode for same file | Medium | Deduplicate in sessionContext.ts: if file is in activeDocContent, skip its KB chunks |
| Users add `node_modules` or `.git` to watched folders | Low | Default exclude patterns. Warn if folder has >10,000 files |
| Chart XML parsing fails for complex Office files | Low | Graceful fallback: skip chart data, tag for lazy vision. Log the file path for debugging |

---

## SECTION 7: WHAT NOT TO BUILD (SCOPE CONTROL)

The 3 plan documents are comprehensive — almost too comprehensive. For a solo developer, some items should be explicitly deferred:

**Defer to post-launch:**
- DWG parsing (`libredwg-web` WASM, 5MB, complex) — support DXF only in Phase 2
- IFC/BIM parsing (`web-ifc` WASM, 8MB, very niche) — offer IFC as a future plugin
- Video/audio content analysis — metadata only, no transcription
- Structural intelligence (contradiction detection, version tracking) — this is a feature in itself, not part of MVP KB
- Windows context menu integration — requires shell extension, complex installer changes
- Cross-document entity matching — sounds good in a plan, very hard to get right

**Build these, they're high-ROI:**
- Text extraction from all common Office files (already 80% done)
- Chart data extraction from XLSX/DOCX/PPTX XML (unique differentiator, zero API cost)
- Speaker notes from PPTX (users love this — "hidden" content surfaced)
- Email attachment recursion (enterprise users live in email)
- Source citations in chat (this is what makes KB feel magical)

---

## SECTION 8: IMPLEMENTATION ORDER FOR CODING AGENT

Give this to your coding agent:

```
TASK: Implement KLYPIX Knowledge Base Phase 1

READ FIRST:
- electron/main.ts lines 1546-2500 (existing file reading)
- electron/main.ts lines 3735-3850 (read-multiple-files handler)
- src/core/sessionContext.ts (context injection)
- src/api/gemini.ts lines 77-128 (system prompt building)
- electron/preload.ts (IPC channel patterns)
- electron/auth/authService.ts lines 25-45 (tier system)

CREATE (in order):
1. electron/kb/types.ts — ContentChunk, RichnessProfile, KBConfig, FileMetadata types
2. electron/kb/kbConfig.ts — Config load/save to %APPDATA%/Klypix/kb/config.json
3. electron/kb/extractor.ts — Wrap existing read-multiple-files extraction into reusable functions
4. electron/kb/chunker.ts — 512-token semantic chunking with overlap
5. electron/kb/embedder.ts — Load multilingual-e5-small, embed(), cache model in userData
6. electron/kb/vectorStore.ts — In-memory Float32Array + cosine similarity + persist to disk
7. electron/kb/fileWatcher.ts — chokidar wrapper, debounced, exclude patterns
8. electron/kb/index.ts — IPC handler registration, init function
9. electron/preload.ts — Add kb:* namespace
10. src/hooks/useKnowledgeBase.ts — React hook
11. src/components/KBSettings.tsx — Settings panel
12. src/components/KBStatus.tsx — Toolbar indicator
13. src/components/KBSourceCitation.tsx — Citation display
14. src/core/sessionContext.ts — MODIFY: add KB chunks to getContextSummary()

MODIFY (carefully):
- electron/main.ts — Add 1 import + 1 init call only
- electron/auth/authService.ts — Extend TierLimits
- src/App.tsx — Add KB components to settings panel + toolbar

DO NOT:
- Rewrite existing file reading code — wrap it
- Add KB code directly to main.ts — use electron/kb/
- Bundle the embedding model in the installer — download on first use
- Use LanceDB in Phase 1 — use brute-force cosine similarity
- Touch the agent engine — that's Phase 4
```

---

## SECTION 9: SUCCESS CRITERIA

**Phase 1 Complete When:**
- User can add a folder in KB Settings and see files being indexed
- Status indicator shows file count and indexing progress
- Chat query like "What was Q4 revenue?" finds the answer from indexed XLSX/PDF/DOCX
- Response includes clickable source citation (file name + location)
- Clicking source opens the original file
- Re-indexing happens automatically when files change
- Works on 8GB RAM machine without degrading KLYPIX core performance
- Embedding model downloads automatically on first KB activation (~120MB, with progress bar)

**Performance Targets:**
- Single file index (10-page PDF): < 3 seconds
- Chat KB retrieval: < 100ms (brute-force on <50K chunks)
- No visible slowdown in Alt+Space response time when KB is active
- Embedding model loads in < 5 seconds
