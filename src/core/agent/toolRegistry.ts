export type PermissionLevel = 'always_allow' | 'ask_first' | 'ask_every';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, any>;
    required: string[];
  };
  permissionLevel: PermissionLevel;
  timeout?: number;
  riskLevel: 'low' | 'medium' | 'high';
}

export const TOOL_REGISTRY: Record<string, ToolDefinition> = {
  capture_screenshot: {
    name: 'capture_screenshot',
    description: 'Takes a screenshot of the current screen and returns base64 PNG',
    input_schema: { type: 'object', properties: {}, required: [] },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  get_active_window: {
    name: 'get_active_window',
    description: 'Returns metadata about the currently focused window (title, app name, file path)',
    input_schema: { type: 'object', properties: {}, required: [] },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  read_active_file: {
    name: 'read_active_file',
    description: 'Read content of the file currently open on screen (Excel via COM automation, PDFs, text files, etc). Works even for cloud/OneDrive files. Use this FIRST when the user has a file open — do NOT guess file paths with read_file.',
    input_schema: { type: 'object', properties: {}, required: [] },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  get_all_open_files: {
    name: 'get_all_open_files',
    description: 'Discover all files and tabs open across all applications',
    input_schema: { type: 'object', properties: {}, required: [] },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  read_file_by_title: {
    name: 'read_file_by_title',
    description: 'Read a file by its window title (from get_all_open_files). Works for Excel via COM automation, PDFs, etc. Use this when read_active_file fails and you have the window title from get_all_open_files.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The originalTitle from get_all_open_files (e.g. "CapEx Budget 2025.xlsx - Excel")' },
      },
      required: ['title'],
    },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  read_file: {
    name: 'read_file',
    description: 'Read contents of a file at a specific path',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        max_chars: { type: 'number', description: 'Max characters to read (default 100000)' },
      },
      required: ['file_path'],
    },
    permissionLevel: 'ask_first',
    riskLevel: 'medium',
  },
  write_file: {
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
    permissionLevel: 'ask_every',
    riskLevel: 'high',
  },
  edit_file: {
    name: 'edit_file',
    description: 'Edit a file by replacing one text string with another',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path' },
        old_text: { type: 'string', description: 'Exact text to find' },
        new_text: { type: 'string', description: 'Replacement text' },
      },
      required: ['file_path', 'old_text', 'new_text'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'high',
  },
  list_directory: {
    name: 'list_directory',
    description: 'List files and folders in a directory',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Absolute path to directory' },
      },
      required: ['dir_path'],
    },
    permissionLevel: 'ask_first',
    riskLevel: 'low',
  },
  file_move: {
    name: 'file_move',
    description: 'Move or rename a file',
    input_schema: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Current file path' },
        dest_path: { type: 'string', description: 'New file path' },
      },
      required: ['source_path', 'dest_path'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'high',
  },
  file_delete: {
    name: 'file_delete',
    description: 'Delete a file (moves to Recycle Bin, recoverable)',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to delete' },
      },
      required: ['file_path'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'high',
  },
  run_shell: {
    name: 'run_shell',
    description: 'Run a shell command in PowerShell. For npm, git, python, etc. Some dangerous commands are blocked.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        timeout: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
      required: ['command'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'high',
    timeout: 30000,
  },
  browser_navigate: {
    name: 'browser_navigate',
    description: 'Open a URL in the default browser',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to open' } },
      required: ['url'],
    },
    permissionLevel: 'ask_first',
    riskLevel: 'medium',
  },
  browser_click: {
    name: 'browser_click',
    description: 'Click an element on a web page (requires CDP-enabled browser)',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        target_description: { type: 'string', description: 'Human description of element' },
      },
      required: [],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'medium',
  },
  browser_fill: {
    name: 'browser_fill',
    description: 'Fill a form field on a web page (requires CDP-enabled browser)',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector' },
        value: { type: 'string', description: 'Value to type' },
        target_description: { type: 'string', description: 'Human description of field' },
      },
      required: ['value'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'medium',
  },
  read_web_content: {
    name: 'read_web_content',
    description: 'Read the text content of a web page by URL',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to read' },
        title: { type: 'string', description: 'Page title hint for CDP fallback' },
      },
      required: ['url'],
    },
    permissionLevel: 'ask_first',
    riskLevel: 'low',
  },
  system_open: {
    name: 'system_open',
    description: 'Open an application or file with the system default handler',
    input_schema: {
      type: 'object',
      properties: { target: { type: 'string', description: 'App name or file path' } },
      required: ['target'],
    },
    permissionLevel: 'ask_first',
    riskLevel: 'medium',
  },
  system_type: {
    name: 'system_type',
    description: 'Type text into the currently focused application via SendKeys',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type' } },
      required: ['text'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'medium',
  },
  clipboard_read: {
    name: 'clipboard_read',
    description: 'Read current clipboard text',
    input_schema: { type: 'object', properties: {}, required: [] },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  clipboard_write: {
    name: 'clipboard_write',
    description: 'Copy text to the system clipboard',
    input_schema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy' } },
      required: ['text'],
    },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  ask_user: {
    name: 'ask_user',
    description: 'Ask the user a clarifying question when something is ambiguous. Use sparingly — only when you genuinely cannot proceed without user input. Provide 2-5 short chip options when possible so the user can tap instead of type. Max 3 questions per session.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional quick-reply options (2-5 short labels). If provided, shown as clickable chips.',
        },
      },
      required: ['question'],
    },
    permissionLevel: 'always_allow',
    riskLevel: 'low',
  },
  generate_document: {
    name: 'generate_document',
    description: `Generate a document file. IMPORTANT: Follow the exact spec structure for each format.

FOR DOCX: { "filename": "name.docx", "metadata": { "title": "...", "author": "...", "date": "..." }, "sections": [ { "type": "heading1", "text": "Title" }, { "type": "paragraph", "text": "Body text" }, { "type": "bullet_list", "items": ["Item 1", "Item 2"] }, { "type": "table", "headers": ["Col1", "Col2"], "rows": [["a", "b"]] }, { "type": "numbered_list", "items": ["Step 1"] } ] }. Section types: heading1, heading2, heading3, paragraph, bullet_list, numbered_list, table, blockquote, page_break.

FOR PPTX: { "filename": "name.pptx", "metadata": { "title": "...", "author": "..." }, "slides": [ { "layout": "title", "title": "Presentation Title", "subtitle": "Subtitle" }, { "layout": "content", "title": "Slide Title", "bullets": ["Point 1", "Point 2", "Point 3"] }, { "layout": "two-column", "title": "Comparison", "left": { "header": "Left", "bullets": ["A", "B"] }, "right": { "header": "Right", "bullets": ["C", "D"] } }, { "layout": "table", "title": "Data", "headers": ["Col1", "Col2"], "rows": [["a", "b"]] }, { "layout": "section", "title": "Section Break" }, { "layout": "closing", "title": "Thank You" } ] }. Slide layouts: title, section, content, two-column, table, closing.

FOR XLSX: { "filename": "name.xlsx", "sheets": [ { "name": "Sheet1", "headers": ["Col1", "Col2"], "rows": [["a", "b"]] } ] }.

FOR PDF: pass content as markdown text string (not spec). The content field will be rendered as a formatted PDF.`,
    input_schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['docx', 'xlsx', 'pptx', 'pdf'], description: 'Output format' },
        spec: { type: 'object', description: 'Structured spec (required for docx/xlsx/pptx)' },
        content: { type: 'string', description: 'Raw text content (for PDF only)' },
      },
      required: ['format'],
    },
    permissionLevel: 'ask_every',
    riskLevel: 'medium',
  },
};

export function getClaudeTools(): Array<{ name: string; description: string; input_schema: any }> {
  return Object.values(TOOL_REGISTRY).map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

/** Cached MCP tools — refreshed on each agent run */
let cachedMCPTools: Array<{ name: string; description: string; input_schema: any }> = [];

/**
 * Set the cached MCP tools (called at start of each agent run).
 */
export function setMCPTools(tools: Array<{ name: string; description: string; input_schema: any }>): void {
  cachedMCPTools = tools;
}

/** Cached sandbox tools — set when sandbox is available */
let cachedSandboxTools: Array<{ name: string; description: string; input_schema: any }> = [];
let sandboxAvailable = false;

export function setSandboxAvailable(available: boolean): void {
  sandboxAvailable = available;
  if (available) {
    // Register sandbox tools with simple schemas
    cachedSandboxTools = [
      { name: 'sandbox_execute', description: 'Execute a Linux command in the WSL2 sandbox', input_schema: { type: 'object', required: ['command', 'description'], properties: { command: { type: 'string', description: 'Linux command to execute' }, description: { type: 'string', description: 'What this command does' }, working_directory: { type: 'string', description: 'Subdirectory within workspace' } } } },
      { name: 'sandbox_read_file', description: 'Read a file from the sandbox workspace', input_schema: { type: 'object', required: ['path'], properties: { path: { type: 'string', description: 'File path relative to workspace root' } } } },
      { name: 'sandbox_write_file', description: 'Write a file to the sandbox workspace', input_schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string', description: 'File path relative to workspace root' }, content: { type: 'string', description: 'File content' } } } },
      { name: 'sandbox_list_dir', description: 'List files in a sandbox directory', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Directory path relative to workspace root' } } } },
      { name: 'sandbox_run_python', description: 'Run a Python script in the sandbox', input_schema: { type: 'object', required: ['script_path'], properties: { script_path: { type: 'string', description: 'Path to Python script' }, args: { type: 'string', description: 'Command line arguments' } } } },
      { name: 'sandbox_copy_from_shared', description: 'Copy a file from the shared Windows folder into the sandbox', input_schema: { type: 'object', required: ['filename'], properties: { filename: { type: 'string', description: 'File name in shared folder' }, destination: { type: 'string', description: 'Destination path in workspace' } } } },
      { name: 'sandbox_save_to_shared', description: 'Save a sandbox file to the shared Windows folder for user access', input_schema: { type: 'object', required: ['source_path'], properties: { source_path: { type: 'string', description: 'Source path in workspace' }, filename: { type: 'string', description: 'Output filename for user' } } } },
    ];
  } else {
    cachedSandboxTools = [];
  }
}

export function isSandboxAvailable(): boolean {
  return sandboxAvailable;
}

/**
 * Get ALL tools — local + MCP + sandbox combined.
 * The agent uses this to get the full tool set available.
 */
export function getAllTools(): Array<{ name: string; description: string; input_schema: any }> {
  return [...getClaudeTools(), ...cachedMCPTools, ...cachedSandboxTools];
}
