import { exec } from 'child_process';
import { promisify } from 'util';
import type { SandboxConfig } from './sandboxConfig';

const execAsync = promisify(exec);

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  command: string;
}

interface FileResult {
  success: boolean;
  content?: string;
  entries?: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }>;
  error?: string;
  path: string;
}

/**
 * Fallback executor for when WSL2 is not available.
 * Uses PowerShell for basic file operations. Intentionally limited.
 */
export class FallbackExecutor {
  private workspacePath: string;

  constructor(config: SandboxConfig) {
    this.workspacePath = config.sharedFolderWindows
      .replace('%APPDATA%', process.env.APPDATA || '');
  }

  async executeCommand(command: string): Promise<CommandResult> {
    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execAsync(
        `powershell -NoProfile -NonInteractive -Command "${command.replace(/"/g, '\\"')}"`,
        { timeout: 30000, windowsHide: true, cwd: this.workspacePath },
      );
      return { exitCode: 0, stdout, stderr, durationMs: Date.now() - startTime, truncated: false, timedOut: false, command };
    } catch (error: any) {
      return {
        exitCode: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        durationMs: Date.now() - startTime,
        truncated: false,
        timedOut: error.killed,
        command,
      };
    }
  }

  async readFile(path: string): Promise<FileResult> {
    const fullPath = `${this.workspacePath}\\${path.replace(/\//g, '\\')}`;
    const result = await this.executeCommand(`Get-Content -Raw '${fullPath}'`);
    return { success: result.exitCode === 0, content: result.stdout, error: result.stderr || undefined, path };
  }

  async writeFile(path: string, content: string): Promise<FileResult> {
    const fullPath = `${this.workspacePath}\\${path.replace(/\//g, '\\')}`;
    const dir = fullPath.substring(0, fullPath.lastIndexOf('\\'));
    await this.executeCommand(`New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`);
    const escaped = content.replace(/'/g, "''");
    const result = await this.executeCommand(`Set-Content -Path '${fullPath}' -Value '${escaped}'`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path };
  }

  async listDirectory(path: string = ''): Promise<FileResult> {
    const fullPath = path
      ? `${this.workspacePath}\\${path.replace(/\//g, '\\')}`
      : this.workspacePath;
    const result = await this.executeCommand(
      `Get-ChildItem '${fullPath}' | Select-Object Name, Length, LastWriteTime, PSIsContainer | ConvertTo-Json`,
    );

    let entries: Array<{ name: string; type: 'file' | 'directory'; size: number; modified: string }> = [];
    if (result.exitCode === 0 && result.stdout.trim()) {
      try {
        const items = JSON.parse(result.stdout);
        const itemArray = Array.isArray(items) ? items : [items];
        entries = itemArray.map((item: any) => ({
          name: item.Name,
          type: item.PSIsContainer ? 'directory' as const : 'file' as const,
          size: item.Length || 0,
          modified: item.LastWriteTime || '',
        }));
      } catch { /* parse failed */ }
    }
    return { success: result.exitCode === 0, entries, path };
  }
}
