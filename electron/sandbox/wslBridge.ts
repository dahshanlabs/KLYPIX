import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  command: string;
}

export interface SandboxStatus {
  available: boolean;
  distro: string | null;
  running: boolean;
  workspaceReady: boolean;
  diskUsageMB: number;
  error: string | null;
}

/**
 * WSL Bridge — communication layer between KLYPIX (Windows) and WSL2 (Linux).
 * Uses `wsl.exe` to execute commands in the Linux environment.
 */
export class WSLBridge {
  private distro: string;
  private isAvailable: boolean | null = null;

  constructor(distro: string = 'Ubuntu') {
    this.distro = distro;
  }

  async checkWSLAvailable(): Promise<SandboxStatus> {
    try {
      await execAsync('wsl --status', { timeout: 10000, windowsHide: true });

      const { stdout: listOutput } = await execAsync('wsl -l -v', {
        timeout: 10000,
        windowsHide: true,
      });

      // WSL list output is UTF-16 on Windows, may have null bytes
      const cleaned = listOutput.replace(/\0/g, '');
      const distroInstalled = cleaned.includes(this.distro);
      const isWSL2 = cleaned.includes('2');

      this.isAvailable = distroInstalled && isWSL2;

      return {
        available: this.isAvailable,
        distro: distroInstalled ? this.distro : null,
        running: false,
        workspaceReady: false,
        diskUsageMB: 0,
        error: distroInstalled ? null : `WSL2 distro "${this.distro}" not found`,
      };
    } catch (error) {
      this.isAvailable = false;
      return {
        available: false,
        distro: null,
        running: false,
        workspaceReady: false,
        diskUsageMB: 0,
        error: 'WSL2 is not installed or not available',
      };
    }
  }

  async executeCommand(
    command: string,
    options: {
      workingDirectory?: string;
      timeout?: number;
      maxOutput?: number;
    } = {},
  ): Promise<CommandResult> {
    const timeout = options.timeout || 60000;
    const maxOutput = options.maxOutput || 100000;
    const cwd = options.workingDirectory || '/home/klypix/workspace';

    const escapedCommand = command.replace(/'/g, "'\\''");
    const fullCommand = `wsl -d ${this.distro} -- bash -c 'cd ${cwd} && ${escapedCommand}'`;

    const startTime = Date.now();

    try {
      const { stdout, stderr } = await execAsync(fullCommand, {
        timeout,
        maxBuffer: maxOutput * 2,
        windowsHide: true,
        env: { ...process.env, WSLENV: '' },
      });

      const truncatedStdout = stdout.length > maxOutput
        ? stdout.substring(0, maxOutput) + '\n[... output truncated]'
        : stdout;

      return {
        exitCode: 0,
        stdout: truncatedStdout,
        stderr,
        durationMs: Date.now() - startTime,
        truncated: stdout.length > maxOutput,
        timedOut: false,
        command,
      };
    } catch (error: any) {
      const timedOut = error.killed || error.signal === 'SIGTERM';

      return {
        exitCode: error.code || 1,
        stdout: error.stdout || '',
        stderr: error.stderr || error.message,
        durationMs: Date.now() - startTime,
        truncated: false,
        timedOut,
        command,
      };
    }
  }

  executeStreaming(
    command: string,
    options: {
      workingDirectory?: string;
      timeout?: number;
      onStdout: (line: string) => void;
      onStderr: (line: string) => void;
      onComplete: (result: CommandResult) => void;
    },
  ): { abort: () => void } {
    const cwd = options.workingDirectory || '/home/klypix/workspace';
    const escapedCommand = command.replace(/'/g, "'\\''");

    const child: ChildProcess = spawn(
      'wsl',
      ['-d', this.distro, '--', 'bash', '-c', `cd ${cwd} && ${escapedCommand}`],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      text.split('\n').filter(Boolean).forEach(options.onStdout);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      text.split('\n').filter(Boolean).forEach(options.onStderr);
    });

    const timer = setTimeout(() => { child.kill('SIGTERM'); }, options.timeout || 60000);

    child.on('close', (code) => {
      clearTimeout(timer);
      options.onComplete({
        exitCode: code || 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        truncated: false,
        timedOut: code === null,
        command,
      });
    });

    return {
      abort: () => { clearTimeout(timer); child.kill('SIGTERM'); },
    };
  }
}
