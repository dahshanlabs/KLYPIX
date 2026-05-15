/**
 * KLYPIX agent eval harness — types.
 *
 * Eval philosophy: test the REAL agent loop end-to-end. Each prompt has a
 * machine-checkable success criterion (an expected artifact path) so pass/fail
 * is automatic, not vibes. Re-run any time you change a model, prompt, or tool —
 * regression is whatever moves a "pass" to a "fail" or makes a passing run cost
 * substantially more.
 */

export type EvalCategory = 'knowledge' | 'code' | 'light' | 'reasoning' | 'resilience';

export interface EvalPrompt {
  id: string;
  category: EvalCategory;
  prompt: string;
  /**
   * Absolute file paths the agent is expected to produce. The runner checks
   * each path after the run; pass requires all artifacts to exist.
   * Empty array = success is judged by state==='done' alone (no file expected).
   */
  expectedArtifacts: string[];
  /** Soft turn budget — used in the report to flag "took longer than expected". */
  expectedMaxTurns?: number;
  /** Soft cost budget — same idea, flag if a run exceeds. */
  expectedMaxCostUSD?: number;
  notes?: string;
}

export type EvalStatus = 'pending' | 'running' | 'passed' | 'failed' | 'errored' | 'skipped';

export interface EvalResult {
  promptId: string;
  status: EvalStatus;
  /** ms from startAgent to done/error. */
  durationMs: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  /**
   * Tokens served from the provider's prompt cache this run
   * (Anthropic cache_read_input_tokens, DeepSeek prompt_cache_hit_tokens).
   * 0 when the provider doesn't report cache stats or no caching occurred.
   */
  cacheHitTokens: number;
  /**
   * "Fresh" tokens that did not hit the cache
   * (Anthropic cache_creation_input_tokens, DeepSeek prompt_cache_miss_tokens).
   * Together with cacheHitTokens these let us compute hit-rate and prove
   * prompt-restructure work later.
   */
  cacheMissTokens: number;
  /**
   * Number of times the loop bumped to a stronger model mid-run
   * (sandwich router escalations: cheap-tier failure → strong-tier retry).
   * 0 for single-model setups (Claude-only baseline = always 0). Tracked from day one
   * so tonight's baseline stays directly comparable to post-router runs.
   */
  escalations: number;
  /** Per-artifact existence check after run. */
  artifactChecks: Array<{ path: string; exists: boolean }>;
  /**
   * First ~1500 chars of the agent's final text response. Captured so eval
   * reviewers can audit content (e.g. did the Arabic prompt actually return
   * Arabic, did the summary cite real PDF data) without rerunning. Truncated
   * because evalRuns sit in localStorage and we cap the storage footprint.
   */
  finalResponse?: string;
  errorMessage?: string;
  /** Free-form notes the runner captures — provider, model, etc. */
  meta: { provider: string; modelId?: string };
}

export interface EvalRun {
  /** ISO timestamp + short label (e.g. 'claude-default'). */
  id: string;
  startedAt: number;
  finishedAt?: number;
  /** What's being tested — provider/model snapshot. */
  label: string;
  results: EvalResult[];
}

export interface EvalRunSummary {
  totalPrompts: number;
  passed: number;
  failed: number;
  errored: number;
  totalCostUSD: number;
  totalDurationMs: number;
  totalTurns: number;
  passRate: number; // 0..1
}
