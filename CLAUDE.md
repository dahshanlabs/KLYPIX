# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Note on scope:** This document is the source of truth for the current codebase. The audit on 2026-05-02 found the previous CLAUDE.md was 17–37% off on file sizes, missed the Canvas mode entirely, and undercounted tools by ~7. Many older docs in `docs/` describe features that were never built or have been superseded — they are now marked with a `SUPERSEDED` header. Trust this file, then trust the code, then `docs/CLAUDE-KLYPIX-CANVAS.md` and `docs/KLYPIX_Canvas_Handoff.md` for canvas detail.

## Project Overview

**Klypix (Alt+Space)** — Windows desktop AI overlay assistant. Electron 33 + React 19 + Vite 6, distributed as an NSIS installer for Windows x64.

The app has **three UI modes**:
- **Chat** — overlay triggered by Alt+Space, screenshot-aware, streams from Gemini.
- **Agent** — multi-model autonomous tool-using agent (Claude / Gemini / OpenAI / GLM / DeepSeek).
- **Canvas** — `.any` infinite-canvas workspace with its own scoped agent, cloud sync, and 3-tier render model.

Backed by Supabase for auth/licensing, with an electron-updater rollout pipeline and a separate Next.js admin app under `admin/`.

## Build & Development Commands

```bash
npm run dev          # Vite dev server (port 5173) + Electron concurrently
npm run dev:vite     # Frontend only
npm run dev:electron # Electron only (expects Vite already running on :5173)
npm run build        # Full production build → NSIS installer in release/
npm run lint         # ESLint
```

**No test suite exists.** All claims of "works" are commit-history + manual-testing only.

### Build Pipeline Detail

`dev:electron` runs: TypeScript compile (`tsconfig.electron.json`) → `scripts/build-electron.js` (renames `.js` → `.cjs`, fixes `require()` paths to use `.cjs` including directory imports, writes `dist-electron/package.json` with `type: "commonjs"`) → launches Electron.

`build` runs: Vite frontend build → same TS + CJS fixup → `electron-builder` (config in `package.json` `"build"` key) → NSIS installer in `release/`.

## Process Model

- **Main process** ([electron/main.ts](electron/main.ts) — **5,224 lines**): Tray icon, overlay window, global hotkey, IPC handlers, PowerShell-based Windows automation. Uses a **persistent PowerShell child process** for window enumeration (~3s polling) instead of spawning per-query.
- **Preload** ([electron/preload.ts](electron/preload.ts)): Context bridge with `contextIsolation: true`. Bridge namespace is `'electron'` (NOT `'electronAPI'`).
- **Renderer** ([src/App.tsx](src/App.tsx) — **3,281 lines**): Large monolithic React component. UI logic is being progressively extracted into hooks and components.

`main.tsx` mounts: `AuthProvider` → `SessionContextProvider` → `App`.

## Mode 1: Chat

### Alt+Space Lifecycle

1. Global hotkey fires at [main.ts:905-921](electron/main.ts#L905). 300ms debounce prevents double-fire.
2. **Pre-capture** (window still hidden, runs in parallel):
   - `getActiveWindowInfo()` — persistent PowerShell + ENUM_WINDOWS (NOT `GetForegroundWindow()`, which would return KLYPIX itself because the global hotkey activates Electron).
   - Screenshot — `screenCapture_1.3.2.exe` → JPEG base64 (detect via base64 header: `/9j/` = JPEG, `iVBOR` = PNG).
   - Browser URL — three-fallback chain: UIA tree walk → SNSS session-file parse (`parseSNSSFile()`) → CDP ports 9222-9226.
   - Active file content — if window title matches a file pattern, read via COM (Office) or pdfplumber (PDF).
   - All bundled into a `pre-capture` IPC event.
3. `mainWindow.show()` — overlay appears with context already populated.
4. [src/core/contextIntelligence.ts](src/core/contextIntelligence.ts) classifies into one of 50+ categories.
5. "What I See" card sends screenshot to `gemini-2.5-flash` for structured `{seeing, key_data, actions}`.
6. User input → routes via `smartRouter`. If classified as agent task, "Run with Agent" button appears (manual click required — auto-routing is **not** wired).
7. Chat responses stream via real Gemini SSE through `model.generateContentStream()`.

### Chat AI Stack

- [src/api/gemini.ts](src/api/gemini.ts) — primary backend. Hardcoded model: `gemini-2.5-flash` ([gemini.ts:58](src/api/gemini.ts#L58)). Hardcoded fallback API key at [gemini.ts:8](src/api/gemini.ts#L8); user can override via `safeStorage` (DPAPI) or `localStorage['gemini_api_key']`.
- [src/core/aiRouter.ts](src/core/aiRouter.ts) — model router for chat. **Only Gemini is functional.** Claude / GPT-4 / Mistral return mock `"coming_soon"` streams ([aiRouter.ts:18-29](src/core/aiRouter.ts#L18)).
- The system prompt brands the AI as "KLYPIX" (overrides model identity).

### Power Button & Suggestions

- **Power button** ([src/App.tsx:1938-2039](src/App.tsx#L1938)) — user-customizable post-response action. Sends only the short prompt + previous answer as `activeDocContent` context (NOT inline, which would trigger doc-gen). Uses `actionType='onscreen'`.
- **Smart suggestions** — [src/core/contextIntelligence.ts](src/core/contextIntelligence.ts) detects context (50+ categories: spreadsheet, email, code-editor, CAD, browser-*, etc.). Gemini reorders/tunes action chips against the screenshot.

### Deep Mode

[src/hooks/useDeepMode.ts](src/hooks/useDeepMode.ts) — a document-scoped chat context, NOT a different model or "reasoning" mode.

1. Polls `getAllOpenFiles()` every 4s to discover open documents.
2. User multi-selects via checkbox UI.
3. Content pre-loads asynchronously with cancel/retry/cache (`fileContentCache` Map).
4. Combined content is injected as `activeDocContent`; follow-up Gemini queries are answered against those files.
5. **Tier-gated to Pro+** at [App.tsx:1195](src/App.tsx#L1195).

### On-Screen / Web Reading

- **Source of truth**: `detectContext()`. Pre-fetched data must NOT override it for non-browser contexts (otherwise minimized browser tabs contaminate the display).
- Web extraction methods (all in `electron/main.ts`): server-side fetch + Cheerio (~500ms, public pages only); CDP (auth pages, needs `--remote-debugging-port`); clipboard injection (Ctrl+A+C, manual-only via "Read full page"); SNSS session-file parsing (`parseSNSSFile()`); UIAutomation (browser as foreground required).
- **`activeDocContent`** ref in `useChat` holds doc/web context for follow-ups. Cleared on every toggle hide.

### Window Management

- **Maximize/restore**: custom `setBounds()`, NOT Electron's `maximize()`. `preMaximizeBounds` stores pre-maximize position. `isTogglingMaximize` flag prevents `moved`/`resize` events from clearing state during programmatic changes. Manual drag/resize on a maximized window unmaximizes.
- **Window constraints**: `maxWidth: 750`, `maxHeight: 980` (BrowserWindow + `setMaximumSize()`). The `resize-window` IPC handler must use the same constraints.

### Arabic / RTL — MINIMAL

[contextIntelligence.ts:430-441](src/core/contextIntelligence.ts#L430): Unicode-range detection injects a "translate accordingly" note to the LLM. **No bundled Arabic font, no RTL CSS, no bidi handling.** Document generators (DOCX/XLSX/PPTX/PDF) are LTR-only — Arabic content will render incorrectly in generated files.

## Mode 2: Agent

### Activation

**Manual toggle** (NOT auto-classification). Flow:
1. User types prompt; [src/core/agent/smartRouter.ts](src/core/agent/smartRouter.ts) silently classifies via Gemini Flash.
2. If classified as agent-worthy, "Run with Agent" button appears. User clicks to confirm.
3. `claudeAgent.startAgent()` is invoked at [App.tsx:1506](src/App.tsx#L1506).

The smartRouter result is **not** auto-applied — the user always confirms via button.

### Agent Loop

[src/core/agent/claudeAgent.ts](src/core/agent/claudeAgent.ts):
- `MAX_TURNS = 25` hard ceiling.
- Real streaming via `stream.onText()` callbacks.
- Exponential backoff: 3 retries, `delay = 2^(retryCount-1) * 1000` ms. Retryable on 429/529/5xx and stream parse failures.
- Hybrid Flash↔Claude per-turn routing: Flash for simple steps, Claude for synthesis/final.
- Per-tool 30s timeout (independent of total turn budget).
- Permission system uses the same `permissionManager.check()` and `callbacks.onPermissionRequest()` for every tool execution. No bypasses.

### Tool Registry — 22 main + 7 sandbox = ~29 callable tools

Main registry at [src/core/agent/toolRegistry.ts:18-269](src/core/agent/toolRegistry.ts#L18). Permission levels: `always_allow` | `ask_first` | `ask_every`.

| # | Tool | Permission |
|---|------|-----------|
| 1 | `capture_screenshot` | always_allow |
| 2 | `get_active_window` | always_allow |
| 3 | `read_active_file` | always_allow |
| 4 | `get_all_open_files` | always_allow |
| 5 | `read_file_by_title` | always_allow |
| 6 | `read_file` | ask_first |
| 7 | `write_file` | ask_every |
| 8 | `edit_file` | ask_every |
| 9 | `list_directory` | ask_first |
| 10 | `file_move` | ask_every |
| 11 | `file_delete` | ask_every |
| 12 | `run_shell` | ask_every |
| 13 | `browser_navigate` | ask_first |
| 14 | `browser_click` | ask_every |
| 15 | `browser_fill` | ask_every |
| 16 | `read_web_content` | ask_first |
| 17 | `system_open` | ask_first |
| 18 | `system_type` | ask_every |
| 19 | `clipboard_read` | always_allow |
| 20 | `clipboard_write` | always_allow |
| 21 | `ask_user` | always_allow (max 3/session) |
| 22 | `generate_document` | ask_every |

**Sandbox tools** at [toolRegistry.ts:320-326](src/core/agent/toolRegistry.ts#L320), running in a WSL2 Linux sandbox: `sandbox_execute`, `sandbox_read_file`, `sandbox_write_file`, `sandbox_list_dir`, `sandbox_run_python`, `sandbox_copy_from_shared`, `sandbox_save_to_shared`.

### Tool Routing Rules

- Tools that already exist as `eye:execute-action` intents (`file_move`, `file_delete`, `browser_*`, `system_*`) **must route through `executeAction`** — do not create new IPC handlers.
- New tools (`read_file`, `write_file`, `edit_file`, `list_directory`, `run_shell`) use `window.electron.agent.*`.
- Screen / clipboard tools call `window.electron.*` directly.

### Model Adapters — 5 working

[src/core/agent/adapters/](src/core/agent/adapters/):
- `claudeAdapter.ts` — Anthropic SDK.
- `geminiAdapter.ts` — Google SDK.
- `openaiAdapter.ts` — OpenAI SDK.
- `glmAdapter.ts` — Z.ai SDK. Auto-upgrades to `glm-5v-turbo` (vision) when task includes a screenshot.
- `deepseekAdapter.ts` — custom HTTP client (DeepSeek had no SDK at addition time). Surfaces hidden `reasoning_content`.

The agent loop only calls `ModelAdapter.stream()` — never provider SDKs directly. Don't add provider-specific types to the loop.

### Permission System

[src/core/agent/permissions.ts](src/core/agent/permissions.ts) + [src/components/PermissionTabs.tsx](src/components/PermissionTabs.tsx):
- Allow / Deny / Session-trust modal with 30s auto-deny timer.
- Session grants persisted to `localStorage['klypix:permissions']`.
- Path-pattern grants persisted to `localStorage['klypix:pathGrants']`.
- "Trust this session" grants all subsequent tool calls until session ends.
- [src/core/agent/shellGuard.ts](src/core/agent/shellGuard.ts) — renderer-side shell command blocklist (defense-in-depth; main process also blocks).

### Cost Tracking

[src/core/agent/costTracker.ts](src/core/agent/costTracker.ts):
- Measured: input tokens (cached + fresh), output tokens, cache hit ratio (Claude/DeepSeek), per-turn usage.
- Storage: `localStorage['klypix:sessionSpend']`, `klypix:dailyBudget` (default $5/day), `klypix:spend:YYYY-MM-DD`, 7-day rolling history.
- Pricing covers all 6+ supported models including DeepSeek V4.
- **Budget is enforced**, not advisory. `CostTracker.isOverBudget()` blocks runs when daily spend ≥ budget.

### Advanced Agent Subsystems (undocumented previously)

These modules in [src/core/agent/](src/core/agent/) ship in production but were absent from the prior CLAUDE.md:

- **`orchestrator.ts`** (~1,588 lines) — multi-step task coordination engine. Used for weak models (Gemini Flash, GLM-4.x); strong models (Claude, GLM-5, GPT-4o) use the legacy loop directly.
- **`planner.ts`** (~730 lines) — plan generation + validation. Rule-based templates + model-based JSON plan extraction with fallbacks.
- **`validator.ts`** — adversarial validation (PASS/FAIL/PARTIAL verdicts), file-existence + size + format checks, optional screen-diff verification.
- **`modelProfiles.ts`** (~401 lines) — per-model capability flags: `supportsForceToolUse`, `supportsVision`, `reliableToolCalling`, `planningCapability`, `earlyTerminationRisk`, `needsExplicitStepInstructions`, system-prompt suffixes.
- **`modelAllocator.ts`** — multi-model chaining (e.g. Claude plans, Gemini executes).
- **`contextManager.ts`** — 9-section compression + token estimation; compresses screenshots to `[Screenshot captured]`, truncates large web/file reads.
- **`compoundTools.ts`** — pre-built atomic multi-tool chains.
- **`toolCache.ts`** — TTL-based result cache (web 5min, file 30s, screenshot never).
- **`checkpoint.ts`** — save/restore plan state to localStorage; 1-hour TTL for resumable runs.
- **`sessionLearning.ts`** — pattern extraction (blocked URLs, preferred paths, tool failures) with 7-day TTL, max 100 patterns.
- **`narrator.ts` / `narrationStore.ts`** — voice narration / TTS.
- **`mcpBridge.ts`** — Model Context Protocol integration (16+ references across agent files).
- **`agentSession.ts`** — session manager. Run history persisted to `klypix:agentHistory` (last 50). **Cross-session learned context does NOT persist** — `setMemory()` is in-memory only; each session starts fresh.

## Mode 3: Canvas (.any files)

A full infinite-canvas workspace shipping at ~75% of design spec, actively maintained (~32 commits in the most recent batch). Triggered from the mode tabs in the header.

> See [docs/CLAUDE-KLYPIX-CANVAS.md](docs/CLAUDE-KLYPIX-CANVAS.md) for architecture detail and [docs/KLYPIX_Canvas_Handoff.md](docs/KLYPIX_Canvas_Handoff.md) for the latest session handoff (2026-05-01/02).

### Structure

- [src/canvas/CanvasEngine.ts](src/canvas/CanvasEngine.ts) — engine.
- [src/canvas/CanvasRenderer.tsx](src/canvas/CanvasRenderer.tsx) — viewport rendering with culling.
- [src/canvas/KlypixCanvas.tsx](src/canvas/KlypixCanvas.tsx) — top-level canvas component.
- [src/canvas/state/canvasStore.tsx](src/canvas/state/canvasStore.tsx) — Redux-style reducer with 150+ actions, fractional-indexing `zKey` for z-order.
- [src/canvas/items/](src/canvas/items/) — 10+ item types: Text, Box, Image, File, Code, Video, Audio, Link, CanvasLink, Approval, Container.
- [src/canvas/interaction/](src/canvas/interaction/) — multi-select bounding box, group resize handles, fill/stroke/text panels, context menu, inline prompts.
- [src/canvas/drawing/](src/canvas/drawing/) — perfect-freehand strokes.
- [src/canvas/file/](src/canvas/file/) — `.any` ZIP serialization (`anyFormat.ts`), schema migrations v1→v3 (`migrations.ts`), templates, drop handler, OCR for dropped images.
- [src/canvas/cloud/](src/canvas/cloud/) — `syncBlob.ts`, `syncClient.ts`, `electronTransport.ts`, AES-256-GCM `encryption.ts`. Cloud sync IPC in `electron/cloudHandlers.ts`.
- [src/canvas/agent/](src/canvas/agent/) — canvas-scoped chat thread + tool-calling agent (distinct from main chat agent).

### 3-Tier Render Model

[items/ContainerItem.tsx](src/canvas/items/ContainerItem.tsx) `getContainerRenderMode()` + [CanvasRenderer.tsx:126-136](src/canvas/CanvasRenderer.tsx#L126):
- **Expanded** — full item list visible.
- **Capsule** — collapsed header bar (auto-fits header text).
- **Dot** — single dot at extreme zoom-out.

Viewport culling via `tabModeContainers` set + transitive `hiddenByCollapse`.

### .any File Format

ZIP container with `canvas.json` (items, connections, lines, strokes, settings) + `assets/` folder (images, embedded files). Schema-versioned with the migration framework. Cloud sync uploads E2E-encrypted blobs.

### Chat → Canvas bridge

A hover button on every assistant chat bubble sends the response into the canvas as a new TextItem.

- **Entry**: `LayoutGrid` icon button rendered at the bottom-right of the assistant branch of `MessageItem` ([src/App.tsx](src/App.tsx)). Visible only on `group/asst` hover. Calls `handleSendToCanvas(msg.content)`.
- **Queue**: `handleSendToCanvas` pushes `{content, timestamp}` to `localStorage['klypix:pendingCanvasItems']` (array, accumulates across clicks) and flips `activeTab` to `'canvas'`.
- **Drain**: A `useEffect` inside `CanvasSurface` in [src/canvas/KlypixCanvas.tsx](src/canvas/KlypixCanvas.tsx) keyed on `[tabActive, file.restoreSettled]` reads the queue, clears it BEFORE dispatching (so a thrown error doesn't strand items), then `pushSnapshot()` + one `ADD_ITEM` per entry. Items are bordered TextItems placed at viewport center with a 28px diagonal stagger; content gets a `From chat · HH:MM` header. Reuses the existing `setToast({ text, id })` pattern for "Added from chat" feedback.
- **Why a queue, not a direct dispatch**: when the canvas mounts for the first time in a session, [useAnyFile.ts](src/canvas/file/useAnyFile.ts) may show a `window.confirm("Unsaved canvas found...")` dialog. We cannot dispatch into the store mid-restore — a successful restore replaces the entire state via a `RESTORE` action, which would wipe items we'd added. The queue lets the button feel instant while the drain waits.
- **`restoreSettled` flag** ([useAnyFile.ts](src/canvas/file/useAnyFile.ts)) is the wait signal. Resets to `false` on `tabActive=false`; only flips `true` after `checkAutosave` resolves AND any `openByPath` triggered by the dialog has fully awaited. The drain depends on this.

### Always-mount canvas (do not revert)

[src/App.tsx](src/App.tsx) renders `<KlypixCanvas appVisible={activeTab === 'canvas'} />` unconditionally — NOT `{activeTab === 'canvas' && <KlypixCanvas />}`. Reasons:

- The previous conditional unmounted every canvas tab on every chat trip, losing in-memory state for all non-active tabs (autosave only rescues one).
- It also re-fired the autosave restore dialog on every chat→canvas switch — designed for crash recovery, not routine tab toggles.

The `appVisible` prop:
1. Toggles a `display: none` on KlypixCanvas's root div.
2. Propagates into `tabActive={t.id === activeId && appVisible}` so each `CanvasSurface`'s side-effect gates (autosave restore, focus claim, comment opener registration) only fire when the canvas is actually shown.

### Canvas Agent vs Chat Agent

[src/canvas/agent/canvasAgent.ts](src/canvas/agent/canvasAgent.ts):
- **Scope**: canvas items only.
- **Tools**: ~22 canvas-specific (`canvas_create_card`, `canvas_read_item`, `canvas_connect_items`, `canvas_compile`, `canvas_organize`, `canvas_find_issues`, `canvas_run_code`, `canvas_pin_file/image`).
- **Selection → AI answer with arrow**: when user selects items and queries the canvas agent, output cards are connected back to source items via `canvas_connect_items`. Single-container selection uses `SCOPE_ANCHOR_ID` to draw one arrow to the group rather than fanning to children.
- **Code execution**: `canvas_run_code` runs Python/bash/Node in the WSL2 sandbox; output is pinned as cards. There are **no live iframes / persistent embedded webviews** — files are read-only cards, not running programs inside the canvas.

The chat agent is system-wide; the canvas agent is canvas-scoped. They do not share tool registries or permission state.

## Document Generation

### Trigger

[src/core/docGeneration.ts:72-145](src/core/docGeneration.ts#L72) — keyword-heuristic intent detection:
- Strong signals (≥0.8 confidence) → direct generation, no picker.
- Ambiguous → `FormatPicker` modal at [App.tsx:2909](src/App.tsx#L2909).
- Question words / trailing `?` → routes to chat instead.
- Agent mode invokes the same generators via the `generate_document` tool.

### Generators (real Office files, not HTML wrappers)

| Format | File | Library |
|---|---|---|
| DOCX | [electron/generators/docxGenerator.ts](electron/generators/docxGenerator.ts) | `docx` |
| XLSX | [electron/generators/xlsxGenerator.ts](electron/generators/xlsxGenerator.ts) | `ExcelJS` |
| PPTX | [electron/generators/pptxGenerator.ts](electron/generators/pptxGenerator.ts) | `pptxgenjs` |
| PDF  | [electron/generators/pdfGenerator.ts](electron/generators/pdfGenerator.ts)  | `pdfkit` (blank-page guard at L74; table layout L466-569) |

All output binary buffers, saved via `generate-file` IPC. Filenames come from the spec JSON the model produces.

### Known limitation: Arabic docs are NOT supported

Hard-coded LTR fonts (Calibri, Helvetica). No bidi handling, no Arabic-capable font bundle. Arabic content in generated files will render incorrectly.

## Memory System

Three layers, with very different durability characteristics. **Be precise about what survives a restart.**

### Persists across restart (localStorage)

| Key | Source | Content |
|---|---|---|
| `alt_space_memory_v1` | [src/api/memoryStore.ts](src/api/memoryStore.ts) | Last 20 interactions (timestamp, query, response preview) |
| `klypix_persona_v2` | `memoryStore.ts saveStructuredPersona()` | AI-synthesized role/domain/tools/language/patterns. Synthesized every 5 interactions. Injected into Gemini system prompt. |
| `klypix:learnedPatterns` | [src/core/agent/sessionLearning.ts](src/core/agent/sessionLearning.ts) | Pattern extraction (blocked URLs, save paths, tool failures), 7-day TTL, max 100 |
| `klypix:agentHistory` | `agentSession.ts` | Last 50 agent runs |
| `klypix:permissions`, `klypix:pathGrants` | `permissions.ts` | Permission grants |
| `klypix:dailyBudget`, `klypix:sessionSpend`, `klypix:spend:YYYY-MM-DD` | `costTracker.ts` | Cost tracking |
| `pinned_chats` | [src/hooks/usePinnedChats.ts](src/hooks/usePinnedChats.ts) | Saved conversations (max 50) |
| `klypix:pendingCanvasItems` | `handleSendToCanvas` in App.tsx | Chat→Canvas hand-off queue: `Array<{content, timestamp}>`. Drained by CanvasSurface on first activation, then cleared. |

### Persists encrypted (Electron main, DPAPI)

- `userData/auth/.session` — Supabase session token (`safeStorage`, plaintext fallback).
- `userData/auth/.api_key`, `userData/claude-key.enc` — encrypted API keys.

### Plain JSON (not encrypted)

- `userData/agent-config.json` — budget / enabled / spend history.

### Does NOT persist

- Session context (`analyzedFiles`, `screenAnalyses`, `generatedDocs`, `activeApp`) — in-memory React Context.
- Screenshot stack, deep-mode file content cache.
- **Agent learned context across sessions** — `agentSession.setMemory()` is in-memory only; the agent does not learn across runs beyond the 7-day pattern store.
- Canvas state — only saved when the user saves to a `.any` file.

### Privacy

[src/api/localRationale.ts](src/api/localRationale.ts) is a stateless function that maps process / window titles to 8 generic categories (Coding, Finance, Social, Design, Documents, Research, System, Unknown) when privacy mode is on.

## Auth, Tiers, API Keys

### Supabase

- [electron/auth/supabaseClient.ts](electron/auth/supabaseClient.ts) — client init.
- [electron/auth/authService.ts](electron/auth/authService.ts) — Google / Azure OAuth, email/password, license-key activation.
- [electron/auth/authGuard.ts](electron/auth/authGuard.ts) — IPC middleware.
- [electron/auth/tokenStore.ts](electron/auth/tokenStore.ts) — `safeStorage` (DPAPI) with plaintext fallback. **7-day offline grace period** before requiring re-login.
- Deep link protocol: `klypix://` for OAuth callbacks.
- Tier limits defined at [authService.ts:33-39](electron/auth/authService.ts#L33).

### Tier enforcement — RENDERER-ONLY (security gap)

Tier gates run in [src/components/AuthProvider.tsx:62-73](src/components/AuthProvider.tsx#L62) via `canUseFeature(feature)`. Deep mode checks at [App.tsx:1195](src/App.tsx#L1195).

**Caveats**:
- A user can edit `localStorage` to claim Pro tier and bypass gates.
- There is no server-side validation of tier before accepting queries.
- Agent mode and doc-gen are NOT explicitly checked in all submit paths.

### API Key Storage — INCONSISTENT

- **Gemini key**: encrypted via `safeStorage` (DPAPI). ✓
- **Claude / OpenAI / GLM / DeepSeek keys**: stored **plaintext in localStorage** via [components/AgentSettings.tsx](src/components/AgentSettings.tsx). Accessible from dev tools.
- Supabase URL / anon key are **hardcoded in source** at `electron/auth/supabaseClient.ts`.

## Renderer Decomposition

### Hooks (13 in [src/hooks/](src/hooks/))

Re-exported from `src/hooks/index.ts`:

`useAgent`, `useAttachments`, `useChat`, `useClaudeAgent` (largest, ~45KB), `useDeepMode`, `useDocGenerator`, `useNarration`, `usePinnedChats`, `useScreenshot`, `useSettings`, `useSuggestions`, `useUpdater`, `useWindowContext`.

### Components (26 in [src/components/](src/components/))

`AgentPanel`, `AgentRobot` (KlypixEyes variant with purple tint + robot helmet antenna), `AgentSettings` (provider selector, API key input, budget slider, cost history), `AuthProvider`, `CdpRestartBanner`, `EnhancerChat`, `FormatPicker`, `GeneratedDocCard`, `KlypixEyes`, `KlypixMascot`, `LoginScreen`, `MemoryConsentDialog`, `MemoryPanel`, `ModeTabs`, `OnboardingCards`, `PdfPasswordModal`, `PermissionTabs` (Allow/Deny/Session with auto-deny timer), `PromptEnhancer`, `RespondingKlypix`, `SandboxApprovalDialog`, `SandboxSetupBanner`, `ScreenshotStack`, `ThinkingBrain`, `UpdateToast`, `WhatISee`, `WorkflowPanel` (collapsible agent console with stats + follow-up input).

### Shared types

[src/types/index.ts](src/types/index.ts) — `Message`, `PinnedChat`, `DiscoveredFile`, `AttachedFile`, `WindowContext`, `Suggestion`.

## IPC Surface

The preload bridge ([electron/preload.ts](electron/preload.ts)) namespace is `'electron'`. Adding a new IPC channel requires three updates: handler in `main.ts`, expose in `preload.ts`, declare on `window.electron` type.

### Surfaces exposed

- **Capture / context**: `captureScreen`, `getActiveWindowContext`, `getCursorPosition`.
- **Files**: `readActiveFile`, `getAllOpenFiles`, `readMultipleFiles`, `readPdfWithPassword`, `extractBrowserUrl`, `lookupBrowserUrl`.
- **Web**: `readWebContent`, `readWebContentClipboard`.
- **Actions**: `executeAction` (intent engine — file_*, browser_*, system_*, clipboard_*).
- **Generation**: `generateFile`.
- **Window**: `resizeWindow`, `toggleMaximize`, `isMaximized`, `onMaximizeStateChanged`, `launchNativeSnipping`.
- **Clipboard**: `readClipboard`, `copyToClipboard`.
- **Shortcuts**: `getShortcut`, `setShortcut`.
- **External**: `openExternal`.
- **Auth**: `auth.*` (signIn, signOut, refresh, license activation).
- **Updater**: `updater.*` (check, download, install).
- **API keys**: `claude-key:store/get/clear` (and parallel for other providers).
- **Agent**: `window.electron.agent.*` — `runShell`, `readFile`, `writeFile`, `editFile`, `listDir`. Plus session/budget/enabled accessors.
- **Sandbox**: `window.electron.sandbox.*` — WSL2 sandbox controls.
- **Canvas**: `window.electron.canvas.*` — cloud sync (load/save/list/delete blobs, share-link operations, encryption keys). Handlers in `electron/cloudHandlers.ts`.
- **Narration**: `window.electron.narration.*` — voice / TTS.

## Auto-Updater

[electron/updater.ts](electron/updater.ts) — `electron-updater` driven by Supabase `releases` table: rollout percentage, mandatory flags, min supported version. Staged rollout decision computed from a hash of machine ID.

## Admin Dashboard

[admin/](admin/) — separate Next.js 14+ app. Manages users, licenses, releases, analytics, app config via Supabase. Has its own `.env.local.example`.

## Styling

Tailwind 3 with custom theme: Outfit / Poppins fonts, emerald accent (`#10b981`), glassmorphism (`.glass`), frameless drag regions, custom animations in [src/index.css](src/index.css).

## TypeScript Configuration

- `tsconfig.json` — frontend, ESNext, React JSX, path alias `@/*` → `src/*`.
- `tsconfig.electron.json` — Electron, CommonJS output to `dist-electron/`.

## Build Output

- Frontend → `dist/` (Vite).
- Electron → `dist-electron/` (CommonJS: `main.cjs`, `preload.cjs`).
- Installer → `release/` (NSIS `.exe`).

## Hard Constraints

- Windows-only (PowerShell scripts for UIA, screenshot, file detection).
- No test suite.
- Electron main-process files **must be CommonJS** (`.cjs`); the build script converts `.js` → `.cjs` automatically.
- Any new IPC channel needs handler + preload exposure + `window.electron` type declaration. Bridge namespace is `'electron'`, NOT `'electronAPI'`.
- `detectContext()` is the source of truth for what the user is viewing — pre-fetched data must not override it for non-browser contexts.
- The `'klypix'` check in `read-active-file` must use exact match (`=== 'KLYPIX'`) because VS Code with the KLYPIX project name contains "klypix" in its title.
- Agent engine must work with all 5 model adapters — never use provider-specific SDK types in the loop.
- Agent tools that already exist as `eye:execute-action` intents (file_move, file_delete, browser_*, system_*) must route through `executeAction`, not new IPC.
- Screenshot format is JPEG (not PNG) — detect via base64 header (`/9j/` = JPEG, `iVBOR` = PNG).
- **Never set `backgroundThrottling: false`** — it breaks on-screen insight visibility detection.
- Canvas: never swap stroke to white on selected items (boost width/opacity instead so palette picks stay visible). `window.prompt` is disabled in Electron renderer; use [src/canvas/interaction/InlinePrompt.tsx](src/canvas/interaction/InlinePrompt.tsx) for any text-input modal.
- **Canvas must stay always-mounted.** `<KlypixCanvas appVisible={activeTab === 'canvas'} />` — never revert to `{activeTab === 'canvas' && <KlypixCanvas />}`. Conditional unmount destroys multi-canvas tab state and re-fires the autosave restore dialog on every chat trip. See the "Always-mount canvas" subsection under Mode 3.
- Canvas resize floors are layered (frame world-px, frame screen-px, font readability) — forgetting #3 lets corner-shrink dot the item.
- `REORDER_ITEMS` in canvas store: dedup zKeys before permuting; duplicates silently no-op.
- Corner-resize aspect math must use diagonal projection, not `max(scaleX, scaleY)` — the latter explodes wide-but-short items on tiny perpendicular wobble.
- `pdfjs-dist` is v2.16; use `build/pdf.worker.min.js?url` (NOT `.mjs`).
- Full-screen overlays must put section title in body, NOT the header row — title bar stacks on top and collides.

## Privacy & Configuration

- All persistent data is local (Electron localStorage + encrypted files). No cloud sync except Canvas (E2E-encrypted) and Supabase auth.
- Screenshots are taken on-device and sent to the chosen AI provider only when needed.
- Privacy mode replaces sensitive window titles with generic categories ([src/api/localRationale.ts](src/api/localRationale.ts)).
- Configurable: hotkeys, API keys, model selection, voice features.

## Known Gaps & Limitations

These are real, current limitations the architect / Claude should not assume away:

1. **Arabic / RTL is passive only.** Document generators output garbled Arabic. UI lacks RTL CSS and bundled Arabic font.
2. **Tier enforcement is renderer-only.** localStorage edits bypass it; no server validation.
3. **Non-Gemini chat models return mocks.** Only Gemini-2.5-Flash actually streams in chat. Claude/GPT-4/Mistral routes are stubs in [aiRouter.ts](src/core/aiRouter.ts).
4. **smartRouter is built but unused for auto-routing.** It classifies but only surfaces a button.
5. **Agent has no cross-session memory.** Each agent run starts cold beyond the 7-day pattern store.
6. **API key storage is inconsistent.** Gemini uses DPAPI; everything else is plaintext localStorage. Supabase keys are hardcoded.
7. **No test suite.** All "works" claims rest on commit history + manual testing.
8. **`docs/` directory is partially obsolete.** Three superseded `KLYPIX_Agent_Engine_v*.md` files coexist; orphan plans live alongside current ones. All stale docs are now marked with a `SUPERSEDED` header.
9. **No native Windows snipping integration.** Crop/snip uses canvas-based draw mode instead.
10. **`run_shell` and `sandbox_*` are powerful and gated only by user prompts.** A careless "Allow for Session" can authorize a lot of operations.

## Help & Feedback

- `/help` — Get help with using Claude Code.
- Report issues at https://github.com/anthropics/claude-code/issues.
