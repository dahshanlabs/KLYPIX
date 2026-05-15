import type { FlashToolSchema } from '../flash/types';

// Sandbox tool definitions exposed to the agent via the Hybrid Router.
// Each tool maps to IPC calls → main process → WSL Bridge → WSL2.

export const SANDBOX_TOOLS: FlashToolSchema[] = [
  {
    name: 'sandbox_execute',
    description: 'Executes a Linux command in the WSL2 sandbox environment. Returns stdout and stderr.',
    whenToUse: 'When you need to run a shell command, process data, or execute scripts in the sandbox',
    whenNotToUse: 'For simple file read/write — use sandbox_read_file or sandbox_write_file instead',
    params: [
      {
        name: 'command',
        type: 'string',
        description: 'The Linux command to execute',
        example: 'python3 script.py --input data.csv --output results.json',
        required: true,
      },
      {
        name: 'description',
        type: 'string',
        description: 'Human-readable description of what this command does (shown to user)',
        example: 'Processing CSV data with Python script',
        required: true,
      },
      {
        name: 'working_directory',
        type: 'string',
        description: 'Subdirectory within workspace to run from. Relative path.',
        example: 'output',
        required: false,
      },
    ],
    returnDescription: 'Object with exitCode, stdout, stderr, durationMs',
    exampleCall: { command: 'ls -la', description: 'List files in workspace' },
    exampleReturn: '{ exitCode: 0, stdout: "total 8\\ndrwxr-xr-x 2 klypix...", stderr: "" }',
  },

  {
    name: 'sandbox_read_file',
    description: 'Reads the contents of a file in the sandbox workspace.',
    whenToUse: 'When you need to see the contents of an existing file in the sandbox',
    whenNotToUse: 'When the file is very large (>1MB) — use sandbox_execute with head/tail instead',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'File path relative to workspace root',
        example: 'output/report.md',
        required: true,
      },
    ],
    returnDescription: 'Object with success boolean and content string',
    exampleCall: { path: 'data/config.json' },
    exampleReturn: '{ success: true, content: "{ \\"key\\": \\"value\\" }" }',
  },

  {
    name: 'sandbox_write_file',
    description: 'Creates or overwrites a file in the sandbox workspace.',
    whenToUse: 'When you need to create a new file or replace an existing one in the sandbox',
    whenNotToUse: 'When you want to add to an existing file — use sandbox_execute with append instead',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'File path relative to workspace root. Parent directories are created automatically.',
        example: 'output/analysis.md',
        required: true,
      },
      {
        name: 'content',
        type: 'string',
        description: 'The full file content to write',
        example: '# Analysis Report\n\nFindings...',
        required: true,
      },
    ],
    returnDescription: 'Object with success boolean',
    exampleCall: { path: 'output/hello.txt', content: 'Hello World' },
    exampleReturn: '{ success: true, path: "output/hello.txt" }',
  },

  {
    name: 'sandbox_list_dir',
    description: 'Lists all files and directories in a sandbox workspace path.',
    whenToUse: 'When you need to see what files exist in the sandbox before reading or processing them',
    whenNotToUse: 'When you already know the exact file path — just use sandbox_read_file directly',
    params: [
      {
        name: 'path',
        type: 'string',
        description: 'Directory path relative to workspace root. Empty string for root.',
        example: 'output',
        required: false,
      },
    ],
    returnDescription: 'Object with entries array: [{ name, type, size, modified }]',
    exampleCall: { path: '' },
    exampleReturn: '{ success: true, entries: [{ name: "data", type: "directory", size: 4096 }] }',
  },

  {
    name: 'sandbox_run_python',
    description: 'Executes a Python script in the sandbox. Write the script first with sandbox_write_file, then run it.',
    whenToUse: 'When you need to process data, do calculations, generate charts, or manipulate files programmatically',
    whenNotToUse: 'For simple file operations — use sandbox_read_file/sandbox_write_file instead',
    params: [
      {
        name: 'script_path',
        type: 'string',
        description: 'Path to the Python script relative to workspace',
        example: 'scripts/analyze.py',
        required: true,
      },
      {
        name: 'args',
        type: 'string',
        description: 'Command line arguments to pass to the script',
        example: '--input data.csv --format json',
        required: false,
      },
    ],
    returnDescription: 'Command result with stdout (script output) and stderr',
    exampleCall: { script_path: 'scripts/process.py', args: '--input data.csv' },
    exampleReturn: '{ exitCode: 0, stdout: "Processed 150 rows\\nOutput saved to results.json" }',
  },

  {
    name: 'sandbox_copy_from_shared',
    description: 'Copies a file from the shared Windows folder into the sandbox workspace for processing.',
    whenToUse: 'When the user mentions a file they want to work with — it needs to be in the shared folder first',
    whenNotToUse: 'When the file is already in the workspace',
    params: [
      {
        name: 'filename',
        type: 'string',
        description: 'Name of the file in the shared folder',
        example: 'quarterly-report.xlsx',
        required: true,
      },
      {
        name: 'destination',
        type: 'string',
        description: 'Where to copy it in the workspace',
        example: 'data/quarterly-report.xlsx',
        required: false,
      },
    ],
    returnDescription: 'Success status and workspace path',
    exampleCall: { filename: 'data.csv' },
    exampleReturn: '{ success: true, path: "data/data.csv" }',
  },

  {
    name: 'sandbox_save_to_shared',
    description: 'Copies a file from the sandbox workspace to the shared Windows folder so the user can access it.',
    whenToUse: 'When you have created a deliverable the user needs (report, spreadsheet, processed file)',
    whenNotToUse: "For intermediate work files the user doesn't need to see",
    params: [
      {
        name: 'source_path',
        type: 'string',
        description: 'Path in the workspace to the file',
        example: 'output/final-report.xlsx',
        required: true,
      },
      {
        name: 'filename',
        type: 'string',
        description: 'Name for the file in the shared folder (what user sees)',
        example: 'Final Report Q3.xlsx',
        required: false,
      },
    ],
    returnDescription: 'Success status and Windows path where file is saved',
    exampleCall: { source_path: 'output/report.pdf', filename: 'Analysis Report.pdf' },
    exampleReturn: '{ success: true, windowsPath: "C:\\\\Users\\\\X\\\\AppData\\\\klypix\\\\sandbox\\\\Analysis Report.pdf" }',
  },
];

// Tool names for quick lookup
export const SANDBOX_TOOL_NAMES = SANDBOX_TOOLS.map(t => t.name);
