# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Memory & Persistence Audit

**Date:** 2026-04-08  
**Purpose:** Complete audit of all existing memory-related functionality before implementing a new memory system.

---

## Overview

The codebase has **15 distinct persistence mechanisms** across 3 storage layers. **Zero external databases** — no SQLite, no IndexedDB. Everything is localStorage (renderer) + encrypted files (Electron main) + in-memory state.

---

## Storage Layer 1: localStorage (Renderer Process)

### A. Chat Messages
- **File:** `src/hooks/useChat.ts`
- **Key:** `active_messages`
- **Data:** Array of Message objects (user + AI responses)
- **Cross-session:** No (cleared on session reset)
- **Cap:** Unlimited
- **Functions:** `saveMessages()`, loaded on component mount

### B. Pinned Chats (Conversation Bookmarking)
- **File:** `src/hooks/usePinnedChats.ts`
- **Key:** `pinned_chats`
- **Data:** Array of `PinnedChat` objects (id, timestamp, previewText, full messages)
- **Cross-session:** Yes
- **Cap:** 50 pinned chats
- **Functions:** `handlePinConversation()`, `handleLoadPinnedChat()`, `handleDeletePinnedChat()`

### C. Memory Store (Interaction History + Persona)
- **File:** `src/api/memoryStore.ts`
- **Keys:**
  - `alt_space_memory_v1` — Main interaction history
  - `alt_space_persona_v1` — String-based user persona (v1)
  - `klypix_persona_v2` — Structured user persona (v2)
- **Data:**
  - `MemoryEvent`: timestamp, app, title, query, responsePreview, type
  - `StructuredPersona`: role, domain, primaryTools[], language, focus, patterns[]
- **Cross-session:** Yes
- **Cap:** 20 memory events (FIFO)
- **Functions:**
  - `saveMemoryEvent()` — Saves interactions
  - `getMemoryHistory()` — Retrieves recent history
  - `getMemorySummary()` — Summarizes for AI context injection (dumps all 20 events into prompt)
  - `savePersona()` / `getPersona()` — Store user profile string
  - `saveStructuredPersona()` / `getStructuredPersona()` — Structured persona management
  - `exportMemoryData()` — Export for backup
  - `clearMemory()` — Wipe all memory
- **Notes:** Integrated with privacy mode (masks sensitive data). Persona is AI-synthesized by Gemini every 5 interactions via `gemini.ts`.

### D. User Settings & Preferences
- **File:** `src/hooks/useSettings.ts`
- **Keys:** `privacy_mode`, `selected_model`, `pdf_ocr_mode`, `power_button_label`, `power_button_prompt`
- **Cross-session:** Yes
- **Functions:** Loaded on mount, synced via useEffect

### E. Agent Session History
- **File:** `src/core/agent/agentSession.ts`
- **Key:** `klypix:agentHistory`
- **Data:** Array of `AgentSession` objects (id, prompt, steps[], finalResponse, cost, status, startTime, endTime)
- **Cross-session:** Yes
- **Cap:** 50 sessions
- **Functions:** `getHistory()`, `saveToHistory()`

### F. Cost Tracking (Budget Management)
- **File:** `src/core/agent/costTracker.ts`
- **Keys:**
  - `klypix:sessionSpend` — Current session spend
  - `klypix:dailyBudget` — Daily budget cap (default $5.00)
  - `klypix:spend:YYYY-MM-DD` — Daily spend by date
- **Cross-session:** Yes
- **Cap:** 7-day rolling history
- **Functions:** `getSessionSpend()`, `addSessionSpend()`, `getDailyBudget()`, `setDailyBudget()`, `isOverBudget()`, `addDailySpend()`, `getCostHistory()`

### G. Learned Patterns (Agent Behavioral Learning)
- **File:** `src/core/agent/sessionLearning.ts`
- **Key:** `klypix:learnedPatterns`
- **Data:** Array of `LearnedPattern` objects
  - type: `'blocked_url' | 'preferred_path' | 'tool_failure' | 'user_correction'`
  - pattern (string), confidence (0–1), lastSeen (timestamp), count
- **Cross-session:** Yes (7-day TTL)
- **Cap:** 100 patterns
- **Functions:**
  - `learnFromSession()` — Extract patterns from completed agent runs
  - `getConstraints()` — Return learned restrictions for planner
  - `getPreferredPath()` — Most common save location
  - `isBlockedDomain()` — Check if URL previously failed
  - `recordUserCorrection()` — Manual pattern recording
  - `clear()` — Reset all patterns

### H. Agent Checkpoints (Resume Capability)
- **File:** `src/core/agent/checkpoint.ts`
- **Key:** `klypix:agentCheckpoint`
- **Data:** `Checkpoint` object (planState, completedResults, agentMemory, contextSummary, costSoFar, turnCount, originalPrompt, modelId, timestamp)
- **Cross-session:** No (1-hour TTL, auto-cleared when stale)
- **Cap:** 1 checkpoint
- **Functions:** `save()`, `load()`, `hasResumable()`, `describe()`, `clear()`

### I. Agent Permissions
- **File:** `src/core/agent/permissions.ts`
- **Key:** Dynamic per-tool
- **Cross-session:** Yes
- **Data:** Permission grants by tool name

### J. Provider/Router/Trust Settings
- **Files:** Multiple
- **Keys:** `klypix:agentProvider`, `klypix:hybridRouter`, `klypix:trustMode`
- **Cross-session:** Yes

### K. Onboarding State
- **File:** `src/components/OnboardingCards.tsx`
- **Key:** Custom (ONBOARDING_KEY)
- **Cross-session:** Yes
- **Data:** Boolean (completed or not)

### L. Trial Start Tracking
- **File:** `src/App.tsx`
- **Key:** TRIAL_START_KEY
- **Cross-session:** Yes
- **Data:** Timestamp

---

## Storage Layer 2: Electron Encrypted File System (Main Process)

### A. Auth Session Token
- **File:** `electron/auth/tokenStore.ts`
- **Path:** `userData/auth/.session`
- **Encryption:** Electron `safeStorage` (Windows DPAPI/Credential Manager)
- **Fallback:** Plain JSON if encryption unavailable
- **Offline grace period:** 7 days
- **Functions:** `storeSession()`, `getSession()`, `clearSession()`, `hasSession()`, `markVerified()`, `isWithinGracePeriod()`

### B. API Keys (Encrypted)
- **Files:** `electron/auth/tokenStore.ts` + `electron/main.ts`
- **Paths:** `userData/auth/.api_key`, `userData/claude-key.enc`
- **Encryption:** Electron `safeStorage`
- **IPC Handlers:** `claude-key:store`, `claude-key:get`, `claude-key:clear`

### C. Agent Configuration (JSON)
- **File:** `electron/agentConfig.ts`
- **Path:** `userData/agent-config.json`
- **Encryption:** None (plain JSON)
- **Data:** budget (float), enabled (boolean), daily spend by date
- **Functions:** `getConfig()`, `setConfig()`, `getTodaySpend()`, `addTodaySpend()`, `getSpendHistory()`

---

## Storage Layer 3: In-Memory Only (Ephemeral)

### A. Session Context (React Context)
- **File:** `src/core/sessionContext.ts`
- **Type:** React Context provider
- **Data:** `analyzedFiles[]`, `screenAnalyses[]` (capped at 5), `activeApp`, `generatedDocs[]`, `lastSourceMode`
- **Persistence:** None — clears on app restart or explicit `clear()`
- **Functions:** `addAnalyzedFile()`, `addScreenAnalysis()`, `addGeneratedDoc()`, `setActiveApp()`, `setLastSourceMode()`, `clear()`, `getContextSummary()`

### B. Tool Result Cache
- **File:** `src/core/agent/toolCache.ts`
- **Type:** Map-based in-memory cache
- **TTL by tool:**
  - `read_web_content`: 5 min
  - `read_file`: 30s
  - `read_active_file`: 10s
  - `list_directory`: 60s
  - `get_active_window`: 5s
  - `get_all_open_files`: 10s
  - No cache: `capture_screenshot`, `run_shell`, `clipboard_*`, `write_file`, `edit_file`, `generate_document`, browser/system ops
- **Functions:** `get()`, `set()`, `isDuplicate()`, `invalidate()`, `invalidatePath()`, `clear()`, `stats()`

---

## Storage Layer 4: Privacy Analysis (No Persistence)

- **File:** `src/api/localRationale.ts`
- **Type:** Pure function (stateless)
- **Purpose:** Maps process/window titles to 8 generic categories (Coding, Finance, Social, Design, Documents, Research, System, Unknown) for privacy mode
- **No storage** — runs on demand

---

## All localStorage Keys Summary

| Key | File | Purpose |
|---|---|---|
| `active_messages` | useChat.ts | Current chat messages |
| `pinned_chats` | usePinnedChats.ts | Saved conversations |
| `alt_space_memory_v1` | memoryStore.ts | Interaction history (20 events) |
| `alt_space_persona_v1` | memoryStore.ts | User persona string |
| `klypix_persona_v2` | memoryStore.ts | Structured user persona |
| `privacy_mode` | useSettings.ts | Privacy toggle |
| `selected_model` | useSettings.ts | AI model selection |
| `pdf_ocr_mode` | useSettings.ts | OCR strategy |
| `power_button_label` | useSettings.ts | Quick action label |
| `power_button_prompt` | useSettings.ts | Quick action prompt |
| `gemini_api_key` | gemini.ts | User's Gemini API key |
| `klypix:agentHistory` | agentSession.ts | Agent run history |
| `klypix:sessionSpend` | costTracker.ts | Current session cost |
| `klypix:dailyBudget` | costTracker.ts | Daily budget limit |
| `klypix:spend:YYYY-MM-DD` | costTracker.ts | Daily spend tracking |
| `klypix:learnedPatterns` | sessionLearning.ts | Behavioral patterns |
| `klypix:agentCheckpoint` | checkpoint.ts | Resume state |
| `klypix:agentProvider` | multiple | Selected AI provider |
| `klypix:hybridRouter` | multiple | Router mode |
| `klypix:trustMode` | multiple | Trust/safety mode |
| ONBOARDING_KEY | OnboardingCards.tsx | Onboarding completed |
| TRIAL_START_KEY | App.tsx | Trial start timestamp |

---

## What's Missing (Gaps for a Full Memory System)

| Gap | Detail |
|---|---|
| **Long-term semantic memory** | No vector store, no embeddings, no similarity search. `memoryStore` is a flat 20-item FIFO with no relevance filtering. |
| **Structured knowledge base** | No entity extraction, no fact storage, no relationship graphs. Persona is AI-synthesized but not user-editable or queryable. |
| **Cross-conversation threading** | Pinned chats save messages but no linking between related conversations or topics. |
| **Explicit "remember this" command** | No user-facing way to tell the AI to persist a specific fact. Learning is implicit only (agent patterns). |
| **Relevance-based memory retrieval** | `getMemorySummary()` dumps all 20 events into context. No filtering by relevance, topic, or recency weighting. No RAG. |
| **Persistent file/document index** | `sessionContext` tracks analyzed files but forgets on restart. No persistent index of previously read documents. |
| **User correction persistence for chat mode** | `sessionLearning` captures agent corrections, but main chat mode has no equivalent feedback loop. |
| **Memory management UI** | No way to view, edit, or delete individual memories. Only bulk `clearMemory()`. |
| **Database backend** | Everything is localStorage (5–10MB browser limit). No SQLite or IndexedDB for larger storage needs. |
| **Memory importance scoring / decay** | Only `sessionLearning` has TTL (7 days). Memory events have no importance weighting, no decay, no consolidation. |
| **Conversation summarization** | No automatic summarization of long conversations for future reference. Pinned chats store raw messages only. |
| **Preference learning from chat** | Structured persona is AI-synthesized every 5 interactions but only captures role/domain/tools — not behavioral preferences, communication style, or topic interests. |

---

## Key Architectural Notes for Implementation

1. **All renderer persistence is localStorage** — if you need > 5MB or structured queries, you'll need IndexedDB or SQLite via Electron main process.
2. **No IPC channel exists for generic storage** — new persistent storage in main process would need new IPC handlers + preload exposure.
3. **`memoryStore.ts` is the natural extension point** for enhanced memory — it already handles history + persona + privacy + export/clear.
4. **`sessionLearning.ts` is the closest to "real" memory** — it has TTL, confidence scoring, pattern types, and feeds constraints back into the planner. Could be generalized.
5. **The session context bus (`sessionContext.ts`) is ephemeral by design** — it's meant to share state within a single session, not persist across restarts.
6. **Persona synthesis happens in `gemini.ts`** (calls `saveStructuredPersona` every 5 interactions) — any memory system should integrate with or replace this flow.
7. **Privacy mode affects `memoryStore`** — any new memory system must respect the same privacy masking.
