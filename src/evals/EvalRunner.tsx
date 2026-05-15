import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useClaudeAgent } from '../hooks/useClaudeAgent';
import { EVAL_PROMPTS, resolveDesktopPath } from './prompts';
import {
  saveRun, listRuns, getBaselineRun, summarize, diffResult, makeRunId,
} from './evalStore';
import type { EvalPrompt, EvalResult, EvalRun } from './types';

const TURN_TIMEOUT_MS = 6 * 60 * 1000; // 6 min per prompt — generous; eval should not hang forever

/**
 * In-app eval runner. Drives the real useClaudeAgent through a sequence of
 * prompts, captures metrics + artifact existence, persists results in
 * localStorage, and shows a current-vs-baseline comparison.
 */
export const EvalRunner: React.FC = () => {
  const agent = useClaudeAgent();
  const [running, setRunning] = useState(false);
  const [currentIdx, setCurrentIdx] = useState(-1);
  const [runs, setRuns] = useState<EvalRun[]>(() => listRuns());

  // Refs survive re-renders and avoid stale closures inside the state-driven driver.
  // Initial value: the most recent run from localStorage so the per-prompt table
  // stays visible across reloads and after a run finishes.
  const runRef = useRef<EvalRun | null>(listRuns()[0] || null);
  const startTimeRef = useRef<number>(0);
  const trustRestoreRef = useRef<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const desktopRef = useRef<string>('');

  useEffect(() => {
    const env = (window as any).klypixEnv;
    desktopRef.current = env?.desktop || `C:\\Users\\${env?.username || 'user'}\\Desktop`;
  }, []);

  const baseline = useMemo(() => getBaselineRun(runRef.current?.id), [runs, running]);
  const currentSummary = useMemo(() => runRef.current ? summarize(runRef.current) : null, [runs, running, currentIdx]);
  const baselineSummary = useMemo(() => baseline ? summarize(baseline) : null, [baseline]);

  /** Build the label that identifies this run — provider + model snapshot. */
  function makeLabel(): string {
    const provider = localStorage.getItem('klypix:agentProvider') || 'claude';
    const modelId = provider === 'deepseek'
      ? (localStorage.getItem('klypix:deepseekModel') || 'deepseek-v4-pro')
      : provider;
    return `${provider}-${modelId}`;
  }

  function startRun() {
    // Trust mode ON during eval so permission prompts don't hang the run.
    trustRestoreRef.current = localStorage.getItem('klypix:trustMode');
    agent.setTrustMode(true);

    const label = makeLabel();
    const run: EvalRun = {
      id: makeRunId(label),
      startedAt: Date.now(),
      label,
      results: [],
    };
    runRef.current = run;
    saveRun(run);
    setRuns(listRuns());
    setRunning(true);
    setCurrentIdx(0);
  }

  function finishRun() {
    if (runRef.current) {
      runRef.current.finishedAt = Date.now();
      saveRun(runRef.current);
      setRuns(listRuns());
    }
    if (trustRestoreRef.current === '0' || trustRestoreRef.current === null) {
      agent.setTrustMode(false);
    }
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    setRunning(false);
    setCurrentIdx(-1);
    // KEEP runRef.current populated so the per-prompt table stays visible after the run ends.
    // Replaced on the next startRun(). The old run is also persisted in localStorage history.
  }

  function stopRun() {
    agent.abort();
    finishRun();
  }

  /** Fire a single prompt — called when currentIdx changes during a run. */
  useEffect(() => {
    if (!running || currentIdx < 0 || currentIdx >= EVAL_PROMPTS.length) return;
    const prompt = EVAL_PROMPTS[currentIdx];
    const resolved = resolveDesktopPath(prompt.prompt, desktopRef.current);
    agent.reset();
    startTimeRef.current = Date.now();

    // Hard timeout — if the agent hangs (waiting on a permission we missed,
    // an ask_user we can't answer, etc.) we record an errored result and move on.
    timeoutRef.current = setTimeout(() => {
      agent.abort();
    }, TURN_TIMEOUT_MS);

    // Tiny defer so reset() flushes before startAgent() reinitializes.
    setTimeout(() => {
      agent.startAgent(resolved, null, {});
    }, 50);
    // Intentionally NOT depending on `agent` (object identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIdx, running]);

  /** Capture result on terminal state, then advance. */
  useEffect(() => {
    if (!running || !runRef.current) return;
    const isTerminal = agent.state === 'done' || agent.state === 'error' || agent.state === 'stopped';
    if (!isTerminal) return;
    if (currentIdx < 0 || currentIdx >= EVAL_PROMPTS.length) return;

    const prompt = EVAL_PROMPTS[currentIdx];

    (async () => {
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

      const turns = agent.steps.filter(s => s.type === 'thinking').length || agent.steps.length;
      const electron = (window as any).electron;

      // Artifact existence check.
      const checks = await Promise.all(
        prompt.expectedArtifacts.map(async (template) => {
          const path = resolveDesktopPath(template, desktopRef.current);
          try {
            const res = await electron?.file?.exists?.(path);
            return { path, exists: !!res?.exists };
          } catch { return { path, exists: false }; }
        }),
      );

      const artifactsOK = checks.every(c => c.exists);
      const stateOK = agent.state === 'done';
      const status: EvalResult['status'] = stateOK && artifactsOK
        ? 'passed'
        : agent.state === 'error' || agent.state === 'stopped'
          ? 'errored'
          : 'failed';

      const result: EvalResult = {
        promptId: prompt.id,
        status,
        durationMs: Date.now() - startTimeRef.current,
        turns,
        inputTokens: agent.cost?.inputTokens ?? 0,
        outputTokens: agent.cost?.outputTokens ?? 0,
        costUSD: agent.cost?.estimatedCost ?? 0,
        cacheHitTokens: agent.cost?.cacheHitTokens ?? 0,
        cacheMissTokens: agent.cost?.cacheMissTokens ?? 0,
        // Single-model setups have no escalation path — defaults to 0. The sandwich
        // router will surface this through a callback later; for now we record 0
        // so tonight's baseline is structurally identical to post-router runs.
        escalations: 0,
        artifactChecks: checks,
        // Capture the agent's final response text so reviewers can audit content
        // (Arabic actually in Arabic? summary cites real data?) without rerunning.
        finalResponse: agent.streamingText ? agent.streamingText.slice(0, 1500) : undefined,
        errorMessage: agent.errorMessage || undefined,
        meta: {
          provider: localStorage.getItem('klypix:agentProvider') || 'claude',
          modelId: agent.cost?.model,
        },
      };

      runRef.current!.results.push(result);
      saveRun(runRef.current!);
      setRuns(listRuns());

      // Advance or finish.
      const nextIdx = currentIdx + 1;
      if (nextIdx >= EVAL_PROMPTS.length) {
        finishRun();
      } else {
        setCurrentIdx(nextIdx);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.state, running]);

  // ── Rendering ────────────────────────────────────────────────────────

  const currentPrompt = currentIdx >= 0 ? EVAL_PROMPTS[currentIdx] : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-sm font-semibold text-white">Eval Harness</h4>
          <p className="text-[10px] text-gray-500">
            Runs {EVAL_PROMPTS.length} prompts through the active provider. Trust mode auto-enabled during run.
          </p>
        </div>
        {!running ? (
          <button
            onClick={startRun}
            disabled={agent.state === 'running'}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            Run All
          </button>
        ) : (
          <button
            onClick={stopRun}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/20 border border-red-500/40 text-red-300 hover:bg-red-500/30"
          >
            Stop
          </button>
        )}
      </div>

      {running && currentPrompt && (
        <div className="text-[10px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 rounded-lg px-2 py-1.5">
          Running {currentIdx + 1}/{EVAL_PROMPTS.length}: <span className="font-mono">{currentPrompt.id}</span>
          <span className="ml-2 text-gray-500">[{agent.state}]</span>
        </div>
      )}

      {/* Summary — current vs baseline */}
      {(currentSummary || baselineSummary) && (
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <SummaryCard label="Current" run={runRef.current} summary={currentSummary} />
          <SummaryCard label="Baseline" run={baseline} summary={baselineSummary} />
        </div>
      )}

      {/* Per-prompt results table */}
      {runRef.current && runRef.current.results.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] text-gray-400 grid grid-cols-12 gap-1 px-1.5">
            <div className="col-span-3">Prompt</div>
            <div className="col-span-1 text-center">Status</div>
            <div className="col-span-1 text-right">Turns</div>
            <div className="col-span-1 text-right" title="Escalations to a stronger model (sandwich router)">Esc</div>
            <div className="col-span-1 text-right">Cost</div>
            <div className="col-span-1 text-right" title="Cache hit % = hit / (hit + miss)">Cache</div>
            <div className="col-span-1 text-right">Time</div>
            <div className="col-span-3 text-right">Δ vs baseline</div>
          </div>
          {runRef.current.results.map(r => {
            const baseResult = baseline?.results.find(b => b.promptId === r.promptId);
            const delta = baseResult ? diffResult(r, baseResult) : null;
            return <ResultRow key={r.promptId} result={r} delta={delta} />;
          })}
          <p className="text-[10px] text-gray-500 italic px-1.5 pt-1">
            Anthropic cache requires explicit cache_control markers (coming in prompt-restructure PR) — expect 0% on Claude runs until then. DeepSeek caches automatically.
          </p>
        </div>
      )}

      {/* Run history */}
      {runs.length > 0 && (
        <details className="text-[10px]">
          <summary className="text-gray-400 cursor-pointer">Run history ({runs.length})</summary>
          <div className="mt-1 space-y-0.5">
            {runs.slice(0, 10).map(r => {
              const s = summarize(r);
              return (
                <div key={r.id} className="grid grid-cols-12 gap-1 text-gray-500 px-1.5 py-0.5 hover:bg-white/5 rounded">
                  <div className="col-span-5 truncate font-mono">{r.label}</div>
                  <div className="col-span-2 text-right">{s.passed}/{s.totalPrompts}</div>
                  <div className="col-span-2 text-right">${s.totalCostUSD.toFixed(3)}</div>
                  <div className="col-span-3 text-right">{new Date(r.startedAt).toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </details>
      )}
    </div>
  );
};

const SummaryCard: React.FC<{ label: string; run: EvalRun | null | undefined; summary: ReturnType<typeof summarize> | null }> = ({ label, run, summary }) => {
  if (!run || !summary) {
    return (
      <div className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5 text-gray-600">
        <div className="font-semibold text-gray-400">{label}</div>
        <div>none</div>
      </div>
    );
  }
  const passColor = summary.passRate >= 0.9 ? 'text-emerald-400' : summary.passRate >= 0.6 ? 'text-yellow-400' : 'text-red-400';
  return (
    <div className="bg-white/5 border border-white/10 rounded-lg px-2 py-1.5">
      <div className="font-semibold text-gray-300">{label} <span className="text-gray-500 font-normal">· {run.label}</span></div>
      <div className={`${passColor} font-mono`}>{summary.passed}/{summary.totalPrompts} passed</div>
      <div className="text-gray-500 font-mono">${summary.totalCostUSD.toFixed(3)} · {Math.round(summary.totalDurationMs / 1000)}s · {summary.totalTurns} turns</div>
    </div>
  );
};

const ResultRow: React.FC<{ result: EvalResult; delta: ReturnType<typeof diffResult> | null }> = ({ result, delta }) => {
  // Soft-budget check: a "pass" that exceeded expectedMaxTurns or expectedMaxCostUSD
  // is technically a pass but a regression-risk signal worth surfacing. These are
  // exactly the prompts where the sandwich router will recoup the most cost, so
  // making them visible at a glance matters for routing-strategy decisions.
  const prompt = EVAL_PROMPTS.find(p => p.id === result.promptId);
  const overTurns = prompt?.expectedMaxTurns != null && result.turns > prompt.expectedMaxTurns;
  const overCost  = prompt?.expectedMaxCostUSD != null && result.costUSD > prompt.expectedMaxCostUSD;
  const overBudget = result.status === 'passed' && (overTurns || overCost);
  const overBudgetReason = overBudget ? [
    overTurns ? `turns: ${result.turns} > ${prompt!.expectedMaxTurns}` : null,
    overCost  ? `cost: $${result.costUSD.toFixed(3)} > $${prompt!.expectedMaxCostUSD!.toFixed(3)}` : null,
  ].filter(Boolean).join(' · ') : '';

  const baseBadge = {
    passed:  { color: 'bg-emerald-500/20 text-emerald-300', text: 'pass' },
    failed:  { color: 'bg-yellow-500/20 text-yellow-300', text: 'fail' },
    errored: { color: 'bg-red-500/20 text-red-300', text: 'err' },
    pending: { color: 'bg-gray-500/20 text-gray-400', text: '...' },
    running: { color: 'bg-blue-500/20 text-blue-300', text: 'run' },
    skipped: { color: 'bg-gray-500/20 text-gray-400', text: 'skip' },
  }[result.status];
  const statusBadge = overBudget
    ? { color: 'bg-yellow-500/25 text-yellow-200', text: 'pass⚠' }  // pass + warning sign
    : baseBadge;

  // Cache hit rate over the participating tokens (hit + miss). Unitless 0..1.
  const cacheTotal = result.cacheHitTokens + result.cacheMissTokens;
  const cachePct = cacheTotal > 0 ? Math.round((result.cacheHitTokens / cacheTotal) * 100) : null;
  const cacheColor = cachePct === null ? 'text-gray-600'
    : cachePct >= 70 ? 'text-emerald-400'
    : cachePct >= 30 ? 'text-yellow-400'
    : 'text-gray-500';

  // Tint the row yellow when an over-budget pass — visible at a glance without
  // changing the column layout. Hover anywhere on the badge to see what was exceeded.
  const rowBg = overBudget ? 'bg-yellow-500/5 hover:bg-yellow-500/10' : 'hover:bg-white/5';
  // Numeric cells go yellow individually when they're the offender so the eye
  // jumps straight to the bad number, not just "row is yellow somewhere".
  const turnsColor = overTurns ? 'text-yellow-300' : 'text-gray-400';
  const costColor  = overCost  ? 'text-yellow-300' : 'text-gray-400';

  return (
    <div className={`grid grid-cols-12 gap-1 text-[10px] px-1.5 py-0.5 rounded ${rowBg}`}>
      <div className="col-span-3 font-mono text-gray-300 truncate" title={[result.errorMessage, result.finalResponse ? `Response:\n${result.finalResponse}` : ''].filter(Boolean).join('\n\n') || result.promptId}>{result.promptId}</div>
      <div className="col-span-1 text-center">
        <span className={`px-1.5 py-0.5 rounded ${statusBadge.color} font-mono`} title={overBudgetReason || undefined}>{statusBadge.text}</span>
      </div>
      <div className={`col-span-1 text-right font-mono ${turnsColor}`} title={overTurns ? `over budget (max ${prompt!.expectedMaxTurns})` : undefined}>{result.turns}</div>
      <div className="col-span-1 text-right text-gray-400 font-mono" title={`${result.escalations} escalation(s)`}>{result.escalations}</div>
      <div className={`col-span-1 text-right font-mono ${costColor}`} title={overCost ? `over budget (max $${prompt!.expectedMaxCostUSD!.toFixed(3)})` : `$${result.costUSD.toFixed(4)}`}>${result.costUSD.toFixed(3)}</div>
      <div className={`col-span-1 text-right font-mono ${cacheColor}`} title={`hit=${result.cacheHitTokens} miss=${result.cacheMissTokens}`}>
        {cachePct !== null ? `${cachePct}%` : '—'}
      </div>
      <div className="col-span-1 text-right text-gray-400 font-mono">{(result.durationMs / 1000).toFixed(0)}s</div>
      <div className="col-span-3 text-right font-mono">
        {delta ? <DeltaCell delta={delta} /> : <span className="text-gray-600">—</span>}
      </div>
    </div>
  );
};

const DeltaCell: React.FC<{ delta: NonNullable<ReturnType<typeof diffResult>> }> = ({ delta }) => {
  if (delta.isRegression) return <span className="text-red-400">REGRESSION</span>;
  if (delta.isRecovery)   return <span className="text-emerald-400">RECOVERY</span>;
  const costSign = delta.costDeltaUSD >= 0 ? '+' : '';
  const costColor = delta.costDeltaUSD > 0.001 ? 'text-yellow-400' : delta.costDeltaUSD < -0.001 ? 'text-emerald-400' : 'text-gray-500';
  const turnSign = delta.turnsDelta >= 0 ? '+' : '';
  const turnColor = delta.turnsDelta > 0 ? 'text-yellow-400' : delta.turnsDelta < 0 ? 'text-emerald-400' : 'text-gray-500';
  return (
    <span className="text-gray-500">
      <span className={costColor}>{costSign}${delta.costDeltaUSD.toFixed(4)}</span>
      <span className="mx-1">·</span>
      <span className={turnColor}>{turnSign}{delta.turnsDelta}t</span>
    </span>
  );
};
