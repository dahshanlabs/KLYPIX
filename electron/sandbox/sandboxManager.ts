import { WSLBridge, type SandboxStatus } from './wslBridge';
import { DEFAULT_SANDBOX_CONFIG, type SandboxConfig } from './sandboxConfig';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Manages sandbox lifecycle: detection, initialization, workspace setup, cleanup.
 */
export class SandboxManager {
  private bridge: WSLBridge;
  private config: SandboxConfig;
  private status: SandboxStatus;
  private initialized = false;

  constructor(config: Partial<SandboxConfig> = {}) {
    this.config = { ...DEFAULT_SANDBOX_CONFIG, ...config };
    this.bridge = new WSLBridge(this.config.wslDistro);
    this.status = { available: false, distro: null, running: false, workspaceReady: false, diskUsageMB: 0, error: 'Not initialized' };
  }

  async initialize(): Promise<SandboxStatus> {
    // Step 1: Check WSL availability
    this.status = await this.bridge.checkWSLAvailable();
    if (!this.status.available) {
      return this.status;
    }

    // Step 2: Create workspace directories
    await this.bridge.executeCommand(
      `mkdir -p ${this.config.workspacePath}/shared ${this.config.workspacePath}/scripts ${this.config.workspacePath}/output ${this.config.workspacePath}/temp`,
    );

    // Step 3: Check first-run initialization
    const firstRunMarker = `${this.config.workspacePath}/.klypix-initialized`;
    const markerCheck = await this.bridge.executeCommand(`test -f ${firstRunMarker} && echo "exists"`);

    if (!markerCheck.stdout.includes('exists')) {
      console.log('[Sandbox] First run — installing essential tools...');
      await this.installEssentialTools();
      await this.bridge.executeCommand(`touch ${firstRunMarker}`);
    }

    // Step 4: Create shared folder link
    await this.createSharedFolderLink();

    this.status.workspaceReady = true;
    this.status.running = true;
    this.initialized = true;

    return this.status;
  }

  private async installEssentialTools(): Promise<void> {
    const installScript = [
      'apt-get update -qq 2>/dev/null',
      'which jq || apt-get install -y -qq jq 2>/dev/null',
      'which pandoc || apt-get install -y -qq pandoc 2>/dev/null',
      'which pdftotext || apt-get install -y -qq poppler-utils 2>/dev/null',
      'which python3 || apt-get install -y -qq python3 python3-pip 2>/dev/null',
      'pip3 install --quiet pandas openpyxl pdfplumber tabulate 2>/dev/null || true',
      'echo "KLYPIX_TOOLS_INSTALLED"',
    ].join(' && ');

    try {
      await this.bridge.executeCommand(
        `bash -c '${installScript.replace(/'/g, "'\\''")}'`,
        { timeout: 120000 },
      );
    } catch (err) {
      console.warn('[Sandbox] Essential tools install failed (may need sudo):', err);
    }
  }

  private async createSharedFolderLink(): Promise<void> {
    const windowsPath = this.config.sharedFolderWindows
      .replace('%APPDATA%', process.env.APPDATA || '');

    if (!fs.existsSync(windowsPath)) {
      fs.mkdirSync(windowsPath, { recursive: true });
    }

    const wslMountPath = windowsPath
      .replace(/\\/g, '/')
      .replace(/^([A-Z]):/, (_, drive: string) => `/mnt/${drive.toLowerCase()}`);

    await this.bridge.executeCommand(
      `ln -sfn "${wslMountPath}" ${this.config.sharedFolderWSL}`,
    );
  }

  async resetWorkspace(): Promise<void> {
    await this.bridge.executeCommand(
      `rm -rf ${this.config.workspacePath}/temp/* ${this.config.workspacePath}/output/*`,
    );
  }

  async getWorkspaceUsage(): Promise<number> {
    const result = await this.bridge.executeCommand(
      `du -sm ${this.config.workspacePath} | cut -f1`,
    );
    return parseInt(result.stdout.trim()) || 0;
  }

  async cleanupOldFiles(maxAgeDays: number = 7): Promise<void> {
    await this.bridge.executeCommand(
      `find ${this.config.workspacePath}/temp -type f -mtime +${maxAgeDays} -delete 2>/dev/null; ` +
      `find ${this.config.workspacePath}/output -type f -mtime +${maxAgeDays} -delete 2>/dev/null`,
    );
  }

  async getStatus(): Promise<SandboxStatus> {
    if (!this.initialized) {
      return this.status;
    }
    const diskUsage = await this.getWorkspaceUsage();
    return { ...this.status, diskUsageMB: diskUsage };
  }

  isReady(): boolean {
    return this.initialized && this.status?.available === true;
  }

  getBridge(): WSLBridge {
    return this.bridge;
  }

  getConfig(): SandboxConfig {
    return this.config;
  }

  getSharedFolderWindows(): string {
    return this.config.sharedFolderWindows.replace('%APPDATA%', process.env.APPDATA || '');
  }
}
