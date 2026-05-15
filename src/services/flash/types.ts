// Flash Agent Loop Hardening Types
// Makes Gemini Flash perform at max capability before escalating to Claude

import type { RouterMessage } from '../router/types';

export interface FlashEngineConfig {
  // Scratchpad
  useScratchpad: boolean;                // force plan-before-execute
  scratchpadMaxSteps: number;            // max steps Flash can plan (prevent runaway)

  // Tool calling
  maxToolRetriesPerCall: number;         // retries per individual tool call (default: 2)
  maxTotalToolCalls: number;             // max tool calls per turn (prevent loops)
  toolTimeoutMs: number;                 // timeout per tool execution

  // Error recovery
  feedErrorsAsContext: boolean;          // feed tool errors back to Flash
  maxErrorRecoveryAttempts: number;      // max times Flash can try to recover from errors

  // Context
  maxInputTokens: number;               // hard cap on input to Flash
  compressToolOutputsAbove: number;      // compress tool outputs longer than N chars
  keepLastNTurnsVerbatim: number;        // recent turns kept uncompressed

  // Output
  enforceMinResponseLength: number;      // force Flash to give substantial response
  requireToolUseForActionTasks: boolean; // fail if Flash didn't use tools when it should
}

export interface ScratchpadPlan {
  taskUnderstanding: string;             // Flash's interpretation of the task
  steps: ScratchpadStep[];              // planned steps
  toolsNeeded: string[];                // which tools Flash intends to use
  expectedOutput: string;               // what the final output should look like
}

export interface ScratchpadStep {
  stepNumber: number;
  action: string;                        // what to do
  tool: string | null;                   // which tool to use (null = reasoning only)
  dependsOn: number | null;              // which previous step this depends on
}

export interface ToolCallAttempt {
  toolName: string;
  input: Record<string, unknown>;
  attempt: number;
  success: boolean;
  output: string | null;
  error: string | null;
  durationMs: number;
}

export interface FlashTurnContext {
  compressedHistory: RouterMessage[];
  scratchpadPlan: ScratchpadPlan | null;
  toolAttempts: ToolCallAttempt[];
  errorRecoveries: number;
  totalToolCalls: number;
}

export interface FlashTurnResult {
  response: string;
  toolAttempts: ToolCallAttempt[];
  totalToolCalls: number;
  errorRecoveries: number;
  loopIterations: number;
  scratchpadPlan: ScratchpadPlan | null;
  validation: FlashValidationResult;
}

export interface FlashValidationResult {
  valid: boolean;
  issues: string[];
  suggestedAction: 'pass' | 'retry_flash' | 'escalate';
}

// Flash-optimized tool schema (more explicit than standard ToolDefinition)
export interface FlashToolParam {
  name: string;
  type: 'string' | 'integer' | 'number' | 'boolean';
  description: string;
  example: string;
  required: boolean;
  enum?: (string | number)[];
  default?: unknown;
}

export interface FlashToolSchema {
  name: string;                          // verb_noun format
  description: string;                   // one clear sentence
  whenToUse: string;                     // explicit guidance for Flash
  whenNotToUse: string;                  // prevent misuse
  params: FlashToolParam[];
  returnDescription: string;             // what the tool returns
  exampleCall: Record<string, unknown>;  // concrete example
  exampleReturn: string;                 // concrete example output
}
