# ⚠️ SUPERSEDED — see CLAUDE.md

# CLAUDE.md — KLYPIX Agent Memory System

## Project Context

KLYPIX is a Windows desktop AI assistant built with Electron 33 / React 19 / TypeScript / Vite / TailwindCSS. It has a Hybrid Router (spec #1), hardened Flash engine (spec #2), and WSL2 sandbox (spec #3).

**Problem:** The agent has no memory between sessions. Every conversation starts blank. The user has to re-explain who they are, what they're working on, and how they prefer things done — every single time. This makes the agent feel disposable, not personal.

**Goal:** Give KLYPIX persistent memory that makes the agent smarter over time — while giving the user FULL control over what's remembered, what's forgotten, and whether memory is used at all. Memory is a feature the user opts into, not something forced on them.

**Core Principle:** This is a local-first, privacy-respecting memory system. All data stays on the user's machine. No cloud. No sync. No third-party access. The user owns their memory data completely.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────┐
│                     KLYPIX Session                         │
│                                                            │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────┐ │
│  │ Memory       │    │ Agent        │    │ Memory      │ │
│  │ Loader       │───►│ Session      │───►│ Extractor   │ │
│  │ (session     │    │ (runs with   │    │ (after      │ │
│  │  start)      │    │  memory      │    │  session)   │ │
│  └──────┬───────┘    │  context)    │    └──────┬──────┘ │
│         │            └──────────────┘           │        │
│         │                                        │        │
│    ┌────▼────────────────────────────────────────▼────┐   │
│    │              Memory Store (SQLite)                │   │
│    │                                                   │   │
│    │  ┌───────────┐ ┌───────────┐ ┌───────────────┐  │   │
│    │  │ Semantic   │ │ Episodic  │ │ Procedural    │  │   │
│    │  │ (facts)    │ │ (history) │ │ (workflows)   │  │   │
│    │  └───────────┘ └───────────┘ └───────────────┘  │   │
│    └──────────────────────────────────────────────────┘   │
│                          ▲                                 │
│                          │                                 │
│    ┌─────────────────────┴───────────────────────────┐    │
│    │           User Memory Controls (UI)              │    │
│    │                                                   │    │
│    │  [✅ Memory ON/OFF]                              │    │
│    │  [View All Memories]                              │    │
│    │  [Edit / Delete Individual Memories]              │    │
│    │  [Pause Memory for This Session]                  │    │
│    │  [Export / Import Memory]                         │    │
│    │  [Nuke All Memory]                                │    │
│    └───────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────┘
```

---

## File Structure

```
src/
├── services/
│   └── memory/
│       ├── index.ts                    # Main memory export
│       ├── memoryStore.ts              # SQLite storage layer
│       ├── memoryLoader.ts             # Loads relevant memories at session start
│       ├── memoryExtractor.ts          # Extracts new memories after session
│       ├── memoryManager.ts            # CRUD operations + user controls
│       ├── memoryInjector.ts           # Injects memories into agent prompts
│       ├── memorySettings.ts           # User preferences for memory behavior
│       ├── memoryExporter.ts           # Export/import memory data
│       ├── types.ts                    # Memory types
│       └── migrations.ts              # Database schema migrations
│
├── components/
│   └── memory/
│       ├── MemoryPanel.tsx             # Main memory management UI
│       ├── MemoryToggle.tsx            # On/off toggle in header
│       ├── MemoryList.tsx              # View all memories
│       ├── MemoryEditor.tsx            # Edit/delete individual memory
│       ├── MemorySettings.tsx          # Memory preferences
│       ├── MemoryExportDialog.tsx      # Export/import dialog
│       ├── MemorySessionBanner.tsx     # "Memory is paused" banner
│       └── MemoryConsentDialog.tsx     # First-time opt-in dialog
```

---

## 1. Types (`types.ts`)

```typescript
// ---- MEMORY TYPES ----

export type MemoryType = 'semantic' | 'episodic' | 'procedural';

export type MemorySource = 'extracted' | 'user_added' | 'user_edited';

export interface Memory {
  id: string;                           // UUID
  type: MemoryType;
  content: string;                      // the actual memory text
  category: string;                     // e.g., "personal", "work", "preferences"
  confidence: number;                   // 0-1, how certain are we this is correct
  source: MemorySource;
  createdAt: number;                    // timestamp
  updatedAt: number;
  lastUsedAt: number | null;            // last time this memory was injected
  useCount: number;                     // how many times used in sessions
  sessionId: string | null;             // which session extracted this
  pinned: boolean;                      // user pinned = always loaded
  archived: boolean;                    // soft delete — hidden but not gone
}

/**
 * SEMANTIC MEMORY — Facts about the user
 * Examples:
 *   "User's name is Abdullah"
 *   "User works in a maintenance department"
 *   "User is building KLYPIX with Electron and React"
 *   "User prefers responses in Arabic and English"
 *   "User's company uses SuccessFactors"
 */

/**
 * EPISODIC MEMORY — What happened in past sessions
 * Examples:
 *   "2024-03-15: User asked me to analyze Q3 invoices. Found 12 overdue."
 *   "2024-03-18: User worked on KLYPIX agent mode. Debugged tool calling."
 *   "2024-03-20: User researched LangGraph vs Mastra for agent framework."
 */

/**
 * PROCEDURAL MEMORY — How the user likes things done
 * Examples:
 *   "When writing reports, user wants Arabic + English versions"
 *   "User prefers concise answers, not long explanations"
 *   "When analyzing files, always save output to shared folder"
 *   "User likes code in TypeScript, not JavaScript"
 */

// ---- USER SETTINGS ----

export interface MemorySettings {
  // Master toggle
  enabled: boolean;                     // global on/off

  // Granular controls
  rememberFacts: boolean;               // semantic memory
  rememberSessions: boolean;            // episodic memory
  rememberWorkflows: boolean;           // procedural memory

  // Extraction behavior
  autoExtract: boolean;                 // automatically extract after sessions
  askBeforeSaving: boolean;             // show extracted memories for approval
  extractionModel: 'flash' | 'claude';  // which model does extraction

  // Privacy
  neverRemember: string[];              // categories to never remember (e.g., "passwords", "financial")
  autoDeleteAfterDays: number | null;   // auto-delete memories older than N days (null = keep forever)

  // Injection
  maxMemoriesPerSession: number;        // max memories injected into prompt
  prioritizePinned: boolean;            // pinned memories always included
  prioritizeRecent: boolean;            // recent memories ranked higher
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  enabled: false,                        // OFF by default — user must opt in
  rememberFacts: true,
  rememberSessions: true,
  rememberWorkflows: true,
  autoExtract: true,
  askBeforeSaving: true,                 // show for approval by default
  extractionModel: 'flash',
  neverRemember: ['passwords', 'credit cards', 'social security', 'bank accounts'],
  autoDeleteAfterDays: null,
  maxMemoriesPerSession: 20,
  prioritizePinned: true,
  prioritizeRecent: true,
};

// ---- SESSION STATE ----

export interface MemorySessionState {
  sessionId: string;
  memoryPausedForSession: boolean;       // user paused memory for this session only
  loadedMemories: Memory[];              // memories loaded at session start
  pendingExtractions: PendingMemory[];   // memories extracted but not yet saved
}

export interface PendingMemory {
  content: string;
  type: MemoryType;
  category: string;
  confidence: number;
  approved: boolean | null;              // null = pending user decision
}

// ---- EXPORT FORMAT ----

export interface MemoryExport {
  version: string;
  exportedAt: string;
  memoryCount: number;
  memories: Memory[];
  settings: MemorySettings;
}
```

---

## 2. Memory Store — SQLite Local Database (`memoryStore.ts`)

```typescript
/**
 * MEMORY STORE
 *
 * Uses SQLite via better-sqlite3 (Electron-compatible).
 * Database file lives at: %APPDATA%/klypix/memory.db
 * Fully local. No network calls. No telemetry.
 *
 * The user can delete this single file to nuke all memory.
 */

import Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import path from 'path';

class MemoryStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(
      process.env.APPDATA || '',
      'klypix',
      'memory.db'
    );
    this.db = new Database(dbPath || defaultPath);
    this.initialize();
  }

  private initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic', 'procedural')),
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        confidence REAL NOT NULL DEFAULT 0.8,
        source TEXT NOT NULL DEFAULT 'extracted',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used_at INTEGER,
        use_count INTEGER NOT NULL DEFAULT 0,
        session_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_log (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        summary TEXT,
        memories_loaded INTEGER DEFAULT 0,
        memories_extracted INTEGER DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
    `);
  }

  // ---- CRUD ----

  addMemory(memory: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'useCount'>): Memory {
    const id = uuid();
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO memories (id, type, content, category, confidence, source, created_at, updated_at, last_used_at, use_count, session_id, pinned, archived)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 0)
    `).run(id, memory.type, memory.content, memory.category, memory.confidence, memory.source, now, now, memory.sessionId, memory.pinned ? 1 : 0);

    return {
      ...memory,
      id,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      useCount: 0,
      archived: false,
    };
  }

  updateMemory(id: string, updates: Partial<Pick<Memory, 'content' | 'category' | 'confidence' | 'pinned'>>) {
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];

    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
    if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
    if (updates.confidence !== undefined) { fields.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.pinned !== undefined) { fields.push('pinned = ?'); values.push(updates.pinned ? 1 : 0); }

    values.push(id);
    this.db.prepare(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  archiveMemory(id: string) {
    this.db.prepare('UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  deleteMemory(id: string) {
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  deleteAllMemories() {
    this.db.prepare('DELETE FROM memories').run();
  }

  restoreMemory(id: string) {
    this.db.prepare('UPDATE memories SET archived = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
  }

  // ---- RETRIEVAL ----

  getActiveMemories(options: {
    type?: MemoryType;
    category?: string;
    limit?: number;
    pinnedFirst?: boolean;
    recentFirst?: boolean;
  } = {}): Memory[] {
    let query = 'SELECT * FROM memories WHERE archived = 0';
    const params: any[] = [];

    if (options.type) {
      query += ' AND type = ?';
      params.push(options.type);
    }
    if (options.category) {
      query += ' AND category = ?';
      params.push(options.category);
    }

    // Ordering
    const orderClauses: string[] = [];
    if (options.pinnedFirst) orderClauses.push('pinned DESC');
    if (options.recentFirst) orderClauses.push('updated_at DESC');
    orderClauses.push('use_count DESC');  // frequently used memories rank higher

    query += ` ORDER BY ${orderClauses.join(', ')}`;

    if (options.limit) {
      query += ' LIMIT ?';
      params.push(options.limit);
    }

    return this.db.prepare(query).all(...params) as Memory[];
  }

  searchMemories(searchText: string, limit: number = 10): Memory[] {
    // Simple text search — for v1 this is sufficient
    // For v2, add vector embeddings for semantic search
    return this.db.prepare(`
      SELECT * FROM memories
      WHERE archived = 0 AND content LIKE ?
      ORDER BY pinned DESC, use_count DESC
      LIMIT ?
    `).all(`%${searchText}%`, limit) as Memory[];
  }

  markUsed(ids: string[]) {
    const now = Date.now();
    const stmt = this.db.prepare(
      'UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?'
    );
    for (const id of ids) {
      stmt.run(now, id);
    }
  }

  getMemoryCount(): { total: number; semantic: number; episodic: number; procedural: number; pinned: number } {
    const result = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN type = 'semantic' THEN 1 ELSE 0 END) as semantic,
        SUM(CASE WHEN type = 'episodic' THEN 1 ELSE 0 END) as episodic,
        SUM(CASE WHEN type = 'procedural' THEN 1 ELSE 0 END) as procedural,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned
      FROM memories WHERE archived = 0
    `).get() as any;
    return result;
  }

  // ---- MAINTENANCE ----

  cleanupOldMemories(maxAgeDays: number) {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    this.db.prepare(
      'DELETE FROM memories WHERE pinned = 0 AND created_at < ? AND use_count < 3'
    ).run(cutoff);
  }

  getDatabaseSize(): number {
    const stats = require('fs').statSync(this.db.name);
    return stats.size;
  }

  // ---- SETTINGS PERSISTENCE ----

  saveSettings(settings: MemorySettings) {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO memory_settings (key, value) VALUES (?, ?)'
    );
    for (const [key, value] of Object.entries(settings)) {
      stmt.run(key, JSON.stringify(value));
    }
  }

  loadSettings(): MemorySettings {
    const rows = this.db.prepare('SELECT key, value FROM memory_settings').all() as { key: string; value: string }[];
    if (rows.length === 0) return DEFAULT_MEMORY_SETTINGS;

    const loaded: Record<string, any> = {};
    for (const row of rows) {
      try { loaded[row.key] = JSON.parse(row.value); } catch { /* skip corrupt */ }
    }
    return { ...DEFAULT_MEMORY_SETTINGS, ...loaded };
  }
}
```

---

## 3. Memory Extractor — Learns from Sessions (`memoryExtractor.ts`)

```typescript
/**
 * MEMORY EXTRACTOR
 *
 * Runs AFTER a session ends (or in background during long sessions).
 * Uses Flash (cheap) to extract facts, preferences, and patterns.
 * Extracted memories go to pending queue for user approval (if setting enabled).
 */

const EXTRACTION_PROMPT = `
You are a memory extraction system. Analyze this conversation and extract distinct memories.

For each memory, output valid JSON array. Each item:
{
  "content": "The factual memory in third person (e.g., 'User prefers dark mode')",
  "type": "semantic" | "episodic" | "procedural",
  "category": "personal" | "work" | "preferences" | "technical" | "project" | "general",
  "confidence": 0.0 to 1.0
}

WHAT TO EXTRACT:

Semantic (facts):
- User's name, role, company, location
- Technologies they use
- Projects they're working on
- People they mention (colleagues, managers)
- Preferences (language, format, tone)

Episodic (what happened):
- Key task outcomes ("User analyzed Q3 data, found 12 anomalies")
- Decisions made ("User chose LangGraph over Mastra")
- Problems solved ("Fixed the PDF export bug in KLYPIX")

Procedural (how to do things):
- Workflow preferences ("When creating reports, always include charts")
- Format preferences ("User wants bullet points, not paragraphs")
- Tool preferences ("User prefers Python over JavaScript for data tasks")

WHAT TO NEVER EXTRACT:
- Passwords, API keys, tokens, secrets
- Credit card numbers, bank details
- Social security numbers, national IDs
- Medical information unless user explicitly discusses it
- Private relationship details
- Anything the user says to forget or not remember

RULES:
- Only extract facts you are confident about (>0.6)
- Don't invent or assume — only extract what's explicitly stated or clearly implied
- Keep each memory to ONE fact (not compound sentences)
- Deduplicate — don't extract the same fact twice
- If conversation is just small talk with no extractable info, return empty array []

Output ONLY the JSON array, nothing else.
`;

async function extractMemories(
  conversationHistory: Message[],
  existingMemories: Memory[],
  settings: MemorySettings
): Promise<PendingMemory[]> {

  if (!settings.autoExtract) return [];

  // Build extraction input
  const conversationText = conversationHistory
    .map(m => `${m.role}: ${m.content.substring(0, 1000)}`)
    .join('\n');

  // Include existing memories so we don't extract duplicates
  const existingFacts = existingMemories
    .map(m => m.content)
    .join('\n');

  const input = `
EXISTING MEMORIES (do not re-extract these):
${existingFacts || '(none)'}

CONVERSATION TO ANALYZE:
${conversationText}
  `.trim();

  // Use Flash for extraction (cheap, ~$0.001)
  const model = settings.extractionModel;
  const response = await callModel(model, EXTRACTION_PROMPT, input);

  // Parse response
  let extracted: PendingMemory[] = [];
  try {
    const parsed = JSON.parse(response.text.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed)) {
      extracted = parsed
        .filter(item =>
          item.content &&
          item.type &&
          item.confidence >= 0.6
        )
        .map(item => ({
          content: item.content,
          type: item.type as MemoryType,
          category: item.category || 'general',
          confidence: item.confidence,
          approved: settings.askBeforeSaving ? null : true,  // null = pending approval
        }));
    }
  } catch {
    // Extraction failed — silently skip
    return [];
  }

  // Filter out sensitive categories
  extracted = extracted.filter(m => {
    const lowerContent = m.content.toLowerCase();
    return !settings.neverRemember.some(sensitive =>
      lowerContent.includes(sensitive.toLowerCase())
    );
  });

  // Deduplicate against existing memories
  extracted = extracted.filter(pending => {
    return !existingMemories.some(existing =>
      stringSimilarity(existing.content, pending.content) > 0.8
    );
  });

  return extracted;
}

// Simple string similarity for dedup (Jaccard on words)
function stringSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = new Set([...wordsA].filter(w => wordsB.has(w)));
  const union = new Set([...wordsA, ...wordsB]);
  return intersection.size / union.size;
}
```

---

## 4. Memory Loader — Session Startup (`memoryLoader.ts`)

```typescript
/**
 * MEMORY LOADER
 *
 * At the start of each session, loads the most relevant memories
 * and prepares them for injection into the agent's system prompt.
 *
 * Relevance ranking:
 * 1. Pinned memories (always loaded)
 * 2. Recently used memories
 * 3. Frequently used memories
 * 4. Category match (if we can detect task category)
 */

async function loadSessionMemories(
  settings: MemorySettings,
  store: MemoryStore,
  initialMessage?: string
): Promise<Memory[]> {

  if (!settings.enabled) return [];

  const loaded: Memory[] = [];
  let remaining = settings.maxMemoriesPerSession;

  // 1. Always load pinned memories
  if (settings.prioritizePinned) {
    const pinned = store.getActiveMemories({ pinnedFirst: true, limit: remaining });
    const pinnedOnly = pinned.filter(m => m.pinned);
    loaded.push(...pinnedOnly);
    remaining -= pinnedOnly.length;
  }

  if (remaining <= 0) return loaded;

  // 2. Load by type based on settings
  const types: MemoryType[] = [];
  if (settings.rememberFacts) types.push('semantic');
  if (settings.rememberSessions) types.push('episodic');
  if (settings.rememberWorkflows) types.push('procedural');

  // 3. Distribute remaining slots across types
  const perType = Math.ceil(remaining / types.length);

  for (const type of types) {
    const memories = store.getActiveMemories({
      type,
      limit: perType,
      pinnedFirst: true,
      recentFirst: settings.prioritizeRecent,
    });

    // Don't add duplicates (might overlap with pinned)
    const newMemories = memories.filter(m =>
      !loaded.some(existing => existing.id === m.id)
    );
    loaded.push(...newMemories.slice(0, perType));
  }

  // 4. If initial message is available, boost relevant memories
  if (initialMessage) {
    const relevant = store.searchMemories(initialMessage, 5);
    const newRelevant = relevant.filter(m =>
      !loaded.some(existing => existing.id === m.id)
    );
    // Add relevant ones, removing least-used ones if over limit
    if (loaded.length + newRelevant.length > settings.maxMemoriesPerSession) {
      // Remove non-pinned, least used to make room
      loaded.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        return b.useCount - a.useCount;
      });
      loaded.splice(settings.maxMemoriesPerSession - newRelevant.length);
    }
    loaded.push(...newRelevant);
  }

  // Mark all loaded memories as used
  store.markUsed(loaded.map(m => m.id));

  return loaded.slice(0, settings.maxMemoriesPerSession);
}
```

---

## 5. Memory Injector — Prompt Integration (`memoryInjector.ts`)

```typescript
/**
 * MEMORY INJECTOR
 *
 * Converts loaded memories into a system prompt section.
 * Injected at the start of the agent's system prompt, BEFORE task instructions.
 *
 * Format designed for Flash compatibility — clear, structured, no ambiguity.
 */

function buildMemoryPromptSection(
  memories: Memory[],
  sessionState: MemorySessionState
): string {

  if (memories.length === 0) return '';
  if (sessionState.memoryPausedForSession) return '';

  const semantic = memories.filter(m => m.type === 'semantic');
  const episodic = memories.filter(m => m.type === 'episodic');
  const procedural = memories.filter(m => m.type === 'procedural');

  const sections: string[] = [];
  sections.push('## MEMORY CONTEXT (from previous sessions)');
  sections.push('Use this information naturally. Do not mention that you have a memory system unless the user asks.');
  sections.push('');

  if (semantic.length > 0) {
    sections.push('### About the User');
    for (const m of semantic) {
      sections.push(`- ${m.content}`);
    }
    sections.push('');
  }

  if (procedural.length > 0) {
    sections.push('### User Preferences & Workflows');
    for (const m of procedural) {
      sections.push(`- ${m.content}`);
    }
    sections.push('');
  }

  if (episodic.length > 0) {
    sections.push('### Recent Session History');
    for (const m of episodic) {
      sections.push(`- ${m.content}`);
    }
    sections.push('');
  }

  return sections.join('\n');
}
```

---

## 6. Memory Manager — User Control Hub (`memoryManager.ts`)

```typescript
/**
 * MEMORY MANAGER
 *
 * This is the central controller that handles all user-facing memory operations.
 * Every action the user can take in the UI goes through here.
 */

class MemoryManager {
  private store: MemoryStore;
  private settings: MemorySettings;

  constructor() {
    this.store = new MemoryStore();
    this.settings = this.store.loadSettings();
  }

  // ---- MASTER TOGGLE ----

  enableMemory() {
    this.settings.enabled = true;
    this.store.saveSettings(this.settings);
  }

  disableMemory() {
    this.settings.enabled = false;
    this.store.saveSettings(this.settings);
    // Note: disabling does NOT delete existing memories
    // User must explicitly delete if they want that
  }

  isEnabled(): boolean {
    return this.settings.enabled;
  }

  // ---- SESSION CONTROLS ----

  pauseForSession(sessionState: MemorySessionState) {
    sessionState.memoryPausedForSession = true;
    // No extraction will happen, no memories will be loaded
  }

  resumeForSession(sessionState: MemorySessionState) {
    sessionState.memoryPausedForSession = false;
  }

  // ---- MEMORY CRUD (user-facing) ----

  getAllMemories(): Memory[] {
    return this.store.getActiveMemories({});
  }

  getMemoriesByType(type: MemoryType): Memory[] {
    return this.store.getActiveMemories({ type });
  }

  addMemoryManually(content: string, type: MemoryType, category: string): Memory {
    return this.store.addMemory({
      type,
      content,
      category,
      confidence: 1.0,  // user-added = full confidence
      source: 'user_added',
      sessionId: null,
      pinned: false,
      archived: false,
    });
  }

  editMemory(id: string, newContent: string) {
    this.store.updateMemory(id, { content: newContent });
  }

  deleteMemory(id: string) {
    this.store.archiveMemory(id);  // soft delete
  }

  permanentlyDeleteMemory(id: string) {
    this.store.deleteMemory(id);  // hard delete
  }

  pinMemory(id: string) {
    this.store.updateMemory(id, { pinned: true });
  }

  unpinMemory(id: string) {
    this.store.updateMemory(id, { pinned: false });
  }

  // ---- BULK OPERATIONS ----

  deleteAllMemories() {
    this.store.deleteAllMemories();
  }

  deleteMemoriesByCategory(category: string) {
    const memories = this.store.getActiveMemories({ category });
    for (const m of memories) {
      this.store.deleteMemory(m.id);
    }
  }

  deleteMemoriesByType(type: MemoryType) {
    const memories = this.store.getActiveMemories({ type });
    for (const m of memories) {
      this.store.deleteMemory(m.id);
    }
  }

  // ---- EXTRACTION APPROVAL ----

  approvePendingMemory(pending: PendingMemory, sessionId: string): Memory {
    return this.store.addMemory({
      type: pending.type,
      content: pending.content,
      category: pending.category,
      confidence: pending.confidence,
      source: 'extracted',
      sessionId,
      pinned: false,
      archived: false,
    });
  }

  rejectPendingMemory(pending: PendingMemory) {
    // Just don't save it — it disappears
    // Could optionally save to a "rejected" list to avoid re-extracting
  }

  approveAllPending(pendingList: PendingMemory[], sessionId: string): Memory[] {
    return pendingList.map(p => this.approvePendingMemory(p, sessionId));
  }

  rejectAllPending() {
    // No action needed
  }

  // ---- SETTINGS ----

  getSettings(): MemorySettings {
    return { ...this.settings };
  }

  updateSettings(updates: Partial<MemorySettings>) {
    this.settings = { ...this.settings, ...updates };
    this.store.saveSettings(this.settings);
  }

  addNeverRemember(category: string) {
    if (!this.settings.neverRemember.includes(category)) {
      this.settings.neverRemember.push(category);
      this.store.saveSettings(this.settings);
    }
  }

  removeNeverRemember(category: string) {
    this.settings.neverRemember = this.settings.neverRemember.filter(c => c !== category);
    this.store.saveSettings(this.settings);
  }

  // ---- STATS ----

  getStats(): {
    totalMemories: number;
    byType: { semantic: number; episodic: number; procedural: number };
    pinned: number;
    databaseSizeKB: number;
  } {
    const counts = this.store.getMemoryCount();
    return {
      totalMemories: counts.total,
      byType: { semantic: counts.semantic, episodic: counts.episodic, procedural: counts.procedural },
      pinned: counts.pinned,
      databaseSizeKB: Math.round(this.store.getDatabaseSize() / 1024),
    };
  }
}
```

---

## 7. Memory Exporter — Export & Import (`memoryExporter.ts`)

```typescript
/**
 * Export/import memory data.
 * User can:
 * - Export all memories as JSON file (backup or transfer)
 * - Import memories from a JSON file
 * - Export as readable text (for their own reference)
 */

function exportMemories(store: MemoryStore, settings: MemorySettings): MemoryExport {
  const memories = store.getActiveMemories({});
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    memoryCount: memories.length,
    memories,
    settings,
  };
}

function importMemories(
  store: MemoryStore,
  data: MemoryExport,
  mode: 'merge' | 'replace'
): { imported: number; skipped: number } {

  if (mode === 'replace') {
    store.deleteAllMemories();
  }

  let imported = 0;
  let skipped = 0;

  const existing = store.getActiveMemories({});

  for (const memory of data.memories) {
    // Check for duplicates
    const isDuplicate = existing.some(e =>
      stringSimilarity(e.content, memory.content) > 0.8
    );

    if (isDuplicate && mode === 'merge') {
      skipped++;
      continue;
    }

    store.addMemory({
      type: memory.type,
      content: memory.content,
      category: memory.category,
      confidence: memory.confidence,
      source: memory.source,
      sessionId: memory.sessionId,
      pinned: memory.pinned,
      archived: false,
    });
    imported++;
  }

  return { imported, skipped };
}

function exportAsReadableText(store: MemoryStore): string {
  const memories = store.getActiveMemories({});
  const lines: string[] = [
    `KLYPIX Memory Export — ${new Date().toLocaleDateString()}`,
    `Total: ${memories.length} memories`,
    '',
    '═══ FACTS ═══',
    ...memories.filter(m => m.type === 'semantic').map(m => `• ${m.content}${m.pinned ? ' 📌' : ''}`),
    '',
    '═══ SESSION HISTORY ═══',
    ...memories.filter(m => m.type === 'episodic').map(m => `• ${m.content}`),
    '',
    '═══ PREFERENCES & WORKFLOWS ═══',
    ...memories.filter(m => m.type === 'procedural').map(m => `• ${m.content}${m.pinned ? ' 📌' : ''}`),
  ];
  return lines.join('\n');
}
```

---

## 8. First-Time Consent Flow

When the user first encounters memory, show this dialog:

```typescript
/**
 * CONSENT DIALOG
 *
 * Shown once when user first enables memory or when KLYPIX first launches
 * with memory capability. Must be explicit opt-in.
 *
 * NEVER enable memory without user consent.
 */

// Content for the consent dialog component:

const CONSENT_DIALOG = {
  title: 'Enable Agent Memory?',
  description: `
    KLYPIX can remember information from your conversations to give you
    better, more personalized help over time.
  `,
  whatWeRemember: [
    'Your name and preferences',
    'Projects you\'re working on',
    'How you like things done',
    'Key outcomes from past sessions',
  ],
  whatWeNeverRemember: [
    'Passwords or API keys',
    'Financial account details',
    'Anything you tell it to forget',
  ],
  privacyPoints: [
    'All memory is stored locally on YOUR machine only',
    'No data is sent to any cloud or third party',
    'You can view, edit, or delete any memory at any time',
    'You can export or nuke all memory with one click',
    'You can pause memory for any session',
    'Memory is OFF by default — you\'re choosing to enable it',
  ],
  actions: {
    enable: 'Enable Memory',
    skip: 'Not Now',         // can enable later in settings
    learnMore: 'Learn More', // opens detailed explanation
  },
};
```

---

## 9. UI Components Specification

### Memory Toggle (Header Bar)

Small toggle in KLYPIX header, always visible:

```
┌──────────────────────────────────────────────┐
│  KLYPIX           🧠 Memory ON  [toggle]     │
└──────────────────────────────────────────────┘
```

States:
- `🧠 Memory ON` — green, memories active
- `🧠 Memory OFF` — gray, no memory
- `🧠 Memory Paused` — yellow, paused for this session only
- Click toggle → turns on/off
- Long press or right-click → "Pause for this session"

### Memory Panel (Sidebar or Settings)

```
┌─────────────────────────────────────┐
│  🧠 Agent Memory                    │
│                                     │
│  Status: ON (47 memories)           │
│  Storage: 24 KB                     │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ 📋 Facts (23)               │    │
│  │ 📅 Session History (15)     │    │
│  │ ⚙️ Workflows (9)            │    │
│  │ 📌 Pinned (5)               │    │
│  └─────────────────────────────┘    │
│                                     │
│  ┌─ Recent Memories ────────────┐   │
│  │ • User's name is Abdullah  📌│   │
│  │ • Building KLYPIX with      │   │
│  │   Electron and React      📌│   │
│  │ • Prefers concise answers    │   │
│  │ • Last session: worked on    │   │
│  │   agent mode routing         │   │
│  └──────────────────────────────┘   │
│                                     │
│  [+ Add Memory]  [View All]         │
│  [Export]  [Settings]               │
│                                     │
│  ┌─ Danger Zone ────────────────┐   │
│  │ [🗑️ Delete All Memories]     │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

### Memory Approval Dialog (After Session)

When `askBeforeSaving` is enabled, show this after session ends:

```
┌──────────────────────────────────────────┐
│  🧠 New memories from this session       │
│                                          │
│  KLYPIX learned these things:            │
│                                          │
│  ☑️ User is evaluating LangGraph         │
│     for agent backend                    │
│                                          │
│  ☑️ User prefers TypeScript over Python  │
│                                          │
│  ☑️ KLYPIX agent mode costs ~$1/session  │
│     with Claude API                      │
│                                          │
│  ☐ User might switch to hybrid model     │
│    routing (uncertain, low confidence)   │
│                                          │
│  [Save Selected]  [Save All]  [Discard]  │
└──────────────────────────────────────────┘
```

### Memory View/Edit Dialog

```
┌──────────────────────────────────────────┐
│  Edit Memory                             │
│                                          │
│  Content:                                │
│  ┌────────────────────────────────────┐  │
│  │ User works in maintenance          │  │
│  │ department                         │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Type: [Fact ▼]                          │
│  Category: [Work ▼]                      │
│  📌 Pinned: [  toggle  ]                │
│                                          │
│  Created: March 15, 2026                 │
│  Used: 12 times                          │
│  Last used: 2 hours ago                  │
│                                          │
│  [Save]  [Delete]  [Cancel]              │
└──────────────────────────────────────────┘
```

### Memory Settings Panel

```
┌──────────────────────────────────────────┐
│  🧠 Memory Settings                      │
│                                          │
│  Master:                                 │
│  [✅] Enable agent memory                │
│                                          │
│  What to remember:                       │
│  [✅] Facts about me                     │
│  [✅] Session history                    │
│  [✅] My preferences & workflows         │
│                                          │
│  Behavior:                               │
│  [✅] Auto-extract after sessions        │
│  [✅] Ask me before saving new memories  │
│  [ ] Use Claude for extraction           │
│      (better quality, costs more)        │
│                                          │
│  Privacy:                                │
│  Never remember:                         │
│  [passwords] [credit cards] [bank] [+]   │
│                                          │
│  Auto-delete memories after:             │
│  [Never ▼]                               │
│                                          │
│  Data:                                   │
│  [Export as JSON]  [Export as Text]       │
│  [Import from File]                      │
│                                          │
│  Max memories per session: [20]          │
│  [✅] Prioritize pinned memories         │
│  [✅] Prioritize recent memories         │
│                                          │
└──────────────────────────────────────────┘
```

---

## 10. Integration Points

### With Hybrid Router

```typescript
// In hybridRouter.ts — at the start of processUserTurn:

const memoryManager = new MemoryManager();
const settings = memoryManager.getSettings();

// Load memories if enabled
let memoryContext = '';
if (settings.enabled && !sessionState.memoryPausedForSession) {
  const memories = await loadSessionMemories(settings, memoryStore, userMessage);
  sessionState.loadedMemories = memories;
  memoryContext = buildMemoryPromptSection(memories, sessionState);
}

// Prepend memory context to system prompt
const fullSystemPrompt = memoryContext + baseSystemPrompt;
```

### With Flash Hardening

```typescript
// In flashEngine.ts — add memory to the system prompt builder:

private buildSystemPrompt(taskCategory: string, memoryContext: string): string {
  const parts = [
    memoryContext,  // Memory goes FIRST so it provides context for everything
    FLASH_BASE_SYSTEM_PROMPT,
    NEGATIVE_EXAMPLES,
    // ... rest of prompt
  ];
  return parts.filter(Boolean).join('\n\n');
}
```

### Session End Hook

```typescript
// When a session ends (user closes chat, navigates away, or timeout):

async function onSessionEnd(
  conversationHistory: Message[],
  sessionState: MemorySessionState
) {
  const settings = memoryManager.getSettings();

  if (!settings.enabled || sessionState.memoryPausedForSession) return;

  // Extract memories
  const pending = await extractMemories(
    conversationHistory,
    sessionState.loadedMemories,
    settings
  );

  if (pending.length === 0) return;

  if (settings.askBeforeSaving) {
    // Show approval dialog in UI
    sessionState.pendingExtractions = pending;
    showMemoryApprovalDialog(pending);
  } else {
    // Auto-save all
    for (const p of pending) {
      memoryManager.approvePendingMemory(p, sessionState.sessionId);
    }
  }
}
```

### Electron IPC Handlers

```typescript
// In electron/main.ts:

ipcMain.handle('memory:getSettings', () => memoryManager.getSettings());
ipcMain.handle('memory:updateSettings', (_, updates) => memoryManager.updateSettings(updates));
ipcMain.handle('memory:getAll', () => memoryManager.getAllMemories());
ipcMain.handle('memory:add', (_, content, type, category) => memoryManager.addMemoryManually(content, type, category));
ipcMain.handle('memory:edit', (_, id, content) => memoryManager.editMemory(id, content));
ipcMain.handle('memory:delete', (_, id) => memoryManager.deleteMemory(id));
ipcMain.handle('memory:pin', (_, id) => memoryManager.pinMemory(id));
ipcMain.handle('memory:unpin', (_, id) => memoryManager.unpinMemory(id));
ipcMain.handle('memory:deleteAll', () => memoryManager.deleteAllMemories());
ipcMain.handle('memory:export', () => exportMemories(memoryStore, memoryManager.getSettings()));
ipcMain.handle('memory:import', (_, data, mode) => importMemories(memoryStore, data, mode));
ipcMain.handle('memory:exportText', () => exportAsReadableText(memoryStore));
ipcMain.handle('memory:getStats', () => memoryManager.getStats());
ipcMain.handle('memory:enable', () => memoryManager.enableMemory());
ipcMain.handle('memory:disable', () => memoryManager.disableMemory());
ipcMain.handle('memory:pauseSession', () => memoryManager.pauseForSession(currentSessionState));
ipcMain.handle('memory:resumeSession', () => memoryManager.resumeForSession(currentSessionState));
ipcMain.handle('memory:approvePending', (_, indices) => { /* approve selected */ });
ipcMain.handle('memory:rejectPending', () => memoryManager.rejectAllPending());
```

---

## 11. Testing & Validation

| Test | Expected |
|------|----------|
| First launch, memory off by default | No consent dialog, no extraction, no injection |
| User enables memory | Consent dialog shown, settings saved |
| Session with facts mentioned | Extraction finds facts, approval dialog shown |
| User approves some, rejects others | Only approved memories saved |
| Next session | Approved memories loaded and injected into prompt |
| User pauses memory for session | No loading, no extraction for that session |
| User edits a memory | Updated content, updated timestamp |
| User deletes a memory | Soft-deleted (archived), not shown |
| User nukes all memories | Database cleared, confirmed |
| User exports as JSON | Valid JSON file with all memories + settings |
| User imports from JSON (merge) | New memories added, duplicates skipped |
| User adds memory manually | Saved with confidence 1.0, source "user_added" |
| Sensitive content in conversation | Filtered out by neverRemember list |
| 50+ memories in DB | Only maxMemoriesPerSession loaded, prioritized correctly |
| Memory toggle OFF | No loading, no extraction, existing memories preserved |

---

## 12. Summary for Claude Code

When executing this spec:

1. Create file structure under `src/services/memory/` and `src/components/memory/`
2. Implement MemoryStore (SQLite) first — this is the foundation
3. Add MemoryManager with all CRUD operations
4. Build extraction pipeline (extractor + loader + injector)
5. Wire into Hybrid Router and Flash Engine system prompts
6. Add session end hook for extraction
7. Build Electron IPC handlers
8. Build UI components in this order:
   - MemoryConsentDialog (first-time opt-in)
   - MemoryToggle (header bar)
   - MemoryPanel (sidebar view)
   - MemorySettings (preferences)
   - MemoryList + MemoryEditor (view/edit/delete)
   - MemoryApprovalDialog (post-session)
   - MemoryExportDialog (import/export)
9. Add `better-sqlite3` as dependency (`npm install better-sqlite3 @types/better-sqlite3`)

Priority order if time is limited:
1. MemoryStore + MemoryManager (storage + CRUD)
2. MemoryLoader + MemoryInjector (memories get into prompts)
3. MemoryToggle + MemorySettings UI (user can control it)
4. MemoryExtractor (auto-learning from sessions)
5. MemoryApprovalDialog (user reviews extractions)
6. MemoryList + MemoryEditor (full management)
7. MemoryExporter (backup/transfer)

**Critical rule: Memory is OFF by default. User must explicitly opt in. Never save anything without consent.**
