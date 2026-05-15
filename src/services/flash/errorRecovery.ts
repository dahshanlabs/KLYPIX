import type { ToolCallAttempt, FlashEngineConfig, FlashTurnContext } from './types';

// ── Error Recovery Loop ──────────────────────────────────────────────────────
// Traditional: Flash calls tool → fails → gives up → bad response
// Hardened:    Flash calls tool → fails → error fed back as context →
//              Flash retries with error awareness → up to N attempts
//
// This mimics what Claude does naturally. Flash needs explicit instruction.

export async function executeToolWithRecovery(
  toolCall: { name: string; input: Record<string, unknown> },
  executeToolFn: (name: string, input: Record<string, unknown>) => Promise<string>,
  config: FlashEngineConfig,
  context: FlashTurnContext,
  availableToolNames: string[],
): Promise<ToolCallAttempt> {
  // Check total tool call budget
  if (context.totalToolCalls >= config.maxTotalToolCalls) {
    return {
      toolName: toolCall.name,
      input: toolCall.input,
      attempt: 0,
      success: false,
      output: null,
      error: 'Tool call budget exceeded for this turn. Summarize what you have so far.',
      durationMs: 0,
    };
  }

  // Tool doesn't exist — return helpful error so Flash can adapt
  if (!availableToolNames.includes(toolCall.name)) {
    return {
      toolName: toolCall.name,
      input: toolCall.input,
      attempt: 1,
      success: false,
      output: null,
      error: `Tool "${toolCall.name}" does not exist. Available tools: ${availableToolNames.join(', ')}. Choose one of these instead.`,
      durationMs: 0,
    };
  }

  // Try executing with retries
  for (let attempt = 1; attempt <= config.maxToolRetriesPerCall; attempt++) {
    const startTime = Date.now();

    try {
      const output = await Promise.race([
        executeToolFn(toolCall.name, toolCall.input),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Tool execution timed out')), config.toolTimeoutMs),
        ),
      ]);

      context.totalToolCalls++;

      // Compress output if too large
      const finalOutput = output.length > config.compressToolOutputsAbove
        ? compressOutput(output, config.compressToolOutputsAbove)
        : output;

      return {
        toolName: toolCall.name,
        input: toolCall.input,
        attempt,
        success: true,
        output: finalOutput,
        error: null,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      context.totalToolCalls++;

      if (attempt === config.maxToolRetriesPerCall) {
        return {
          toolName: toolCall.name,
          input: toolCall.input,
          attempt,
          success: false,
          output: null,
          error: errorMessage,
          durationMs: Date.now() - startTime,
        };
      }
      // Loop continues for retry
    }
  }

  return {
    toolName: toolCall.name,
    input: toolCall.input,
    attempt: config.maxToolRetriesPerCall,
    success: false,
    output: null,
    error: 'Unknown error after all retries',
    durationMs: 0,
  };
}

// ── Error formatting for Flash ───────────────────────────────────────────────
// HOW we present errors to Flash matters enormously.
// Flash needs explicit instruction on what to do next.

export function formatToolErrorForFlash(attempt: ToolCallAttempt): string {
  return [
    `TOOL RESULT [${attempt.toolName}]: FAILED`,
    `Error: ${attempt.error}`,
    '',
    'ACTION REQUIRED: Do NOT give up. Try one of these alternatives:',
    '1. Fix the input and call the same tool again with corrected parameters',
    '2. Use a different tool to achieve the same goal',
    '3. If no tools can help, use your reasoning to provide the best answer possible',
    '',
    'Do NOT apologize or say you cannot help. Take action now.',
  ].join('\n');
}

export function formatToolSuccessForFlash(attempt: ToolCallAttempt): string {
  return [
    `TOOL RESULT [${attempt.toolName}]: SUCCESS`,
    'Output:',
    attempt.output || '(empty)',
  ].join('\n');
}

// ── Rule-based output compression (no LLM call) ─────────────────────────────

function compressOutput(output: string, maxChars: number): string {
  let compressed = output;

  // Remove excessive whitespace
  compressed = compressed.replace(/\n{3,}/g, '\n\n');
  compressed = compressed.replace(/\s{2,}/g, ' ');

  // Remove HTML tags
  compressed = compressed.replace(/<[^>]+>/g, '');

  // Remove common web boilerplate
  compressed = compressed.replace(/cookie\s*(policy|notice|consent)[^.]*\./gi, '');
  compressed = compressed.replace(/subscribe\s*to\s*(our|the)\s*newsletter[^.]*\./gi, '');
  compressed = compressed.replace(/copyright\s*©[^.]*\./gi, '');
  compressed = compressed.replace(/all rights reserved[^.]*\./gi, '');

  if (compressed.length > maxChars) {
    const truncated = compressed.substring(0, maxChars);
    const lastSentence = truncated.lastIndexOf('.');
    if (lastSentence > maxChars * 0.5) {
      compressed = truncated.substring(0, lastSentence + 1) + '\n\n[... content truncated for brevity]';
    } else {
      compressed = truncated + '\n\n[... content truncated]';
    }
  }

  return compressed;
}
