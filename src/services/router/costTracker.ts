import type { ModelProvider, RouterConfig, SessionMetrics, TurnCost } from './types';

// ── Router-level cost tracker ────────────────────────────────────────────────
// Tracks per-session costs to inform routing decisions (budget enforcement).
// This is separate from the existing agent costTracker which tracks daily/global spend.

export class RouterCostTracker {
  private turns: TurnCost[] = [];
  private _escalations = 0;
  private _retries = 0;

  addTurn(model: ModelProvider, inputTokens: number, outputTokens: number, config: RouterConfig): number {
    const rates = model === 'flash' ? config.flashCostPerToken : config.claudeCostPerToken;
    const cost = (inputTokens * rates.input) + (outputTokens * rates.output);

    this.turns.push({
      model,
      inputTokens,
      outputTokens,
      cost,
      timestamp: Date.now(),
    });

    return cost;
  }

  recordEscalation(): void {
    this._escalations++;
  }

  recordRetry(): void {
    this._retries++;
  }

  getSessionMetrics(): SessionMetrics {
    const qualityScores: number[] = []; // populated externally if needed
    return {
      totalTurns: this.turns.length,
      flashTurns: this.turns.filter(t => t.model === 'flash').length,
      claudeTurns: this.turns.filter(t => t.model === 'claude').length,
      escalations: this._escalations,
      retries: this._retries,
      totalCostUSD: this.turns.reduce((sum, t) => sum + t.cost, 0),
      averageQuality: qualityScores.length > 0
        ? qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length
        : 0,
    };
  }

  getTotalCostUSD(): number {
    return this.turns.reduce((sum, t) => sum + t.cost, 0);
  }

  isOverBudget(config: RouterConfig): boolean {
    return this.getTotalCostUSD() >= config.sessionBudgetUSD;
  }

  reset(): void {
    this.turns = [];
    this._escalations = 0;
    this._retries = 0;
  }
}
