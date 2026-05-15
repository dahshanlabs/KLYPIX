/**
 * Session Learning — Cross-session pattern extraction (Innovation #9).
 *
 * Analyzes past agent sessions to improve future plans:
 *   - Blocked URLs → avoid in future scraping plans
 *   - Preferred save paths → default there instead of Desktop
 *   - Tool failures → skip unreliable tools
 *   - User corrections → remember preferences
 *
 * Patterns expire after 7 days. Max 100 patterns stored.
 */

import type { AgentSession } from './agentSession';
import type { LearnedPattern } from './types';

const STORAGE_KEY = 'klypix:learnedPatterns';
const MAX_PATTERNS = 100;
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export class SessionLearning {
  private patterns: LearnedPattern[] = [];

  constructor() {
    try {
      this.patterns = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      this.patterns = [];
    }
  }

  /**
   * After each session, extract patterns from what happened.
   */
  learnFromSession(session: AgentSession): void {
    for (const step of session.steps) {
      // Pattern: URLs that fail
      if (step.toolName === 'read_web_content' && step.status === 'error') {
        const url = step.toolInput?.url;
        if (url) {
          try {
            this.recordPattern('blocked_url', new URL(url).hostname);
          } catch { /* invalid URL */ }
        }
      }

      // Pattern: Where user's files end up
      if (step.toolName === 'write_file' && step.status === 'completed') {
        const dir = step.toolInput?.file_path?.replace(/[/\\][^/\\]+$/, '');
        if (dir) this.recordPattern('preferred_path', dir);
      }

      // Pattern: Tools that consistently fail
      if (step.status === 'error' && step.toolName) {
        this.recordPattern('tool_failure', step.toolName);
      }
    }

    this.persist();
  }

  /**
   * Before planning, get learned constraints to inject into the planner.
   */
  getConstraints(): string[] {
    const constraints: string[] = [];

    // Blocked domains (at least 2 failures)
    const blockedDomains = this.patterns
      .filter(p => p.type === 'blocked_url' && p.count >= 2)
      .map(p => p.pattern);
    if (blockedDomains.length > 0) {
      constraints.push(`AVOID these domains (historically blocked): ${blockedDomains.join(', ')}`);
    }

    // Preferred save path (most common)
    const pathCounts = this.patterns
      .filter(p => p.type === 'preferred_path')
      .sort((a, b) => b.count - a.count);
    if (pathCounts.length > 0) {
      constraints.push(`User's preferred save location: ${pathCounts[0].pattern}`);
    }

    // Unreliable tools (3+ failures)
    const unreliableTools = this.patterns
      .filter(p => p.type === 'tool_failure' && p.count >= 3)
      .map(p => p.pattern);
    if (unreliableTools.length > 0) {
      constraints.push(`These tools often fail on this system: ${unreliableTools.join(', ')}`);
    }

    return constraints;
  }

  /**
   * Get the user's most commonly used save path.
   */
  getPreferredPath(): string | null {
    const paths = this.patterns
      .filter(p => p.type === 'preferred_path')
      .sort((a, b) => b.count - a.count);
    return paths.length > 0 ? paths[0].pattern : null;
  }

  /**
   * Check if a domain has been blocked multiple times.
   */
  isBlockedDomain(hostname: string): boolean {
    const pattern = this.patterns.find(p =>
      p.type === 'blocked_url' && p.pattern === hostname && p.count >= 2
    );
    return !!pattern;
  }

  /**
   * Record a user correction (e.g., user changed file path, corrected approach).
   */
  recordUserCorrection(description: string): void {
    this.recordPattern('user_correction', description);
    this.persist();
  }

  /**
   * Get all patterns (for debugging/display).
   */
  getPatterns(): LearnedPattern[] {
    return [...this.patterns];
  }

  /**
   * Clear all learned patterns.
   */
  clear(): void {
    this.patterns = [];
    localStorage.removeItem(STORAGE_KEY);
  }

  private recordPattern(type: LearnedPattern['type'], pattern: string): void {
    const existing = this.patterns.find(p => p.type === type && p.pattern === pattern);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
    } else {
      this.patterns.push({
        type,
        pattern,
        confidence: 0.3,
        lastSeen: Date.now(),
        count: 1,
      });
    }
  }

  private persist(): void {
    // Expire old patterns
    this.patterns = this.patterns
      .filter(p => Date.now() - p.lastSeen < EXPIRY_MS)
      .slice(-MAX_PATTERNS);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.patterns));
    } catch (err) {
      console.warn('[SessionLearning] Failed to persist:', err);
    }
  }
}

export const sessionLearning = new SessionLearning();
