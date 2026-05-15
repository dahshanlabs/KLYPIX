/**
 * Context Manager — 9-section context compression + token estimation.
 *
 * Prevents context window bloat by compressing old tool results,
 * summarizing completed steps, and building focused context per step.
 * Instead of sending full message history (O(n^2) token growth),
 * the orchestrator sends: compressed summary + full current step context.
 *
 * Token savings estimate:
 * - 10-turn task with screenshots: ~120K raw → ~15K compressed (87% reduction)
 * - 20-turn task: ~300K raw → ~20K compressed (93% reduction)
 */

import type { ModelProfile } from './modelProfiles';
import type {
  ExecutionPlan,
  PlanStep,
  CompressedContext,
  AgentMemory,
} from './types';

export class ContextManager {
  private stepSummaries: Map<number, string> = new Map();
  /** Raw (uncompressed) tool results — preserved for synthesis pipeline */
  private rawResults: Map<number, Array<{ tool: string; result: string }>> = new Map();
  private compressedCtx: CompressedContext = {
    primaryRequest: '',
    technicalContext: '',
    fileOperations: [],
    errorsAndFixes: [],
    decisions: [],
    collectedData: '',
    pendingTasks: [],
    currentWork: '',
    suggestedNext: '',
  };

  /**
   * Initialize context with the user's original request.
   */
  init(userPrompt: string): void {
    this.compressedCtx.primaryRequest = userPrompt;
    this.stepSummaries.clear();
  }

  // ── Tool Result Compression ─────────────────────────────────────────

  /**
   * Compress a tool result based on tool type.
   * Screenshots: remove base64, keep metadata.
   * Web content: truncate long pages.
   * File reads: truncate large files.
   */
  compressToolResult(toolName: string, result: string, _stepId: number): string {
    // Screenshots — always compress (base64 images are huge)
    if (toolName === 'capture_screenshot') {
      try {
        const parsed = JSON.parse(result);
        if (parsed.image) {
          return JSON.stringify({ type: 'screenshot', captured: true, timestamp: Date.now() });
        }
      } catch { /* not JSON, keep as-is */ }
      return '[Screenshot captured successfully]';
    }

    // Web content — keep generous amount (models have large context windows)
    if (toolName === 'read_web_content' && result.length > 10000) {
      return result.substring(0, 8000) + `\n...[truncated, ${result.length} chars total]`;
    }

    // File reads — keep generous amount
    if (toolName === 'read_file' && result.length > 15000) {
      return result.substring(0, 10000) + `\n...[truncated, ${result.length} chars total]`;
    }

    // Active file read — same as file read
    if (toolName === 'read_active_file' && result.length > 15000) {
      return result.substring(0, 10000) + `\n...[truncated, ${result.length} chars total]`;
    }

    // Shell command output — keep more
    if (toolName === 'run_shell' && result.length > 8000) {
      return result.substring(0, 5000) + `\n...[truncated, ${result.length} chars total]`;
    }

    // List directory, clipboard, etc. — usually small, keep as-is
    return result;
  }

  // ── Step Summary ────────────────────────────────────────────────────

  /**
   * Summarize a step's tool results into a compact form.
   * Called after each step completes. Stored for context building.
   */
  summarizeStep(stepId: number, toolResults: Array<{ tool: string; result: string }>): string {
    const summaries = toolResults.map(tr => {
      if (tr.tool === 'read_web_content') {
        return `Web read (${tr.result.length} chars): ${tr.result.substring(0, 300)}...`;
      }
      if (tr.tool === 'write_file' || tr.tool === 'generate_document') {
        try {
          const parsed = JSON.parse(tr.result);
          return `File created: ${parsed.path || parsed.filePath || 'unknown'} (${parsed.size || '?'} bytes)`;
        } catch {
          return `File operation: ${tr.result.substring(0, 100)}`;
        }
      }
      if (tr.tool === 'capture_screenshot') {
        return 'Screenshot captured';
      }
      if (tr.tool === 'run_shell') {
        return `Shell: ${tr.result.substring(0, 200)}`;
      }
      if (tr.tool === 'list_directory') {
        return `Directory listing: ${tr.result.substring(0, 200)}`;
      }
      if (tr.tool === 'read_file' || tr.tool === 'read_active_file') {
        return `File read (${tr.result.length} chars): ${tr.result.substring(0, 200)}...`;
      }
      return `${tr.tool}: ${tr.result.substring(0, 200)}`;
    });

    const summary = summaries.join(' | ');
    this.stepSummaries.set(stepId, summary);
    return summary;
  }

  // ── Context Building ────────────────────────────────────────────────

  /**
   * Build compressed context for the current step.
   * Instead of full message history, provides:
   * - Plan progress overview
   * - Compressed summaries of completed steps
   * - Dependency results (full for direct deps, summarized for others)
   */
  buildContextForStep(step: PlanStep, plan: ExecutionPlan): string {
    const parts: string[] = [];

    // Plan progress
    parts.push('## Current Task Progress');
    parts.push(`Goal: ${plan.goal}`);
    for (const s of plan.steps) {
      const icon = s.status === 'completed' ? '[DONE]' :
                   s.status === 'running' ? '[NOW]' :
                   s.status === 'failed' ? '[FAILED]' :
                   s.status === 'skipped' ? '[SKIP]' : '[ ]';
      parts.push(`${icon} Step ${s.id}: ${s.action}`);
      if (s.status === 'completed' && s.result) {
        parts.push(`   Result: ${s.result}`);
      }
    }

    // Dependency results (full detail for direct dependencies)
    const depResults: string[] = [];
    for (const depId of step.depends) {
      const summary = this.stepSummaries.get(depId);
      if (summary) {
        depResults.push(`Step ${depId}: ${summary}`);
      }
    }
    if (depResults.length > 0) {
      parts.push('\n## Data From Previous Steps');
      parts.push(...depResults);
    }

    // Previous step summaries (compressed, for general context)
    const otherSummaries: string[] = [];
    for (const [id, summary] of this.stepSummaries) {
      if (!step.depends.includes(id)) {
        otherSummaries.push(`Step ${id}: ${summary}`);
      }
    }
    if (otherSummaries.length > 0) {
      parts.push('\n## Other Completed Results');
      parts.push(...otherSummaries);
    }

    // Collected data summary (from 9-section context)
    if (this.compressedCtx.collectedData) {
      parts.push('\n## Collected Data So Far');
      parts.push(this.compressedCtx.collectedData);
    }

    // Errors and fixes (so model doesn't repeat mistakes)
    if (this.compressedCtx.errorsAndFixes.length > 0) {
      parts.push('\n## Known Issues (Avoid These)');
      for (const ef of this.compressedCtx.errorsAndFixes) {
        parts.push(`- ${ef.error} → Fixed by: ${ef.resolution}`);
      }
    }

    return parts.join('\n');
  }

  // ── 9-Section Context Management ───────────────────────────────────

  /**
   * Record a file operation for the compressed context.
   */
  recordFileOperation(path: string, action: 'read' | 'write' | 'create', summary: string): void {
    this.compressedCtx.fileOperations.push({ path, action, summary });
  }

  /**
   * Record an error and its resolution.
   */
  recordError(error: string, resolution: string): void {
    this.compressedCtx.errorsAndFixes.push({ error, resolution });
  }

  /**
   * Record a decision and its reasoning.
   */
  recordDecision(decision: string, reason: string): void {
    this.compressedCtx.decisions.push({ decision, reason });
  }

  /**
   * Update collected data summary (replaces previous).
   */
  updateCollectedData(data: string): void {
    this.compressedCtx.collectedData = data;
  }

  /**
   * Update pending tasks list.
   */
  updatePendingTasks(tasks: string[]): void {
    this.compressedCtx.pendingTasks = tasks;
  }

  /**
   * Set the current work description.
   */
  setCurrentWork(work: string): void {
    this.compressedCtx.currentWork = work;
  }

  /**
   * Set the suggested next step.
   */
  setSuggestedNext(next: string): void {
    this.compressedCtx.suggestedNext = next;
  }

  // ── Token Estimation ────────────────────────────────────────────────

  /**
   * Rough token estimate: ~4 characters per token.
   * This is approximate but sufficient for compression decisions.
   */
  estimateTokens(messages: any[]): number {
    const json = JSON.stringify(messages);
    return Math.ceil(json.length / 4);
  }

  /**
   * Check if context has grown beyond the model's compression threshold.
   */
  shouldCompress(messages: any[], modelProfile: ModelProfile): boolean {
    return this.estimateTokens(messages) > modelProfile.contextCompressionThreshold;
  }

  // ── Aggressive Compression ──────────────────────────────────────────

  /**
   * Aggressively compress a message array when context is too large.
   * Applies increasingly aggressive strategies:
   * 1. Replace screenshot base64 with placeholder
   * 2. Replace old tool results (>3 turns ago) with summaries
   * 3. Drop tool results entirely, keep only step summaries
   * 4. Truncate oldest messages
   */
  aggressiveCompress(messages: any[], modelProfile: ModelProfile): any[] {
    let compressed = [...messages];

    // Pass 1: Replace screenshot base64 data
    compressed = compressed.map(msg => this.stripScreenshots(msg));

    if (this.estimateTokens(compressed) <= modelProfile.contextCompressionThreshold) {
      return compressed;
    }

    // Pass 2: Truncate large tool results in older messages (keep last 3)
    const keepFullCount = 3;
    for (let i = 0; i < compressed.length - keepFullCount; i++) {
      compressed[i] = this.truncateToolResults(compressed[i]);
    }

    if (this.estimateTokens(compressed) <= modelProfile.contextCompressionThreshold) {
      return compressed;
    }

    // Pass 3: Drop old messages entirely (keep first user message + last 4 messages)
    if (compressed.length > 5) {
      const first = compressed[0];
      const recent = compressed.slice(-4);
      compressed = [first, ...recent];
    }

    return compressed;
  }

  /**
   * Strip base64 image data from a message, replacing with placeholder text.
   */
  private stripScreenshots(msg: any): any {
    if (!msg || !msg.content) return msg;

    if (Array.isArray(msg.content)) {
      const stripped = msg.content.map((block: any) => {
        if (block.type === 'image' || (block.source?.type === 'base64')) {
          return { type: 'text', text: '[Screenshot — image data removed for context compression]' };
        }
        // Tool results containing screenshot images
        if (block.type === 'tool_result' && typeof block.content !== 'string') {
          if (Array.isArray(block.content)) {
            const hasImage = block.content.some((c: any) => c.type === 'image');
            if (hasImage) {
              return { ...block, content: '[Screenshot result — image data removed]' };
            }
          }
        }
        return block;
      });
      return { ...msg, content: stripped };
    }

    return msg;
  }

  /**
   * Truncate long tool result text in a message.
   */
  private truncateToolResults(msg: any): any {
    if (!msg || !msg.content) return msg;

    if (Array.isArray(msg.content)) {
      const truncated = msg.content.map((block: any) => {
        if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500) {
          return { ...block, content: block.content.substring(0, 500) + '...[truncated]' };
        }
        return block;
      });
      return { ...msg, content: truncated };
    }

    if (typeof msg.content === 'string' && msg.content.length > 1000) {
      return { ...msg, content: msg.content.substring(0, 1000) + '...[truncated]' };
    }

    return msg;
  }

  // ── Agent Memory Integration ────────────────────────────────────────

  /**
   * Build memory context string from AgentMemory for injection into model calls.
   */
  buildMemoryContext(memory: AgentMemory): string {
    const parts: string[] = [];

    parts.push(`## Agent Memory`);
    parts.push(`Goal: ${memory.goal}`);

    if (memory.constraints.length > 0) {
      parts.push(`Constraints: ${memory.constraints.join('; ')}`);
    }

    if (memory.decisions.length > 0) {
      parts.push('Decisions made:');
      for (const d of memory.decisions.slice(-5)) { // Keep last 5 decisions
        parts.push(`  - ${d.what} (because: ${d.why})`);
      }
    }

    if (memory.openQuestions.length > 0) {
      parts.push(`Open questions: ${memory.openQuestions.join('; ')}`);
    }

    const { tested, untested } = memory.verificationState;
    if (tested.length > 0 || untested.length > 0) {
      parts.push(`Verified: ${tested.length} items | Unverified: ${untested.length} items`);
    }

    return parts.join('\n');
  }

  /**
   * Get the full compressed context object (for persistence/debugging).
   */
  getCompressedContext(): CompressedContext {
    return { ...this.compressedCtx };
  }

  /**
   * Get all step summaries (for synthesis phase).
   */
  getStepSummaries(): Map<number, string> {
    return new Map(this.stepSummaries);
  }

  // ── Raw Result Storage (for synthesis pipeline) ─────────────────────

  /**
   * Store the original uncompressed tool result.
   * Used by synthesis to extract data from full content, not truncated.
   */
  storeRawResult(stepId: number, toolName: string, rawResult: string): void {
    if (!this.rawResults.has(stepId)) {
      this.rawResults.set(stepId, []);
    }
    this.rawResults.get(stepId)!.push({ tool: toolName, result: rawResult });
  }

  /**
   * Get raw (uncompressed) results for synthesis.
   */
  getRawResults(): Map<number, Array<{ tool: string; result: string }>> {
    return this.rawResults;
  }

  /**
   * Reset context manager state for a new task.
   */
  reset(): void {
    this.stepSummaries.clear();
    this.rawResults.clear();
    this.compressedCtx = {
      primaryRequest: '',
      technicalContext: '',
      fileOperations: [],
      errorsAndFixes: [],
      decisions: [],
      collectedData: '',
      pendingTasks: [],
      currentWork: '',
      suggestedNext: '',
    };
  }
}
