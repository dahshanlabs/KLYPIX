/**
 * Tool Result Caching + Deduplication (Innovation #3).
 *
 * TTL-based cache per tool type. Prevents redundant IPC calls when the agent
 * reads the same URL or file twice (common with weak models that "forget"
 * they already called a tool).
 *
 * TTL policy:
 *   read_web_content: 5 min (web pages don't change fast)
 *   read_file: 30s (files change during editing)
 *   list_directory: 60s (directory listings)
 *   capture_screenshot: never (screen always changes)
 *   run_shell: never (commands have side effects)
 *   clipboard_read: never
 */

interface CacheEntry {
  toolName: string;
  inputHash: string;
  result: string;
  timestamp: number;
  ttlMs: number;
}

/** Per-tool TTL in milliseconds. 0 = never cache. */
const TOOL_TTL: Record<string, number> = {
  'read_web_content': 5 * 60 * 1000,   // 5 min
  'read_file': 30 * 1000,               // 30s
  'read_active_file': 10 * 1000,        // 10s
  'list_directory': 60 * 1000,           // 1 min
  'get_active_window': 5 * 1000,         // 5s
  'get_all_open_files': 10 * 1000,       // 10s
  'capture_screenshot': 0,               // Never
  'run_shell': 0,                        // Never (side effects)
  'clipboard_read': 0,                   // Never
  'clipboard_write': 0,                  // Never
  'write_file': 0,                       // Never
  'edit_file': 0,                        // Never
  'file_move': 0,                        // Never
  'file_delete': 0,                      // Never
  'generate_document': 0,                // Never
  'browser_navigate': 0,                 // Never
  'browser_click': 0,                    // Never
  'browser_fill': 0,                     // Never
  'system_open': 0,                      // Never
  'system_type': 0,                      // Never
};

export class ToolCache {
  private cache = new Map<string, CacheEntry>();

  /**
   * Get a cached result for a tool call, or null if not cached/expired.
   */
  get(toolName: string, input: Record<string, any>): string | null {
    const hash = this.hash(toolName, input);
    const entry = this.cache.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(hash);
      return null;
    }
    console.log(`[ToolCache] HIT: ${toolName} (${Math.round((Date.now() - entry.timestamp) / 1000)}s old)`);
    return entry.result;
  }

  /**
   * Store a tool result in cache (only if the tool is cacheable).
   */
  set(toolName: string, input: Record<string, any>, result: string): void {
    const ttl = TOOL_TTL[toolName] ?? 0;
    if (ttl === 0) return;

    // Don't cache error results
    try {
      const parsed = JSON.parse(result);
      if (parsed.error) return;
    } catch { /* not JSON, cache anyway */ }

    const hash = this.hash(toolName, input);
    this.cache.set(hash, {
      toolName,
      inputHash: hash,
      result,
      timestamp: Date.now(),
      ttlMs: ttl,
    });
  }

  /**
   * Check if this exact tool call was already made (deduplication).
   */
  isDuplicate(toolName: string, input: Record<string, any>): boolean {
    return this.get(toolName, input) !== null;
  }

  /**
   * Invalidate all cached results for a specific tool.
   * Useful after writes (invalidate read_file cache after write_file).
   */
  invalidate(toolName: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.toolName === toolName) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Invalidate cache entries that match a file path.
   * Called after write_file/edit_file to ensure stale reads are cleared.
   */
  invalidatePath(filePath: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.inputHash.includes(filePath)) {
        this.cache.delete(key);
      }
    }
  }

  /** Clear the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  /** Get cache stats for debugging. */
  stats(): { entries: number; tools: Record<string, number> } {
    const tools: Record<string, number> = {};
    for (const entry of this.cache.values()) {
      tools[entry.toolName] = (tools[entry.toolName] || 0) + 1;
    }
    return { entries: this.cache.size, tools };
  }

  private hash(toolName: string, input: Record<string, any>): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }
}
