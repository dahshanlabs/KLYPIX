# ⚠️ SUPERSEDED — see CLAUDE.md

# ALT+Space — Agent Mode Feasibility & Architecture

**Document Type:** Technical Feasibility Assessment
**Date:** 2026-03-18
**Status:** Proposal — Pre-Implementation

---

## 1. What Is Being Proposed

An **Agent Mode** — a robot/autopilot mode inside ALT+Space that can:

- **Execute multi-step workflows** autonomously (e.g., "download all PDFs from this page, summarize each, and save a report to Desktop")
- **Take real actions** on the user's computer — open apps, click UI elements, type text, move files, navigate browsers
- **Schedule tasks** — run workflows at specific times or on triggers ("every morning at 9am, check these 3 sites and summarize what's new")
- **Act on suggested actions** — the current action buttons (Decision, Risk, Extract, etc.) become executable, not just analytical. "Actions" mode could output a plan and then *do* it
- **Show progress** — a visual workflow runner (like Claude Cowork / Cursor's agent) with step-by-step status, confirmations for destructive actions, and undo

---

## 2. What Already Exists (Foundation Audit)

The codebase has a surprisingly strong foundation. Here's what's already built:

### Ready to Use

| Capability | Location | Status |
|-----------|----------|--------|
| **Intent Engine** — AI classifies natural language into 14 action types with confidence scores | `src/core/engine/intentEngine.ts` | Built, not integrated into UI |
| **Action Taxonomy** — file_save, file_rename, browser_navigate, system_open, clipboard_copy, system_type, browser_fill, browser_click, etc. | `src/core/engine/intentTypes.ts` | 14 types defined |
| **Action Executor** — IPC handler that receives an intent and executes it | `electron/main.ts:795-855` | Partial — 5 of 14 types implemented |
| **Confirmation System** — `requiresConfirmation` flag on destructive intents + `previewDescription` for human review | `intentTypes.ts` | Defined, not wired to UI |
| **Window Enumeration** — see all open windows, detect active app | `electron/main.ts` | Active, persistent PS process |
| **Browser Tab Detection** — read all open tabs via UIAutomation + session files | `electron/main.ts` | Active |
| **Screen Capture** — full screen or region, returns base64 | `electron/main.ts` | Active |
| **Keyboard Injection** — SendKeys via PowerShell (Ctrl+A, Ctrl+C, etc.) | `electron/main.ts` | Active (used in clipboard fallback) |
| **Window Focus** — SetForegroundWindow Win32 call | `electron/main.ts` | Active |
| **File I/O** — read/write/rename via Node fs | `electron/main.ts` | Active |
| **Clipboard** — read and write (text + HTML) | `electron/main.ts` | Active |
| **CDP (Chrome DevTools Protocol)** — inject JavaScript into browser pages | `electron/main.ts` | Active |
| **App Launch** — open any app via shell.openPath + exec | `electron/main.ts` | Active |
| **Undo Payload** — `ActionResult.undoPayload` field defined for rollback | `intentTypes.ts` | Defined, not implemented |

### Gaps That Need Building

| Capability | Effort | Notes |
|-----------|--------|-------|
| **Mouse control** — move cursor, click at coordinates | Medium | Need Win32 `SendInput` via PowerShell or native module. `@nut-tree-fork` is already in node_modules |
| **Element targeting** — click a specific button/field by label or selector | Medium | CDP covers browsers. Desktop apps need UIAutomation `InvokePattern` / `ValuePattern` |
| **Workflow orchestrator** — execute a chain of actions with branching, retries, rollback | Large | Core new system. This is the agent loop |
| **Scheduler** — cron-like triggers, persistent across app restarts | Medium | Need a task store (localStorage or file) + interval runner in main process |
| **Agent UI** — step-by-step progress, confirm/deny, live status | Large | New React panel (the "robot mode" view) |
| **Action buttons → executable** — "Actions" prompt outputs a plan, user clicks "Execute", agent runs it | Medium | Wire intent engine to action prompt output parser |
| **Browser form filling** — CDP `DOM.querySelector` + `Input.dispatchKeyEvent` | Medium | CDP is already connected, need to add input injection |
| **Undo system** — rollback file renames, clipboard restores, etc. | Small | `undoPayload` field exists, just needs executor-side implementation |

---

## 3. Proposed Architecture

### 3.1 — Agent Loop (Core)

```
User prompt
    ↓
┌─────────────────────────┐
│  1. PLAN                │  Gemini generates a multi-step plan
│     (intentEngine ×N)   │  Each step = one Intent with params
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│  2. REVIEW              │  User sees the plan in Agent UI
│     Confirm / Edit /    │  Destructive steps highlighted
│     Cancel              │  User can edit params before execution
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│  3. EXECUTE             │  Each step runs sequentially
│     Step 1 → result     │  After each step:
│     Step 2 → result     │    - Update UI with status
│     Step 3 → ...        │    - Capture screenshot (optional)
│                         │    - AI verifies result matches intent
│                         │    - If failed: retry once, then pause
└──────────┬──────────────┘
           ↓
┌─────────────────────────┐
│  4. REPORT              │  Summary of what was done
│     + Undo option       │  List of reversible actions
└─────────────────────────┘
```

### 3.2 — Workflow Schema

Each workflow is a JSON object stored in localStorage or a file:

```typescript
interface Workflow {
    id: string;
    name: string;                          // "Summarize morning news"
    trigger: WorkflowTrigger;
    steps: WorkflowStep[];
    status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
    createdAt: number;
    lastRunAt?: number;
}

interface WorkflowTrigger {
    type: 'manual' | 'schedule' | 'hotkey' | 'window-focus';
    cron?: string;                         // "0 9 * * 1-5" (weekdays at 9am)
    hotkey?: string;                       // "Ctrl+Shift+1"
    windowMatch?: string;                  // regex on window title
}

interface WorkflowStep {
    id: string;
    intent: Intent;                        // From existing intentTypes.ts
    dependsOn?: string[];                  // Step IDs this waits for
    condition?: string;                    // "previous.result.contains('error')"
    status: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
    result?: ActionResult;
    retries: number;
    maxRetries: number;
}
```

### 3.3 — Agent UI (React Panel)

The agent mode gets its own panel, toggled via a robot icon button next to the existing mode buttons (screenshot, deep mode, etc.):

```
┌─────────────────────────────────────────────┐
│  🤖 AGENT MODE                    [Stop] [×]│
│─────────────────────────────────────────────│
│                                              │
│  "Download all PDFs from this page and       │
│   summarize each into a single report"       │
│                                              │
│  ── Plan ──────────────────────────────────  │
│                                              │
│  ✅ Step 1: Navigate to active browser tab   │
│     → Opened: arxiv.org/list/cs.AI           │
│                                              │
│  ✅ Step 2: Extract PDF links from page      │
│     → Found 12 PDF links                     │
│                                              │
│  🔄 Step 3: Download PDF #3 of 12           │
│     → attention_mechanisms_v2.pdf (2.1 MB)   │
│                                              │
│  ⏳ Step 4: Read and summarize each PDF      │
│  ⏳ Step 5: Compile summaries into report    │
│  ⏳ Step 6: Save report to Desktop           │
│                                              │
│  ── Actions ───────────────────────────────  │
│  [ Pause ]  [ Skip Step ]  [ Undo Last ]     │
│                                              │
└─────────────────────────────────────────────┘
```

**Key UX principles:**
- Every step shows *what it will do* before doing it
- Destructive steps (file delete, overwrite) require explicit confirmation
- User can pause, skip, or undo at any point
- Screenshot captured after each visual step (browser nav, app open) for verification
- AI can self-correct: if a screenshot shows an unexpected state, it re-plans

### 3.4 — Scheduler UI

Accessible from the agent panel or settings:

```
┌─────────────────────────────────────────────┐
│  📅 SCHEDULED WORKFLOWS                      │
│─────────────────────────────────────────────│
│                                              │
│  Morning Brief          Weekdays 9:00 AM    │
│  "Check Reuters, Bloomberg, summarize"  [▶] │
│                                              │
│  Weekly Report          Friday 5:00 PM      │
│  "Compile this week's notes into PDF"   [▶] │
│                                              │
│  [ + New Scheduled Workflow ]                │
│                                              │
└─────────────────────────────────────────────┘
```

Schedules persist in `localStorage` and are checked by a `setInterval` in the main process. When triggered, the agent UI opens with the workflow pre-loaded and begins execution (or waits for confirmation, depending on user preference).

---

## 4. How Action Buttons Evolve

Currently, action buttons (Decision, Risk, Actions, etc.) are **analytical** — they send a prompt and show text output.

In Agent Mode, the "Actions" button becomes a bridge:

### Current Flow
```
User clicks "Actions" → AI generates a to-do list → User reads it
```

### Agent Mode Flow
```
User clicks "Actions" → AI generates a to-do list → Each item is an executable Intent
    → User sees the plan with [Execute All] or [Execute Step] buttons
    → Agent runs the steps with live progress
```

The other action buttons remain analytical. Only "Actions" gains an execution path. This keeps the UX clean — analysis buttons analyze, the action button acts.

Optionally, any AI response could contain actionable items that the agent can detect and offer to execute:

```
AI Response: "You should rename report_draft.pdf to report_final.pdf"
              [Execute this] ← inline button, parsed from intent detection
```

---

## 5. Implementation Phases

### Phase 1 — Complete the Action Executor (1-2 weeks)

**Goal:** All 14 intent types work end-to-end.

What to build:
- Implement missing executor cases: `file_create`, `file_delete`, `file_move`, `system_type`, `system_click`, `system_screenshot`
- Add mouse control via `@nut-tree-fork` (already in node_modules) or Win32 `SendInput`
- Wire `browser_fill` and `browser_click` through CDP
- Implement undo for reversible actions (file_rename → rename back, clipboard_copy → restore previous)
- Add `eye:execute-action` to preload bridge (it may already be there but unused)

**Test:** User says "rename this file to X" → intent classified → preview shown → user confirms → file renamed → undo available.

### Phase 2 — Single-Step Agent Mode (1 week)

**Goal:** The intent engine is live in the UI. User types a command, AI classifies it, user confirms, it executes.

What to build:
- Add intent detection to `handleSubmit` — if confidence > 0.8, show the action preview instead of (or alongside) the AI text response
- Confirmation UI: a card showing "I'll do X. [Confirm] [Cancel]"
- Result display: "Done. [Undo]"
- Robot icon toggle in the toolbar to enable/disable agent mode

**Test:** User types "open Notepad" → AI classifies as `system_open` with confidence 0.95 → preview card appears → user clicks Confirm → Notepad opens.

### Phase 3 — Multi-Step Workflows (2-3 weeks)

**Goal:** The agent can plan and execute sequences of actions.

What to build:
- Workflow planner: Gemini takes a high-level command and outputs a `WorkflowStep[]`
- Workflow executor: sequential runner with status updates, error handling, retries
- Agent UI panel (the step-by-step view shown in section 3.3)
- Self-verification: after each step, capture context (screenshot or file state) and verify the step succeeded

**Test:** User says "Save all open browser tabs as bookmarks in a text file on Desktop" → AI plans 4 steps → user reviews → agent executes → report saved.

### Phase 4 — Scheduler + Triggers (1-2 weeks)

**Goal:** Workflows can run on a schedule or in response to triggers.

What to build:
- Workflow persistence (localStorage or JSON file in app data)
- Schedule checker in main process (`setInterval` checking against cron expressions)
- Trigger system: schedule, hotkey, window-focus-match
- Scheduler UI (section 3.4)
- Notification when a scheduled workflow completes or fails

**Test:** User creates a workflow "Every weekday at 9am, open Reuters, capture the front page, summarize top 5 stories, save to Desktop/daily_brief.txt" → workflow runs the next morning automatically.

### Phase 5 — Polish & Safety (1 week)

- Rate limiting (max N actions per minute to prevent runaway loops)
- Sandboxed file operations (restricted to user directories, no system files)
- Action audit log (every action recorded with timestamp, intent, result, undo payload)
- Kill switch: `Escape` key immediately halts all agent execution
- Timeout per step (default 30s, configurable)

---

## 6. What This Does NOT Require

- **No new AI model** — Gemini 2.5 Flash handles both intent classification (already built) and workflow planning
- **No new native dependencies for basic agent** — `@nut-tree-fork` is already installed for mouse control. PowerShell + Win32 covers the rest
- **No server/cloud component** — everything runs locally in the Electron main process
- **No changes to the existing chat flow** — agent mode is a parallel mode, not a replacement. Toggle on/off like screenshot mode

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Runaway execution** — agent keeps acting after an error | High | Kill switch (Escape), step timeout, max-actions-per-workflow limit |
| **Destructive actions** — deletes wrong file, overwrites data | High | Confirmation required for all destructive intents, undo system, sandboxed directories |
| **Intent misclassification** — AI misunderstands command | Medium | 0.80 confidence threshold + human confirmation before execution |
| **Window focus conflicts** — agent focuses a window while user is typing | Medium | Pause execution if user is actively interacting (detect keystrokes/mouse movement) |
| **CDP instability** — browser automation fails silently | Medium | Verify each browser step with a follow-up screenshot or DOM check |
| **Performance** — PowerShell spawning adds latency | Low | Persistent PS process already solves this for scanning; reuse for actions |

---

## 8. Comparison to Claude Cowork / Cursor Agent

| Feature | Claude Cowork | Cursor Agent | ALT+Space Agent (Proposed) |
|---------|--------------|-------------|---------------------------|
| **Scope** | Code editing only | Code editing + terminal | Full desktop — any app, any file, browsers |
| **Execution** | Edits files in sandbox | Edits files + runs commands | Opens apps, types, clicks, navigates, manages files |
| **UI** | Step-by-step diff view | Inline code changes | Step-by-step action view with screenshots |
| **Confirmation** | Per-file approval | Auto-apply with undo | Per-step for destructive, auto for safe actions |
| **Scheduling** | None | None | Cron-like scheduling with triggers |
| **Platform** | Web/API | VS Code extension | Windows desktop (full OS access) |

ALT+Space's advantage: it has OS-level access that code editors don't. It can interact with *any* application, not just code files. The agent can open Excel, fill cells, save, open a browser, navigate, extract data — across application boundaries.

---

## 9. Minimum Viable Agent

The smallest useful agent mode that delivers value:

1. **Intent detection ON** in the existing chat flow (Phase 2)
2. **5 working actions**: `system_open`, `file_save`, `file_rename`, `clipboard_copy`, `browser_navigate`
3. **Confirmation card** before execution
4. **Undo** for file operations
5. **Robot icon** toggle in toolbar

This can be shipped in **~2 weeks** on top of the existing codebase. Everything beyond this (multi-step, scheduling, mouse control) is additive.
