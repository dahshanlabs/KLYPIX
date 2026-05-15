export interface CostSummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  turns: number;
  model: string;
  /** Tokens that hit the provider's prompt cache (charged at cachedInput rate). */
  cacheHitTokens?: number;
  /**
   * "Fresh" tokens that did not hit the cache. Anthropic reports this as
   * cache_creation_input_tokens (writing new content into the cache, billed at
   * a premium); DeepSeek reports it as prompt_cache_miss_tokens. Surfaced so
   * we can compute hit-rate accurately and prove prompt-restructure work.
   */
  cacheMissTokens?: number;
  /** Cache hit ratio across this run, 0–1. Undefined if provider doesn't report cache stats. */
  cacheHitRatio?: number;
}

interface PriceRow {
  /** $ per 1M input tokens (uncached). */
  input: number;
  /** $ per 1M output tokens. */
  output: number;
  /** $ per 1M cached input tokens. Falls back to `input` when undefined. */
  cachedInput?: number;
}

const MODEL_PRICING: Record<string, PriceRow> = {
  // Claude (per 1M tokens in dollars)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  // Gemini
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // GLM (Z.ai)
  'glm-5': { input: 1.20, output: 4.00 },
  'glm-5v-turbo': { input: 1.20, output: 4.00 },
  'glm-4.6': { input: 0.60, output: 2.00 },
  'glm-4.5': { input: 0.60, output: 2.00 },
  'glm-4.5-flash': { input: 0.15, output: 0.60 },
  'glm-4-plus': { input: 0.40, output: 1.60 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  // DeepSeek V4 (list pricing — adjust if you're on the 75% promo or a different tier).
  // cachedInput is the discounted rate when prompt_cache_hit_tokens fires.
  'deepseek-v4-flash': { input: 0.27, cachedInput: 0.07, output: 1.10 },
  'deepseek-v4-pro':   { input: 0.55, cachedInput: 0.14, output: 2.19 },
  // Legacy V3-era IDs kept so existing localStorage values don't crash; DeepSeek silently routes them to v4-flash.
  'deepseek-chat':     { input: 0.27, cachedInput: 0.07, output: 1.10 },
  'deepseek-reasoner': { input: 0.27, cachedInput: 0.07, output: 1.10 },
};

export class CostTracker {
  private model = 'claude-sonnet-4-20250514';
  private currentInputTokens = 0;
  private currentOutputTokens = 0;
  private currentCacheHitTokens = 0;
  private currentCacheMissTokens = 0;
  private turns = 0;

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Record token usage from one model turn.
   * cacheHit is the subset of `input` tokens served from the provider's prompt cache
   * (DeepSeek prompt_cache_hit_tokens, Anthropic cache_read_input_tokens).
   * cacheMiss is the "fresh" portion that did not hit cache
   * (DeepSeek prompt_cache_miss_tokens, Anthropic cache_creation_input_tokens —
   * the latter is charged at a premium but we surface the raw count for visibility).
   * Pass undefined for either when the provider doesn't report them.
   */
  addUsage(input: number, output: number, cacheHit?: number, cacheMiss?: number): void {
    this.currentInputTokens += input;
    this.currentOutputTokens += output;
    if (typeof cacheHit === 'number' && cacheHit > 0) {
      this.currentCacheHitTokens += Math.min(cacheHit, input);
    }
    if (typeof cacheMiss === 'number' && cacheMiss > 0) {
      this.currentCacheMissTokens += cacheMiss;
    }
    this.turns++;
  }

  reset(): void {
    this.currentInputTokens = 0;
    this.currentOutputTokens = 0;
    this.currentCacheHitTokens = 0;
    this.currentCacheMissTokens = 0;
    this.turns = 0;
  }

  getSummary(): CostSummary {
    const pricing = MODEL_PRICING[this.model] || { input: 3, output: 15 };
    const cachedRate = pricing.cachedInput ?? pricing.input;
    const cacheHit = Math.min(this.currentCacheHitTokens, this.currentInputTokens);
    const freshInput = this.currentInputTokens - cacheHit;
    const inputCost = (freshInput / 1_000_000) * pricing.input + (cacheHit / 1_000_000) * cachedRate;
    const outputCost = (this.currentOutputTokens / 1_000_000) * pricing.output;
    return {
      inputTokens: this.currentInputTokens,
      outputTokens: this.currentOutputTokens,
      totalTokens: this.currentInputTokens + this.currentOutputTokens,
      estimatedCost: parseFloat((inputCost + outputCost).toFixed(6)),
      turns: this.turns,
      model: this.model,
      cacheHitTokens: this.currentCacheHitTokens > 0 ? this.currentCacheHitTokens : undefined,
      cacheMissTokens: this.currentCacheMissTokens > 0 ? this.currentCacheMissTokens : undefined,
      cacheHitRatio: this.currentInputTokens > 0 && this.currentCacheHitTokens > 0
        ? cacheHit / this.currentInputTokens
        : undefined,
    };
  }

  static getSessionSpend(): number {
    const raw = localStorage.getItem('klypix:sessionSpend');
    return raw ? parseFloat(raw) : 0;
  }

  static addSessionSpend(amount: number): void {
    const current = CostTracker.getSessionSpend();
    localStorage.setItem('klypix:sessionSpend', (current + amount).toFixed(6));
  }

  static getDailyBudget(): number {
    const raw = localStorage.getItem('klypix:dailyBudget');
    return raw ? parseFloat(raw) : 5.0;
  }

  static setDailyBudget(amount: number): void {
    localStorage.setItem('klypix:dailyBudget', amount.toFixed(2));
  }

  static isOverBudget(): boolean {
    const today = new Date().toISOString().split('T')[0];
    const spent = parseFloat(localStorage.getItem(`klypix:spend:${today}`) || '0');
    return spent >= CostTracker.getDailyBudget();
  }

  static addDailySpend(amount: number): void {
    const today = new Date().toISOString().split('T')[0];
    const key = `klypix:spend:${today}`;
    const current = parseFloat(localStorage.getItem(key) || '0');
    localStorage.setItem(key, (current + amount).toFixed(6));
  }

  static getCostHistory(): number[] {
    const history: number[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      const key = `klypix:spend:${date.toISOString().split('T')[0]}`;
      history.push(parseFloat(localStorage.getItem(key) || '0'));
    }
    return history.reverse();
  }
}
