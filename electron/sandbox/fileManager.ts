import { WSLBridge, type CommandResult } from './wslBridge';
import type { SandboxConfig } from './sandboxConfig';

export interface FileResult {
  success: boolean;
  content?: string;
  entries?: DirectoryEntry[];
  error?: string;
  path: string;
}

export interface DirectoryEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  modified: string;
}

/**
 * High-level file operations scoped to the sandbox workspace.
 * Every path is resolved relative to the workspace root.
 */
export class FileManager {
  private bridge: WSLBridge;
  private workspacePath: string;
  private config: SandboxConfig;

  constructor(bridge: WSLBridge, config: SandboxConfig) {
    this.bridge = bridge;
    this.workspacePath = config.workspacePath;
    this.config = config;
  }

  private resolvePath(relativePath: string): string {
    const cleaned = relativePath
      .replace(/\.\.\//g, '')
      .replace(/\.\./g, '')
      .replace(/^\//, '');
    return `${this.workspacePath}/${cleaned}`;
  }

  async readFile(path: string): Promise<FileResult> {
    const fullPath = this.resolvePath(path);
    const result = await this.bridge.executeCommand(`cat "${fullPath}"`);
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr, path };
    }
    return { success: true, content: result.stdout, path };
  }

  async writeFile(path: string, content: string): Promise<FileResult> {
    const fullPath = this.resolvePath(path);

    if (content.length > this.config.maxFileSize) {
      return { success: false, error: `File exceeds max size of ${this.config.maxFileSize} bytes`, path };
    }

    const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
    await this.bridge.executeCommand(`mkdir -p "${dir}"`);

    const result = await this.bridge.executeCommand(
      `cat > "${fullPath}" << 'KLYPIX_EOF'\n${content}\nKLYPIX_EOF`,
    );

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr, path };
    }
    return { success: true, path };
  }

  async appendFile(path: string, content: string): Promise<FileResult> {
    const fullPath = this.resolvePath(path);
    const result = await this.bridge.executeCommand(
      `cat >> "${fullPath}" << 'KLYPIX_EOF'\n${content}\nKLYPIX_EOF`,
    );
    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr, path };
    }
    return { success: true, path };
  }

  async deleteFile(path: string): Promise<FileResult> {
    if (!this.config.allowFileDelete) {
      return { success: false, error: 'File deletion is disabled', path };
    }
    const fullPath = this.resolvePath(path);
    if (!fullPath.startsWith(this.workspacePath)) {
      return { success: false, error: 'Cannot delete files outside workspace', path };
    }
    const result = await this.bridge.executeCommand(`rm -f "${fullPath}"`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path };
  }

  async listDirectory(path: string = ''): Promise<FileResult> {
    const fullPath = this.resolvePath(path || '');
    const result = await this.bridge.executeCommand(
      `find "${fullPath}" -maxdepth 1 -printf '%y %s %T+ %f\\n' 2>/dev/null | sort`,
    );

    if (result.exitCode !== 0) {
      return { success: false, error: result.stderr, path, entries: [] };
    }

    const entries: DirectoryEntry[] = result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [type, size, modified, ...nameParts] = line.split(' ');
        return {
          name: nameParts.join(' '),
          type: type === 'd' ? 'directory' as const : 'file' as const,
          size: parseInt(size) || 0,
          modified: modified || '',
        };
      })
      .filter(e => e.name !== '.' && e.name !== '..');

    return { success: true, entries, path };
  }

  async fileExists(path: string): Promise<boolean> {
    const fullPath = this.resolvePath(path);
    const result = await this.bridge.executeCommand(`test -e "${fullPath}" && echo "yes"`);
    return result.stdout.trim() === 'yes';
  }

  async moveFile(source: string, destination: string): Promise<FileResult> {
    const fullSource = this.resolvePath(source);
    const fullDest = this.resolvePath(destination);
    const result = await this.bridge.executeCommand(`mv "${fullSource}" "${fullDest}"`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path: destination };
  }

  async copyFile(source: string, destination: string): Promise<FileResult> {
    const fullSource = this.resolvePath(source);
    const fullDest = this.resolvePath(destination);
    const result = await this.bridge.executeCommand(`cp -r "${fullSource}" "${fullDest}"`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path: destination };
  }

  async createDirectory(path: string): Promise<FileResult> {
    const fullPath = this.resolvePath(path);
    const result = await this.bridge.executeCommand(`mkdir -p "${fullPath}"`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path };
  }

  async copyFromWindows(windowsPath: string, sandboxPath: string): Promise<FileResult> {
    const wslPath = windowsPath
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
    return this.copyFile(wslPath, sandboxPath);
  }

  async copyToWindows(sandboxPath: string, windowsPath: string): Promise<FileResult> {
    const wslPath = windowsPath
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`);
    const fullSource = this.resolvePath(sandboxPath);
    const result = await this.bridge.executeCommand(`cp "${fullSource}" "${wslPath}"`);
    return { success: result.exitCode === 0, error: result.stderr || undefined, path: windowsPath };
  }
}
