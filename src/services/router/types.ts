// Hybrid Router Types
// Routes agent turns between Flash (cheap) and Claude (powerful)

export type ModelProvider = 'flash' | 'claude';

export type TaskComplexity = 'simple' | 'complex' | 'uncertain';

export interface RouterConfig {
  // Classification thresholds
  complexityThreshold: number;          // 0-1 score above which = complex
  uncertaintyFallback: ModelProvider;    // which model handles uncertain tasks

  // Retry settings
  maxFlashRetries: number;              // max retries before escalation (default: 1)
  retryWithTighterPrompt: boolean;      // rewrite prompt on retry

  // Quality gate settings
  minResponseLength: number;            // minimum chars for valid response
  maxEmptyToolCalls: number;            // max failed tool calls before escalation
  detectEarlyExit: boolean;             // detect when Flash gives up too soon

  // Cost settings
  flashCostPerToken: { input: number; output: number };
  claudeCostPerToken: { input: number; output: number };
  sessionBudgetUSD: number;             // max spend per session

  // Context management
  maxFlashContextTokens: number;        // Flash effective context limit
  summarizeAfterTurns: number;          // summarize history after N turns
}

export interface ClassificationResult {
  complexity: TaskComplexity;
  confidence: number;                   // 0-1
  reason: string;                       // why this classification
  suggestedModel: ModelProvider;
  taskCategory?: string;                // research, file_ops, data, general, etc.
}

export interface TurnResult {
  model: ModelProvider;
  response: string;
  toolCalls: ToolCallResult[];
  tokens: { input: number; output: number };
  costUSD: number;
  wasRetry: boolean;
  wasEscalated: boolean;
  qualityScore: number;
}

export interface ToolCallResult {
  name: string;
  input: Record<string, unknown>;
  output: string | null;
  success: boolean;
  error?: string;
}

export interface FlashAttempt {
  response: string;
  toolCalls: ToolCallResult[];
  qualityScore: number;
  failures: string[];
  tokens: { input: number; output: number };
}

export interface QualityCheckResult {
  passed: boolean;
  score: number;          // 0-1
  failures: string[];     // what went wrong
}

export interface SessionMetrics {
  totalTurns: number;
  flashTurns: number;
  claudeTurns: number;
  escalations: number;
  retries: number;
  totalCostUSD: number;
  averageQuality: number;
}

export interface TurnCost {
  model: ModelProvider;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  timestamp: number;
}

// Message type compatible with existing KLYPIX message structure
export interface RouterMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
}
