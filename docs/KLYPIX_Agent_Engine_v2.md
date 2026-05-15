# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Agent Engine - Comprehensive Integration Guide

## claw-code Architecture -> TypeScript Agent Loop

**Dahshan Labs | April 2026 | v2.0**

**Screen-First + Deep Tools + Terminal = Full Agent**

---

## Table of Contents

1. Architecture Overview
2. Capability Audit: What Exists vs What to Build
3. New IPC Handlers (5 handlers, ~80 lines)
4. Preload Bridge Additions
5. Tool Registry (tools.ts) - All 22 Tools
6. Permission System (permissions.ts) - Allow/Deny Tabs
7. Tool Executor (toolExecutor.ts) - IPC Bridge
8. Agent Loop (claudeAgent.ts) - The Core Engine
9. Agent Session Manager (agentSession.ts)
10. React Hook (useClaudeAgent.ts)
11. UI Components - Workflow Panel + Permission Tabs
12. App.tsx Integration - Mode Router
13. Settings UI - Claude API Key
14. File Map & Build Order
15. 20 Real User Scenarios

---

## 1. Architecture Overview

The KLYPIX Agent Engine translates the claw-code open-source agent loop pattern (Rust crates) into TypeScript that runs inside your existing Electron app. The core idea is simple: send a prompt + tool definitions to Claude, Claude calls tools, you execute them and send results back, repeat until Claude says it is done.

### Three-Layer Tool Architecture

- **SCREEN LAYER:** Screenshot capture, active window context, screen OCR. This is your killer advantage. Claude sees what the user sees, zero friction.
- **DEEP TOOLS LAYER:** File I/O (read/write/edit/list), document generation (DOCX/XLSX/PPTX/PDF), web content reading, clipboard, browser automation via CDP.
- **TERMINAL LAYER:** Arbitrary shell command execution via PowerShell. This is the NEW capability. Gives Claude access to npm, git, python, pip, anything on the system.

### claw-code Pattern (from Rust crates/runtime)

- **Session Management:** Track conversation history, tool results, and context across turns (session.rs pattern).
- **Tool Registry:** Define tools with JSON Schema input specs, Claude picks which to call (tools/src/lib.rs pattern).
- **Permission System:** Classify tools by risk level, require user approval for dangerous operations (permissions.rs pattern).
- **Agent Loop:** Send messages to Claude API, parse tool_use blocks, execute, return tool_result, loop until stop (conversation.rs pattern).

### What makes this different from Cowork

- Cowork has NO screen. User must manually describe what they see or attach files. KLYPIX auto-captures the screen BEFORE the agent even starts thinking.
- Cowork is cloud-sandboxed. KLYPIX runs locally with direct access to the user's filesystem, running processes, and Windows automation.
- KLYPIX can see AND act on what is on screen simultaneously: read a PDF, see a spreadsheet error, type into a browser form, all in one agent loop.

---

## 2. Capability Audit: What Exists vs What to Build

This is the honest, code-verified audit of every IPC handler in main.ts and what works today.

### EXISTING - Ready to wire as Claude tools (15 capabilities)

| Capability | IPC Channel | Status | Notes |
|---|---|---|---|
| capture_screen | capture-screen | WORKS | Full screen via desktopCapturer |
| capture_screen_raw | capture-screen-raw | WORKS | Returns buffer for vision |
| get_window_context | get-active-window-context | WORKS | Title + process name |
| read_active_file | read-active-file | WORKS | Foreground window file content |
| get_all_open_files | get-all-open-files | WORKS | EnumWindows+UIA+CDP+Sessions |
| read_multiple_files | read-multiple-files | WORKS | Batch file reader |
| read_web_content | read-web-content | WORKS | Fetch URL + cheerio + CDP fallback |
| read_clipboard | read-clipboard | WORKS | clipboard.readText() |
| generate_file | generate-file | WORKS | DOCX/XLSX/PPTX/PDF generation |
| system_open | eye:execute-action | WORKS | shell.openPath + exec start |
| system_type | eye:execute-action | WORKS | SendKeys via PowerShell |
| system_close | eye:execute-action | WORKS | CloseMainWindow via PS |
| file_save/rename/move | eye:execute-action | WORKS | fs.copyFile/rename |
| file_create | eye:execute-action | WORKS | fs.writeFileSync |
| file_delete | eye:execute-action | WORKS | shell.trashItem (recycle bin) |
| clipboard_copy | eye:execute-action | WORKS | clipboard.writeText |
| browser_navigate | eye:execute-action | PARTIAL | shell.openExternal only |
| browser_fill/click | eye:execute-action | CDP ONLY | Needs debug port enabled |
| browser_scroll | eye:execute-action | FALLBACK | CDP or SendKeys PgUp/PgDn |

### TO BUILD - New IPC handlers needed (5 handlers, ~80 lines total)

| Handler | Purpose | Complexity | Lines |
|---|---|---|---|
| run-shell-command | Execute arbitrary PowerShell/cmd, return stdout+stderr | Simple | ~25 |
| read-file-at-path | Read any file by absolute path | Trivial | ~10 |
| write-file-at-path | Write content to any file path | Trivial | ~10 |
| edit-file-content | Find-and-replace in a file | Simple | ~15 |
| list-directory | List files/folders at a path | Trivial | ~10 |

---

## 3. New IPC Handlers for main.ts

Add these 5 handlers to electron/main.ts. They give the agent full filesystem and terminal access.

### Handler 1: run-shell-command (THE BIG ONE)

This single handler gives Claude terminal access to everything: npm, git, python, powershell scripts, system commands.

```typescript
// -- Agent: Shell Command Execution --
ipcMain.handle('run-shell-command', async (_event: any, { command, cwd, timeout }: {
  command: string; cwd?: string; timeout?: number;
}) => {
  console.log('[Agent] Shell:', command.substring(0, 100));
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
// -- Agent: Read File at Path --
ipcMain.handle('read-file-at-path', async (_event: any, { filePath, maxChars }: {
  filePath: string; maxChars?: number;
}) => {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const limit = maxChars || 100000;
    return {
      success: true,
      content: content.length > limit ? content.slice(0, limit) + '\n[...truncated]' : content,
      size: content.length,
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

### Handler 3: write-file-at-path

```typescript
// -- Agent: Write File at Path --
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
// -- Agent: Edit File (find-and-replace) --
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
// -- Agent: List Directory --
ipcMain.handle('list-directory', async (_event: any, { dirPath }: { dirPath: string }) => {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return {
      success: true,
      entries: entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : undefined,
      })),
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

---

## 4. Preload Bridge Additions

Add these lines to electron/preload.ts inside the contextBridge.exposeInMainWorld block, under the existing Agent Mode section:

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
```

### TypeScript declaration (add to src/types/electron.d.ts or global.d.ts):

```typescript
interface ElectronAgent {
  runShell(opts: { command: string; cwd?: string; timeout?: number }): Promise<{
    success: boolean; stdout: string; stderr: string; code?: number;
  }>;
  readFile(opts: { filePath: string; maxChars?: number }): Promise<{
    success: boolean; content?: string; size?: number; error?: string;
  }>;
  writeFile(opts: { filePath: string; content: string }): Promise<{
    success: boolean; path?: string; size?: number; error?: string;
  }>;
  editFile(opts: { filePath: string; oldText: string; newText: string }): Promise<{
    success: boolean; path?: string; error?: string;
  }>;
  listDir(opts: { dirPath: string }): Promise<{
    success: boolean; entries?: Array<{ name: string; type: string; size?: number }>; error?: string;
  }>;
}

interface ElectronAPI {
  // ... existing methods ...
  agent: ElectronAgent;
}
```

---

## 5. Tool Registry - src/core/agent/tools.ts

This is the claw-code tools.rs pattern translated to TypeScript. Each tool has a name, description, input_schema (JSON Schema), and a permission level. Claude sees these definitions and decides which to call.

### Permission Levels (from claw-code permissions.rs)

| Level | Behavior | Examples |
|---|---|---|
| ALWAYS_ALLOW | Execute immediately, no prompt | screenshot, read_clipboard, list_directory, get_context |
| ASK_FIRST_TIME | Ask once, then remember choice for session | read_file, write_file, edit_file, web_content |
| ASK_EVERY_TIME | Ask EVERY time before executing | run_shell, file_delete, browser_click, generate_file |
| NEVER_ALLOW | Blocked entirely, cannot be enabled | (reserved for future dangerous ops) |

```typescript
// === src/core/agent/tools.ts ===
// claw-code pattern: tools registry with JSON Schema input specs

export type PermissionLevel = 'always_allow' | 'ask_first' | 'ask_every' | 'never';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, any>;  // JSON Schema for Claude
  permission: PermissionLevel;
  category: 'screen' | 'file' | 'terminal' | 'browser' | 'system' | 'docs';
}

export const AGENT_TOOLS: ToolDefinition[] = [

  // -- SCREEN LAYER (KLYPIX's killer advantage) --
  {
    name: 'capture_screenshot',
    description: 'Capture a screenshot of the entire screen. Returns base64 PNG. Use this to see what the user sees.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'get_active_window',
    description: 'Get info about the currently focused window: title, process name, and file path if applicable.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'read_active_file',
    description: 'Read the content of the file currently open in the foreground application.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permission: 'always_allow',
    category: 'screen',
  },
  {
    name: 'get_all_open_files',
    description: 'Discover all files and tabs currently open across all applications.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permission: 'always_allow',
    category: 'screen',
  },

  // -- FILE SYSTEM LAYER --
  {
    name: 'read_file',
    description: 'Read the contents of a file at a specific path.',
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
        content: { type: 'string', description: 'File content to write' },
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
    description: 'Delete a file (moves to Recycle Bin).',
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
    description: 'Run a shell command in PowerShell. Use for npm, git, python, system commands, etc.',
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
      properties: {
        url: { type: 'string', description: 'URL to open' },
      },
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
        target_description: { type: 'string', description: 'Human description of what to click' },
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
        selector: { type: 'string', description: 'CSS selector of the input' },
        value: { type: 'string', description: 'Value to type' },
        target_description: { type: 'string', description: 'Human description of the field' },
      },
      required: ['value'],
    },
    permission: 'ask_every',
    category: 'browser',
  },
  {
    name: 'read_web_content',
    description: 'Read the text content of a web page by URL.',
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
    description: 'Open an application or file with the system default handler.',
    input_schema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'App name or file path to open' },
      },
      required: ['target'],
    },
    permission: 'ask_first',
    category: 'system',
  },
  {
    name: 'system_type',
    description: 'Type text into the currently focused application using SendKeys.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
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
      properties: {
        text: { type: 'string', description: 'Text to copy' },
      },
      required: ['text'],
    },
    permission: 'always_allow',
    category: 'system',
  },
  {
    name: 'read_clipboard',
    description: 'Read the current clipboard text content.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
    permission: 'always_allow',
    category: 'system',
  },

  // -- DOCUMENT GENERATION LAYER --
  {
    name: 'generate_document',
    description: 'Generate a document file (DOCX, XLSX, PPTX, PDF, or text formats).',
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['docx','xlsx','pptx','pdf','md','txt','csv','json'], description: 'Output format' },
        spec: { type: 'object', description: 'Structured content spec for the generator' },
        content: { type: 'string', description: 'Raw text content (for PDF/text formats)' },
      },
      required: ['format'],
    },
    permission: 'ask_every',
    category: 'docs',
  },
];

// Helper: Get tools formatted for Claude API
export function getClaudeTools() {
  return AGENT_TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

// Helper: Look up a tool by name
export function getToolByName(name: string): ToolDefinition | undefined {
  return AGENT_TOOLS.find(t => t.name === name);
}
```

---

## 6. Permission System - src/core/agent/permissions.ts

This is the claw-code permissions.rs pattern. It manages which tools need user approval, tracks session-level grants, and provides the Allow/Deny UI data.

```typescript
// === src/core/agent/permissions.ts ===
// claw-code pattern: permission gates before tool execution

import { getToolByName, PermissionLevel } from './tools';

export type PermissionDecision = 'allow' | 'deny' | 'pending';

export interface PermissionRequest {
  toolName: string;
  toolInput: Record<string, any>;
  permission: PermissionLevel;
  category: string;
  description: string;      // human-readable summary of what this call will do
  riskSummary: string;      // what could go wrong
}

export class PermissionManager {
  // Session-level grants: once user says 'Allow' for ask_first tools,
  // they stay allowed for the rest of this agent session
  private sessionGrants: Map<string, 'allow' | 'deny'> = new Map();

  // Path-level grants: 'allow read_file for C:\Projects\*'
  private pathGrants: Map<string, Set<string>> = new Map();

  // Master toggle: 'allow all for this session' (like Cowork's trust mode)
  private trustMode = false;

  setTrustMode(on: boolean) { this.trustMode = on; }
  isTrustMode() { return this.trustMode; }

  // Check if a tool call needs permission
  async check(toolName: string, input: Record<string, any>): Promise<{
    allowed: boolean;
    needsPrompt: boolean;
    request?: PermissionRequest;
  }> {
    const tool = getToolByName(toolName);
    if (!tool) return { allowed: false, needsPrompt: false };

    // Trust mode: everything allowed
    if (this.trustMode) return { allowed: true, needsPrompt: false };

    // Always allow: no prompt needed
    if (tool.permission === 'always_allow') return { allowed: true, needsPrompt: false };

    // Never allow: blocked
    if (tool.permission === 'never') return { allowed: false, needsPrompt: false };

    // Ask first: check session grants
    if (tool.permission === 'ask_first') {
      const grant = this.sessionGrants.get(toolName);
      if (grant === 'allow') return { allowed: true, needsPrompt: false };
      if (grant === 'deny') return { allowed: false, needsPrompt: false };
      // Check path-level grants
      const filePath = input.file_path || input.dir_path || input.source_path;
      if (filePath && this.isPathGranted(toolName, filePath)) {
        return { allowed: true, needsPrompt: false };
      }
    }

    // Needs user prompt
    return {
      allowed: false,
      needsPrompt: true,
      request: {
        toolName,
        toolInput: input,
        permission: tool.permission,
        category: tool.category,
        description: this.describeAction(toolName, input),
        riskSummary: this.describeRisk(toolName, input),
      },
    };
  }

  // Record user's decision
  grant(toolName: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'path' = 'session', pathPattern?: string) {
    if (scope === 'session' || scope === 'once') {
      this.sessionGrants.set(toolName, decision);
    }
    if (scope === 'path' && pathPattern && decision === 'allow') {
      if (!this.pathGrants.has(toolName)) this.pathGrants.set(toolName, new Set());
      this.pathGrants.get(toolName)!.add(pathPattern);
    }
  }

  private isPathGranted(toolName: string, filePath: string): boolean {
    const grants = this.pathGrants.get(toolName);
    if (!grants) return false;
    for (const pattern of grants) {
      if (filePath.startsWith(pattern.replace('*', ''))) return true;
    }
    return false;
  }

  // Human-readable description of what the tool call will do
  private describeAction(name: string, input: Record<string, any>): string {
    switch (name) {
      case 'run_shell': return `Run command: ${(input.command || '').substring(0, 80)}`;
      case 'read_file': return `Read file: ${input.file_path}`;
      case 'write_file': return `Write to: ${input.file_path} (${(input.content||'').length} chars)`;
      case 'edit_file': return `Edit file: ${input.file_path}`;
      case 'file_delete': return `Delete: ${input.file_path} (moves to Recycle Bin)`;
      case 'file_move': return `Move: ${input.source_path} -> ${input.dest_path}`;
      case 'browser_navigate': return `Open URL: ${input.url}`;
      case 'browser_click': return `Click: ${input.target_description || input.selector}`;
      case 'browser_fill': return `Fill form field with: ${(input.value||'').substring(0, 40)}`;
      case 'system_open': return `Open: ${input.target}`;
      case 'system_type': return `Type: "${(input.text||'').substring(0, 40)}"`;
      case 'generate_document': return `Generate ${input.format?.toUpperCase()} document`;
      case 'read_web_content': return `Read web page: ${input.url}`;
      default: return `${name}(${JSON.stringify(input).substring(0, 60)})`;
    }
  }

  private describeRisk(name: string, input: Record<string, any>): string {
    switch (name) {
      case 'run_shell': return 'Runs a system command. Review the command carefully.';
      case 'write_file': return 'Will overwrite the file if it exists.';
      case 'edit_file': return 'Will modify file contents in place.';
      case 'file_delete': return 'File will be moved to Recycle Bin (recoverable).';
      case 'browser_click': return 'Will interact with a live web page.';
      case 'browser_fill': return 'Will type into a form field on a live web page.';
      case 'system_type': return 'Will type into the currently focused window.';
      default: return '';
    }
  }

  // Reset all grants (on new agent session)
  reset() {
    this.sessionGrants.clear();
    this.pathGrants.clear();
    this.trustMode = false;
  }
}
```

---

## 7. Tool Executor - src/core/agent/toolExecutor.ts

This bridges Claude's tool calls to your actual IPC handlers. Each tool name maps to the right Electron API call.

```typescript
// === src/core/agent/toolExecutor.ts ===
// Maps Claude tool_use calls to Electron IPC handlers

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
        const ctx = await api.getActiveWindowContext();
        return JSON.stringify(ctx);
      }
      case 'read_active_file': {
        const file = await api.readActiveFile();
        return JSON.stringify(file);
      }
      case 'get_all_open_files': {
        const files = await api.getAllOpenFiles();
        return JSON.stringify(files);
      }

      // -- File System Layer --
      case 'read_file': {
        const r = await api.agent.readFile({
          filePath: input.file_path,
          maxChars: input.max_chars,
        });
        return JSON.stringify(r);
      }
      case 'write_file': {
        const r = await api.agent.writeFile({
          filePath: input.file_path,
          content: input.content,
        });
        return JSON.stringify(r);
      }
      case 'edit_file': {
        const r = await api.agent.editFile({
          filePath: input.file_path,
          oldText: input.old_text,
          newText: input.new_text,
        });
        return JSON.stringify(r);
      }
      case 'list_directory': {
        const r = await api.agent.listDir({ dirPath: input.dir_path });
        return JSON.stringify(r);
      }
      case 'file_move': {
        const r = await api.executeAction({
          type: 'file_move',
          parameters: { sourcePath: input.source_path, destinationPath: input.dest_path },
        });
        return JSON.stringify(r);
      }
      case 'file_delete': {
        const r = await api.executeAction({
          type: 'file_delete',
          parameters: { sourcePath: input.file_path },
        });
        return JSON.stringify(r);
      }

      // -- Terminal Layer --
      case 'run_shell': {
        const r = await api.agent.runShell({
          command: input.command,
          cwd: input.cwd,
          timeout: input.timeout,
        });
        return JSON.stringify(r);
      }

      // -- Browser Layer --
      case 'browser_navigate': {
        const r = await api.executeAction({
          type: 'browser_navigate',
          parameters: { url: input.url },
        });
        return JSON.stringify(r);
      }
      case 'browser_click': {
        const r = await api.executeAction({
          type: 'browser_click',
          parameters: { selector: input.selector, targetDescription: input.target_description },
        });
        return JSON.stringify(r);
      }
      case 'browser_fill': {
        const r = await api.executeAction({
          type: 'browser_fill',
          parameters: { selector: input.selector, value: input.value, targetDescription: input.target_description },
        });
        return JSON.stringify(r);
      }
      case 'read_web_content': {
        const r = await api.readWebContent({ url: input.url, title: input.title || '' });
        return JSON.stringify(r);
      }

      // -- System Layer --
      case 'system_open': {
        const r = await api.executeAction({
          type: 'system_open',
          parameters: { appName: input.target },
        });
        return JSON.stringify(r);
      }
      case 'system_type': {
        const r = await api.executeAction({
          type: 'system_type',
          parameters: { text: input.text },
        });
        return JSON.stringify(r);
      }
      case 'clipboard_write': {
        const r = await api.executeAction({
          type: 'clipboard_copy',
          parameters: { text: input.text },
        });
        return JSON.stringify(r);
      }
      case 'read_clipboard': {
        const text = await api.readClipboard();
        return JSON.stringify({ text });
      }

      // -- Document Generation --
      case 'generate_document': {
        const r = await api.generateFile({
          format: input.format,
          spec: input.spec,
          content: input.content,
        });
        return JSON.stringify(r);
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

## 8. Agent Loop - src/core/agent/claudeAgent.ts

This is THE core engine. It is the claw-code conversation.rs + runtime session.rs pattern translated to TypeScript. The entire agent loop is here: send to Claude, parse tool calls, execute them (with permission checks), send results back, repeat.

### How it works

1. User types a prompt + KLYPIX auto-attaches a screenshot
2. The loop sends prompt + screenshot + tool definitions to Claude API
3. Claude responds with either text (done) or tool_use blocks (wants to do something)
4. For each tool_use: check permissions, show Allow/Deny if needed, execute, collect result
5. Send all tool_results back to Claude as the next message
6. Repeat steps 3-5 until Claude sends a text-only response (done)
7. Max 25 turns to prevent infinite loops

```typescript
// === src/core/agent/claudeAgent.ts ===
// THE CORE: claw-code agent loop in TypeScript

import Anthropic from '@anthropic-ai/sdk';
import { getClaudeTools } from './tools';
import { PermissionManager, PermissionRequest } from './permissions';
import { executeTool } from './toolExecutor';

const MAX_TURNS = 25;

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
  onStep: (step: AgentStep) => void;              // UI updates each step
  onText: (text: string, done: boolean) => void;   // streaming text from Claude
  onPermissionRequest: (req: PermissionRequest) => Promise<{
    decision: 'allow' | 'deny';
    scope: 'once' | 'session' | 'path';
    pathPattern?: string;
  }>;                                              // show Allow/Deny tabs to user
  onComplete: (steps: AgentStep[]) => void;        // agent finished
  onError: (error: string) => void;                // something broke
}

export class ClaudeAgent {
  private client: Anthropic;
  private permissions: PermissionManager;
  private steps: AgentStep[] = [];
  private aborted = false;

  constructor(apiKey: string) {
    this.client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true, // Electron renderer is trusted
    });
    this.permissions = new PermissionManager();
  }

  abort() { this.aborted = true; }
  getPermissions() { return this.permissions; }

  async run(
    userPrompt: string,
    screenshotBase64: string | null,
    windowContext: any,
    callbacks: AgentCallbacks,
  ) {
    this.aborted = false;
    this.steps = [];

    // -- Build the system prompt --
    const systemPrompt = [
      'You are KLYPIX, an AI agent running on the user\'s Windows desktop.',
      'You can see the user\'s screen, read/write files, run shell commands, and automate their browser.',
      'Always start by understanding the context: look at the screenshot, check the active window.',
      'Be proactive: if you need information, use your tools to get it rather than asking the user.',
      'For multi-step tasks, work through them systematically.',
      'When you are done, provide a clear summary of what you did.',
      '',
      windowContext ? `Active window: ${windowContext.title} (${windowContext.processName})` : '',
    ].join('\n');

    // -- Build initial message with screenshot --
    const userContent: any[] = [];
    if (screenshotBase64) {
      userContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: screenshotBase64,
        },
      });
    }
    userContent.push({ type: 'text', text: userPrompt });

    // -- Conversation history for the loop --
    const messages: any[] = [{ role: 'user', content: userContent }];

    // -- THE AGENT LOOP --
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.aborted) {
        callbacks.onError('Agent stopped by user');
        return;
      }

      // Step: Thinking
      this.addStep({ type: 'thinking', status: 'running', description: `Turn ${turn + 1}: Calling Claude...` }, callbacks);

      // -- Call Claude API --
      let response;
      try {
        response = await this.client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 8192,
          system: systemPrompt,
          tools: getClaudeTools(),
          messages,
        });
      } catch (err: any) {
        callbacks.onError(`Claude API error: ${err.message}`);
        return;
      }

      // -- Process response blocks --
      const toolResults: any[] = [];
      let hasToolUse = false;
      let finalText = '';

      for (const block of response.content) {
        if (this.aborted) break;

        // -- Text block: Claude is talking --
        if (block.type === 'text') {
          finalText += block.text;
          callbacks.onText(block.text, false);
        }

        // -- Tool use block: Claude wants to do something --
        if (block.type === 'tool_use') {
          hasToolUse = true;
          const { id, name, input } = block;

          // Step: Tool call
          this.addStep({
            type: 'tool_call',
            toolName: name,
            toolInput: input as Record<string, any>,
            status: 'pending',
            description: `Calling ${name}...`,
          }, callbacks);

          // -- Permission check --
          const perm = await this.permissions.check(name, input as Record<string, any>);

          if (perm.needsPrompt && perm.request) {
            // Show Allow/Deny to user
            this.addStep({
              type: 'permission',
              toolName: name,
              status: 'waiting_permission',
              description: perm.request.description,
            }, callbacks);

            const decision = await callbacks.onPermissionRequest(perm.request);
            this.permissions.grant(name, decision.decision, decision.scope, decision.pathPattern);

            if (decision.decision === 'deny') {
              this.addStep({
                type: 'tool_result',
                toolName: name,
                status: 'denied',
                result: 'User denied permission',
              }, callbacks);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: id,
                content: 'Permission denied by user. Try a different approach or ask the user what they prefer.',
              });
              continue;
            }
          } else if (!perm.allowed) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: id,
              content: 'This tool is not available.',
            });
            continue;
          }

          // -- Execute the tool --
          this.updateLastStep({ status: 'running' }, callbacks);

          let result: string;
          try {
            result = await executeTool(name, input as Record<string, any>);
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }

          this.addStep({
            type: 'tool_result',
            toolName: name,
            status: 'completed',
            result: result.substring(0, 200) + (result.length > 200 ? '...' : ''),
          }, callbacks);

          // Handle screenshot results (send as image, not text)
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

          toolResults.push({
            type: 'tool_result',
            tool_use_id: id,
            content: toolContent,
          });
        }
      }

      // -- Check stop condition --
      if (response.stop_reason === 'end_turn' && !hasToolUse) {
        // Claude is done -- no more tool calls
        callbacks.onText(finalText, true);
        callbacks.onComplete(this.steps);
        return;
      }

      // -- Send tool results back to Claude --
      if (toolResults.length > 0) {
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
      } else {
        // end_turn with tool_use but no results (shouldn't happen)
        callbacks.onComplete(this.steps);
        return;
      }
    }

    callbacks.onError('Max turns reached (25). Agent stopped to prevent infinite loop.');
  }

  private addStep(step: Partial<AgentStep>, callbacks: AgentCallbacks) {
    const full: AgentStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      type: 'text',
      status: 'pending',
      ...step,
    };
    this.steps.push(full);
    callbacks.onStep(full);
  }

  private updateLastStep(update: Partial<AgentStep>, callbacks: AgentCallbacks) {
    const last = this.steps[this.steps.length - 1];
    if (last) {
      Object.assign(last, update);
      callbacks.onStep(last);
    }
  }
}
```

---

## 9. Session Manager - src/core/agent/agentSession.ts

Tracks agent sessions so the user can see history, resume, and understand what the agent did. Mirrors claw-code session.rs pattern.

```typescript
// === src/core/agent/agentSession.ts ===

import { AgentStep } from './claudeAgent';

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
}

const SESSION_KEY = 'klypix_agent_sessions';
const MAX_SESSIONS = 50;

export class AgentSessionManager {
  private current: AgentSession | null = null;

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
  }

  complete(finalResponse: string, status: 'completed' | 'error' | 'aborted' = 'completed') {
    if (!this.current) return;
    this.current.completedAt = Date.now();
    this.current.status = status;
    this.current.finalResponse = finalResponse;
    this.save(this.current);
    this.current = null;
  }

  getCurrent() { return this.current; }

  getHistory(): AgentSession[] {
    try {
      return JSON.parse(localStorage.getItem(SESSION_KEY) || '[]');
    } catch { return []; }
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

## 10. React Hook - src/hooks/useClaudeAgent.ts

This hook connects the agent engine to your React UI. It manages the agent lifecycle and exposes state for the WorkflowPanel and PermissionTabs components.

```typescript
// === src/hooks/useClaudeAgent.ts ===

import { useState, useCallback, useRef } from 'react';
import { ClaudeAgent, AgentStep, AgentCallbacks } from '../core/agent/claudeAgent';
import { AgentSessionManager } from '../core/agent/agentSession';
import { PermissionRequest } from '../core/agent/permissions';

interface AgentState {
  isRunning: boolean;
  steps: AgentStep[];
  streamingText: string;
  permissionRequest: PermissionRequest | null;
  error: string | null;
  trustMode: boolean;
}

export function useClaudeAgent(apiKey: string | null) {
  const [state, setState] = useState<AgentState>({
    isRunning: false,
    steps: [],
    streamingText: '',
    permissionRequest: null,
    error: null,
    trustMode: false,
  });

  const agentRef = useRef<ClaudeAgent | null>(null);
  const sessionMgr = useRef(new AgentSessionManager());
  const permissionResolveRef = useRef<((val: any) => void) | null>(null);

  // -- Start agent run --
  const runAgent = useCallback(async (
    prompt: string,
    screenshotBase64: string | null,
    windowContext: any,
  ) => {
    if (!apiKey) {
      setState(s => ({ ...s, error: 'No Claude API key. Add it in Settings.' }));
      return;
    }

    const agent = new ClaudeAgent(apiKey);
    agentRef.current = agent;
    if (state.trustMode) agent.getPermissions().setTrustMode(true);

    sessionMgr.current.start(prompt);
    setState(s => ({ ...s, isRunning: true, steps: [], streamingText: '', error: null }));

    const callbacks: AgentCallbacks = {
      onStep: (step) => {
        sessionMgr.current.addStep(step);
        setState(s => ({ ...s, steps: [...s.steps, step] }));
      },
      onText: (text, done) => {
        setState(s => ({ ...s, streamingText: s.streamingText + text }));
      },
      onPermissionRequest: (req) => {
        setState(s => ({ ...s, permissionRequest: req }));
        // Return a promise that resolves when user clicks Allow/Deny
        return new Promise((resolve) => {
          permissionResolveRef.current = resolve;
        });
      },
      onComplete: (steps) => {
        sessionMgr.current.complete(state.streamingText);
        setState(s => ({ ...s, isRunning: false }));
      },
      onError: (error) => {
        sessionMgr.current.complete(error, 'error');
        setState(s => ({ ...s, isRunning: false, error }));
      },
    };

    await agent.run(prompt, screenshotBase64, windowContext, callbacks);
  }, [apiKey, state.trustMode]);

  // -- Permission response (from Allow/Deny buttons) --
  const respondToPermission = useCallback((
    decision: 'allow' | 'deny',
    scope: 'once' | 'session' | 'path' = 'session',
    pathPattern?: string,
  ) => {
    if (permissionResolveRef.current) {
      permissionResolveRef.current({ decision, scope, pathPattern });
      permissionResolveRef.current = null;
      setState(s => ({ ...s, permissionRequest: null }));
    }
  }, []);

  // -- Stop the agent --
  const stopAgent = useCallback(() => {
    agentRef.current?.abort();
    setState(s => ({ ...s, isRunning: false }));
  }, []);

  // -- Toggle trust mode --
  const toggleTrustMode = useCallback(() => {
    setState(s => {
      const newTrust = !s.trustMode;
      agentRef.current?.getPermissions().setTrustMode(newTrust);
      return { ...s, trustMode: newTrust };
    });
  }, []);

  return {
    ...state,
    runAgent,
    respondToPermission,
    stopAgent,
    toggleTrustMode,
    sessionHistory: sessionMgr.current.getHistory(),
  };
}
```

---

## 11. UI Components

### 11a. Permission Tabs (the Allow/Deny UI)

This is the critical UX piece. When the agent wants to do something risky, this slides in with clear Allow / Deny / Allow All buttons. Inspired by claw-code permission prompts.

```tsx
// === src/components/PermissionTabs.tsx ===

import React from 'react';
import { PermissionRequest } from '../core/agent/permissions';

interface Props {
  request: PermissionRequest;
  onDecision: (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'path') => void;
}

const CATEGORY_ICONS: Record<string, string> = {
  terminal: '>_',  file: '[F]',  browser: '[W]',
  system: '[S]',   screen: '[C]',  docs: '[D]',
};

const RISK_COLORS: Record<string, string> = {
  ask_every: 'border-amber-500 bg-amber-500/10',
  ask_first: 'border-blue-500 bg-blue-500/10',
};

export function PermissionTabs({ request, onDecision }: Props) {
  const icon = CATEGORY_ICONS[request.category] || '[?]';
  const colorClass = RISK_COLORS[request.permission] || 'border-gray-500';

  return (
    <div className={`rounded-xl border-2 ${colorClass} p-4 mx-3 my-2 animate-slideIn`}>
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <span className="text-lg font-mono">{icon}</span>
        <span className="font-semibold text-white text-sm uppercase tracking-wide">
          {request.category} action
        </span>
        <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${
          request.permission === 'ask_every' ? 'bg-amber-500/20 text-amber-400' : 'bg-blue-500/20 text-blue-400'
        }`}>
          {request.permission === 'ask_every' ? 'Asks every time' : 'Asks once'}
        </span>
      </div>

      {/* What it wants to do */}
      <p className="text-white text-sm mb-1">{request.description}</p>
      {request.riskSummary && (
        <p className="text-gray-400 text-xs mb-3">{request.riskSummary}</p>
      )}

      {/* Tool input preview (collapsed) */}
      <details className="mb-3">
        <summary className="text-gray-500 text-xs cursor-pointer hover:text-gray-300">
          View details
        </summary>
        <pre className="text-xs text-gray-400 bg-black/30 rounded p-2 mt-1 overflow-x-auto">
          {JSON.stringify(request.toolInput, null, 2)}
        </pre>
      </details>

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={() => onDecision('allow', 'once')}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
        >
          Allow
        </button>
        <button
          onClick={() => onDecision('allow', 'session')}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-400 text-sm font-medium transition-colors border border-emerald-600/50"
        >
          Allow for Session
        </button>
        <button
          onClick={() => onDecision('deny', 'once')}
          className="px-3 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 text-sm font-medium transition-colors border border-red-600/30"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
```

### 11b. Workflow Panel (step-by-step progress)

Shows the agent working in real time: each tool call, permission check, and result as a vertical timeline.

```tsx
// === src/components/WorkflowPanel.tsx ===

import React from 'react';
import { AgentStep } from '../core/agent/claudeAgent';
import { PermissionRequest } from '../core/agent/permissions';
import { PermissionTabs } from './PermissionTabs';

interface Props {
  steps: AgentStep[];
  isRunning: boolean;
  streamingText: string;
  permissionRequest: PermissionRequest | null;
  trustMode: boolean;
  onPermissionDecision: (d: 'allow'|'deny', s: 'once'|'session'|'path') => void;
  onStop: () => void;
  onToggleTrust: () => void;
}

const STATUS_ICON: Record<string, string> = {
  pending: '...',  running: '>>',  completed: '[OK]',
  denied: '[NO]',  error: '[ERR]',  waiting_permission: '[?]',
};

export function WorkflowPanel({
  steps, isRunning, streamingText, permissionRequest,
  trustMode, onPermissionDecision, onStop, onToggleTrust,
}: Props) {
  return (
    <div className="flex flex-col h-full">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isRunning ? 'bg-emerald-400 animate-pulse' : 'bg-gray-500'}`} />
          <span className="text-sm text-white font-medium">
            {isRunning ? 'Agent Working...' : 'Agent Idle'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {/* Trust mode toggle */}
          <button
            onClick={onToggleTrust}
            className={`text-xs px-2 py-1 rounded-full transition-colors ${
              trustMode
                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40'
                : 'bg-gray-700 text-gray-400 border border-gray-600'
            }`}
          >
            {trustMode ? 'Trust Mode ON' : 'Trust Mode OFF'}
          </button>
          {isRunning && (
            <button onClick={onStop} className="text-xs px-2 py-1 rounded bg-red-600/30 text-red-400 hover:bg-red-600/50">
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Steps timeline */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
        {steps.map((step) => (
          <div key={step.id} className="flex items-start gap-2 text-sm">
            <span className="flex-shrink-0 mt-0.5 font-mono text-xs">{STATUS_ICON[step.status] || '*'}</span>
            <div className="flex-1 min-w-0">
              <span className={`${
                step.status === 'completed' ? 'text-gray-400' :
                step.status === 'running' ? 'text-emerald-400' :
                step.status === 'denied' ? 'text-red-400' : 'text-gray-300'
              }`}>
                {step.toolName && <span className="font-mono text-xs bg-white/5 px-1 rounded mr-1">{step.toolName}</span>}
                {step.description}
              </span>
              {step.result && (
                <p className="text-xs text-gray-500 truncate mt-0.5">{step.result}</p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Permission prompt (slides in when needed) */}
      {permissionRequest && (
        <PermissionTabs request={permissionRequest} onDecision={onPermissionDecision} />
      )}

      {/* Streaming text from Claude */}
      {streamingText && (
        <div className="px-3 py-2 border-t border-white/10 max-h-48 overflow-y-auto">
          <p className="text-sm text-gray-300 whitespace-pre-wrap">{streamingText}</p>
        </div>
      )}
    </div>
  );
}
```

---

## 12. App.tsx Integration - Mode Router

The key change to App.tsx: detect when to route to the Claude agent vs the existing Gemini chat. If the user has a Claude API key AND the input looks like an agent task (multi-step, file ops, terminal, etc.), route to the agent. Otherwise, keep the existing Gemini flow.

```typescript
// === In App.tsx ===
// Add to imports:
import { useClaudeAgent } from './hooks/useClaudeAgent';
import { WorkflowPanel } from './components/WorkflowPanel';

// Inside App component, add:
const [claudeApiKey, setClaudeApiKey] = useState<string | null>(
  localStorage.getItem('klypix_claude_key')
);
const [agentMode, setAgentMode] = useState(false);

const {
  isRunning: agentRunning,
  steps: agentSteps,
  streamingText: agentText,
  permissionRequest,
  error: agentError,
  trustMode,
  runAgent,
  respondToPermission,
  stopAgent,
  toggleTrustMode,
} = useClaudeAgent(claudeApiKey);

// -- Route decision in handleSubmit --
const handleSubmit = async (input: string) => {
  // If Claude key exists AND agent mode is on, route to agent
  if (claudeApiKey && agentMode) {
    const screenshot = await window.electron.captureScreen();
    const context = await window.electron.getActiveWindowContext();
    await runAgent(input, screenshot, context);
    return;
  }
  // Otherwise: existing Gemini flow (unchanged)
  // ... your existing handleSubmit code ...
};

// -- Agent mode toggle (add to header/toolbar) --
// <button onClick={() => setAgentMode(!agentMode)}>
//   {agentMode ? 'Agent Mode' : 'Chat Mode'}
// </button>

// -- Render WorkflowPanel when agent is active --
// {agentRunning && (
//   <WorkflowPanel
//     steps={agentSteps}
//     isRunning={agentRunning}
//     streamingText={agentText}
//     permissionRequest={permissionRequest}
//     trustMode={trustMode}
//     onPermissionDecision={respondToPermission}
//     onStop={stopAgent}
//     onToggleTrust={toggleTrustMode}
//   />
// )}
```

---

## 13. Settings UI - Claude API Key

Add a Claude API key field to your existing settings panel. The key is stored encrypted via Electron safeStorage (same pattern as your Gemini key).

```typescript
// === Main process (main.ts) - add alongside existing api-key handlers: ===

ipcMain.handle('claude-key:store', (_event: any, key: string) => {
  try {
    const encrypted = safeStorage.encryptString(key);
    fs.writeFileSync(
      path.join(app.getPath('userData'), 'claude_key.enc'),
      encrypted
    );
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('claude-key:get', () => {
  try {
    const encPath = path.join(app.getPath('userData'), 'claude_key.enc');
    if (!fs.existsSync(encPath)) return null;
    const encrypted = fs.readFileSync(encPath);
    return safeStorage.decryptString(encrypted);
  } catch {
    return null;
  }
});

ipcMain.handle('claude-key:clear', () => {
  const encPath = path.join(app.getPath('userData'), 'claude_key.enc');
  if (fs.existsSync(encPath)) fs.unlinkSync(encPath);
  return { success: true };
});

// === Preload (preload.ts): ===
claudeKey: {
  store: (key: string) => ipcRenderer.invoke('claude-key:store', key),
  get: () => ipcRenderer.invoke('claude-key:get'),
  clear: () => ipcRenderer.invoke('claude-key:clear'),
},

// === Settings component snippet: ===
// <div className="space-y-2">
//   <label className="text-sm text-gray-400">Claude API Key (for Agent Mode)</label>
//   <input
//     type="password"
//     placeholder="sk-ant-api03-..."
//     className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-2 text-white"
//     onChange={e => {
//       const key = e.target.value;
//       window.electron.claudeKey.store(key);
//       setClaudeApiKey(key);
//     }}
//   />
// </div>
```

---

## 14. File Map & Build Order

### New files to create

| # | File Path | What It Does | LoC |
|---|---|---|---|
| 1 | src/core/agent/tools.ts | Tool registry (22 tools with JSON schemas) | ~250 |
| 2 | src/core/agent/permissions.ts | Permission manager (allow/deny/trust mode) | ~130 |
| 3 | src/core/agent/toolExecutor.ts | Maps tool names to IPC calls | ~140 |
| 4 | src/core/agent/claudeAgent.ts | THE agent loop engine | ~200 |
| 5 | src/core/agent/agentSession.ts | Session tracking + history | ~70 |
| 6 | src/hooks/useClaudeAgent.ts | React hook for agent state | ~100 |
| 7 | src/components/PermissionTabs.tsx | Allow/Deny UI component | ~80 |
| 8 | src/components/WorkflowPanel.tsx | Step-by-step progress UI | ~90 |

### Files to modify (small additions)

| File | What to Add | Lines Changed |
|---|---|---|
| electron/main.ts | 5 new IPC handlers | ~80 lines added |
| electron/preload.ts | agent namespace + claude key | ~20 lines added |
| src/App.tsx | useClaudeAgent hook + mode router | ~30 lines added |
| package.json | @anthropic-ai/sdk dependency | 1 line |

### Build order (do them in this sequence)

1. npm install @anthropic-ai/sdk
2. Add 5 IPC handlers to main.ts (Section 3)
3. Add preload bridge entries (Section 4)
4. Create src/core/agent/ folder with tools.ts, permissions.ts, toolExecutor.ts, claudeAgent.ts, agentSession.ts
5. Create src/hooks/useClaudeAgent.ts
6. Create src/components/PermissionTabs.tsx and WorkflowPanel.tsx
7. Wire into App.tsx (mode router + WorkflowPanel render)
8. Add Claude key settings UI
9. Add Claude key IPC handlers to main.ts
10. npm run dev and test

---

## 15. 20 Real User Scenarios

These show what a user can do with the agent engine. Each shows the prompt, what tools fire, and what permissions the user sees.

### DAILY WORKER

| # | User Says | Tools Used | Permission Tabs |
|---|---|---|---|
| 1 | "Summarize this PDF on my screen" | capture_screenshot -> read_active_file | None (always_allow) |
| 2 | "Save this email as a Word doc on my Desktop" | capture_screenshot -> read_active_file -> generate_document | Allow: Generate DOCX |
| 3 | "Compare these two spreadsheets open on my screen" | capture_screenshot -> get_all_open_files -> read_file x2 | Allow: read_file (once for session) |
| 4 | "Turn my clipboard into a formatted PDF" | read_clipboard -> generate_document | Allow: Generate PDF |
| 5 | "Fix the typo in this Word doc" | capture_screenshot -> read_active_file -> edit_file | Allow: edit_file |

### STUDENT / RESEARCHER

| # | User Says | Tools Used | Permission Tabs |
|---|---|---|---|
| 6 | "Research this topic and write a report" | read_web_content x3 -> generate_document | Allow: read_web_content, Generate DOCX |
| 7 | "Extract the table from this screenshot into Excel" | capture_screenshot -> generate_document (xlsx) | Allow: Generate XLSX |
| 8 | "Translate this PDF page to Arabic" | capture_screenshot -> read_active_file -> clipboard_write | None (always_allow) |

### DEVELOPER (Terminal + Screen)

| # | User Says | Tools Used | Permission Tabs |
|---|---|---|---|
| 9 | "What errors are in this terminal?" | capture_screenshot (reads the terminal visually) | None |
| 10 | "Run npm install and fix any errors" | run_shell(npm install) -> read output -> run_shell(fix) | Allow: run_shell (each time) |
| 11 | "Create a React component for this mockup on screen" | capture_screenshot -> write_file -> run_shell(npm run dev) | Allow: write_file, run_shell |
| 12 | "Find all TODO comments in my project" | run_shell(grep -r TODO src/) | Allow: run_shell |
| 13 | "Git commit everything with a good message" | run_shell(git status) -> run_shell(git add) -> run_shell(git commit) | Allow: run_shell (3 prompts, or trust mode) |
| 14 | "This error on screen - find the bug and fix it" | capture_screenshot -> read_file -> edit_file -> run_shell(npm test) | Allow: read_file, edit_file, run_shell |

### BUSINESS / POWER USER

| # | User Says | Tools Used | Permission Tabs |
|---|---|---|---|
| 15 | "Make a pitch deck from this document" | read_active_file -> generate_document(pptx) | Allow: Generate PPTX |
| 16 | "Fill this web form with my company info" | capture_screenshot -> browser_fill x5 | Allow: browser_fill (each field) |
| 17 | "Organize my Downloads folder - sort by type" | list_directory -> file_move x20 | Allow: list_directory, file_move (session) |
| 18 | "Open Chrome, go to LinkedIn, search for AI jobs" | system_open -> browser_navigate -> browser_fill -> browser_click | Allow: system_open, browser_navigate, browser_fill, browser_click |

### KLYPIX-UNIQUE (Screen-First)

| # | User Says | Tools Used | Permission Tabs |
|---|---|---|---|
| 19 | "What app is this? Can it do X?" | capture_screenshot -> get_active_window -> read_web_content | Allow: read_web_content |
| 20 | "Compare what's on my left monitor vs right" | capture_screenshot x2 (Claude analyzes visually) | None (always_allow) |

Notice the pattern: Screen tools (capture, context) NEVER need permission. File reads ask once per session. Terminal and browser ask every time. Trust Mode skips all prompts for power users who want speed.

---

## Summary

Total new code: ~1,100 lines across 8 new files + ~130 lines of additions to 4 existing files. The entire agent engine adds approximately 1,230 lines to your codebase.

The architecture follows claw-code's open source patterns (session management, tool registry, permission gates, agent loop) translated into TypeScript that plugs directly into your existing Electron IPC infrastructure.

Your unique advantage over Cowork, Cursor, or any other agent: the screen-first layer. Every agent conversation starts with Claude SEEING what the user sees. No other desktop agent does this as a default. Combined with the terminal and deep tools, KLYPIX becomes the most context-aware agent on any desktop.
