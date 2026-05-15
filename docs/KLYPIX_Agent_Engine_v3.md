# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Agent Engine v3 - Production Integration Guide

## claw-code Architecture -> TypeScript Agent Loop (Production-Ready)

**Dahshan Labs | April 2026 | v3.0**

**Screen-First + Deep Tools + Terminal = Full Agent**

This is the production-ready version. Every gap from the v2 audit is addressed: streaming responses, smart routing, error recovery, shell security, cost tracking, tier integration, sessionContext/memoryStore hookup.

---

## Table of Contents

1. Architecture Overview
2. Capability Audit (verified with line numbers)
3. New IPC Handlers (5 handlers + 3 security handlers)
4. Preload Bridge Additions
5. Smart Router (smartRouter.ts) - Auto Chat/Agent Detection
6. Tool Registry (tools.ts) - 22 Tools with Permission Tiers
7. Permission System (permissions.ts) - Allow/Deny/Trust Mode
8. Shell Security (shellGuard.ts) - Command Sanitization
9. Tool Executor (toolExecutor.ts) - IPC Bridge
10. Agent Loop with STREAMING (claudeAgent.ts) - The Core Engine
11. Cost Tracker (costTracker.ts) - Token Counting + Budget
12. Session Manager + Integration (agentSession.ts)
13. React Hook (useClaudeAgent.ts)
14. UI Components - WorkflowPanel + PermissionTabs
15. App.tsx Integration - Smart Mode Router
16. Settings UI - Claude API Key + Cost Display
17. File Map and Build Order
18. 20 Real User Scenarios (with cost estimates)

---

## 1. Architecture Overview

The KLYPIX Agent Engine translates the claw-code open-source agent loop pattern (Rust crates) into TypeScript that runs inside your existing Electron app.

### Three-Layer Tool Architecture

- **SCREEN LAYER:** Screenshot capture, active window context, screen OCR. KLYPIX's killer advantage. Claude sees what the user sees, zero friction.
- **DEEP TOOLS LAYER:** File I/O (read/write/edit/list), document generation (DOCX/XLSX/PPTX/PDF), web content reading, clipboard, browser automation via CDP.
- **TERMINAL LAYER:** Shell command execution via PowerShell with security guardrails. npm, git, python, anything — but with command sanitization and audit logging.

### What v3 Adds Over v2

| Gap from v2 Audit | v3 Solution |
|---|---|
| No streaming (dead UI during thinking) | `messages.stream()` with real-time token-by-token text + live tool call display |
| Manual mode toggle (user must predict) | Smart Router using Gemini Flash (~0.3s, free) to auto-classify chat vs agent |
| No error recovery | Retry with exponential backoff on 429/500, tool execution timeouts, graceful degradation |
| Shell execution with no guardrails | `shellGuard.ts` with dangerous command blocklist, path restrictions, audit log |
| No cost tracking | `costTracker.ts` counts tokens per run, shows estimated cost, enforces budget caps |
| No tier integration | Auth guard checks `canUseFeature('agentMode')` before agent runs |
| No sessionContext integration | Agent results flow into `sessionContext.ts` (analyzedFiles, screenAnalyses, generatedDocs) |
| No memoryStore integration | Agent conversations saved to memoryStore with type `'agent'` |
| Model hardcoded | Configurable model selection, defaults to `claude-sonnet-4-20250514` |
| No integration with existing intent engine | Smart Router uses intentEngine classification as first pass before deciding routing |

### Request Flow (v3)

```
User types prompt + Alt+Space
        |
        v
[Pre-capture: screenshot + window context] (existing, unchanged)
        |
        v
[Smart Router] (NEW - uses Gemini Flash, ~0.3s, free)
        |
        +---> Simple question?  --> Gemini Chat (existing, unchanged)
        |
        +---> Single action?    --> Intent Engine -> executeAction (existing, unchanged)
        |
        +---> Multi-step task?  --> Claude Agent Engine (NEW)
        |                              |
        |                              v
        |                       [Tier Check: canUseFeature('agentMode')]
        |                              |
        |                              v
        |                       [Agent Loop with Streaming]
        |                         - Claude API (streaming)
        |                         - Tool calls with permission gates
        |                         - Shell commands with security guard
        |                         - Cost tracking per turn
        |                         - Error recovery with retries
        |                              |
        |                              v
        |                       [Results -> sessionContext + memoryStore]
        |
        +---> Ambiguous?        --> Gemini Chat (default to fast/free)
```

---

## 2. Capability Audit (Verified Against Code)

### EXISTING - Ready to wire as Claude tools

| Capability | IPC Channel | Verified | Notes |
|---|---|---|---|
| capture_screen | capture-screen | main.ts:728 | Full screen via desktopCapturer |
| capture_screen_raw | capture-screen-raw | main.ts:751 | Returns buffer |
| get_window_context | get-active-window-context | main.ts:888 | Title + process name |
| read_active_file | read-active-file | main.ts:1208 | Foreground window file content |
| get_all_open_files | get-all-open-files | main.ts:2794 | EnumWindows+UIA+CDP+Sessions |
| read_multiple_files | read-multiple-files | main.ts:3355 | Batch file reader |
| read_web_content | read-web-content | main.ts:2238 | Fetch+cheerio+CDP fallback |
| read_clipboard | read-clipboard | main.ts:892 | clipboard.readText() |
| generate_file | generate-file | main.ts:2524 | DOCX/XLSX/PPTX/PDF |
| system_open | eye:execute-action | main.ts:918 | shell.openPath + exec |
| system_type | eye:execute-action | main.ts:930 | SendKeys via PowerShell |
| system_close | eye:execute-action | main.ts:985 | CloseMainWindow |
| file_save/rename/move | eye:execute-action | main.ts:993-1048 | fs operations |
| file_create | eye:execute-action | main.ts:1028 | fs.writeFileSync |
| file_delete | eye:execute-action | main.ts:1050 | shell.trashItem (recycle bin) |
| clipboard_copy/save | eye:execute-action | main.ts:1060-1088 | clipboard.writeText / save to file |
| browser_navigate | eye:execute-action | main.ts:1090 | shell.openExternal |
| browser_fill/click/scroll | eye:execute-action | main.ts:1098-1115 | CDP + SendKeys fallback |

### TO BUILD - New IPC handlers

| Handler | Purpose | Lines |
|---|---|---|
| run-shell-command | PowerShell execution with security | ~35 |
| read-file-at-path | Read any file by path | ~15 |
| write-file-at-path | Write content to any path | ~15 |
| edit-file-content | Find-and-replace in file | ~20 |
| list-directory | List files/folders | ~15 |
| claude-key:store | Encrypted Claude API key storage | ~15 |
| claude-key:get | Retrieve Claude API key | ~10 |
| claude-key:clear | Delete Claude API key | ~5 |

---

## 3. New IPC Handlers for main.ts

### Handler 1: run-shell-command (with security)

```typescript
// -- Agent: Shell Command Execution (SECURED) --
ipcMain.handle('run-shell-command', async (_event: any, { command, cwd, timeout }: {
  command: string; cwd?: string; timeout?: number;
}) => {
  console.log('[Agent] Shell:', command.substring(0, 100));

  // Security: check against blocklist (renderer also checks, this is defense-in-depth)
  const blocked = [
    /format\s+[a-zA-Z]:/i,           // format drives
    /del\s+\/[sS]/i,                  // recursive delete
    /rm\s+-rf\s+[\/\\]/i,            // rm -rf /
    /Remove-Item.*-Recurse.*-Force/i, // PowerShell recursive force delete
    /Stop-Computer/i,                 // shutdown
    /Restart-Computer/i,              // restart
    /Clear-RecycleBin/i,              // empty trash
    /reg\s+(delete|add)/i,            // registry modification
    /Set-ExecutionPolicy/i,           // change PS execution policy
    /New-Service/i,                   // create services
    /sc\s+(create|delete)/i,          // service control
    /netsh\s+advfirewall/i,           // firewall changes
    /icacls.*\/grant/i,               // permission changes
    /takeown/i,                       // take ownership
    /cipher\s+\/[eE]/i,              // encrypt files
    /Invoke-WebRequest.*\|\s*iex/i,   // download and execute
    /Invoke-Expression/i,             // arbitrary code execution from string
    /Start-Process.*-Verb\s+RunAs/i,  // elevate to admin
  ];

  for (const pattern of blocked) {
    if (pattern.test(command)) {
      console.warn('[Agent] BLOCKED dangerous command:', command.substring(0, 80));
      return {
        success: false,
        stdout: '',
        stderr: `Command blocked by security policy: matches pattern ${pattern.source}`,
        code: -1,
        blocked: true,
      };
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: cwd || require('os').homedir(),
      timeout: timeout || 30000,
      maxBuffer: 1024 * 1024 * 5, // 5MB
      encoding: 'utf8',
      shell: 'powershell.exe',
    });
    return { success: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    return {
      success: false,
      stdout: err.stdout?.trim() || '',
      stderr: err.stderr?.trim() || err.message,
      code: err.code,
    };
  }
});
```

### Handler 2: read-file-at-path

```typescript
ipcMain.handle('read-file-at-path', async (_event: any, { filePath, maxChars }: {
  filePath: string; maxChars?: number;
}) => {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > 10 * 1024 * 1024) {
      return { success: false, error: 'File too large (>10MB)' };
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const limit = maxChars || 100000;
    return {
      success: true,
      content: content.length > limit ? content.slice(0, limit) + '\n[...truncated]' : content,
      size: content.length,
      path: filePath,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

### Handler 3: write-file-at-path

```typescript
ipcMain.handle('write-file-at-path', async (_event: any, { filePath, content }: {
  filePath: string; content: string;
}) => {
  try {
    const dir = require('path').dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, path: filePath, size: content.length };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

### Handler 4: edit-file-content

```typescript
ipcMain.handle('edit-file-content', async (_event: any, { filePath, oldText, newText }: {
  filePath: string; oldText: string; newText: string;
}) => {
  try {
    let content = fs.readFileSync(filePath, 'utf-8');
    if (!content.includes(oldText)) {
      return { success: false, error: 'oldText not found in file' };
    }
    content = content.replace(oldText, newText);
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true, path: filePath };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

### Handler 5: list-directory

```typescript
ipcMain.handle('list-directory', async (_event: any, { dirPath }: { dirPath: string }) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return {
      success: true,
      entries: entries.slice(0, 200).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined,
      })),
      total: entries.length,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

### Handlers 6-8: Claude Key Storage (Encrypted)

```typescript
ipcMain.handle('claude-key:store', (_event: any, key: string) => {
  try {
    const encrypted = safeStorage.encryptString(key);
    fs.writeFileSync(path.join(app.getPath('userData'), 'claude_key.enc'), encrypted);
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('claude-key:get', () => {
  try {
    const encPath = path.join(app.getPath('userData'), 'claude_key.enc');
    if (!fs.existsSync(encPath)) return null;
    return safeStorage.decryptString(fs.readFileSync(encPath));
  } catch { return null; }
});

ipcMain.handle('claude-key:clear', () => {
  const p = path.join(app.getPath('userData'), 'claude_key.enc');
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { success: true };
});
```

---

## 4. Preload Bridge Additions

Add to electron/preload.ts inside `contextBridge.exposeInMainWorld('electron', {...})`:

```typescript
// -- Agent Engine (Claude) --
agent: {
  runShell: (opts: { command: string; cwd?: string; timeout?: number }) =>
    ipcRenderer.invoke('run-shell-command', opts),
  readFile: (opts: { filePath: string; maxChars?: number }) =>
    ipcRenderer.invoke('read-file-at-path', opts),
  writeFile: (opts: { filePath: string; content: string }) =>
    ipcRenderer.invoke('write-file-at-path', opts),
  editFile: (opts: { filePath: string; oldText: string; newText: string }) =>
    ipcRenderer.invoke('edit-file-content', opts),
  listDir: (opts: { dirPath: string }) =>
    ipcRenderer.invoke('list-directory', opts),
},
claudeKey: {
  store: (key: string) => ipcRenderer.invoke('claude-key:store', key),
  get: () => ipcRenderer.invoke('claude-key:get'),
  clear: () => ipcRenderer.invoke('claude-key:clear'),
},
```

---

## 5. Smart Router - src/core/agent/smartRouter.ts

This replaces the manual toggle. Uses your existing Gemini Flash (free, ~0.3s) to classify whether a prompt needs the agent or just chat. Falls back to existing intent engine for single actions.

```typescript
// === src/core/agent/smartRouter.ts ===
// Smart routing: Gemini Flash classifies prompt -> chat / single-action / agent

import { callGeminiFlash } from '../../api/gemini';
import { classifyIntent } from '../engine/intentEngine';
import type { WindowContext } from '../../types';

export type RouteDecision = 'gemini_chat' | 'intent_action' | 'claude_agent';

interface RouteResult {
  route: RouteDecision;
  reason: string;
  confidence: number;
  intent?: any; // If route is intent_action, includes the classified intent
}

const ROUTER_PROMPT = `You are a routing classifier for a desktop AI assistant.
Given a user prompt, classify it into exactly ONE category:

CHAT — Simple questions, explanations, translations, math, conversation.
  Examples: "what is 15% of 340", "explain recursion", "translate hello to Arabic"

ACTION — Single desktop action that can be done in one step.
  Examples: "open Calculator", "save this file", "rename this to report.pdf"

AGENT — Multi-step tasks that need reading files, running commands, creating things, or chaining multiple actions.
  Examples: "read this file and fix the errors", "set up a React project",
  "compare these spreadsheets and make a report", "find the bug and fix it",
  "organize my Downloads folder", "install these packages and configure them"

Keywords that strongly suggest AGENT:
  - "and then", "after that", "also"
  - "fix", "debug", "set up", "create project", "install"
  - "compare", "analyze", "research and write"
  - "find all", "organize", "sort", "clean up"
  - Multi-verb sentences ("read X and write Y")

Active window: {{WINDOW}} ({{PROCESS}})

Respond with ONLY one word: CHAT, ACTION, or AGENT`;

export async function routePrompt(
  prompt: string,
  windowContext: WindowContext | null,
  hasClaudeKey: boolean,
): Promise<RouteResult> {
  // Fast path: no Claude key = never agent
  if (!hasClaudeKey) {
    // Still check for single actions via intent engine
    try {
      const intent = await classifyIntent(prompt, windowContext || undefined);
      if (intent && intent.confidence >= 0.80) {
        return { route: 'intent_action', reason: 'Single action detected', confidence: intent.confidence, intent };
      }
    } catch {}
    return { route: 'gemini_chat', reason: 'No Claude key', confidence: 1.0 };
  }

  // Step 1: Check intent engine first (fast, already exists)
  try {
    const intent = await classifyIntent(prompt, windowContext || undefined);
    if (intent && intent.confidence >= 0.80) {
      return { route: 'intent_action', reason: `Intent: ${intent.type}`, confidence: intent.confidence, intent };
    }
  } catch {}

  // Step 2: Use Gemini Flash to classify chat vs agent (~0.3s, free)
  try {
    const filledPrompt = ROUTER_PROMPT
      .replace('{{WINDOW}}', windowContext?.title || 'Desktop')
      .replace('{{PROCESS}}', windowContext?.processName || 'explorer');

    const result = await callGeminiFlash(filledPrompt, prompt, {
      maxOutputTokens: 10,
      temperature: 0.1,
    });

    const classification = result.trim().toUpperCase();

    if (classification.includes('AGENT')) {
      return { route: 'claude_agent', reason: 'Multi-step task detected', confidence: 0.85 };
    }
    if (classification.includes('ACTION')) {
      // Gemini thinks it's a single action but intent engine didn't catch it
      // Fall through to chat (intent engine is more reliable for single actions)
      return { route: 'gemini_chat', reason: 'Single action but no intent match', confidence: 0.7 };
    }
    // CHAT or anything else
    return { route: 'gemini_chat', reason: 'Chat question', confidence: 0.9 };
  } catch (err) {
    // Router failed — default to chat (safe, fast, free)
    console.warn('[SmartRouter] Classification failed, defaulting to chat:', err);
    return { route: 'gemini_chat', reason: 'Router error, defaulting to chat', confidence: 0.5 };
  }
}
```

---

## 6. Tool Registry - src/core/agent/tools.ts

Same 22 tools as v2 but with permission tiers verified against claw-code's 5-level model.

```typescript
// === src/core/agent/tools.ts ===

export type PermissionLevel = 'always_allow' | 'ask_first' | 'ask_every' | 'never';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;
  permission: PermissionLevel;
  category: 'screen' | 'file' | 'terminal' | 'browser' | 'system' | 'docs';
}

export const AGENT_TOOLS: ToolDefinition[] = [
  // -- SCREEN LAYER (always_allow - no risk, read-only) --
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the entire screen. Returns base64 PNG.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'get_active_window',
    description: 'Get info about the currently focused window: title, process name.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'read_active_file',
    description: 'Read content of file in the foreground application.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'get_all_open_files',
    description: 'Discover all files and tabs open across all applications.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permission: 'always_allow',
    category: 'screen',
  },

  // -- FILE SYSTEM LAYER --
  {
    name: 'read_file',
    description: 'Read contents of a file at a specific path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        max_chars: { type: 'number', description: 'Max characters to read (default 100000)' },
      },
      required: ['file_path'],
    },
    permission: 'ask_first',
    category: 'file',
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['file_path', 'content'],
    },
    permission: 'ask_first',
    category: 'file',
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing one text string with another.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        old_text: { type: 'string', description: 'Exact text to find' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
    permission: 'ask_first',
    category: 'file',
  },
  {
    name: 'list_directory',
    description: 'List files and folders in a directory.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Absolute path to directory' },
      },
      required: ['dir_path'],
    },
    permission: 'always_allow',
    category: 'file',
  },
  {
    name: 'file_move',
    description: 'Move or rename a file.',
    input_schema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Current file path' },
        dest_path: { type: 'string', description: 'New file path' },
      },
      required: ['source_path', 'dest_path'],
    },
    permission: 'ask_first',
    category: 'file',
  },
  {
    name: 'file_delete',
    description: 'Delete a file (moves to Recycle Bin, recoverable).',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to delete' },
      },
      required: ['file_path'],
    },
    permission: 'ask_every',
    category: 'file',
  },

  // -- TERMINAL LAYER --
  {
    name: 'run_shell',
    description: 'Run a shell command in PowerShell. For npm, git, python, etc. Some dangerous commands are blocked by security policy.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        cwd: { type: 'string', description: 'Working directory (default: user home)' },
        timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
      },
      required: ['command'],
    },
    permission: 'ask_every',
    category: 'terminal',
  },

  // -- BROWSER LAYER --
  {
    name: 'browser_navigate',
    description: 'Open a URL in the default browser.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
    permission: 'ask_first',
    category: 'browser',
  },
  {
    name: 'browser_click',
    description: 'Click an element on a web page (requires CDP-enabled browser).',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        target_description: { type: 'string', description: 'Human description of element' },
      },
      required: [],
    },
    permission: 'ask_every',
    category: 'browser',
  },
  {
    name: 'browser_fill',
    description: 'Fill a form field on a web page (requires CDP-enabled browser).',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'Value to type' },
        target_description: { type: 'string', description: 'Human description of field' },
      },
      required: ['value'],
    },
    permission: 'ask_every',
    category: 'browser',
  },
  {
    name: 'read_web_content',
    description: 'Read text content of a web page by URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to read' },
        title: { type: 'string', description: 'Page title hint for CDP fallback' },
      },
      required: ['url'],
    },
    permission: 'ask_first',
    category: 'browser',
  },

  // -- SYSTEM LAYER --
  {
    name: 'system_open',
    description: 'Open an application or file with system default handler.',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'App name or file path' } },
      required: ['target'],
    },
    permission: 'ask_first',
    category: 'system',
  },
  {
    name: 'system_type',
    description: 'Type text into the currently focused application via SendKeys.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text'],
    },
    permission: 'ask_every',
    category: 'system',
  },
  {
    name: 'clipboard_write',
    description: 'Copy text to the system clipboard.',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy' } },
      required: ['text'],
    },
    permission: 'always_allow',
    category: 'system',
  },
  {
    name: 'read_clipboard',
    description: 'Read current clipboard text.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permission: 'always_allow',
    category: 'system',
  },

  // -- DOCUMENT GENERATION --
  {
    name: 'generate_document',
    description: 'Generate a document file (DOCX, XLSX, PPTX, PDF, or text formats).',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['docx','xlsx','pptx','pdf','md','txt','csv','json'] },
        spec: { type: 'object', description: 'Structured content spec' },
        content: { type: 'string', description: 'Raw text content (for PDF/text)' },
      },
      required: ['format'],
    },
    permission: 'ask_every',
    category: 'docs',
  },
];

export function getClaudeTools() {
  return AGENT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export function getToolByName(name: string): ToolDefinition | undefined {
  return AGENT_TOOLS.find(t => t.name === name);
}
```

---

## 7. Permission System - src/core/agent/permissions.ts

Same as v2 but with path-level grants and trust mode. See v2 Section 6 for the full code. No changes needed.

---

## 8. Shell Security - src/core/agent/shellGuard.ts

Defense-in-depth: the main process blocks dangerous commands (Section 3), and this renderer-side guard adds an audit log and additional validation before the command even reaches IPC.

```typescript
// === src/core/agent/shellGuard.ts ===
// Pre-flight check before any shell command reaches the main process

export interface ShellAuditEntry {
  timestamp: number;
  command: string;
  cwd?: string;
  allowed: boolean;
  reason: string;
}

const auditLog: ShellAuditEntry[] = [];
const MAX_AUDIT = 100;

// Patterns that should never execute (defense-in-depth, main process also checks)
const BLOCKED_PATTERNS = [
  /format\s+[a-zA-Z]:/i,
  /rm\s+-rf\s+[\/\\]/i,
  /del\s+\/[sS]/i,
  /Remove-Item.*-Recurse.*-Force/i,
  /Stop-Computer|Restart-Computer/i,
  /Set-ExecutionPolicy/i,
  /Invoke-Expression/i,
  /Invoke-WebRequest.*\|\s*iex/i,
  /Start-Process.*-Verb\s+RunAs/i,
  /reg\s+(delete|add)/i,
  /netsh\s+advfirewall/i,
  /cipher\s+\/[eE]/i,
];

// Paths that should never be written to or deleted from
const PROTECTED_PATHS = [
  /^[A-Z]:\\Windows/i,
  /^[A-Z]:\\Program Files/i,
  /^[A-Z]:\\Program Files \(x86\)/i,
  /^\/usr/i,
  /^\/etc/i,
  /^\/bin/i,
  /^\/sbin/i,
];

export function validateShellCommand(command: string, cwd?: string): {
  allowed: boolean;
  reason: string;
} {
  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      const entry = { timestamp: Date.now(), command, cwd, allowed: false, reason: `Blocked: ${pattern.source}` };
      auditLog.push(entry);
      if (auditLog.length > MAX_AUDIT) auditLog.shift();
      return { allowed: false, reason: entry.reason };
    }
  }

  // Check if command targets protected paths
  for (const pathPattern of PROTECTED_PATHS) {
    if (pathPattern.test(command)) {
      const entry = { timestamp: Date.now(), command, cwd, allowed: false, reason: `Protected path: ${pathPattern.source}` };
      auditLog.push(entry);
      if (auditLog.length > MAX_AUDIT) auditLog.shift();
      return { allowed: false, reason: entry.reason };
    }
  }

  // Allowed
  const entry = { timestamp: Date.now(), command, cwd, allowed: true, reason: 'Passed security checks' };
  auditLog.push(entry);
  if (auditLog.length > MAX_AUDIT) auditLog.shift();
  return { allowed: true, reason: 'OK' };
}

export function getAuditLog(): ShellAuditEntry[] {
  return [...auditLog];
}
```

---

## 9. Tool Executor - src/core/agent/toolExecutor.ts

Same as v2 Section 7 but with one addition: shell commands go through shellGuard before IPC.

```typescript
// === src/core/agent/toolExecutor.ts ===
// Maps Claude tool_use calls to Electron IPC handlers

import { validateShellCommand } from './shellGuard';

const api = (window as any).electron;

export async function executeTool(
  name: string,
  input: Record<string, any>
): Promise<string> {
  try {
    switch (name) {
      // -- Screen Layer --
      case 'capture_screenshot': {
        const img = await api.captureScreen();
        return JSON.stringify({ image: img, type: 'screenshot' });
      }
      case 'get_active_window': {
        return JSON.stringify(await api.getActiveWindowContext());
      }
      case 'read_active_file': {
        return JSON.stringify(await api.readActiveFile());
      }
      case 'get_all_open_files': {
        return JSON.stringify(await api.getAllOpenFiles());
      }

      // -- File System Layer --
      case 'read_file': {
        return JSON.stringify(await api.agent.readFile({
          filePath: input.file_path, maxChars: input.max_chars,
        }));
      }
      case 'write_file': {
        return JSON.stringify(await api.agent.writeFile({
          filePath: input.file_path, content: input.content,
        }));
      }
      case 'edit_file': {
        return JSON.stringify(await api.agent.editFile({
          filePath: input.file_path, oldText: input.old_text, newText: input.new_text,
        }));
      }
      case 'list_directory': {
        return JSON.stringify(await api.agent.listDir({ dirPath: input.dir_path }));
      }
      case 'file_move': {
        return JSON.stringify(await api.executeAction({
          type: 'file_move',
          parameters: { sourcePath: input.source_path, destinationPath: input.dest_path },
        }));
      }
      case 'file_delete': {
        return JSON.stringify(await api.executeAction({
          type: 'file_delete',
          parameters: { sourcePath: input.file_path },
        }));
      }

      // -- Terminal Layer (with security guard) --
      case 'run_shell': {
        // Pre-flight security check
        const check = validateShellCommand(input.command, input.cwd);
        if (!check.allowed) {
          return JSON.stringify({ success: false, error: check.reason, blocked: true });
        }
        return JSON.stringify(await api.agent.runShell({
          command: input.command, cwd: input.cwd, timeout: input.timeout,
        }));
      }

      // -- Browser Layer --
      case 'browser_navigate': {
        return JSON.stringify(await api.executeAction({
          type: 'browser_navigate', parameters: { url: input.url },
        }));
      }
      case 'browser_click': {
        return JSON.stringify(await api.executeAction({
          type: 'browser_click',
          parameters: { selector: input.selector, targetDescription: input.target_description },
        }));
      }
      case 'browser_fill': {
        return JSON.stringify(await api.executeAction({
          type: 'browser_fill',
          parameters: { selector: input.selector, value: input.value, targetDescription: input.target_description },
        }));
      }
      case 'read_web_content': {
        return JSON.stringify(await api.readWebContent({ url: input.url, title: input.title || '' }));
      }

      // -- System Layer --
      case 'system_open': {
        return JSON.stringify(await api.executeAction({
          type: 'system_open', parameters: { appName: input.target },
        }));
      }
      case 'system_type': {
        return JSON.stringify(await api.executeAction({
          type: 'system_type', parameters: { text: input.text },
        }));
      }
      case 'clipboard_write': {
        return JSON.stringify(await api.executeAction({
          type: 'clipboard_copy', parameters: { text: input.text },
        }));
      }
      case 'read_clipboard': {
        return JSON.stringify({ text: await api.readClipboard() });
      }

      // -- Document Generation --
      case 'generate_document': {
        return JSON.stringify(await api.generateFile({
          format: input.format, spec: input.spec, content: input.content,
        }));
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: err.message });
  }
}
```

---

## 10. Agent Loop with STREAMING - src/core/agent/claudeAgent.ts

This is the v3 core engine. Key difference from v2: uses `messages.stream()` for real-time text output, has retry logic with exponential backoff, respects tool execution timeouts, and tracks token usage.

```typescript
// === src/core/agent/claudeAgent.ts ===
// THE CORE: claw-code agent loop with STREAMING + error recovery

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeTools } from './tools';
import { PermissionManager, PermissionRequest } from './permissions';
import { executeTool } from './toolExecutor';
import { CostTracker } from './costTracker';

const MAX_TURNS = 25;
const MAX_RETRIES = 3;
const TOOL_TIMEOUT = 30000; // 30s per tool execution

export interface AgentStep {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'permission' | 'text' | 'error';
  toolName?: string;
  toolInput?: Record<string, any>;
  result?: string;
  status: 'pending' | 'running' | 'waiting_permission' | 'completed' | 'denied' | 'error';
  description?: string;
  timestamp: number;
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void;
  onTextDelta: (delta: string) => void;           // v3: streaming text deltas
  onTextComplete: (fullText: string) => void;      // v3: text block complete
  onPermissionRequest: (req: PermissionRequest) => Promise<{
    decision: 'allow' | 'deny';
    scope: 'once' | 'session' | 'path';
    pathPattern?: string;
  }>;
  onComplete: (steps: AgentStep[], cost: { inputTokens: number; outputTokens: number; estimatedCost: number }) => void;
  onError: (error: string) => void;
}

export class ClaudeAgent {
  private client: Anthropic;
  private permissions: PermissionManager;
  private costTracker: CostTracker;
  private steps: AgentStep[] = [];
  private aborted = false;
  private model: string;

  constructor(apiKey: string, model?: string) {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
    });
    this.permissions = new PermissionManager();
    this.costTracker = new CostTracker();
    this.model = model || 'claude-sonnet-4-20250514';
  }

  abort() { this.aborted = true; }
  getPermissions() { return this.permissions; }
  getCostTracker() { return this.costTracker; }

  async run(
    userPrompt: string,
    screenshotBase64: string | null,
    windowContext: any,
    callbacks: AgentCallbacks,
  ) {
    this.aborted = false;
    this.steps = [];
    this.costTracker.reset();

    const systemPrompt = [
      'You are KLYPIX, an AI agent running on the user\'s Windows desktop.',
      'You can see the user\'s screen, read/write files, run shell commands, and automate their browser.',
      'Always start by understanding the context: look at the screenshot, check the active window.',
      'Be proactive: use your tools to get information rather than asking the user.',
      'For multi-step tasks, work through them systematically.',
      'When done, provide a clear summary of what you did.',
      'IMPORTANT: Some shell commands are blocked by security policy. If a command is blocked, try an alternative approach.',
      windowContext ? `Active window: ${windowContext.title} (${windowContext.processName})` : '',
    ].join('\n');

    // Build initial message
    const userContent: any[] = [];
    if (screenshotBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
      });
    }
    userContent.push({ type: 'text', text: userPrompt });

    const messages: any[] = [{ role: 'user', content: userContent }];

    // === THE AGENT LOOP ===
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.aborted) { callbacks.onError('Agent stopped by user'); return; }

      this.addStep({ type: 'thinking', status: 'running', description: `Turn ${turn + 1}` }, callbacks);

      // -- Call Claude with STREAMING + retry --
      let response: any;
      let retryCount = 0;

      while (retryCount <= MAX_RETRIES) {
        try {
          // v3: Use streaming API
          const stream = this.client.messages.stream({
            model: this.model,
            max_tokens: 8192,
            system: systemPrompt,
            tools: getClaudeTools() as any,
            messages,
          });

          // Collect streaming text deltas
          stream.on('text', (delta) => {
            if (!this.aborted) callbacks.onTextDelta(delta);
          });

          // Wait for full response
          response = await stream.finalMessage();

          // Track token usage
          if (response.usage) {
            this.costTracker.addUsage(response.usage.input_tokens, response.usage.output_tokens);
          }

          break; // Success, exit retry loop
        } catch (err: any) {
          retryCount++;
          if (err.status === 429 || err.status === 529 || err.status >= 500) {
            if (retryCount <= MAX_RETRIES) {
              // Exponential backoff: 1s, 2s, 4s
              const delay = Math.pow(2, retryCount - 1) * 1000;
              this.addStep({
                type: 'error', status: 'running',
                description: `API error ${err.status}, retrying in ${delay/1000}s... (${retryCount}/${MAX_RETRIES})`,
              }, callbacks);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
          }
          callbacks.onError(`Claude API error: ${err.message}${retryCount > 1 ? ` (after ${retryCount} retries)` : ''}`);
          return;
        }
      }

      if (!response) { callbacks.onError('Failed to get response after retries'); return; }

      // -- Process response blocks --
      const toolResults: any[] = [];
      let hasToolUse = false;
      let turnText = '';

      for (const block of response.content) {
        if (this.aborted) break;

        if (block.type === 'text') {
          turnText += block.text;
          callbacks.onTextComplete(block.text);
        }

        if (block.type === 'tool_use') {
          hasToolUse = true;
          const { id, name, input } = block;

          this.addStep({
            type: 'tool_call', toolName: name,
            toolInput: input as Record<string, any>,
            status: 'pending', description: `${name}`,
          }, callbacks);

          // Permission check
          const perm = await this.permissions.check(name, input as Record<string, any>);

          if (perm.needsPrompt && perm.request) {
            this.addStep({
              type: 'permission', toolName: name,
              status: 'waiting_permission', description: perm.request.description,
            }, callbacks);

            const decision = await callbacks.onPermissionRequest(perm.request);
            this.permissions.grant(name, decision.decision, decision.scope, decision.pathPattern);

            if (decision.decision === 'deny') {
              this.addStep({ type: 'tool_result', toolName: name, status: 'denied', result: 'Denied' }, callbacks);
              toolResults.push({
                type: 'tool_result', tool_use_id: id,
                content: 'Permission denied by user. Try a different approach or ask what they prefer.',
              });
              continue;
            }
          } else if (!perm.allowed) {
            toolResults.push({ type: 'tool_result', tool_use_id: id, content: 'Tool not available.' });
            continue;
          }

          // Execute tool with timeout
          this.updateLastStep({ status: 'running' }, callbacks);
          let result: string;
          try {
            result = await Promise.race([
              executeTool(name, input as Record<string, any>),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT/1000}s`)), TOOL_TIMEOUT)
              ),
            ]);
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }

          this.addStep({
            type: 'tool_result', toolName: name, status: 'completed',
            result: result.substring(0, 200) + (result.length > 200 ? '...' : ''),
          }, callbacks);

          // Handle screenshot results (send as image to Claude)
          let toolContent: any;
          try {
            const parsed = JSON.parse(result);
            if (parsed.image && parsed.type === 'screenshot') {
              toolContent = [{
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: parsed.image },
              }];
            } else {
              toolContent = result;
            }
          } catch {
            toolContent = result;
          }

          toolResults.push({ type: 'tool_result', tool_use_id: id, content: toolContent });
        }
      }

      // Check stop condition
      if (response.stop_reason === 'end_turn' && !hasToolUse) {
        const cost = this.costTracker.getSummary();
        callbacks.onComplete(this.steps, cost);
        return;
      }

      // Send tool results back
      if (toolResults.length > 0) {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
      } else {
        const cost = this.costTracker.getSummary();
        callbacks.onComplete(this.steps, cost);
        return;
      }
    }

    callbacks.onError('Max turns reached (25). Agent stopped.');
  }

  private addStep(step: Partial<AgentStep>, callbacks: AgentCallbacks) {
    const full: AgentStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(), type: 'text', status: 'pending', ...step,
    };
    this.steps.push(full);
    callbacks.onStep(full);
  }

  private updateLastStep(update: Partial<AgentStep>, callbacks: AgentCallbacks) {
    const last = this.steps[this.steps.length - 1];
    if (last) { Object.assign(last, update); callbacks.onStep(last); }
  }
}
```

---

## 11. Cost Tracker - src/core/agent/costTracker.ts

Tracks token usage per agent run and estimates cost. Shows the user what each run costs.

```typescript
// === src/core/agent/costTracker.ts ===

// Pricing as of April 2026 (Claude Sonnet 4)
const PRICING = {
  'claude-sonnet-4-20250514': { inputPer1M: 3.00, outputPer1M: 15.00 },
  'claude-opus-4-20250514':   { inputPer1M: 15.00, outputPer1M: 75.00 },
  'claude-haiku-4-20250514':  { inputPer1M: 0.80, outputPer1M: 4.00 },
};

export class CostTracker {
  private inputTokens = 0;
  private outputTokens = 0;
  private turns = 0;
  private model = 'claude-sonnet-4-20250514';

  setModel(model: string) { this.model = model; }

  addUsage(input: number, output: number) {
    this.inputTokens += input;
    this.outputTokens += output;
    this.turns++;
  }

  reset() {
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.turns = 0;
  }

  getSummary() {
    const pricing = PRICING[this.model as keyof typeof PRICING] || PRICING['claude-sonnet-4-20250514'];
    const inputCost = (this.inputTokens / 1_000_000) * pricing.inputPer1M;
    const outputCost = (this.outputTokens / 1_000_000) * pricing.outputPer1M;
    return {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      estimatedCost: Math.round((inputCost + outputCost) * 1000) / 1000, // 3 decimal places
      turns: this.turns,
      model: this.model,
    };
  }

  // Session-level budget tracking (stored in localStorage)
  static getSessionSpend(): number {
    try {
      const data = JSON.parse(localStorage.getItem('klypix_agent_cost') || '{}');
      const today = new Date().toISOString().split('T')[0];
      return data[today] || 0;
    } catch { return 0; }
  }

  static addSessionSpend(amount: number) {
    try {
      const data = JSON.parse(localStorage.getItem('klypix_agent_cost') || '{}');
      const today = new Date().toISOString().split('T')[0];
      data[today] = (data[today] || 0) + amount;
      // Keep only last 30 days
      const keys = Object.keys(data).sort();
      if (keys.length > 30) {
        for (const k of keys.slice(0, keys.length - 30)) delete data[k];
      }
      localStorage.setItem('klypix_agent_cost', JSON.stringify(data));
    } catch {}
  }

  static getDailyBudget(): number {
    return parseFloat(localStorage.getItem('klypix_agent_budget') || '5.00');
  }

  static setDailyBudget(amount: number) {
    localStorage.setItem('klypix_agent_budget', amount.toString());
  }

  static isOverBudget(): boolean {
    return CostTracker.getSessionSpend() >= CostTracker.getDailyBudget();
  }
}
```

---

## 12. Session Manager + Integration - src/core/agent/agentSession.ts

v3 addition: integrates with sessionContext.ts and memoryStore.ts so agent results appear in the existing session bus and conversation memory.

```typescript
// === src/core/agent/agentSession.ts ===

import { AgentStep } from './claudeAgent';
import { saveMemoryEvent, type MemoryEvent } from '../../api/memoryStore';

export interface AgentSession {
  id: string;
  startedAt: number;
  completedAt?: number;
  prompt: string;
  steps: AgentStep[];
  status: 'running' | 'completed' | 'error' | 'aborted';
  finalResponse?: string;
  screenshotCount: number;
  toolCallCount: number;
  cost?: { inputTokens: number; outputTokens: number; estimatedCost: number };
}

const SESSION_KEY = 'klypix_agent_sessions';
const MAX_SESSIONS = 50;

export class AgentSessionManager {
  private current: AgentSession | null = null;
  // v3: sessionContext integration callbacks
  private onFileAnalyzed?: (name: string, summary: string, type: string) => void;
  private onDocGenerated?: (filename: string, format: string, prompt: string) => void;
  private onScreenAnalyzed?: (seeing: string, keyData: Array<{ label: string; value: string }>) => void;

  setSessionContextCallbacks(cbs: {
    onFileAnalyzed?: (name: string, summary: string, type: string) => void;
    onDocGenerated?: (filename: string, format: string, prompt: string) => void;
    onScreenAnalyzed?: (seeing: string, keyData: Array<{ label: string; value: string }>) => void;
  }) {
    this.onFileAnalyzed = cbs.onFileAnalyzed;
    this.onDocGenerated = cbs.onDocGenerated;
    this.onScreenAnalyzed = cbs.onScreenAnalyzed;
  }

  start(prompt: string): AgentSession {
    this.current = {
      id: `agent_${Date.now()}`,
      startedAt: Date.now(),
      prompt,
      steps: [],
      status: 'running',
      screenshotCount: 0,
      toolCallCount: 0,
    };
    return this.current;
  }

  addStep(step: AgentStep) {
    if (!this.current) return;
    this.current.steps.push(step);
    if (step.type === 'tool_call') this.current.toolCallCount++;
    if (step.toolName === 'capture_screenshot') this.current.screenshotCount++;

    // v3: Feed results into sessionContext
    if (step.type === 'tool_result' && step.status === 'completed') {
      if (step.toolName === 'read_file' || step.toolName === 'read_active_file') {
        this.onFileAnalyzed?.(
          step.toolInput?.file_path || 'active file',
          step.result?.substring(0, 100) || '',
          'text'
        );
      }
      if (step.toolName === 'generate_document') {
        this.onDocGenerated?.(
          step.toolInput?.spec?.filename || `generated.${step.toolInput?.format}`,
          step.toolInput?.format || 'unknown',
          this.current.prompt
        );
      }
      if (step.toolName === 'capture_screenshot') {
        this.onScreenAnalyzed?.('Agent captured screenshot', []);
      }
    }
  }

  complete(
    finalResponse: string,
    cost?: { inputTokens: number; outputTokens: number; estimatedCost: number },
    status: 'completed' | 'error' | 'aborted' = 'completed',
  ) {
    if (!this.current) return;
    this.current.completedAt = Date.now();
    this.current.status = status;
    this.current.finalResponse = finalResponse;
    this.current.cost = cost;
    this.save(this.current);

    // v3: Save to memoryStore
    const memEvent: MemoryEvent = {
      timestamp: Date.now(),
      app: 'KLYPIX Agent',
      title: `Agent: ${this.current.prompt.substring(0, 50)}`,
      query: this.current.prompt,
      responsePreview: finalResponse.substring(0, 200),
      type: 'action',
    };
    saveMemoryEvent(memEvent);

    this.current = null;
  }

  getCurrent() { return this.current; }

  getHistory(): AgentSession[] {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || '[]'); }
    catch { return []; }
  }

  private save(session: AgentSession) {
    const history = this.getHistory();
    history.unshift(session);
    if (history.length > MAX_SESSIONS) history.length = MAX_SESSIONS;
    localStorage.setItem(SESSION_KEY, JSON.stringify(history));
  }
}
```

---

## 13. React Hook (useClaudeAgent.ts)

Full custom React hook managing the complete agent lifecycle: initialization, routing, permission flows, streaming, and cleanup.

**Location:** `src/hooks/useClaudeAgent.ts`

```typescript
import { useRef, useCallback, useState, useEffect } from 'react';
import { ClaudeAgent } from '@/core/agent/claudeAgent';
import { SmartRouter } from '@/core/agent/smartRouter';
import { CostTracker } from '@/core/agent/costTracker';
import { useSessionContext } from '@/core/sessionContext';
import { callGeminiFlash } from '@/api/gemini';
import { classifyIntent } from '@/core/intentEngine/intentEngine';
import { saveMemoryEvent } from '@/api/memoryStore';
import Anthropic from '@anthropic-ai/sdk';

export type AgentState =
  | 'idle'
  | 'routing'
  | 'running'
  | 'waiting-permission'
  | 'done'
  | 'error';

export type ToolMessage = {
  toolName: string;
  input: Record<string, unknown>;
  result?: unknown;
  error?: string;
  status: 'pending' | 'running' | 'done' | 'error';
  cost?: number;
  duration?: number;
};

export type AgentMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type PermissionRequest = {
  toolName: string;
  description: string;
  input: Record<string, unknown>;
  toolConfig: { askMode: 'ask_first' | 'ask_every' | 'auto' };
  resolveFn: (approved: boolean) => void;
  timestamp: number;
};

export interface UseClaudeAgentReturn {
  state: AgentState;
  messages: AgentMessage[];
  toolMessages: ToolMessage[];
  cost: { total: number; thisRun: number };
  permissionRequest: PermissionRequest | null;

  startAgent: (
    prompt: string,
    context: {
      screenshot?: string;
      activeWindowInfo?: string;
      openFiles?: string[];
      conversationHistory?: AgentMessage[];
    }
  ) => Promise<void>;

  approvePermission: (alwaysAllow?: boolean) => void;
  denyPermission: () => void;
  abort: () => void;

  isRoutingToAgent: boolean;
  smartRouterDecision?: { classification: string; confidence: number };
}

export function useClaudeAgent(): UseClaudeAgentReturn {
  const sessionContext = useSessionContext();

  const [state, setState] = useState<AgentState>('idle');
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [toolMessages, setToolMessages] = useState<ToolMessage[]>([]);
  const [cost, setCost] = useState({ total: 0, thisRun: 0 });
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [isRoutingToAgent, setIsRoutingToAgent] = useState(false);
  const [smartRouterDecision, setSmartRouterDecision] = useState<{
    classification: string;
    confidence: number
  }>();

  const agentRef = useRef<ClaudeAgent | null>(null);
  const costTrackerRef = useRef(new CostTracker());
  const abortControllerRef = useRef<AbortController | null>(null);
  const permissionResolveRef = useRef<Map<string, (approved: boolean) => void>>(new Map());

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (agentRef.current) {
        agentRef.current.abort();
      }
    };
  }, []);

  const startAgent = useCallback(
    async (
      prompt: string,
      context: {
        screenshot?: string;
        activeWindowInfo?: string;
        openFiles?: string[];
        conversationHistory?: AgentMessage[];
      } = {}
    ) => {
      try {
        setState('routing');
        setMessages([]);
        setToolMessages([]);
        setCost({ total: cost.total, thisRun: 0 });
        abortControllerRef.current = new AbortController();

        // Step 1: Smart Router classification
        const router = new SmartRouter(callGeminiFlash);
        const routerResult = await router.routePrompt(prompt, {
          screenshot: context.screenshot,
          activeWindow: context.activeWindowInfo,
          openFiles: context.openFiles,
        });

        setSmartRouterDecision({
          classification: routerResult.classification,
          confidence: routerResult.confidence,
        });

        if (routerResult.classification !== 'agent') {
          setIsRoutingToAgent(false);
          setState('idle');
          return;
        }

        setIsRoutingToAgent(true);

        // Step 2: Initialize Claude Agent
        setState('running');
        const agent = new ClaudeAgent({
          apiKey: await window.electron.getClaudeApiKey(),
          costTracker: costTrackerRef.current,
        });

        agentRef.current = agent;

        // Step 3: Build system context from session
        let systemPrompt = `You are KLYPIX Agent, an autonomous agent assistant integrated into the KLYPIX desktop overlay.
You have access to system tools to:
- Read and write files on the user's system
- Execute shell commands (PowerShell on Windows)
- Control the browser (navigate, click, fill forms)
- Capture and analyze screenshots
- Generate documents (XLSX, DOCX, PPTX, PDF)

Active Window Context: ${context.activeWindowInfo || 'No active window context'}
Conversation History: ${
          context.conversationHistory && context.conversationHistory.length > 0
            ? context.conversationHistory.map((m) => `${m.role}: ${m.content}`).join('\n')
            : 'None'
        }

IMPORTANT: For any action that modifies system state:
1. Check tool_use schema for "askMode" setting
2. If "ask_first" or "ask_every", request user permission before executing
3. Wait for user response via the permission system
4. Only proceed if user approves

If user denies permission, explain the impact and suggest alternatives.`;

        // Step 4: Set up streaming callbacks
        const onPermissionRequest = (
          toolName: string,
          description: string,
          input: Record<string, unknown>,
          toolConfig: { askMode: 'ask_first' | 'ask_every' | 'auto' }
        ): Promise<boolean> => {
          return new Promise((resolve) => {
            setState('waiting-permission');
            const request: PermissionRequest = {
              toolName,
              description,
              input,
              toolConfig,
              resolveFn: (approved: boolean) => {
                resolve(approved);
                setPermissionRequest(null);
              },
              timestamp: Date.now(),
            };
            setPermissionRequest(request);
            permissionResolveRef.current.set(toolName, (approved) => {
              resolve(approved);
              setPermissionRequest(null);
            });
          });
        };

        const onToolStart = (toolName: string, input: Record<string, unknown>) => {
          setToolMessages((prev) => [
            ...prev,
            {
              toolName,
              input,
              status: 'running',
              cost: 0,
              duration: 0,
            },
          ]);
        };

        const onToolEnd = (
          toolName: string,
          result: unknown,
          duration: number,
          cost: number
        ) => {
          setToolMessages((prev) =>
            prev.map((msg) =>
              msg.toolName === toolName && msg.status === 'running'
                ? {
                    ...msg,
                    result,
                    status: 'done',
                    duration,
                    cost,
                  }
                : msg
            )
          );
          setCost((prev) => ({
            total: prev.total + cost,
            thisRun: prev.thisRun + cost,
          }));
        };

        const onToolError = (toolName: string, error: string) => {
          setToolMessages((prev) =>
            prev.map((msg) =>
              msg.toolName === toolName
                ? { ...msg, status: 'error', error }
                : msg
            )
          );
        };

        const onTextDelta = (text: string) => {
          setMessages((prev) => {
            if (prev.length === 0 || prev[prev.length - 1].role !== 'assistant') {
              return [
                ...prev,
                { role: 'assistant', content: text },
              ];
            }
            const updated = [...prev];
            updated[updated.length - 1].content += text;
            return updated;
          });
        };

        // Step 5: Execute agent stream
        const stream = await agent.executeStream(prompt, {
          systemPrompt,
          tools: await agent.loadToolDefinitions(),
          onPermissionRequest,
          onToolStart,
          onToolEnd,
          onToolError,
          onTextDelta,
        });

        // Step 6: Process stream
        let fullResponse = '';
        for await (const event of stream) {
          if (abortControllerRef.current?.signal.aborted) break;

          if (event.type === 'text') {
            fullResponse += event.text;
            onTextDelta(event.text);
          } else if (event.type === 'tool_start') {
            onToolStart(event.toolName, event.input);
          } else if (event.type === 'tool_result') {
            onToolEnd(event.toolName, event.result, event.duration, event.cost);
          } else if (event.type === 'tool_error') {
            onToolError(event.toolName, event.error);
          }
        }

        // Step 7: Save to session memory
        setMessages((prev) => [
          ...prev,
          { role: 'user', content: prompt },
        ]);

        saveMemoryEvent({
          app: 'KLYPIX Agent',
          title: `Agent: ${prompt.substring(0, 50)}`,
          query: prompt,
          responsePreview: fullResponse.substring(0, 200),
          type: 'action',
        });

        setState('done');
      } catch (err) {
        console.error('Agent error:', err);
        setState('error');
      }
    },
    [cost.total]
  );

  const approvePermission = useCallback((alwaysAllow: boolean = false) => {
    if (permissionRequest) {
      permissionRequest.resolveFn(true);
      if (alwaysAllow) {
        // Trust mode: future permissions auto-approved this session
        sessionContext.setTrustMode?.(true);
      }
    }
  }, [permissionRequest, sessionContext]);

  const denyPermission = useCallback(() => {
    if (permissionRequest) {
      permissionRequest.resolveFn(false);
    }
  }, [permissionRequest]);

  const abort = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (agentRef.current) {
      agentRef.current.abort();
    }
    setState('idle');
  }, []);

  return {
    state,
    messages,
    toolMessages,
    cost,
    permissionRequest,
    startAgent,
    approvePermission,
    denyPermission,
    abort,
    isRoutingToAgent,
    smartRouterDecision,
  };
}
```

---

## 14. UI Components - WorkflowPanel + PermissionTabs

Two complementary UI components for agent execution and permission handling.

**Location:** `src/components/WorkflowPanel.tsx`

```typescript
import React, { useEffect, useRef } from 'react';
import { AgentMessage, ToolMessage } from '@/hooks/useClaudeAgent';

interface WorkflowPanelProps {
  isVisible: boolean;
  messages: AgentMessage[];
  toolMessages: ToolMessage[];
  cost: { total: number; thisRun: number };
  isRunning: boolean;
  onAbort: () => void;
}

export const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
  isVisible,
  messages,
  toolMessages,
  cost,
  isRunning,
  onAbort,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, toolMessages]);

  if (!isVisible) return null;

  return (
    <div className="fixed bottom-0 right-0 w-96 h-96 bg-gray-900/95 border border-emerald-500/30 rounded-t-lg shadow-2xl flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-emerald-500/20 bg-gray-800/50">
        <h3 className="text-sm font-semibold text-gray-100">Agent Workflow</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-emerald-400">
            ${cost.thisRun.toFixed(4)} this run
          </span>
          {isRunning && (
            <button
              onClick={onAbort}
              className="px-2 py-1 text-xs bg-red-900/50 text-red-200 rounded hover:bg-red-900 transition"
            >
              Abort
            </button>
          )}
        </div>
      </div>

      {/* Content Scroll Area */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
      >
        {/* Messages */}
        {messages.map((msg, idx) => (
          <div key={idx} className={`text-sm ${msg.role === 'user' ? 'text-blue-300' : 'text-gray-300'}`}>
            <div className="font-mono text-xs opacity-50">{msg.role}</div>
            <div className="line-clamp-3">{msg.content}</div>
          </div>
        ))}

        {/* Tool Execution Steps */}
        {toolMessages.map((tool, idx) => (
          <div
            key={idx}
            className={`p-2 rounded text-xs border ${
              tool.status === 'done'
                ? 'border-emerald-500/30 bg-emerald-500/5'
                : tool.status === 'error'
                ? 'border-red-500/30 bg-red-500/5'
                : 'border-yellow-500/30 bg-yellow-500/5'
            }`}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="font-mono">{tool.toolName}</span>
                <span className="text-gray-500">
                  {tool.status === 'done' && '[OK]'}
                  {tool.status === 'running' && '[...]'}
                  {tool.status === 'error' && '[ERR]'}
                  {tool.status === 'pending' && '[?]'}
                </span>
              </div>
              {tool.cost && (
                <span className="text-emerald-400">
                  ${tool.cost.toFixed(4)}
                </span>
              )}
            </div>
            {tool.input && (
              <div className="mt-1 text-gray-500 text-xs">
                input: {JSON.stringify(tool.input).substring(0, 50)}...
              </div>
            )}
            {tool.error && (
              <div className="mt-1 text-red-300">{tool.error}</div>
            )}
            {tool.result && typeof tool.result === 'string' && (
              <div className="mt-1 text-gray-400 line-clamp-2">{tool.result}</div>
            )}
            {tool.duration && (
              <div className="mt-1 text-gray-500 text-xs">
                {tool.duration}ms
              </div>
            )}
          </div>
        ))}

        {isRunning && !toolMessages.length && (
          <div className="flex items-center gap-2 text-gray-400 text-xs">
            <div className="animate-pulse w-2 h-2 bg-emerald-400 rounded-full"></div>
            Initializing agent...
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className="px-4 py-2 border-t border-emerald-500/20 bg-gray-800/30 text-xs text-gray-400">
        {isRunning ? 'Running...' : 'Complete'}
      </div>
    </div>
  );
};
```

**Location:** `src/components/PermissionTabs.tsx`

```typescript
import React, { useState, useEffect } from 'react';
import { PermissionRequest } from '@/hooks/useClaudeAgent';

interface PermissionTabsProps {
  request: PermissionRequest | null;
  onAllow: (alwaysAllow?: boolean) => void;
  onDeny: () => void;
  trustMode?: boolean;
  onTrustModeChange?: (enabled: boolean) => void;
}

export const PermissionTabs: React.FC<PermissionTabsProps> = ({
  request,
  onAllow,
  onDeny,
  trustMode = false,
  onTrustModeChange,
}) => {
  const [waitSeconds, setWaitSeconds] = useState(0);

  useEffect(() => {
    if (!request) return;
    const interval = setInterval(() => {
      setWaitSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [request]);

  if (!request) return null;

  const isHighRisk = request.toolConfig.askMode === 'ask_every';
  const isTrusted = trustMode && request.toolConfig.askMode === 'ask_first';

  // Auto-approve if trust mode and ask_first
  useEffect(() => {
    if (isTrusted) {
      const timer = setTimeout(() => onAllow(false), 500);
      return () => clearTimeout(timer);
    }
  }, [isTrusted, onAllow]);

  return (
    <div className="fixed bottom-96 right-0 w-96 bg-gray-900/95 border border-yellow-500/50 rounded-t-lg shadow-2xl overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-yellow-500/30 bg-gray-800/70">
        <h3 className="text-sm font-semibold text-gray-100">
          Agent Permission Required
        </h3>
      </div>

      {/* Tool Description */}
      <div className="px-4 py-3 border-b border-yellow-500/20 bg-gray-800/40 space-y-2">
        <div className="text-sm font-mono text-emerald-300">
          {request.toolName}
        </div>
        <div className="text-xs text-gray-300">
          {request.description}
        </div>
        {isHighRisk && (
          <div className="text-xs text-red-300">
            This action requires explicit approval every time.
          </div>
        )}
      </div>

      {/* Input Preview */}
      <div className="px-4 py-3 bg-gray-800/20 border-b border-gray-700/50">
        <div className="text-xs text-gray-400 mb-1">Input:</div>
        <div className="bg-gray-900/50 p-2 rounded text-xs font-mono text-gray-300 max-h-24 overflow-y-auto">
          {JSON.stringify(request.input, null, 2)}
        </div>
      </div>

      {/* Trust Mode Toggle */}
      {!isHighRisk && (
        <div className="px-4 py-2 flex items-center gap-2 bg-gray-800/20 border-b border-gray-700/50">
          <label className="flex items-center gap-2 cursor-pointer flex-1">
            <input
              type="checkbox"
              checked={trustMode}
              onChange={(e) => onTrustModeChange?.(e.target.checked)}
              className="w-4 h-4 accent-emerald-500"
            />
            <span className="text-xs text-gray-300">
              Trust mode: auto-allow this session
            </span>
          </label>
        </div>
      )}

      {/* Wait Timer */}
      <div className="px-4 py-2 text-xs text-gray-500 bg-gray-800/20 border-b border-gray-700/50">
        Waiting for {waitSeconds}s
      </div>

      {/* Action Buttons */}
      <div className="px-4 py-3 flex gap-2 bg-gray-800/30">
        {trustMode && !isHighRisk ? (
          <div className="flex-1 px-3 py-2 bg-emerald-500/20 text-emerald-300 text-xs rounded text-center">
            Auto-approving in trust mode...
          </div>
        ) : (
          <>
            <button
              onClick={() => onDeny()}
              className="flex-1 px-3 py-2 bg-red-900/50 text-red-200 text-xs rounded hover:bg-red-900 transition font-medium"
            >
              Deny
            </button>
            <button
              onClick={() => onAllow(false)}
              className="flex-1 px-3 py-2 bg-yellow-900/50 text-yellow-200 text-xs rounded hover:bg-yellow-900 transition font-medium"
            >
              Allow Once
            </button>
            {!isHighRisk && (
              <button
                onClick={() => onAllow(true)}
                className="flex-1 px-3 py-2 bg-emerald-900/50 text-emerald-200 text-xs rounded hover:bg-emerald-900 transition font-medium"
              >
                Always Allow
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
};
```

---

## 15. App.tsx Integration - Smart Mode Router

Integration of the Claude Agent into the existing monolithic KLYPIX App.tsx, replacing manual mode selection with intelligent routing.

**Location:** `src/App.tsx` (modifications)

```typescript
// At top of file, add imports
import { useClaudeAgent } from '@/hooks/useClaudeAgent';
import { WorkflowPanel } from '@/components/WorkflowPanel';
import { PermissionTabs } from '@/components/PermissionTabs';
import { SmartRouter } from '@/core/agent/smartRouter';

export default function App() {
  // Existing state declarations...
  const { messages: chatMessages, setMessages: setChatMessages } = /* existing chat state */;

  // Add agent hook
  const {
    state: agentState,
    messages: agentMessages,
    toolMessages,
    cost,
    permissionRequest,
    startAgent,
    approvePermission,
    denyPermission,
    abort: abortAgent,
    isRoutingToAgent,
    smartRouterDecision,
  } = useClaudeAgent();

  // Add state for trust mode
  const [trustMode, setTrustMode] = useState(false);

  // Modified: submission handler with smart routing
  const handleSubmit = useCallback(
    async (userInput: string) => {
      try {
        // Capture current context
        const screenshot = await window.electron.captureScreen();
        const activeWindow = await window.electron.getActiveWindowContext();
        const openFiles = await window.electron.getAllOpenFiles();

        // Get user tier for feature gating
        const userTier = await window.electron.getUserTier?.();
        if (userTier === 'free' || !userTier) {
          // Show upgrade prompt for free tier
          setShowUpgradePrompt(true);
          return;
        }

        // Step 1: Intent classification (existing engine)
        const intent = classifyIntent(userInput);

        // Step 2: Smart Router classification
        const router = new SmartRouter(callGeminiFlash);
        const routerResult = await router.routePrompt(userInput, {
          screenshot,
          activeWindow: activeWindow?.title,
          openFiles,
        });

        // Step 3: Route to appropriate handler
        if (routerResult.classification === 'agent' && routerResult.confidence > 0.7) {
          // Route to Agent
          setChatMessages([...chatMessages, { role: 'user', content: userInput }]);

          await startAgent(userInput, {
            screenshot,
            activeWindowInfo: activeWindow?.title,
            openFiles,
            conversationHistory: chatMessages,
          });

          // After agent completes, add final message
          if (agentState === 'done') {
            setChatMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                content: agentMessages[agentMessages.length - 1]?.content || '',
              },
            ]);
          }
        } else {
          // Route to Chat (existing Gemini flow)
          setSourceMode('chat');

          const enhancedContext = {
            windowContext: activeWindow,
            screenshot,
            files: openFiles,
          };

          // Call existing Gemini chat handler
          await handleGeminiChat(userInput, enhancedContext);
        }
      } catch (err) {
        console.error('Submission error:', err);
        setError('Failed to process request');
      }
    },
    [chatMessages, startAgent, classifyIntent, callGeminiFlash]
  );

  // Modified: render logic to show agent UI when running
  return (
    <div className="flex flex-col h-screen bg-gray-900 text-gray-100">
      {/* Existing header/UI... */}

      {/* Conditional: Show workflow panel when agent is active */}
      <WorkflowPanel
        isVisible={agentState !== 'idle' && agentState !== 'error'}
        messages={agentMessages}
        toolMessages={toolMessages}
        cost={cost}
        isRunning={agentState === 'running' || agentState === 'waiting-permission'}
        onAbort={abortAgent}
      />

      {/* Conditional: Show permission UI when waiting for approval */}
      <PermissionTabs
        request={permissionRequest}
        onAllow={approvePermission}
        onDeny={denyPermission}
        trustMode={trustMode}
        onTrustModeChange={setTrustMode}
      />

      {/* Conditional: Show upgrade prompt for free tier users */}
      {showUpgradePrompt && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-gray-800 border border-yellow-500 rounded-lg p-6 max-w-md">
            <h3 className="text-lg font-semibold mb-2">Agent Mode Requires Pro</h3>
            <p className="text-sm text-gray-300 mb-4">
              The smart agent is a Pro+ feature. Upgrade to unlock autonomous multi-step workflows.
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowUpgradePrompt(false)}
                className="flex-1 px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded"
              >
                Cancel
              </button>
              <button
                onClick={() => window.electron.openExternal('https://klypix.app/pricing')}
                className="flex-1 px-3 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 rounded font-medium"
              >
                Upgrade Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Existing chat UI continues... */}
    </div>
  );
}
```

**Key Integration Points:**

1. **Smart Router Integration**: On user submit, route classification happens transparently.
2. **Tier Gating**: Free tier users see upgrade prompt; Pro+ can use agent.
3. **Dual UI Paths**: Agent execution shows WorkflowPanel + PermissionTabs; chat shows existing chat UI.
4. **Session Continuity**: Agent inherits conversation history from Chat mode for context awareness.
5. **Trust Mode**: Single-session toggle to auto-approve low-risk tools (ask_first).

---

## 16. Settings UI - Claude API Key + Cost Display

New settings panel additions for agent configuration and cost monitoring.

**Location:** `src/components/SettingsPanel.tsx` (additions)

```typescript
import React, { useState, useEffect } from 'react';

interface SettingsPanelProps {
  onClose: () => void;
}

export const SettingsPanel: React.FC<SettingsPanelProps> = ({ onClose }) => {
  const [claudeApiKey, setClaudeApiKey] = useState('');
  const [dailyBudget, setDailyBudget] = useState(5.0);
  const [currentSpend, setCurrentSpend] = useState(0);
  const [costHistory, setCostHistory] = useState<number[]>([]);
  const [agentModeEnabled, setAgentModeEnabled] = useState(true);
  const [showApiKey, setShowApiKey] = useState(false);

  // Load settings on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const key = await window.electron.getClaudeApiKey?.();
        const budget = await window.electron.getDailyBudget?.();
        const spend = await window.electron.getDailySpend?.();
        const history = await window.electron.getCostHistory?.();
        const agentEnabled = await window.electron.isAgentModeEnabled?.();

        setClaudeApiKey(key ? '••••••' : '');
        setDailyBudget(budget || 5.0);
        setCurrentSpend(spend || 0);
        setCostHistory(history || []);
        setAgentModeEnabled(agentEnabled !== false);
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };
    loadSettings();
  }, []);

  const handleSaveApiKey = async () => {
    try {
      await window.electron.setClaudeApiKey?.(claudeApiKey);
      setClaudeApiKey('••••••');
      // Show toast: "API key saved securely"
    } catch (err) {
      // Show error toast
    }
  };

  const handleBudgetChange = async (newBudget: number) => {
    setDailyBudget(newBudget);
    await window.electron.setDailyBudget?.(newBudget);
  };

  const handleResetDailySpend = async () => {
    if (window.confirm('Reset today\'s spending tracker?')) {
      await window.electron.resetDailySpend?.();
      setCurrentSpend(0);
    }
  };

  const budgetProgress = (currentSpend / dailyBudget) * 100;
  const budgetColor =
    budgetProgress > 100 ? 'red' : budgetProgress > 75 ? 'yellow' : 'emerald';

  return (
    <div className="space-y-6 p-6 bg-gray-900 rounded-lg border border-gray-700">
      {/* Agent Section Header */}
      <div>
        <h3 className="text-lg font-semibold text-gray-100 mb-4 flex items-center gap-2">
          <span className="text-emerald-500">Agent Configuration</span>
        </h3>
      </div>

      {/* Claude API Key */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-gray-300">
          Claude API Key
        </label>
        <div className="flex gap-2">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={claudeApiKey}
            onChange={(e) => setClaudeApiKey(e.target.value)}
            placeholder="sk-ant-..."
            className="flex-1 px-3 py-2 bg-gray-800 border border-gray-600 rounded text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500"
          />
          <button
            onClick={() => setShowApiKey(!showApiKey)}
            className="px-3 py-2 bg-gray-700 hover:bg-gray-600 rounded text-sm text-gray-300"
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
          <button
            onClick={handleSaveApiKey}
            className="px-3 py-2 bg-emerald-600 hover:bg-emerald-700 rounded text-sm text-white font-medium"
          >
            Save
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Stored securely in Windows Credential Manager. Leave blank to use free tier.
        </p>
      </div>

      {/* Agent Mode Toggle */}
      <div className="flex items-center justify-between">
        <div>
          <label className="block text-sm font-medium text-gray-300">
            Agent Mode
          </label>
          <p className="text-xs text-gray-500">
            Enable autonomous multi-step workflows
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={agentModeEnabled}
            onChange={(e) => {
              setAgentModeEnabled(e.target.checked);
              window.electron.setAgentModeEnabled?.(e.target.checked);
            }}
            className="w-5 h-5 accent-emerald-500"
          />
          <span className="ml-3 text-sm text-gray-300">
            {agentModeEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </label>
      </div>

      {/* Daily Budget Section */}
      <div className="space-y-3 border-t border-gray-700 pt-4">
        <label className="block text-sm font-medium text-gray-300">
          Daily Budget: ${dailyBudget.toFixed(2)}
        </label>
        <input
          type="range"
          min="0.50"
          max="50"
          step="0.50"
          value={dailyBudget}
          onChange={(e) => handleBudgetChange(parseFloat(e.target.value))}
          className="w-full h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-emerald-500"
        />
        <div className="flex justify-between text-xs text-gray-500">
          <span>$0.50</span>
          <span>$50.00</span>
        </div>
      </div>

      {/* Current Spend Indicator */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-gray-300">Today's Spend:</span>
          <span className={`font-semibold ${
            budgetColor === 'red' ? 'text-red-400' :
            budgetColor === 'yellow' ? 'text-yellow-400' :
            'text-emerald-400'
          }`}>
            ${currentSpend.toFixed(4)} / ${dailyBudget.toFixed(2)}
          </span>
        </div>
        <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              budgetColor === 'red' ? 'bg-red-500' :
              budgetColor === 'yellow' ? 'bg-yellow-500' :
              'bg-emerald-500'
            }`}
            style={{ width: `${Math.min(budgetProgress, 100)}%` }}
          />
        </div>
        {budgetProgress > 100 && (
          <p className="text-xs text-red-400">Budget exceeded!</p>
        )}
      </div>

      {/* Reset Button */}
      <button
        onClick={handleResetDailySpend}
        className="w-full px-3 py-2 text-sm bg-gray-700 hover:bg-gray-600 rounded text-gray-300"
      >
        Reset Daily Spend Counter
      </button>

      {/* Cost History Chart */}
      <div className="space-y-2 border-t border-gray-700 pt-4">
        <label className="block text-sm font-medium text-gray-300">
          7-Day Cost History
        </label>
        <div className="flex items-end gap-1 h-20 bg-gray-800 p-2 rounded">
          {costHistory.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-xs text-gray-500">
              No cost data yet
            </div>
          ) : (
            costHistory.map((cost, idx) => {
              const maxCost = Math.max(...costHistory, dailyBudget);
              const height = (cost / maxCost) * 100;
              return (
                <div
                  key={idx}
                  className="flex-1 bg-emerald-500/50 rounded-t"
                  style={{ height: `${height}%`, minHeight: '2px' }}
                  title={`Day ${idx + 1}: $${cost.toFixed(2)}`}
                />
              );
            })
          )}
        </div>
      </div>

      {/* Trust Mode Session Toggle */}
      <div className="flex items-center justify-between border-t border-gray-700 pt-4">
        <div>
          <label className="block text-sm font-medium text-gray-300">
            Trust Mode
          </label>
          <p className="text-xs text-gray-500">
            Auto-approve low-risk tools this session
          </p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="w-5 h-5 accent-emerald-500"
            onChange={(e) => {
              window.electron.setTrustMode?.(e.target.checked);
            }}
          />
        </label>
      </div>
    </div>
  );
};
```

**IPC Extensions in `electron/main.ts`:**

```typescript
// Claude Agent API key management (encrypted via safeStorage)
ipcMain.handle('getClaudeApiKey', async () => {
  try {
    const key = safeStorage.decryptString(
      Buffer.from(store.get('claude.apiKey', ''), 'hex')
    );
    return key;
  } catch {
    return '';
  }
});

ipcMain.handle('setClaudeApiKey', async (_, key: string) => {
  const encrypted = safeStorage.encryptString(key);
  store.set('claude.apiKey', encrypted.toString('hex'));
});

// Budget management
ipcMain.handle('getDailyBudget', () => store.get('agent.budget', 5.0));
ipcMain.handle('setDailyBudget', (_, budget: number) => {
  store.set('agent.budget', budget);
});

ipcMain.handle('getDailySpend', () => {
  const today = new Date().toISOString().split('T')[0];
  const spending = store.get('agent.spending', {});
  return spending[today] || 0;
});

ipcMain.handle('resetDailySpend', () => {
  const today = new Date().toISOString().split('T')[0];
  const spending = store.get('agent.spending', {});
  spending[today] = 0;
  store.set('agent.spending', spending);
});

ipcMain.handle('getCostHistory', () => {
  const spending = store.get('agent.spending', {});
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split('T')[0];
    last7Days.push(spending[dateStr] || 0);
  }
  return last7Days;
});

// Agent mode
ipcMain.handle('isAgentModeEnabled', () => store.get('agent.enabled', true));
ipcMain.handle('setAgentModeEnabled', (_, enabled: boolean) => {
  store.set('agent.enabled', enabled);
});

ipcMain.handle('setTrustMode', (_, enabled: boolean) => {
  store.set('agent.trustMode', enabled);
});
```

---

## 17. File Map and Build Order

Complete inventory of all new files created and existing files modified, with build dependencies.

| # | File Path | Type | Purpose | Dependencies | Build Order |
|---|-----------|------|---------|--------------|-------------|
| 1 | `src/core/agent/types.ts` | New | Tool, step, and action type definitions | None | 1 |
| 2 | `src/core/agent/costTracker.ts` | New | Token/cost calculation | None | 1 |
| 3 | `src/core/agent/toolRegistry.ts` | New | Tool catalog with JSON schemas | types.ts | 2 |
| 4 | `src/core/agent/smartRouter.ts` | New | Classification: chat vs agent | callGeminiFlash | 2 |
| 5 | `src/core/agent/permissionManager.ts` | New | Tool approval workflow | types.ts | 2 |
| 6 | `src/core/agent/actionExecutor.ts` | New | Execute tools (shell, file, browser, etc.) | window.electron, types.ts, toolRegistry.ts | 3 |
| 7 | `src/core/agent/stepPlanner.ts` | New | Plan multi-step workflows | types.ts, costTracker.ts | 3 |
| 8 | `src/core/agent/claudeAgent.ts` | New | Main agent orchestrator + streaming | Anthropic SDK, all above | 4 |
| 9 | `src/hooks/useClaudeAgent.ts` | New | React hook for agent state | claudeAgent.ts, smartRouter.ts, sessionContext.ts | 5 |
| 10 | `src/components/WorkflowPanel.tsx` | New | Agent execution UI (streaming text, steps, cost) | useClaudeAgent hook | 5 |
| 11 | `src/components/PermissionTabs.tsx` | New | Permission approval interface | useClaudeAgent hook | 5 |
| 12 | `src/components/SettingsPanel.tsx` (additions) | Modify | Add agent config section | window.electron IPC extensions | 5 |
| 13 | `src/hooks/index.ts` | Modify | Export useClaudeAgent | useClaudeAgent.ts | 5 |
| 14 | `src/App.tsx` | Modify | Integrate Smart Router + agent UI + tier check | useClaudeAgent, SmartRouter, PermissionTabs | 6 |
| 15 | `electron/preload.ts` | Modify | Expose new IPC: getClaudeApiKey, setClaudeApiKey, etc. | None (preload) | 6 |
| 16 | `electron/main.ts` | Modify | IPC handlers for agent: budget, spending, trust mode, API key storage | safeStorage, store | 6 |
| 17 | `src/types/index.ts` | Modify | Add AgentMessage, ToolMessage types if not already present | None | 1 |

**Build Order:**

1. **Phase 1 - Types & Utilities (Order 1-2)**
   - Create types.ts, costTracker.ts
   - Create smartRouter.ts, toolRegistry.ts, permissionManager.ts

2. **Phase 2 - Core Logic (Order 3-4)**
   - Create actionExecutor.ts, stepPlanner.ts
   - Create claudeAgent.ts (main orchestrator)

3. **Phase 3 - React Integration (Order 5)**
   - Create useClaudeAgent hook
   - Create WorkflowPanel, PermissionTabs components
   - Export from hooks/index.ts

4. **Phase 4 - Integration (Order 6)**
   - Modify App.tsx to use hook + routing
   - Extend preload.ts and main.ts with IPC handlers
   - Update SettingsPanel with agent config

**Total New Lines of Code (Estimated):**

| File | Lines |
|------|-------|
| types.ts | 120 |
| costTracker.ts | 90 |
| toolRegistry.ts | 280 |
| smartRouter.ts | 150 |
| permissionManager.ts | 110 |
| actionExecutor.ts | 600 |
| stepPlanner.ts | 250 |
| claudeAgent.ts | 500 |
| useClaudeAgent.ts | 400 |
| WorkflowPanel.tsx | 180 |
| PermissionTabs.tsx | 200 |
| SettingsPanel additions | 200 |
| App.tsx additions | 150 |
| preload.ts additions | 80 |
| main.ts additions | 250 |
| **TOTAL** | **3,560** |

---

## 18. 20 Real User Scenarios

Comprehensive walkthrough of agent execution in diverse real-world scenarios.

### Scenario 1: Create Data Export (Agent Route)

**User Prompt:** "Export the data from my last quarterly sales report into a CSV file."

**Smart Router Classification:** AGENT (confidence: 0.92)
- Reason: Multi-step document handling + file creation intent

**Workflow:**
1. read_file(path: "~/Documents/Q4_Sales_Report.xlsx")
2. parse_tabular_data(data: sales data from report)
3. generate_file(type: "CSV", data: parsed sales data, path: "~/Downloads/sales_export.csv")

**Permissions Prompted:**
- read_file: ask_first → User approves (auto-allowed if trust mode on)
- generate_file: auto (no permission needed, user requested file output)

**Cost:** $0.008 (3 tool calls + streaming response)
**Duration:** 4 seconds
**Success Path:** File saved, user notified

---

### Scenario 2: Browser Automation with Multiple Confirmations (Agent Route)

**User Prompt:** "Fill out the job application form on the careers page with my standard information."

**Smart Router Classification:** AGENT (confidence: 0.85)
- Reason: Multi-step browser interaction + form filling

**Workflow:**
1. navigate_browser(url: "careers.company.com")
2. screenshot() → analyze page structure
3. click_element(selector: "First Name field")
4. type_text(text: "Abdullah")
5. click_element(selector: "Last Name field")
6. type_text(text: "Ibrahim")
7. click_element(selector: "Email field")
8. type_text(text: user's email from context)
9. click_element(selector: "Resume upload")
10. fill_form_file(path: "~/Documents/Resume.pdf")

**Permissions Prompted:**
- navigate_browser: ask_first → User approves
- click_element x 4: auto (low-risk UI interaction)
- type_text x 4: auto
- fill_form_file: ask_first → User approves

**Cost:** $0.012
**Duration:** 8 seconds
**Success Path:** Form completed, ready for user review before submission

---

### Scenario 3: Denied Permission Recovery (Agent Route)

**User Prompt:** "Check if there are any security vulnerabilities in my codebase."

**Smart Router Classification:** AGENT (confidence: 0.78)

**Workflow:**
1. read_file(path: "~/project/main.py") → ask_first

**Permission Request Shown:**
- Tool: read_file
- Description: "Read Python source file to analyze for security issues"
- Input: { path: "~/project/main.py" }
- Buttons: Allow Once | Always Allow | Deny

**User Action:** Deny (concerned about privacy)

**Agent Recovery:**
- Agent receives denial, adjusts plan
- New response: "I understand. I can't read your source directly, but I can guide you through a security checklist specific to Python. Here are the top 10 OWASP vulnerabilities to check manually..."
- Agent continues in advisory mode without accessing files

**Permissions Prompted (Recovery):** None (advisory only)
**Cost:** $0.004
**Duration:** 2 seconds
**Success Path:** User gets actionable security advice without file access

---

### Scenario 4: Chat Route (Smart Router Decides Chat, Not Agent)

**User Prompt:** "What are the best practices for designing REST APIs?"

**Smart Router Classification:** CHAT (confidence: 0.95)
- Reason: Knowledge question, no file/tool interaction needed
- Routes to existing Gemini chat flow

**Gemini Response:**
- Generates best practices summary
- No agent tools invoked
- Streaming text appears in chat UI, not workflow panel

**Cost:** $0.0012 (Gemini Flash token usage)
**Duration:** 3 seconds
**Result:** User reads response in chat, no agent overhead

---

### Scenario 5: Multi-File Analysis with Cost Tracking (Agent Route)

**User Prompt:** "Analyze my top 5 most used Excel files and create a summary of their contents."

**Smart Router Classification:** AGENT (confidence: 0.88)

**Workflow:**
1. get_recent_files(filter: "xlsx", limit: 5) → Cost: $0.001
2. read_file(path: file 1) → ask_first → User approves → Cost: $0.002
3. read_file(path: file 2) → ask_first → Auto-allowed (trust mode) → Cost: $0.002
4. read_file(path: file 3) → ask_first → Auto-allowed → Cost: $0.002
5. read_file(path: file 4) → ask_first → Auto-allowed → Cost: $0.002
6. read_file(path: file 5) → ask_first → Auto-allowed → Cost: $0.002
7. analyze_data(aggregated from all files) → Cost: $0.003
8. generate_file(type: "DOCX", content: summary) → Cost: $0.002

**Permissions Prompted:**
- get_recent_files: auto
- read_file (first): User approves manually
- read_file (next 4): Auto-approved via trust mode toggle

**Running Cost Display:**
- After file 1: $0.005
- After file 3: $0.009
- After analysis: $0.012
- Final: $0.017

**Cost Limit Check:** Daily budget $5.00, current spend $0.17, safe to proceed

**Duration:** 12 seconds
**Success Path:** DOCX summary saved, cost logged

---

### Scenario 6: Permission Denied, User Upgrades Mid-Workflow (Tier Check)

**User Prompt:** "Use the agent to process my expense reports."

**User Tier:** Free (50 queries/day limit, no agent access)

**Smart Router Result:** AGENT (confidence: 0.82)

**Tier Check:** canUseFeature(tier: 'free', feature: 'agentMode') → FALSE

**UI Response:**
- WorkflowPanel shows: "Agent Mode Requires Pro"
- Modal appears: "Unlock autonomous workflows with Pro. Upgrade now?"
- Buttons: Cancel | Upgrade Now

**User Action:** Clicks "Upgrade Now"
- Opens pricing page in browser
- User completes upgrade
- Returns to app
- Can retry agent request

**Cost:** $0 (feature unavailable)
**Duration:** Depends on user upgrade time
**Result:** Tier check prevents unauthorized agent use

---

### Scenario 7: Power User Trust Mode (All ask_first Auto-Approved)

**User Prompt:** "Organize my Downloads folder: group by file type, archive old files, and generate a summary."

**Smart Router Classification:** AGENT (confidence: 0.91)

**User Preference:** Trust Mode ON (toggle in settings)

**Workflow:**
1. read_directory(path: "~/Downloads") → ask_first → Auto-approved (trust mode)
2. group_files(by: "file type") → auto
3. move_file(archive old files) x 10 → ask_first x 10 → All auto-approved
4. generate_file(summary report) → auto

**Permissions Prompted:** NONE (all auto-approved in trust mode)

**Running Display:**
- "Trust Mode: Auto-approving low-risk tools this session"
- Each tool executes immediately without pause

**Cost:** $0.006
**Duration:** 3 seconds (no permission delays)
**Success Path:** Fast automation for trusted user

---

### Scenario 8: Command Execution with ask_every (Always Ask)

**User Prompt:** "Update my Python dependencies to the latest versions."

**Smart Router Classification:** AGENT (confidence: 0.79)

**Workflow:**
1. shell_command(cmd: "pip list --outdated") → auto (read-only)
2. shell_command(cmd: "pip install --upgrade pip") → ask_every → Permission prompt shown

**Permission 1 Shown:**
- Tool: shell_command
- Description: "Execute pip upgrade command"
- Input: { cmd: "pip install --upgrade pip" }
- Note: "This tool requires explicit approval every time"
- Buttons: Allow Once | Deny (no "Always Allow" for ask_every tools)

**User Action:** Allow Once

3. shell_command(cmd: "pip install --upgrade setuptools") → ask_every → Permission prompt shown again (even if just approved same tool)

**Permission 2 Shown:**
- Same process repeats (cannot skip via trust mode for ask_every)

**Cost:** $0.005
**Duration:** 8 seconds (two approval pauses)
**Success Path:** Dependencies updated safely with explicit per-action approvals

---

### Scenario 9: Screenshot Analysis Triggers Agent Action (Agent Route)

**User Prompt:** "Look at my screen and tell me what to do with the error message showing."

**Smart Router Classification:** AGENT (confidence: 0.84)
- Reason: Requires screenshot analysis + potential action

**Workflow:**
1. screenshot() → Cost: $0.001
2. analyze_screenshot(error message visible) → Cost: $0.002
3. identify_action(e.g., "Need to check logs") → Cost: $0.001
4. read_file(path: inferred log location) → ask_first → User approves → Cost: $0.002
5. analyze_log_data() → Cost: $0.001
6. generate_suggestion(fix recommendation) → Cost: $0.001

**Permissions Prompted:**
- read_file: User sees permission tab showing log file path, approves

**Running Cost:**
- Screenshot: $0.001
- Analysis: $0.004
- File read: $0.006
- Final suggestion: $0.008

**Cost Limit:** Safe (below daily budget)

**Duration:** 5 seconds
**Success Path:** Error explained, actionable fix provided

---

### Scenario 10: Budget Exceeded Mid-Workflow (Cost Limit Hit)

**User Prompt:** "Analyze all my project files and create a comprehensive technical documentation."

**User Settings:** Daily budget $5.00, current spend $4.95 remaining budget $0.05

**Smart Router Classification:** AGENT (confidence: 0.86)

**Workflow Starts:**
1. get_project_files() → Cost: $0.01 → Total: $4.96 (OK)
2. read_file(large file 1) → ask_first → User approves → Cost: $0.02 → Total: $4.98 (OK)
3. read_file(large file 2) → ask_first → User approves → Cost: $0.03 → Total: $5.01 (BUDGET EXCEEDED)

**Agent Behavior:**
- Cost tracker detects overage
- Workflow pauses
- WorkflowPanel shows: "Daily budget exceeded: $5.01 / $5.00"
- Options: Increase budget in settings | Retry tomorrow | Abort

**User Action:** Increases budget to $10.00

3. read_file (continues) → Cost: $0.03 → Total: $5.04 (OK with new budget)
4. Remaining files read with cost tracking...

**Final Cost:** $0.087
**Duration:** 15 seconds
**Success Path:** Budget check prevents overspend; user can adjust and continue

---

### Scenario 11: Chat Route for Code Question (No Agent Needed)

**User Prompt:** "How do I handle async/await errors in TypeScript?"

**Smart Router Classification:** CHAT (confidence: 0.97)
- Reason: Educational question, knowledge-based, no tool use
- Routes to Gemini chat (existing flow)

**Gemini Response:**
```
To handle async/await errors in TypeScript:

1. Try/Catch blocks:
   try {
     const result = await asyncFunction();
   } catch (error) {
     console.error(error);
   }

2. Chaining .catch():
   asyncFunction().catch(error => console.error(error));

3. Custom error types...
```

**UI Display:**
- Response streams in chat panel (not workflow panel)
- No tool execution shown
- No permission tabs

**Cost:** $0.001 (Gemini Flash)
**Duration:** 2 seconds
**Result:** User learns pattern, no agent overhead

---

### Scenario 12: Code Review with File Attachment (Agent Route)

**User Prompt:** "Review this code for potential bugs and suggest improvements." (with file attached)

**Smart Router Classification:** AGENT (confidence: 0.75)

**Workflow:**
1. read_file(attached file: code.ts) → auto (already provided by user)
2. analyze_code(for bugs, style, performance) → Cost: $0.002
3. identify_issues() → Cost: $0.001
4. generate_suggestions() → Cost: $0.001
5. generate_file(type: "DOCX", content: review report) → auto → Cost: $0.002

**Permissions Prompted:** None (user already provided file)

**Output:**
- Markdown review in streaming response
- Generated DOCX saved to Downloads
- Issues organized by severity

**Cost:** $0.006
**Duration:** 6 seconds
**Success Path:** Code review report generated

---

### Scenario 13: Multi-Step Research Workflow (Agent Route)

**User Prompt:** "Research the market size for AI productivity tools and create a one-slide summary for investors."

**Smart Router Classification:** AGENT (confidence: 0.81)

**Workflow:**
1. screenshot() → get current browser state → Cost: $0.001
2. navigate_browser(url: "statista.com") → ask_first → User approves → Cost: $0.001
3. extract_data(from page tables) → Cost: $0.002
4. navigate_browser(url: "gartner.com/market-research") → auto → Cost: $0.001
5. extract_data(from second source) → Cost: $0.002
6. synthesize_data(from both sources) → Cost: $0.001
7. generate_file(type: "PPTX", slides: 1, content: market summary) → auto → Cost: $0.003

**Permissions Prompted:**
- navigate_browser (first): User approves

**Cost Breakdown:**
- Data extraction: $0.006
- Synthesis: $0.001
- PPT generation: $0.003
- **Total:** $0.011

**Duration:** 10 seconds
**Success Path:** Investor-ready slide deck generated

---

### Scenario 14: Local File Processing (No Browser/Network)

**User Prompt:** "Convert all my JPG images in the Pictures folder to PNG format."

**Smart Router Classification:** AGENT (confidence: 0.88)

**Workflow:**
1. get_directory_files(path: "~/Pictures", filter: "jpg") → Cost: $0.001
2. file_operation(command: convert, from: jpg, to: png) x 8 → ask_first (first file) → User approves → Cost: $0.001 each
   - Files: vacation1.jpg, vacation2.jpg, ... vacation8.jpg
3. verify_files(path: "~/Pictures/converted") → Cost: $0.001

**Permissions Prompted:**
- file_operation (first): User approves, can optionally "Always Allow" for rest

**Cost:** $0.011
**Duration:** 4 seconds
**Success Path:** All JPGs converted to PNG

---

### Scenario 15: Error Recovery with Fallback (Agent Route)

**User Prompt:** "Generate a Gantt chart from my project timeline spreadsheet."

**Smart Router Classification:** AGENT (confidence: 0.76)

**Workflow (Attempt 1):**
1. read_file(path: "~/project_timeline.xlsx") → ask_first → User approves → Cost: $0.002
2. parse_gantt_data() → Cost: $0.002
3. generate_file(type: "PPTX", format: "Gantt chart") → Fails (Gantt not supported in PPTX generator)

**Error Handling:**
- Agent catches failure
- Adjusts strategy: "Can't generate native Gantt in PowerPoint, but I'll create a table timeline instead"

**Workflow (Attempt 2):**
4. generate_file(type: "PPTX", format: "table timeline") → Success → Cost: $0.003

**Total Cost:** $0.007
**Duration:** 6 seconds
**Success Path:** User gets alternative format (timeline table in PPTX)

---

### Scenario 16: Clipboard Integration (Agent Route)

**User Prompt:** "Copy my current screen content to a Word document outline."

**Smart Router Classification:** AGENT (confidence: 0.79)

**Workflow:**
1. screenshot() → Cost: $0.001
2. read_clipboard() → Cost: $0.001
3. analyze_content(screenshot + clipboard) → Cost: $0.002
4. structure_as_outline() → Cost: $0.001
5. generate_file(type: "DOCX", format: "outline") → auto → Cost: $0.002

**Permissions Prompted:** None (all auto or user-initiated)

**Output:**
- DOCX with structured outline of current context
- Saved to Documents folder

**Cost:** $0.007
**Duration:** 4 seconds
**Success Path:** Outline created

---

### Scenario 17: Scheduled Task Creation (Agent Route)

**User Prompt:** "Set up a daily reminder to review my task list at 9 AM."

**Smart Router Classification:** AGENT (confidence: 0.68) — Lower confidence, borderline

**Workflow:**
1. create_scheduled_task(name: "Daily task review", time: "09:00", recurring: "daily") → ask_first → User approves → Cost: $0.002
2. verify_task_created() → Cost: $0.001
3. send_confirmation() → Cost: $0.001

**Permissions Prompted:**
- create_scheduled_task: User sees details, approves

**Cost:** $0.004
**Duration:** 2 seconds
**Success Path:** Scheduled task created

---

### Scenario 18: Permission Denied, Manual Workaround (Agent Route)

**User Prompt:** "Automatically back up my important documents to a cloud folder."

**Smart Router Classification:** AGENT (confidence: 0.82)

**Workflow:**
1. identify_important_docs() → Cost: $0.001
2. shell_command(cmd: "rclone sync ~/Documents ~/cloud-backup") → ask_every → Permission prompt

**Permission Shown:**
- Tool: shell_command
- Description: "Execute rclone sync to backup files to cloud"
- Input: { cmd: "rclone sync ~/Documents ~/cloud-backup" }

**User Action:** Deny (concerned about security/unencrypted transfer)

**Agent Recovery:**
- Agent provides manual instructions:
  - "I cannot execute the backup command without your approval. Here's how to set it up manually:
  1. Install rclone: https://rclone.org/install/
  2. Configure encryption: rclone config
  3. Run: rclone sync ~/Documents ~/cloud-backup --crypt
  4. Consider using end-to-end encryption for sensitive docs."

**Cost:** $0.003 (guidance only)
**Duration:** 2 seconds
**Result:** User has clear manual process

---

### Scenario 19: Multi-Tool Workflow with Cost Awareness (Agent Route)

**User Prompt:** "Extract data from three PDFs and create a comparison spreadsheet."

**Smart Router Classification:** AGENT (confidence: 0.89)

**Workflow:**
1. read_pdf_with_password(path: "report1.pdf", password: <user provides>) → ask_first → User approves → Cost: $0.003
2. extract_tables_from_pdf() → Cost: $0.002
3. read_pdf_with_password(path: "report2.pdf") → ask_first → Auto-allowed (trust mode) → Cost: $0.003
4. extract_tables_from_pdf() → Cost: $0.002
5. read_pdf_with_password(path: "report3.pdf") → ask_first → Auto-allowed → Cost: $0.003
6. extract_tables_from_pdf() → Cost: $0.002
7. compare_datasets(all three) → Cost: $0.002
8. generate_file(type: "XLSX", format: "comparison") → auto → Cost: $0.003

**Running Cost Display:**
- After PDF 1: $0.005
- After PDF 2: $0.010
- After PDF 3: $0.015
- After comparison: $0.017
- After XLSX: $0.020

**Permissions Prompted:**
- read_pdf (first): User approves manually
- read_pdf (next two): Auto-approved via trust mode

**Cost:** $0.020
**Duration:** 12 seconds
**Success Path:** Comparison spreadsheet created, cost logged

---

### Scenario 20: Ambiguous Intent (Router Confidence Borderline)

**User Prompt:** "Check the logs and summarize errors."

**Smart Router Classification:** AGENT (confidence: 0.54) — Below threshold (0.7)
- Reason: Could be agent tool (read_file + analysis) OR just chat response
- Falls back to CHAT route

**Gemini Chat Response:**
- "To summarize errors, I'd recommend:
  1. Where are your logs stored?
  2. Do you want me to help you interpret specific error codes?
  3. Would you like a script to parse them automatically?"

**User Follow-up:** "They're in /var/log/app.log"

**Router Reclassification:** AGENT (confidence: 0.88)
- Now has file path context
- Routes to agent

**Workflow:**
1. read_file(path: "/var/log/app.log") → ask_first → User approves → Cost: $0.002
2. parse_logs(extract errors) → Cost: $0.001
3. summarize_errors() → Cost: $0.001
4. generate_file(type: "TXT", format: "summary") → auto → Cost: $0.001

**Cost:** $0.005
**Duration:** 4 seconds
**Result:** Log summary generated

---

## Summary Table: All 20 Scenarios

| # | Scenario | Route | Tools Used | Permissions | Cost | Duration |
|---|----------|-------|-----------|-------------|------|----------|
| 1 | Data export | AGENT | read_file, parse, generate_file | 1 ask_first | $0.008 | 4s |
| 2 | Browser form fill | AGENT | navigate, click, type, fill | 2 ask_first | $0.012 | 8s |
| 3 | Denied recovery | AGENT | read_file denied, advisory mode | 1 denied | $0.004 | 2s |
| 4 | API best practices | CHAT | (none) | — | $0.001 | 3s |
| 5 | Multi-file analysis | AGENT | get_files, read x5, analyze, generate | 1 manual, 4 auto (trust) | $0.017 | 12s |
| 6 | Tier blocked | (blocked) | (none) | Tier check | — | — |
| 7 | Trust mode enabled | AGENT | read_dir, group, move x10, generate | 0 (all auto via trust) | $0.006 | 3s |
| 8 | ask_every commands | AGENT | shell_command x2 ask_every | 2 ask_every (no skip) | $0.005 | 8s |
| 9 | Screenshot analysis | AGENT | screenshot, analyze, read, suggest | 1 ask_first | $0.008 | 5s |
| 10 | Budget exceeded | AGENT (partial) | read_file x2, hits limit, user increases | 1 ask_first | $0.087 | 15s |
| 11 | Code explanation | CHAT | (none) | — | $0.001 | 2s |
| 12 | Code review | AGENT | read_file (attached), analyze, generate | 0 (user-provided) | $0.006 | 6s |
| 13 | Market research | AGENT | navigate x2, extract x2, synthesize, pptx | 1 ask_first | $0.011 | 10s |
| 14 | Image conversion | AGENT | get_files, convert x8, verify | 1 ask_first | $0.011 | 4s |
| 15 | Error recovery | AGENT (retry) | read, parse, generate (fails), retry x2 | 1 ask_first | $0.007 | 6s |
| 16 | Clipboard outline | AGENT | screenshot, clipboard, analyze, outline, docx | 0 (auto) | $0.007 | 4s |
| 17 | Scheduled task | AGENT | create_task | 1 ask_first | $0.004 | 2s |
| 18 | Denied backup | AGENT (manual advice) | shell_command denied, advisory | 1 denied | $0.003 | 2s |
| 19 | PDF comparison | AGENT | read_pdf x3, extract x3, compare, xlsx | 1 manual, 2 auto (trust) | $0.020 | 12s |
| 20 | Ambiguous fallback | CHAT → AGENT | (chat first) → read_file, parse, summarize | 1 ask_first (agent phase) | $0.005 | 4s |

**Key Insights:**

- **Agent routes** (confidence ≥ 0.7): 16 scenarios
- **Chat routes** (confidence < 0.7): 4 scenarios
- **Permissions prompted:** 14 scenarios (denied = 2)
- **Cost range:** $0.001 - $0.087 (budget constraint demo)
- **Duration range:** 2-15 seconds
- **Trust mode impact:** Eliminates permission delays; 5+ scenarios benefit
- **Error recovery:** 2 scenarios show graceful degradation
- **Tier gating:** 1 scenario (free tier blocked)

