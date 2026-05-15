import type { EvalRun, EvalResult, EvalRunSummary } from './types';

/**
 * Persistence for eval runs. Stored in localStorage as a list of runs
 * (newest first). Cap at 20 runs to bound storage. The "baseline" is just
 * the most recent run before the current one — comparison is current vs
 * the last completed run.
 */

const STORAGE_KEY = 'klypix:evalRuns';
const MAX_RUNS = 20;

export function listRuns(): EvalRun[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

export function saveRun(run: EvalRun): void {
  const runs = listRuns().filter(r => r.id !== run.id);
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs));
}

export function getRun(id: string): EvalRun | undefined {
  return listRuns().find(r => r.id === id);
}

export function deleteRun(id: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(listRuns().filter(r => r.id !== id)));
}

/** The most recent COMPLETED run — used as the baseline to compare against. */
export function getBaselineRun(excludeId?: string): EvalRun | undefined {
  return listRuns().find(r => r.id !== excludeId && r.finishedAt != null);
}

export function summarize(run: EvalRun): EvalRunSummary {
  const passed = run.results.filter(r => r.status === 'passed').length;
  const failed = run.results.filter(r => r.status === 'failed').length;
  const errored = run.results.filter(r => r.status === 'errored').length;
  const totalCostUSD = run.results.reduce((s, r) => s + r.costUSD, 0);
  const totalDurationMs = run.results.reduce((s, r) => s + r.durationMs, 0);
  const totalTurns = run.results.reduce((s, r) => s + r.turns, 0);
  const totalPrompts = run.results.length;
  return {
    totalPrompts,
    passed,
    failed,
    errored,
    totalCostUSD,
    totalDurationMs,
    totalTurns,
    passRate: totalPrompts > 0 ? passed / totalPrompts : 0,
  };
}

/**
 * Diff two results (current vs baseline) for a single prompt. Returns null when
 * the baseline doesn't have a result for that prompt id.
 */
export interface ResultDelta {
  promptId: string;
  statusBefore: EvalResult['status'];
  statusNow: EvalResult['status'];
  /** Negative = cheaper now (good), positive = more expensive now (bad). */
  costDeltaUSD: number;
  /** Negative = fewer turns now (good). */
  turnsDelta: number;
  /** Negative = faster now (good). */
  durationDeltaMs: number;
  /** Regression = was passing, now failing. */
  isRegression: boolean;
  /** Recovery = was failing, now passing. */
  isRecovery: boolean;
}

export function diffResult(current: EvalResult, baseline: EvalResult): ResultDelta {
  const wasPassing = baseline.status === 'passed';
  const isPassingNow = current.status === 'passed';
  return {
    promptId: current.promptId,
    statusBefore: baseline.status,
    statusNow: current.status,
    costDeltaUSD: current.costUSD - baseline.costUSD,
    turnsDelta: current.turns - baseline.turns,
    durationDeltaMs: current.durationMs - baseline.durationMs,
    isRegression: wasPassing && !isPassingNow,
    isRecovery: !wasPassing && isPassingNow,
  };
}

export function makeRunId(label: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = label.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `${ts}__${safe}`;
}
