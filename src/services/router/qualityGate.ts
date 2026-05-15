import type { QualityCheckResult, RouterConfig, TurnResult } from './types';

// ── Text similarity (Jaccard on word bigrams) ────────────────────────────────

function similarity(a: string, b: string): number {
  const bigrams = (s: string) => {
    const words = s.toLowerCase().split(/\s+/);
    const bg = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) bg.add(`${words[i]} ${words[i + 1]}`);
    return bg;
  };
  const setA = bigrams(a);
  const setB = bigrams(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ── Quality gate patterns ────────────────────────────────────────────────────

const GAVE_UP_PATTERNS = [
  /i (?:can't|cannot|am unable to)/i,
  /i don't have (?:access|the ability)/i,
  /unfortunately.*(?:can't|cannot)/i,
  /as an ai.*(?:can't|cannot|don't)/i,
  /i'm not able to/i,
  /please (?:provide|paste|share|copy)/i,       // Asking user to do the work
  /you (?:can|could|should|need to) (?:provide|paste|share|copy)/i,
  /would you like (?:me to|to)/i,               // Asking for confirmation instead of acting
];

const HALLUCINATION_SIGNALS = [
  /as of my (?:last|knowledge) (?:update|cutoff)/i,
  /i (?:think|believe) (?:it|the answer) (?:is|might be)/i,
];

// ── Main quality check ──────────────────────────────────────────────────────

export function checkQuality(
  turnResult: TurnResult,
  userMessage: string,
  config: RouterConfig,
): QualityCheckResult {
  const failures: string[] = [];
  let score = 1.0;

  // CHECK 1: Empty or too short response
  if (turnResult.response.length < config.minResponseLength) {
    failures.push('Response too short — likely early exit');
    score -= 0.4;
  }

  // CHECK 2: Flash gave up / apologized without trying
  if (GAVE_UP_PATTERNS.some(p => p.test(turnResult.response))) {
    failures.push('Flash gave up without attempting the task');
    score -= 0.5;
  }

  // CHECK 3: Tool calls all failed
  const failedTools = turnResult.toolCalls.filter(t => !t.success);
  if (failedTools.length >= config.maxEmptyToolCalls) {
    failures.push(`${failedTools.length} tool calls failed`);
    score -= 0.3;
  }

  // CHECK 4: No tool calls when task clearly needed them — STRONG penalty in agent mode
  const taskNeedsTools = /\b(search|find|read|open|create|write|check|look\s*up|fetch|analyze|generate|build|make|extract|summarize|compare)\b/i.test(userMessage);
  if (taskNeedsTools && turnResult.toolCalls.length === 0) {
    failures.push('Task needed tool use but Flash made no tool calls');
    score -= 0.5;  // was 0.3 — mid-execution text-only responses MUST retry
  }

  // CHECK 4b: Response is announcing FUTURE actions instead of taking them.
  // Catches two patterns:
  //   (a) starts with "I'll" / "Let me..." (original check)
  //   (b) mid-sentence "I will now process...", "I'll then generate..." — the real failure mode
  //       where Flash reads the file, explains, then describes what it WILL do without doing it.
  const startsWithPromise = /^(?:I'll|Let me|I will|I can|I'm going to)\b/i.test(turnResult.response.trim());
  const midPromisesFutureAction = /(?:^|[.!?]\s+)(?:I'll|I will|I'm going to|Let me|Next[,.]?\s+I(?:'ll| will)?|Now[,.]?\s+I(?:'ll| will)?|Then[,.]?\s+I(?:'ll| will)?)\s+(?:now\s+)?(?:process|generate|create|build|write|extract|analyze|save|run|execute|produce|make|prepare|compile)/i.test(turnResult.response);
  const justPlanning = (startsWithPromise || midPromisesFutureAction) && turnResult.toolCalls.length === 0;
  if (justPlanning) {
    failures.push('Flash described future actions instead of calling tools');
    score -= 0.5;  // bumped from 0.4 — common and expensive failure mode
  }

  // CHECK 5: Response is just echoing the question
  if (turnResult.response.length > 0 && similarity(userMessage, turnResult.response) > 0.7) {
    failures.push('Response too similar to input — likely echo');
    score -= 0.4;
  }

  // CHECK 6: Hallucination signals (hedging without tool verification)
  if (HALLUCINATION_SIGNALS.some(p => p.test(turnResult.response)) && turnResult.toolCalls.length === 0) {
    failures.push('Possible hallucination — hedging without tool verification');
    score -= 0.2;
  }

  return {
    passed: score >= 0.5,
    score: Math.max(0, score),
    failures,
  };
}
