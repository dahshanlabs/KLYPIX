// MemoryStore — SQLite-backed persistent storage via sql.js.
// Database blob is saved to IndexedDB (survives reloads, faster than localStorage for binary).
// Local-first: no network, no telemetry. User can nuke via deleteAllMemories().

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';
import { v4 as uuidv4 } from 'uuid';
import type { Memory, MemorySettings, MemoryStats, MemoryType } from './types';
import { DEFAULT_MEMORY_SETTINGS } from './types';

const IDB_NAME = 'klypix-memory';
const IDB_STORE = 'db';
const IDB_KEY = 'main';

// sql.js loaded asynchronously — cache the instance
let sqlJsInstance: SqlJsStatic | null = null;

async function loadSqlJs(): Promise<SqlJsStatic> {
  if (sqlJsInstance) return sqlJsInstance;
  sqlJsInstance = await initSqlJs({
    // sql.js ships its .wasm file; let it resolve from node_modules via Vite
    locateFile: (file) => `/node_modules/sql.js/dist/${file}`,
  });
  return sqlJsInstance;
}

// ── IndexedDB helpers for persisting the SQLite blob ──────────────────────────

function openIdb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadBlob(): Promise<Uint8Array | null> {
  try {
    const db = await openIdb();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result ? new Uint8Array(req.result) : null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

async function saveBlob(blob: Uint8Array): Promise<void> {
  try {
    const db = await openIdb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(blob, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (e) { console.warn('[MemoryStore] Failed to persist DB blob:', e); }
}

// ── Row → Memory mapping ──────────────────────────────────────────────────────

function rowToMemory(r: any): Memory {
  return {
    id: r.id,
    type: r.type,
    content: r.content,
    category: r.category,
    confidence: r.confidence,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    sessionId: r.session_id,
    pinned: !!r.pinned,
    archived: !!r.archived,
  };
}

// ── MemoryStore ───────────────────────────────────────────────────────────────

export class MemoryStore {
  private db: Database | null = null;
  private saveDebounceTimer: any = null;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.initialize();
  }

  private async initialize(): Promise<void> {
    const SQL = await loadSqlJs();
    const existing = await loadBlob();
    this.db = existing ? new SQL.Database(existing) : new SQL.Database();

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

      CREATE TABLE IF NOT EXISTS pending_memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('semantic', 'episodic', 'procedural')),
        content TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        confidence REAL NOT NULL DEFAULT 0.8,
        created_at INTEGER NOT NULL,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
      CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(pinned);
      CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_memories(created_at);
    `);

    if (!existing) this.persist();
  }

  private persist(): void {
    if (!this.db) return;
    // Debounce writes — rapid updates shouldn't each trigger an IDB write
    clearTimeout(this.saveDebounceTimer);
    this.saveDebounceTimer = setTimeout(() => {
      if (this.db) saveBlob(this.db.export());
    }, 500);
  }

  async waitReady(): Promise<void> { await this.ready; }

  // ── CRUD ──

  async addMemory(m: Omit<Memory, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'useCount' | 'archived'>): Promise<Memory> {
    await this.ready;
    const id = uuidv4();
    const now = Date.now();
    this.db!.run(
      `INSERT INTO memories (id, type, content, category, confidence, source, created_at, updated_at, last_used_at, use_count, session_id, pinned, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, 0)`,
      [id, m.type, m.content, m.category, m.confidence, m.source, now, now, m.sessionId, m.pinned ? 1 : 0],
    );
    this.persist();
    return { ...m, id, createdAt: now, updatedAt: now, lastUsedAt: null, useCount: 0, archived: false };
  }

  async updateMemory(id: string, updates: Partial<Pick<Memory, 'content' | 'category' | 'confidence' | 'pinned'>>): Promise<void> {
    await this.ready;
    const fields: string[] = ['updated_at = ?'];
    const values: any[] = [Date.now()];
    if (updates.content !== undefined) { fields.push('content = ?'); values.push(updates.content); }
    if (updates.category !== undefined) { fields.push('category = ?'); values.push(updates.category); }
    if (updates.confidence !== undefined) { fields.push('confidence = ?'); values.push(updates.confidence); }
    if (updates.pinned !== undefined) { fields.push('pinned = ?'); values.push(updates.pinned ? 1 : 0); }
    values.push(id);
    this.db!.run(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`, values);
    this.persist();
  }

  async archiveMemory(id: string): Promise<void> {
    await this.ready;
    this.db!.run('UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?', [Date.now(), id]);
    this.persist();
  }

  async deleteMemory(id: string): Promise<void> {
    await this.ready;
    this.db!.run('DELETE FROM memories WHERE id = ?', [id]);
    this.persist();
  }

  async deleteAllMemories(): Promise<void> {
    await this.ready;
    this.db!.run('DELETE FROM memories');
    this.persist();
  }

  // ── Retrieval ──

  async getActiveMemories(options: {
    type?: MemoryType;
    category?: string;
    limit?: number;
    pinnedFirst?: boolean;
    recentFirst?: boolean;
  } = {}): Promise<Memory[]> {
    await this.ready;
    let query = 'SELECT * FROM memories WHERE archived = 0';
    const params: any[] = [];
    if (options.type) { query += ' AND type = ?'; params.push(options.type); }
    if (options.category) { query += ' AND category = ?'; params.push(options.category); }
    const orderClauses: string[] = [];
    if (options.pinnedFirst) orderClauses.push('pinned DESC');
    if (options.recentFirst) orderClauses.push('updated_at DESC');
    orderClauses.push('use_count DESC');
    query += ` ORDER BY ${orderClauses.join(', ')}`;
    if (options.limit) { query += ' LIMIT ?'; params.push(options.limit); }

    const result = this.db!.exec(query, params);
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => {
      const obj: any = {};
      result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
      return rowToMemory(obj);
    });
  }

  async searchMemories(text: string, limit = 10): Promise<Memory[]> {
    await this.ready;
    const result = this.db!.exec(
      `SELECT * FROM memories WHERE archived = 0 AND LOWER(content) LIKE ? ORDER BY pinned DESC, use_count DESC LIMIT ?`,
      [`%${text.toLowerCase()}%`, limit],
    );
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => {
      const obj: any = {};
      result[0].columns.forEach((col, i) => { obj[col] = row[i]; });
      return rowToMemory(obj);
    });
  }

  async markUsed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ready;
    const now = Date.now();
    const stmt = this.db!.prepare('UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?');
    for (const id of ids) stmt.run([now, id]);
    stmt.free();
    this.persist();
  }

  async getStats(): Promise<MemoryStats> {
    await this.ready;
    const result = this.db!.exec(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN type = 'semantic' THEN 1 ELSE 0 END) as semantic,
        SUM(CASE WHEN type = 'episodic' THEN 1 ELSE 0 END) as episodic,
        SUM(CASE WHEN type = 'procedural' THEN 1 ELSE 0 END) as procedural,
        SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END) as pinned
      FROM memories WHERE archived = 0
    `);
    if (result.length === 0 || result[0].values.length === 0) {
      return { total: 0, semantic: 0, episodic: 0, procedural: 0, pinned: 0 };
    }
    const [total, semantic, episodic, procedural, pinned] = result[0].values[0];
    return {
      total: Number(total) || 0,
      semantic: Number(semantic) || 0,
      episodic: Number(episodic) || 0,
      procedural: Number(procedural) || 0,
      pinned: Number(pinned) || 0,
    };
  }

  // ── Pending memories (extracted but not yet approved) ──

  async addPendingMemories(items: Array<{ type: MemoryType; content: string; category: string; confidence: number; sessionId?: string | null }>): Promise<void> {
    if (items.length === 0) return;
    await this.ready;
    const now = Date.now();
    const stmt = this.db!.prepare(
      'INSERT INTO pending_memories (id, type, content, category, confidence, created_at, session_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const p of items) {
      stmt.run([uuidv4(), p.type, p.content, p.category, p.confidence, now, p.sessionId || null]);
    }
    stmt.free();
    this.persist();
  }

  async getPendingMemories(): Promise<Array<{ id: string; type: MemoryType; content: string; category: string; confidence: number; createdAt: number }>> {
    await this.ready;
    const result = this.db!.exec('SELECT id, type, content, category, confidence, created_at FROM pending_memories ORDER BY created_at DESC');
    if (result.length === 0) return [];
    return result[0].values.map((row: any[]) => ({
      id: row[0] as string,
      type: row[1] as MemoryType,
      content: row[2] as string,
      category: row[3] as string,
      confidence: row[4] as number,
      createdAt: row[5] as number,
    }));
  }

  async approvePendingMemory(pendingId: string): Promise<Memory | null> {
    await this.ready;
    const result = this.db!.exec(
      'SELECT id, type, content, category, confidence, session_id FROM pending_memories WHERE id = ?',
      [pendingId],
    );
    if (result.length === 0 || result[0].values.length === 0) return null;
    const row = result[0].values[0];
    const saved = await this.addMemory({
      type: row[1] as MemoryType,
      content: row[2] as string,
      category: row[3] as string,
      confidence: row[4] as number,
      source: 'extracted',
      sessionId: row[5] as string | null,
      pinned: false,
    });
    // Remove from pending after promoting
    this.db!.run('DELETE FROM pending_memories WHERE id = ?', [pendingId]);
    this.persist();
    return saved;
  }

  async discardPendingMemory(pendingId: string): Promise<void> {
    await this.ready;
    this.db!.run('DELETE FROM pending_memories WHERE id = ?', [pendingId]);
    this.persist();
  }

  async clearPendingMemories(): Promise<void> {
    await this.ready;
    this.db!.run('DELETE FROM pending_memories');
    this.persist();
  }

  async getPendingCount(): Promise<number> {
    await this.ready;
    const result = this.db!.exec('SELECT COUNT(*) FROM pending_memories');
    if (result.length === 0 || result[0].values.length === 0) return 0;
    return Number(result[0].values[0][0]) || 0;
  }

  // ── Settings ──

  async saveSettings(settings: MemorySettings): Promise<void> {
    await this.ready;
    const stmt = this.db!.prepare('INSERT OR REPLACE INTO memory_settings (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(settings)) {
      stmt.run([key, JSON.stringify(value)]);
    }
    stmt.free();
    this.persist();
  }

  async loadSettings(): Promise<MemorySettings> {
    await this.ready;
    const result = this.db!.exec('SELECT key, value FROM memory_settings');
    if (result.length === 0) return DEFAULT_MEMORY_SETTINGS;
    const loaded: Record<string, any> = {};
    for (const row of result[0].values) {
      try { loaded[row[0] as string] = JSON.parse(row[1] as string); } catch {}
    }
    return { ...DEFAULT_MEMORY_SETTINGS, ...loaded };
  }
}

// ── Singleton ────────────────────────────────────────────────────────────────

let instance: MemoryStore | null = null;

export function getMemoryStore(): MemoryStore {
  if (!instance) instance = new MemoryStore();
  return instance;
}
