import type { RouterConfig } from './types';

export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  // Classification
  complexityThreshold: 0.6,
  uncertaintyFallback: 'flash',        // try flash first when unsure

  // Retry
  maxFlashRetries: 1,
  retryWithTighterPrompt: true,

  // Quality gate
  minResponseLength: 50,
  maxEmptyToolCalls: 2,
  detectEarlyExit: true,

  // Cost (Gemini 2.5 Flash & Claude Sonnet 4 pricing)
  flashCostPerToken: { input: 0.00000015, output: 0.0000006 },
  claudeCostPerToken: { input: 0.000003, output: 0.000015 },
  sessionBudgetUSD: 0.30,

  // Context
  maxFlashContextTokens: 128000,
  summarizeAfterTurns: 8,
};

// Agent mode: lower threshold (escalate faster), higher budget
export const AGENT_MODE_CONFIG: Partial<RouterConfig> = {
  complexityThreshold: 0.4,
  maxFlashRetries: 1,
  sessionBudgetUSD: 0.50,
  summarizeAfterTurns: 6,
};
