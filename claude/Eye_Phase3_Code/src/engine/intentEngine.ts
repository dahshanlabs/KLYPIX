// ============================================================
// intentEngine.ts  —  Project Eye / ALT+Space
// Phase 3.1: Intent Engine — Classifier
// ============================================================
//
// This module is the FIRST interceptor in the command pipeline.
// It runs before any LLM chat routing. If a structured intent
// is found with confidence ≥ INTENT_THRESHOLD, the command
// never reaches the chat LLM — it goes to the Action Executor.
//
// Usage (from aiRouter.ts):
//   import { classifyIntent } from './intentEngine';
//   const intent = await classifyIntent(userCommand, activeWindowContext);
//   if (intent) { /* → Action Engine */ } else { /* → LLM chat */ }
// ============================================================

import {
  Intent,
  IntentType,
  WindowContext,
  INTENT_THRESHOLD,
  INTENT_MIN_CONFIDENCE,
} from './intentTypes';

// ── Import your existing Gemini caller ──────────────────────
// Adjust this path to match where your gemini.ts lives
import { callGeminiFlash } from '../api/gemini';

// ────────────────────────────────────────────────────────────
// INTENT CLASSIFICATION PROMPT
// ────────────────────────────────────────────────────────────

const INTENT_SYSTEM_PROMPT = `
You are an intent classifier for a desktop AI assistant called Eye (ALT+Space).
Your ONLY job is to determine whether a user command is an EXECUTABLE ACTION or a CHAT MESSAGE.

Active window context (use this to resolve file paths, URLs, etc.):
  Window Title : {{WINDOW_TITLE}}
  Process      : {{PROCESS_NAME}}
  Active File  : {{FILE_PATH}}
  File Name    : {{FILE_NAME}}
  Browser URL  : {{BROWSER_URL}}

────────────────────────────────────────────────
EXECUTABLE INTENT TYPES (return one of these):
────────────────────────────────────────────────
  file_save         — "save this", "save to desktop", "save as X"
  file_rename       — "rename this to X", "rename X to Y"
  file_move         — "move this to Documents", "move X to Y"
  file_create       — "create a new file", "make a text file called X"
  file_delete       — "delete this", "remove the file", "trash X"
  clipboard_save    — "save clipboard to a file", "write clipboard to X"
  clipboard_copy    — "copy the response", "copy to clipboard"
  browser_navigate  — "go to X", "open X.com", "navigate to URL"
  browser_fill      — "fill X with Y", "type Y into the X field"
  browser_click     — "click the X button on the page"
  browser_scroll    — "scroll down", "scroll to bottom"
  system_open       — "open X", "launch X", "start X"
  system_type       — "type: X", "write X", "input X"
  system_click      — "click the X button", "press X"
  system_screenshot — "screenshot", "take a screenshot", "capture screen"

────────────────────────────────────────────────
RESPONSE FORMAT — return ONLY valid JSON, no markdown, no commentary:
────────────────────────────────────────────────

If the command IS an action intent:
{
  "type": "<intent_type_from_list_above>",
  "confidence": <0.0 to 1.0>,
  "parameters": {
    "sourcePath"        : "<resolved absolute path, or null>",
    "destination"       : "<resolved absolute path or directory, or null>",
    "newName"           : "<filename string, or null>",
    "content"           : "<text content for file_create, or null>",
    "url"               : "<full URL, or null>",
    "selector"          : "<CSS selector or element description, or null>",
    "value"             : "<value to type or fill, or null>",
    "targetDescription" : "<human label of UI element, or null>",
    "appName"           : "<application name, or null>",
    "text"              : "<text to type for system_type, or null>"
  },
  "previewDescription": "<one sentence: exactly what will happen, e.g. Will save report.pdf to C:\\Users\\HP\\Desktop>",
  "requiresConfirmation": <true for destructive/irreversible actions, false for safe ones>
}

If the command is a QUESTION, CONVERSATION, or ANALYSIS REQUEST — return exactly:
null

────────────────────────────────────────────────
RULES:
- Resolve "this file", "the current document", "it" → use the Active File path above.
- Resolve "desktop" → C:\\Users\\HP\\Desktop  (standard Windows path).
- Resolve "documents" → C:\\Users\\HP\\Documents.
- If the active file path is unknown (null) and the command requires a file, set confidence ≤ 0.60.
- Set requiresConfirmation=true for: file_delete, file_move, file_rename, file_save (overwrite risk).
- Set requiresConfirmation=false for: clipboard_copy, browser_navigate, system_screenshot, system_open.
- Confidence should reflect how certain you are this is an action, not a chat query.
  - "save this to my desktop" → 0.97
  - "can you save this" → 0.85 (slightly ambiguous)
  - "what does save mean" → 0.05 (chat question)
`.trim();

// ────────────────────────────────────────────────────────────
// MAIN EXPORT
// ────────────────────────────────────────────────────────────

/**
 * Classifies a user command into a structured Intent, or returns null
 * if the command should be handled by the LLM chat path.
 *
 * @param command   Raw user text from the overlay input
 * @param context   Current window/file/URL context from main process
 * @returns         Resolved Intent object, or null for chat fallback
 */
export async function classifyIntent(
  command: string,
  context: WindowContext
): Promise<Intent | null> {
  // Skip classification for very short inputs — almost certainly not actions
  if (command.trim().length < 4) return null;

  const filledPrompt = INTENT_SYSTEM_PROMPT
    .replace('{{WINDOW_TITLE}}', context.windowTitle  || 'Unknown')
    .replace('{{PROCESS_NAME}}', context.processName  || 'Unknown')
    .replace('{{FILE_PATH}}',    context.filePath     || 'null')
    .replace('{{FILE_NAME}}',    context.fileName     || 'null')
    .replace('{{BROWSER_URL}}',  context.browserUrl   || 'null');

  let rawResponse: string;
  try {
    rawResponse = await callGeminiFlash(filledPrompt, command, {
      maxOutputTokens: 400,
      temperature:     0.1,   // Low temperature for deterministic classification
    });
  } catch (err) {
    console.error('[IntentEngine] Gemini call failed:', err);
    return null;   // Fail safe → fall through to chat
  }

  return parseIntentResponse(rawResponse, command);
}

// ────────────────────────────────────────────────────────────
// RESPONSE PARSER
// ────────────────────────────────────────────────────────────

function parseIntentResponse(raw: string, originalCommand: string): Intent | null {
  // Strip markdown code fences if model wraps response
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/,           '')
    .trim();

  if (cleaned === 'null' || cleaned === '') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.warn('[IntentEngine] Failed to parse JSON response:', cleaned);
    return null;
  }

  if (parsed === null) return null;

  // ── Type guard & validation ──────────────────────────────
  if (!isValidIntentShape(parsed)) {
    console.warn('[IntentEngine] Invalid intent shape:', parsed);
    return null;
  }

  const intent = parsed as RawIntentResponse;

  // ── Apply confidence threshold ───────────────────────────
  if (intent.confidence < INTENT_MIN_CONFIDENCE) {
    return null;   // Below noise floor — treat as chat
  }

  // ── Build final Intent object ────────────────────────────
  const result: Intent = {
    type:                 intent.type as IntentType,
    confidence:           intent.confidence,
    parameters:           sanitizeParameters(intent.parameters),
    rawCommand:           originalCommand,
    previewDescription:   intent.previewDescription || `Execute: ${intent.type}`,
    requiresConfirmation: intent.requiresConfirmation ?? true,
    classifiedAt:         new Date().toISOString(),
  };

  // Emit to console in dev mode for easy debugging
  if (process.env.NODE_ENV === 'development') {
    console.log(
      `[IntentEngine] ✓ Intent: ${result.type} (${Math.round(result.confidence * 100)}%) — "${originalCommand}"`
    );
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// VALIDATION HELPERS
// ────────────────────────────────────────────────────────────

const VALID_INTENT_TYPES: IntentType[] = [
  'file_save', 'file_rename', 'file_move', 'file_create', 'file_delete',
  'clipboard_save', 'clipboard_copy',
  'browser_navigate', 'browser_fill', 'browser_click', 'browser_scroll',
  'system_open', 'system_type', 'system_click', 'system_screenshot',
  'chat',
];

interface RawIntentResponse {
  type:                 string;
  confidence:           number;
  parameters:           Record<string, string | null>;
  previewDescription:   string;
  requiresConfirmation: boolean;
}

function isValidIntentShape(obj: unknown): obj is RawIntentResponse {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['type']       === 'string'  &&
    typeof o['confidence'] === 'number'  &&
    o['confidence'] >= 0   &&
    o['confidence'] <= 1   &&
    VALID_INTENT_TYPES.includes(o['type'] as IntentType) &&
    typeof o['parameters'] === 'object'  &&
    o['parameters'] !== null
  );
}

/**
 * Remove null values and trim strings in the parameters object.
 */
function sanitizeParameters(
  raw: Record<string, string | null>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (val !== null && val !== 'null' && val.trim() !== '') {
      result[key] = val.trim();
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────────
// UTILITY: Check if a classified intent meets execution threshold
// Call this in aiRouter.ts to decide whether to route to actions
// ────────────────────────────────────────────────────────────

export function meetsExecutionThreshold(intent: Intent): boolean {
  return intent.confidence >= INTENT_THRESHOLD;
}

// ────────────────────────────────────────────────────────────
// UTILITY: Quick rule-based pre-filter (runs BEFORE the Gemini call)
// If the command very clearly cannot be an action, skip the API call
// entirely to save latency. Conservative — only blocks obvious cases.
// ────────────────────────────────────────────────────────────

const CHAT_ONLY_PATTERNS: RegExp[] = [
  /^(what|why|how|who|when|where|explain|tell me|describe|define|is|are|can|could|should|would|do|does|did)\b/i,
  /^(summarize|summary|analyse|analyze|review|compare|list|show me|give me|write|draft|generate|create a report|make a plan)\b/i,
  /\?$/,   // ends with a question mark
];

/**
 * Returns true if the command almost certainly doesn't need intent classification.
 * Used to short-circuit the Gemini call for obvious chat messages.
 */
export function isObviousChatMessage(command: string): boolean {
  const trimmed = command.trim();
  // Very short commands are likely actions ("save this", "go to gmail.com")
  if (trimmed.split(' ').length <= 5) return false;
  return CHAT_ONLY_PATTERNS.some(p => p.test(trimmed));
}
