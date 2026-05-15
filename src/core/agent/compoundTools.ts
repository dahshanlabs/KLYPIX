/**
 * Compound Tool Operations (Innovation #13).
 *
 * Pre-built multi-tool chains that combine multiple IPC calls into a single
 * atomic operation. Instead of the model needing to make 3 separate tool calls
 * (each one a chance for Gemini to give up), compound tools execute the entire
 * chain in one orchestrator-managed operation.
 *
 * Available compounds:
 *   read_and_summarize — Read a web page and return structured metadata
 *   create_and_open — Create a document and open it
 *   find_desktop_path — Resolve the user's Desktop path
 *   safe_write — Write a file with automatic versioning (_v2, _v3)
 */

import { executeTool } from './toolExecutor';

export interface CompoundResult {
  success: boolean;
  data: Record<string, any>;
  error?: string;
}

/**
 * Read a web page and extract structured metadata.
 * Combines: read_web_content → code-based extraction.
 */
export async function readAndSummarize(url: string): Promise<CompoundResult> {
  try {
    const result = await executeTool('read_web_content', { url });
    const content = typeof result === 'string' ? result :
      JSON.stringify(result);

    // Extract metadata from content
    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i) ||
                       content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() || url;

    // Extract date patterns
    const dateMatch = content.match(/\b(20\d{2}[-/]\d{1,2}[-/]\d{1,2})\b/) ||
                      content.match(/\b((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s+20\d{2})\b/i);
    const date = dateMatch?.[1] || null;

    // Extract first meaningful paragraph
    const paraMatch = content.match(/<p[^>]*>([^<]{50,300})<\/p>/i) ||
                      content.match(/\n([A-Z][^.\n]{50,300}\.)/);
    const summary = paraMatch?.[1]?.trim() || content.substring(0, 200);

    return {
      success: true,
      data: { url, title, date, summary, contentLength: content.length },
    };
  } catch (err: any) {
    return { success: false, data: { url }, error: err.message };
  }
}

/**
 * Create a document and open it in the default application.
 * Combines: generate_document → system_open.
 */
export async function createAndOpen(
  format: string,
  spec?: Record<string, any>,
  content?: string,
): Promise<CompoundResult> {
  try {
    const genResult = await executeTool('generate_document', { format, spec, content });
    const parsed = JSON.parse(genResult);
    const filePath = parsed.path || parsed.filePath;

    if (!filePath) {
      return { success: false, data: parsed, error: 'No file path in result' };
    }

    // Open the file
    await executeTool('system_open', { target: filePath });

    return { success: true, data: { path: filePath, format, opened: true } };
  } catch (err: any) {
    return { success: false, data: {}, error: err.message };
  }
}

/**
 * Resolve the user's Desktop path via PowerShell.
 * Combines: run_shell → trim output.
 */
export async function findDesktopPath(): Promise<CompoundResult> {
  try {
    const result = await executeTool('run_shell', {
      command: 'echo $env:USERPROFILE\\Desktop',
    });
    const parsed = JSON.parse(result);
    const path = (parsed.stdout || parsed.output || '').trim();

    if (!path || path.length < 5) {
      return { success: false, data: {}, error: 'Could not resolve Desktop path' };
    }

    return { success: true, data: { desktopPath: path } };
  } catch (err: any) {
    // Fallback to common path
    return { success: true, data: { desktopPath: 'C:\\Users\\Default\\Desktop', fallback: true } };
  }
}

/**
 * Write a file with automatic versioning.
 * If the file already exists, appends _v2, _v3, etc.
 * Combines: list_directory → resolve path → write_file.
 */
export async function safeWrite(
  filePath: string,
  content: string,
): Promise<CompoundResult> {
  try {
    const dirPath = filePath.replace(/[/\\][^/\\]+$/, '');
    const fileName = filePath.split(/[/\\]/).pop() || 'output.txt';
    const ext = fileName.includes('.') ? '.' + fileName.split('.').pop() : '';
    const baseName = fileName.replace(ext, '');

    // Check if file exists
    let resolvedPath = filePath;
    try {
      const dirResult = await executeTool('list_directory', { dir_path: dirPath });
      if (dirResult.includes(fileName)) {
        // File exists — find next version
        let version = 2;
        while (version <= 20) {
          const versionedName = `${baseName}_v${version}${ext}`;
          if (!dirResult.includes(versionedName)) {
            resolvedPath = `${dirPath}\\${versionedName}`;
            break;
          }
          version++;
        }
      }
    } catch {
      // Directory might not exist — write_file will create it
    }

    // Write the file
    const writeResult = await executeTool('write_file', {
      file_path: resolvedPath,
      content,
    });

    return {
      success: true,
      data: {
        path: resolvedPath,
        originalPath: filePath,
        versioned: resolvedPath !== filePath,
        writeResult: JSON.parse(writeResult),
      },
    };
  } catch (err: any) {
    return { success: false, data: { path: filePath }, error: err.message };
  }
}

/**
 * Registry of available compound tools with descriptions.
 * The orchestrator can reference these when building micro-prompts.
 */
export const COMPOUND_TOOLS = {
  read_and_summarize: {
    name: 'read_and_summarize',
    description: 'Read a web page and return structured metadata (title, date, summary)',
    execute: readAndSummarize,
  },
  create_and_open: {
    name: 'create_and_open',
    description: 'Create a document file and open it in the default application',
    execute: createAndOpen,
  },
  find_desktop_path: {
    name: 'find_desktop_path',
    description: 'Get the user Desktop path (resolves %USERPROFILE%\\Desktop)',
    execute: findDesktopPath,
  },
  safe_write: {
    name: 'safe_write',
    description: 'Write a file with automatic versioning (appends _v2 if file exists)',
    execute: safeWrite,
  },
} as const;
