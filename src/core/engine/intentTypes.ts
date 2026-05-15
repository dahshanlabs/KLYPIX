// ============================================================
// intentTypes.ts  —  Project Eye / Klypix
// Phase 3.1: Intent Engine — Type Definitions
// ============================================================

/**
 * All supported action intent types.
 * Commands that don't match any of these fall through to the LLM chat path.
 */
export type IntentType =
  // ── File System ─────────────────────────────────────────
  | 'file_save'         // "save this", "save to desktop"
  | 'file_rename'       // "rename this to report_final.pdf"
  | 'file_move'         // "move this to my Documents folder"
  | 'file_create'       // "create a new file called notes.txt"
  | 'file_delete'       // "delete this file"
  // ── Clipboard ───────────────────────────────────────────
  | 'clipboard_save'    // "save clipboard content to a file"
  | 'clipboard_copy'    // "copy the AI response to clipboard"
  // ── Browser Automation ──────────────────────────────────
  | 'browser_navigate'  // "go to linkedin.com"
  | 'browser_fill'      // "fill the name field with John"
  | 'browser_click'     // "click the Submit button"
  | 'browser_scroll'    // "scroll down on this page"
  // ── System / OS ─────────────────────────────────────────
  | 'system_open'       // "open Notepad", "launch Excel"
  | 'system_type'       // "type: Hello World"
  | 'system_click'      // "click the OK button"
  | 'system_screenshot' // "take a screenshot and save it"
  | 'system_close'      // "close Notepad", "kill Chrome"
  // ── Fallback ────────────────────────────────────────────
  | 'chat';             // Not an action — route to LLM

// ────────────────────────────────────────────────────────────

/**
 * The active context that is injected into the intent classifier prompt.
 * Mirrors what your existing getActiveWindowInfo() + readActiveFile() already provide.
 */
export interface WindowContext {
  windowTitle:   string;
  processName:   string;
  filePath:      string | null;
  fileName:      string | null;
  browserUrl:    string | null;
  textContent:   string | null;  // parsed file/page text (truncated for prompt)
}

// ────────────────────────────────────────────────────────────

/**
 * A resolved, structured intent returned by the Intent Engine.
 * All string parameter values are fully resolved at classification time
 * (e.g., "the current file" → "C:\\Users\\HP\\Downloads\\report.pdf").
 */
export interface Intent {
  /** The classified action type */
  type: IntentType;

  /** Confidence score 0.0 – 1.0. Actions below INTENT_THRESHOLD are dropped. */
  confidence: number;

  /** Fully resolved parameters extracted from the command + context */
  parameters: IntentParameters;

  /** The original raw command text from the user */
  rawCommand: string;

  /**
   * Human-readable description shown in the Confirmation Modal.
   * Example: "Will rename 'report.pdf' → 'Q4_Report_Final.pdf'"
   */
  previewDescription: string;

  /**
   * If true → always show the Confirmation Modal before executing.
   * If false → show a 3-second auto-execute toast (cancellable).
   * Destructive actions (delete, overwrite) must always be true.
   */
  requiresConfirmation: boolean;

  /** ISO timestamp of when this intent was classified */
  classifiedAt: string;
}

// ────────────────────────────────────────────────────────────

/**
 * Union of all possible parameter shapes, keyed by IntentType.
 * The Action Executor narrows to the correct shape at dispatch time.
 */
export type IntentParameters =
  | FileIntentParams
  | ClipboardIntentParams
  | BrowserIntentParams
  | SystemIntentParams
  | Record<string, never>;  // empty for 'chat'

export interface FileIntentParams {
  /** Resolved absolute path of the source file (if known from context) */
  sourcePath?:   string;
  /** Resolved absolute destination path or directory */
  destination?:  string;
  /** New filename for rename/create operations */
  newName?:      string;
  /** Text content for file_create */
  content?:      string;
}

export interface ClipboardIntentParams {
  /** Destination path/directory for clipboard_save */
  destination?: string;
  /** Filename to save clipboard content as */
  filename?:    string;
}

export interface BrowserIntentParams {
  /** Full URL for browser_navigate */
  url?:              string;
  /** CSS selector or description for the target element */
  selector?:         string;
  /** Value to type into a field */
  value?:            string;
  /** Human description of element to click (Playwright locator text) */
  targetDescription?: string;
}

export interface SystemIntentParams {
  /** Application name for system_open */
  appName?:   string;
  /** Executable path override */
  appPath?:   string;
  /** Text to type for system_type */
  text?:      string;
  /** Human description of the UI element to click */
  targetDescription?: string;
}

// ────────────────────────────────────────────────────────────

/** Result returned by the Action Executor after running an intent */
export interface ActionResult {
  success:     boolean;
  intentType:  IntentType;
  message:     string;
  /** Reversible: if set, the executor stored enough info to undo this action */
  undoPayload?: unknown;
  executedAt:  string;
}

/** The response shape that aiRouter returns when an intent is intercepted */
export interface ActionPendingResponse {
  type:   'action_pending';
  intent: Intent;
}

/** The response shape that aiRouter returns for normal chat */
export interface ChatResponse {
  type:    'chat';
  content: string;
  stream?: AsyncIterable<string>;
}

export type RouterResponse = ActionPendingResponse | ChatResponse;

// ────────────────────────────────────────────────────────────

/** Minimum confidence to treat a classification as a valid intent */
export const INTENT_THRESHOLD = 0.80;

/** Confidence below which we silently treat as chat (not even a toast) */
export const INTENT_MIN_CONFIDENCE = 0.50;
