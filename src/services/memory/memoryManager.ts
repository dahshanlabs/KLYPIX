// MemoryManager — high-level API for the rest of the app.
// Orchestrates: settings → retrieval → NL command parsing → injection.
// Memory is OFF by default; this module is a no-op when disabled.

import { getMemoryStore } from './memoryStore';
import type { Memory, MemorySettings, MemoryType, PendingMemory } from './types';

// Fast-path flag — lets callers skip sql.js init entirely when memory has never been on.
// Memory is OFF by default. Users who never enable it should pay zero cost.
const ENABLED_FLAG_KEY = 'klypix:memoryEnabled';

/**
 * Synchronous quick check — returns true if memory has EVER been turned on.
 * Used by prompt builders to avoid loading sql.js for users who don't use memory.
 * When false, callers should skip memory injection entirely.
 */
export function isMemoryEnabled(): boolean {
  try { return localStorage.getItem(ENABLED_FLAG_KEY) === '1'; } catch { return false; }
}

// ── Relevance scoring ─────────────────────────────────────────────────────────
// Simple TF-ish scoring: count query terms that appear in memory content.
// Pinned memories always get a boost; recent/frequently-used memories rank higher.

function scoreMemory(memory: Memory, queryTerms: string[]): number {
  const content = memory.content.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    if (term.length < 3) continue;
    if (content.includes(term)) score += 1;
  }
  // Confidence weighting
  score *= memory.confidence;
  // Pinned boost
  if (memory.pinned) score += 2;
  // Recency boost — memories used in last 7 days
  if (memory.lastUsedAt && Date.now() - memory.lastUsedAt < 7 * 24 * 60 * 60 * 1000) score += 0.5;
  return score;
}

function extractQueryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3);
}

// ── MemoryManager ────────────────────────────────────────────────────────────

export class MemoryManager {
  private settings: MemorySettings | null = null;

  async getSettings(): Promise<MemorySettings> {
    if (!this.settings) this.settings = await getMemoryStore().loadSettings();
    return this.settings;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const current = await this.getSettings();
    const next = { ...current, enabled };
    await getMemoryStore().saveSettings(next);
    this.settings = next;
    try { localStorage.setItem(ENABLED_FLAG_KEY, enabled ? '1' : '0'); } catch {}
  }

  async updateSettings(updates: Partial<MemorySettings>): Promise<void> {
    const current = await this.getSettings();
    const next = { ...current, ...updates };
    await getMemoryStore().saveSettings(next);
    this.settings = next;
    if (updates.enabled !== undefined) {
      try { localStorage.setItem(ENABLED_FLAG_KEY, updates.enabled ? '1' : '0'); } catch {}
    }
  }

  /**
   * Get relevant memories for injection into a system prompt.
   * Returns empty array if memory is disabled.
   */
  async getRelevantMemories(userQuery: string): Promise<Memory[]> {
    const settings = await this.getSettings();
    if (!settings.enabled) return [];

    const store = getMemoryStore();
    const all = await store.getActiveMemories({
      pinnedFirst: settings.prioritizePinned,
      recentFirst: settings.prioritizeRecent,
      limit: 100, // fetch candidates, then rank
    });

    if (all.length === 0) return [];

    const terms = extractQueryTerms(userQuery);
    const scored = all
      .map(m => ({ m, score: scoreMemory(m, terms) }))
      .sort((a, b) => b.score - a.score);

    // Always include pinned memories even if score is 0
    const pinned = scored.filter(s => s.m.pinned).map(s => s.m);
    const nonPinnedByScore = scored.filter(s => !s.m.pinned && s.score > 0).map(s => s.m);

    const selected = [...pinned, ...nonPinnedByScore].slice(0, settings.maxMemoriesPerSession);

    // Mark as used
    if (selected.length > 0) {
      await store.markUsed(selected.map(m => m.id));
    }

    return selected;
  }

  /**
   * Format memories for system prompt injection.
   * Returns empty string if no memories or disabled.
   */
  formatForPrompt(memories: Memory[]): string {
    if (memories.length === 0) return '';
    const byType: Record<string, string[]> = { semantic: [], episodic: [], procedural: [] };
    for (const m of memories) {
      byType[m.type]?.push(`- ${m.content}`);
    }
    const sections: string[] = [];
    if (byType.semantic.length > 0) sections.push('About the user:\n' + byType.semantic.join('\n'));
    if (byType.procedural.length > 0) sections.push('User preferences:\n' + byType.procedural.join('\n'));
    if (byType.episodic.length > 0) sections.push('Recent context:\n' + byType.episodic.slice(0, 5).join('\n'));
    return sections.join('\n\n');
  }

  /**
   * Parse natural-language memory commands from user input.
   * Returns a result describing what command was detected, or null if none.
   *
   * Supported patterns:
   *   "remember that I [fact]"    → add semantic memory
   *   "remember [fact]"           → add semantic memory
   *   "forget about [topic]"      → search + archive
   *   "forget that I [fact]"      → search + archive
   *   "what do you remember about [me/X]" → query
   */
  parseCommand(message: string): {
    kind: 'remember' | 'forget' | 'query' | null;
    content?: string;
  } {
    const trimmed = message.trim();
    const lower = trimmed.toLowerCase();

    // Remember patterns
    const rememberMatch = trimmed.match(/^(?:please\s+)?remember(?:\s+that)?\s+(.+)$/i);
    if (rememberMatch) {
      return { kind: 'remember', content: rememberMatch[1].trim() };
    }

    // Forget patterns
    const forgetMatch = trimmed.match(/^(?:please\s+)?forget(?:\s+(?:about|that))?\s+(.+)$/i);
    if (forgetMatch) {
      return { kind: 'forget', content: forgetMatch[1].trim() };
    }

    // Query patterns
    if (/^what do you (?:remember|know) about/i.test(lower)) {
      const q = lower.replace(/^what do you (?:remember|know) about\s*/i, '').replace(/\??$/, '').trim();
      return { kind: 'query', content: q };
    }

    return { kind: null };
  }

  /**
   * Execute a parsed NL command. Returns a user-facing response string.
   */
  async executeCommand(cmd: { kind: 'remember' | 'forget' | 'query'; content?: string }): Promise<string> {
    const settings = await this.getSettings();
    if (!settings.enabled) {
      return 'Memory is turned off. Enable it in settings to use remember/forget commands.';
    }
    if (!cmd.content) return '';

    const store = getMemoryStore();

    if (cmd.kind === 'remember') {
      // Check against sensitive category list
      const lower = cmd.content.toLowerCase();
      if (settings.neverRemember.some(s => lower.includes(s.toLowerCase()))) {
        return `I won't remember that — it matches your privacy filter (${settings.neverRemember.join(', ')}).`;
      }
      // Classify type heuristically: starts with "I" or about preferences → semantic
      const type: MemoryType = /^(i |my |when .* i )/i.test(cmd.content) ? 'semantic'
        : /prefer|always|never|usually/i.test(cmd.content) ? 'procedural'
        : 'semantic';
      await store.addMemory({
        type, content: cmd.content, category: 'user_added', confidence: 1.0,
        source: 'user_added', sessionId: null, pinned: false,
      });
      return `Got it — I'll remember that.`;
    }

    if (cmd.kind === 'forget') {
      const matches = await store.searchMemories(cmd.content, 10);
      if (matches.length === 0) return `I don't have any memories matching "${cmd.content}".`;
      for (const m of matches) await store.archiveMemory(m.id);
      return `Forgotten ${matches.length} ${matches.length === 1 ? 'memory' : 'memories'} matching "${cmd.content}".`;
    }

    if (cmd.kind === 'query') {
      const matches = cmd.content ? await store.searchMemories(cmd.content, 10) : await store.getActiveMemories({ limit: 10 });
      if (matches.length === 0) return `I don't have any memories about that.`;
      return matches.map(m => `• ${m.content}`).join('\n');
    }

    return '';
  }

  /**
   * Save a pending extraction as a real memory (after user approval).
   */
  async approvePending(pending: PendingMemory, sessionId: string | null = null): Promise<Memory> {
    return getMemoryStore().addMemory({
      type: pending.type,
      content: pending.content,
      category: pending.category,
      confidence: pending.confidence,
      source: 'extracted',
      sessionId,
      pinned: false,
    });
  }

  /**
   * End-of-session extraction. Called after a chat/agent session completes.
   * - Skips entirely if memory disabled or autoExtract off
   * - Runs Flash extractor with last ~30 messages + existing memories for dedup
   * - If askBeforeSaving is OFF: saves directly as memories
   * - If askBeforeSaving is ON: stores in pending_memories for user approval
   *
   * Runs in background; never blocks the UI. Errors are swallowed with a warn log.
   */
  async runSessionEndExtraction(conversation: Array<{ role: 'user' | 'assistant' | string; content: string }>): Promise<number> {
    const settings = await this.getSettings();
    if (!settings.enabled || !settings.autoExtract) return 0;
    if (conversation.length < 3) return 0;

    try {
      const store = getMemoryStore();
      const existing = await store.getActiveMemories({ limit: 200 });
      const { extractMemoriesFromConversation } = await import('./memoryExtractor');
      const extracted = await extractMemoriesFromConversation({
        conversation, existingMemories: existing, settings,
      });
      if (extracted.length === 0) return 0;

      if (settings.askBeforeSaving) {
        await store.addPendingMemories(extracted.map(p => ({
          type: p.type, content: p.content, category: p.category,
          confidence: p.confidence, sessionId: null,
        })));
      } else {
        // Auto-save straight to memories
        for (const p of extracted) {
          await store.addMemory({
            type: p.type, content: p.content, category: p.category,
            confidence: p.confidence, source: 'extracted',
            sessionId: null, pinned: false,
          });
        }
      }
      return extracted.length;
    } catch (err) {
      console.warn('[MemoryManager] Session-end extraction failed:', err);
      return 0;
    }
  }
}

// Singleton
let mgr: MemoryManager | null = null;
export function getMemoryManager(): MemoryManager {
  if (!mgr) mgr = new MemoryManager();
  return mgr;
}
