import type {
  RouterConfig,
  RouterMessage,
  ClassificationResult,
  SessionMetrics,
  TurnResult,
  FlashAttempt,
  ToolCallResult,
  ModelProvider,
} from './types';
import { DEFAULT_ROUTER_CONFIG } from './routerConfig';
import { classifyTask } from './taskClassifier';
import { checkQuality } from './qualityGate';
import { buildRetryPrompt } from './retryEngine';
import { buildEscalationContext } from './escalationHandler';
import { manageContext } from './contextManager';
import { RouterCostTracker } from './costTracker';
import { FlashEngine } from '../flash/flashEngine';
import type { ModelAdapter, ToolDefinition, ModelMessage, MessageComplete } from '../../core/agent/modelAdapter';

// ── HybridRouter ─────────────────────────────────────────────────────────────
// Sits between the agent loop and model adapters.
// Per-turn: classify → route → quality gate → retry/escalate.
//
// The router does NOT own the agent loop. ClaudeAgent still runs the loop.
// The router decides WHICH adapter to use for each turn and validates output.
// The FlashEngine provides hardened prompts + tool optimization for Flash turns.

export class HybridRouter {
  private config: RouterConfig;
  private costTracker: RouterCostTracker;
  private flashEngine: FlashEngine;
  private failureCount = 0;
  private turnNumber = 0;
  private lastClassification: ClassificationResult | null = null;

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.flashEngine = new FlashEngine();
    this.costTracker = new RouterCostTracker();
  }

  // ── Main entry: decide which adapter to use for this turn ──────────────

  /**
   * Classify the current turn and return which model to use.
   * Called by the agent loop BEFORE streaming.
   *
   * @param userMessage - The user's current message
   * @param conversationHistory - Recent messages for context
   * @param isFirstTurn - True if this is the planning turn
   * @param isLastTurn - True if agent is about to deliver final answer
   * @returns 'flash' | 'claude'
   */
  async decideModel(
    userMessage: string,
    conversationHistory: RouterMessage[],
    isFirstTurn = false,
    isLastTurn = false,
  ): Promise<{ model: ModelProvider; classification: ClassificationResult }> {
    this.turnNumber++;

    // "Claude sandwich": first turn (planning) and last turn (synthesis) always Claude
    if (isFirstTurn) {
      const classification: ClassificationResult = {
        complexity: 'complex',
        confidence: 1.0,
        reason: 'First turn — planning phase requires strong model',
        suggestedModel: 'claude',
        taskCategory: 'general',
      };
      this.lastClassification = classification;
      return { model: 'claude', classification };
    }

    if (isLastTurn) {
      const classification: ClassificationResult = {
        complexity: 'complex',
        confidence: 1.0,
        reason: 'Final turn — synthesis requires strong model',
        suggestedModel: 'claude',
        taskCategory: 'general',
      };
      this.lastClassification = classification;
      return { model: 'claude', classification };
    }

    // FAST PATH: Tool execution turns → Flash
    // After the first turn, if the conversation is just assistant→tool_result loops,
    // the model is executing tools, not planning. Flash handles this fine and costs 10x less.
    // Only escalate to Claude if Flash fails (quality gate handles that).
    if (this.turnNumber > 2 && this.failureCount === 0) {
      // Check if the last few messages are tool-result exchanges (not new user input)
      const lastMsg = conversationHistory[conversationHistory.length - 1];
      const isToolExecution = !lastMsg || lastMsg.role !== 'user' ||
        (typeof lastMsg.content === 'string' && lastMsg.content.length < 50);
      if (isToolExecution) {
        const classification: ClassificationResult = {
          complexity: 'simple',
          confidence: 0.9,
          reason: 'Tool execution turn — Flash handles this',
          suggestedModel: 'flash',
          taskCategory: 'file_ops',
        };
        this.lastClassification = classification;
        return { model: 'flash', classification };
      }
    }

    // Manage context before classifying (keep Flash window clean)
    const managedHistory = await manageContext(conversationHistory, this.config);

    // Classify this turn
    const classification = await classifyTask(
      userMessage,
      managedHistory,
      this.failureCount,
      this.config,
    );

    // Budget check: if over budget, force Flash
    if (this.costTracker.isOverBudget(this.config) && classification.suggestedModel === 'claude') {
      classification.suggestedModel = 'flash';
      classification.reason += ' (budget exceeded, forcing flash)';
    }

    this.lastClassification = classification;
    return { model: classification.suggestedModel, classification };
  }

  // ── Post-turn: validate Flash output ───────────────────────────────────

  /**
   * After a Flash turn completes, check quality.
   * Returns whether to accept, retry, or escalate.
   */
  evaluateFlashTurn(
    userMessage: string,
    response: string,
    toolCalls: ToolCallResult[],
    tokens: { input: number; output: number },
  ): { action: 'accept' | 'retry' | 'escalate'; turnResult: TurnResult; retryPrompt?: string } {
    const turnResult: TurnResult = {
      model: 'flash',
      response,
      toolCalls,
      tokens,
      costUSD: this.costTracker.addTurn('flash', tokens.input, tokens.output, this.config),
      wasRetry: false,
      wasEscalated: false,
      qualityScore: 1.0,
    };

    const quality = checkQuality(turnResult, userMessage, this.config);
    turnResult.qualityScore = quality.score;

    if (quality.passed) {
      this.failureCount = 0;
      return { action: 'accept', turnResult };
    }

    // Should we retry or escalate?
    if (this.config.retryWithTighterPrompt && this.failureCount < this.config.maxFlashRetries) {
      this.costTracker.recordRetry();
      const retryPrompt = buildRetryPrompt(userMessage, response, quality.failures);
      return { action: 'retry', turnResult, retryPrompt };
    }

    // Escalate
    this.failureCount++;
    this.costTracker.recordEscalation();
    return { action: 'escalate', turnResult };
  }

  /**
   * After a retry Flash turn, check quality again.
   * If still fails, escalate.
   */
  evaluateFlashRetry(
    userMessage: string,
    response: string,
    toolCalls: ToolCallResult[],
    tokens: { input: number; output: number },
  ): { action: 'accept' | 'escalate'; turnResult: TurnResult } {
    const turnResult: TurnResult = {
      model: 'flash',
      response,
      toolCalls,
      tokens,
      costUSD: this.costTracker.addTurn('flash', tokens.input, tokens.output, this.config),
      wasRetry: true,
      wasEscalated: false,
      qualityScore: 1.0,
    };

    const quality = checkQuality(turnResult, userMessage, this.config);
    turnResult.qualityScore = quality.score;

    if (quality.passed) {
      this.failureCount = 0;
      return { action: 'accept', turnResult };
    }

    this.failureCount++;
    this.costTracker.recordEscalation();
    return { action: 'escalate', turnResult };
  }

  /**
   * Record a Flash tool-execution turn (skip quality gate — tool calls mean it's working).
   */
  recordFlashToolTurn(tokens: { input: number; output: number }): void {
    this.costTracker.addTurn('flash', tokens.input, tokens.output, this.config);
  }

  /**
   * Record a Claude turn's cost (no quality gate needed for Claude).
   */
  recordClaudeTurn(tokens: { input: number; output: number }): void {
    this.costTracker.addTurn('claude', tokens.input, tokens.output, this.config);
    this.failureCount = 0; // Claude success resets failure count
  }

  /**
   * Get the escalation context to inject into Claude's system prompt
   * when Flash has failed.
   */
  getEscalationContext(flashAttempts: FlashAttempt[]): string {
    return buildEscalationContext(flashAttempts);
  }

  // ── Session management ─────────────────────────────────────────────────

  getMetrics(): SessionMetrics {
    return this.costTracker.getSessionMetrics();
  }

  getLastClassification(): ClassificationResult | null {
    return this.lastClassification;
  }

  resetSession(): void {
    this.costTracker.reset();
    this.failureCount = 0;
    this.turnNumber = 0;
    this.lastClassification = null;
  }

  updateConfig(config: Partial<RouterConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get the Flash Engine for hardened prompts, tool optimization, and validation.
   * Used by ClaudeAgent when routing a turn to Flash.
   */
  getFlashEngine(): FlashEngine {
    return this.flashEngine;
  }

  /**
   * Build a hardened system prompt for Flash turns.
   * Includes base prompt + task-specific injection + scratchpad + negative examples.
   */
  buildFlashSystemPrompt(taskCategory: string, isAgentMode: boolean): string {
    return this.flashEngine.buildSystemPrompt(taskCategory, isAgentMode);
  }
}
