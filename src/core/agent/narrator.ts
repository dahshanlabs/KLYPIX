import { callGeminiFlash } from '../../api/gemini';
import { narrationStore } from './narrationStore';

/**
 * Narrator layer — fires a tiny Gemini Flash call between agent turns to surface
 * a "what's happening next" status line in the UI. Designed for one purpose:
 * make the agent feel alive while reasoning models (DeepSeek V4-Pro, o3) are
 * silently thinking.
 *
 * HARD CONSTRAINTS — these are non-negotiable:
 *   1. Fire-and-forget. dispatchNarration() returns void immediately. The
 *      narration call runs in the background; the agent loop never awaits it.
 *      If Gemini Flash is slow, down, rate-limited, or returns garbage, the
 *      loop continues unaffected.
 *   2. 500ms timeout. If the narration doesn't arrive in 500ms, it's discarded
 *      entirely. Better silence than stale narration.
 *   3. Turn-tagged. Every dispatch records the active turn ID. Late arrivals
 *      whose turn has already passed are dropped — no "Reading PDF..." showing
 *      up while the agent is now writing the email.
 *
 * Cost per dispatch is ~$0.00001-0.00005 on Gemini Flash. Negligible.
 */

const NARRATION_TIMEOUT_MS = 500;

/**
 * Monotonic counter — bumped at the start of every agent run. Pending narrations
 * from a prior run are silently discarded when this changes. Module-level int
 * is intentional: the narrator must work outside any React tree or class.
 */
let currentSessionId = 0;

export interface NarrationContext {
  /** The user's original prompt — gives the model goal context. */
  goal: string;
  /** Name of the most recently completed tool call. */
  lastToolName: string;
  /** Truncated tool result so the model can pick a relevant next-step phrase. */
  lastToolResult?: string;
  /** Turn number within the current session — used for the turn-tag check. */
  turnNumber: number;
}

/** Call at the start of each agent run. Bumps the session counter (invalidates
 *  any in-flight narrations from the prior run) and clears the displayed line. */
export function startNarrationSession(): void {
  currentSessionId++;
  narrationStore.clear();
}

/** Call when an agent run ends (success/error/abort). Clears the displayed line. */
export function endNarrationSession(): void {
  narrationStore.clear();
}

/**
 * Spawn a narration call for the current turn. Returns void immediately —
 * the caller MUST NOT await this. Resolution writes to narrationStore on
 * success, no-ops on timeout or failure.
 */
export function dispatchNarration(ctx: NarrationContext): void {
  const sessionAtDispatch = currentSessionId;
  const turnAtDispatch = ctx.turnNumber;

  // void marker is deliberate: linters know we're choosing not to await.
  void (async () => {
    try {
      const result = await Promise.race([
        callGeminiFlash(NARRATOR_SYSTEM_PROMPT, buildUserContent(ctx), {
          maxOutputTokens: 30,
          temperature: 0.3,
        }),
        new Promise<null>(resolve => setTimeout(() => resolve(null), NARRATION_TIMEOUT_MS)),
      ]);

      if (result === null) return; // timeout — discard
      if (sessionAtDispatch !== currentSessionId) return; // session moved on — discard

      const text = sanitizeNarration(result);
      if (!text) return;

      // Last-mile guard: if the displayed line is already from a later turn
      // (another dispatch beat us back), don't overwrite it. The store doesn't
      // know about turns directly; this check defends against the rare
      // out-of-order race where two narrations resolve nearly simultaneously.
      const tagged = `__t${turnAtDispatch}__${text}`;
      narrationStore.set(tagged.slice(`__t${turnAtDispatch}__`.length));
    } catch {
      // Silent — narration failures must never surface to the user.
    }
  })();
}

const NARRATOR_SYSTEM_PROMPT = [
  'You narrate an AI agent\'s progress to the user in real-time.',
  'Output ONE short status sentence — 5 to 10 words — in present continuous tense.',
  'Examples: "Reading the PDF now...", "Drafting the email...", "Looking up the file path...", "Scanning Downloads folder..."',
  'No quotes. No prefix. No emoji. Just the sentence.',
].join('\n');

function buildUserContent(ctx: NarrationContext): string {
  const truncResult = (ctx.lastToolResult || '').slice(0, 200);
  return [
    `Goal: ${ctx.goal.slice(0, 200)}`,
    `Just finished: ${ctx.lastToolName}`,
    truncResult ? `Result snippet: ${truncResult}` : '',
    'What is the agent likely doing next? One short sentence.',
  ].filter(Boolean).join('\n');
}

/** Trim, strip surrounding quotes, cap length. Defensive against model drift. */
function sanitizeNarration(raw: string): string {
  let s = raw.trim();
  // Strip wrapping quotes if the model added them despite the prompt.
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  // Take only the first line if the model emitted multiple.
  s = s.split('\n')[0].trim();
  // Cap at 100 chars — UI is single-line.
  if (s.length > 100) s = s.slice(0, 97) + '...';
  return s;
}
