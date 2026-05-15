import type { FlashEngineConfig, FlashTurnResult, FlashToolSchema, FlashTurnContext } from './types';
import type { RouterMessage } from '../router/types';
import { SCRATCHPAD_SYSTEM_PROMPT, parseScratchpad, validatePlan, buildReplanPrompt } from './scratchpad';
import { selectToolsForTask, convertToFlashSchema } from './toolSchemas';
import { executeToolWithRecovery, formatToolErrorForFlash, formatToolSuccessForFlash } from './errorRecovery';
import { prepareContext, deduplicateContext } from './contextPrep';
import { FLASH_BASE_SYSTEM_PROMPT, FLASH_AGENT_PROMPT_ADDITION, TASK_PROMPT_INJECTIONS, NEGATIVE_EXAMPLES } from './promptTemplates';
import { validateFlashOutput } from './outputValidator';

// ── Default config ───────────────────────────────────────────────────────────

export const DEFAULT_FLASH_CONFIG: FlashEngineConfig = {
  useScratchpad: true,
  scratchpadMaxSteps: 8,
  maxToolRetriesPerCall: 2,
  maxTotalToolCalls: 15,
  toolTimeoutMs: 30000,
  feedErrorsAsContext: true,
  maxErrorRecoveryAttempts: 3,
  maxInputTokens: 100000,
  compressToolOutputsAbove: 3000,
  keepLastNTurnsVerbatim: 6,
  enforceMinResponseLength: 80,
  requireToolUseForActionTasks: true,
};

// ── Flash Engine ─────────────────────────────────────────────────────────────
// The complete Flash execution pipeline.
// Called by the Hybrid Router when it decides to use Flash.
//
// Pipeline:
// 1. Prepare context (compress, deduplicate)
// 2. Select relevant tools for this task
// 3. Build hardened prompt (base + task-specific + negative examples + scratchpad)
// 4. Return the hardened prompt + filtered tools for the adapter to use
// 5. After response, parse scratchpad + validate output

export class FlashEngine {
  private config: FlashEngineConfig;

  constructor(config: Partial<FlashEngineConfig> = {}) {
    this.config = { ...DEFAULT_FLASH_CONFIG, ...config };
  }

  /**
   * Build a hardened system prompt for Flash based on task category.
   * The caller (hybridRouter/claudeAgent) uses this as the system prompt
   * when routing to the Flash adapter.
   */
  buildSystemPrompt(taskCategory: string, isAgentMode: boolean): string {
    const parts = [FLASH_BASE_SYSTEM_PROMPT, NEGATIVE_EXAMPLES];

    if (TASK_PROMPT_INJECTIONS[taskCategory]) {
      parts.push(TASK_PROMPT_INJECTIONS[taskCategory]);
    }

    if (isAgentMode) {
      parts.push(FLASH_AGENT_PROMPT_ADDITION);
    }

    if (this.config.useScratchpad && isAgentMode) {
      parts.push(SCRATCHPAD_SYSTEM_PROMPT);
    }

    return parts.join('\n\n');
  }

  /**
   * Select the most relevant tools for this task category.
   * Returns tool names that should be passed to the adapter.
   */
  selectTools(taskCategory: string, allToolNames: string[]): string[] {
    return selectToolsForTask(taskCategory, allToolNames);
  }

  /**
   * Convert a standard ToolDefinition to Flash-optimized format.
   */
  optimizeTool(tool: { name: string; description: string; input_schema: Record<string, any> }): FlashToolSchema {
    return convertToFlashSchema(tool);
  }

  /**
   * Prepare conversation context for Flash (compress + deduplicate).
   */
  async prepareHistory(history: RouterMessage[]): Promise<RouterMessage[]> {
    const prepared = await prepareContext(history, this.config);
    return deduplicateContext(prepared);
  }

  /**
   * Validate Flash's output after a turn completes.
   * Called by the router after receiving the Flash response.
   */
  validateOutput(
    response: string,
    userMessage: string,
    toolResults: Array<{ name: string; success: boolean; output: string | null; error: string | null }>,
  ): { valid: boolean; issues: string[]; suggestedAction: 'pass' | 'retry_flash' | 'escalate' } {
    const plan = parseScratchpad(response);
    const toolAttempts = toolResults.map((t, i) => ({
      toolName: t.name,
      input: {},
      attempt: 1,
      success: t.success,
      output: t.output,
      error: t.error,
      durationMs: 0,
    }));

    return validateFlashOutput(response, userMessage, plan, toolAttempts, this.config);
  }

  /**
   * Execute a tool call with retry/recovery logic.
   * Used when the agent loop delegates tool execution through the Flash engine.
   */
  async executeToolWithRecovery(
    toolCall: { name: string; input: Record<string, unknown> },
    executeToolFn: (name: string, input: Record<string, unknown>) => Promise<string>,
    context: FlashTurnContext,
    availableToolNames: string[],
  ) {
    return executeToolWithRecovery(toolCall, executeToolFn, this.config, context, availableToolNames);
  }

  /**
   * Format tool results for feeding back to Flash.
   */
  formatToolResult(attempt: { success: boolean; toolName: string; output: string | null; error: string | null }): string {
    if (attempt.success) {
      return formatToolSuccessForFlash(attempt as any);
    }
    return formatToolErrorForFlash(attempt as any);
  }

  /**
   * Parse a scratchpad from Flash's response.
   */
  parsePlan(response: string) {
    return parseScratchpad(response);
  }

  /**
   * Validate a scratchpad plan.
   */
  validatePlan(plan: NonNullable<ReturnType<typeof parseScratchpad>>, availableTools: string[]) {
    return validatePlan(plan, availableTools, this.config);
  }

  /**
   * Build a re-plan prompt when the plan fails validation.
   */
  buildReplanPrompt(plan: NonNullable<ReturnType<typeof parseScratchpad>>, issues: string[]) {
    return buildReplanPrompt(plan, issues);
  }

  getConfig(): FlashEngineConfig {
    return { ...this.config };
  }

  updateConfig(config: Partial<FlashEngineConfig>): void {
    this.config = { ...this.config, ...config };
  }
}
