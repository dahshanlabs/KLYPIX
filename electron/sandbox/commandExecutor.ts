import { WSLBridge, type CommandResult } from './wslBridge';
import { checkPermission } from './permissionGuard';
import type { SandboxConfig } from './sandboxConfig';

export interface CommandRequest {
  command: string;
  workingDirectory?: string;
  timeout?: number;
  requiresApproval: boolean;
  description: string;
  stream: boolean;
}

export interface ApprovalRequest {
  command: string;
  description: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked';
  reason: string;
}

export type StreamEvent =
  | { type: 'commandStart'; command: string; description: string }
  | { type: 'stdout'; line: string }
  | { type: 'stderr'; line: string }
  | { type: 'commandEnd'; exitCode: number; durationMs: number };

/**
 * Safe command execution wrapper.
 * Every command goes through: permission check → approval (if needed) → execute.
 */
export class CommandExecutor {
  private bridge: WSLBridge;
  private config: SandboxConfig;
  private approvalCallback: (request: ApprovalRequest) => Promise<boolean>;
  private streamCallback: ((event: StreamEvent) => void) | null = null;

  constructor(
    bridge: WSLBridge,
    config: SandboxConfig,
    approvalCallback: (request: ApprovalRequest) => Promise<boolean>,
    streamCallback?: (event: StreamEvent) => void,
  ) {
    this.bridge = bridge;
    this.config = config;
    this.approvalCallback = approvalCallback;
    this.streamCallback = streamCallback || null;
  }

  async execute(request: CommandRequest): Promise<CommandResult> {
    // Step 1: Permission check
    const permission = checkPermission(request.command, this.config);

    if (!permission.allowed) {
      return {
        exitCode: 126,
        stdout: '',
        stderr: `BLOCKED: ${permission.reason}`,
        durationMs: 0,
        truncated: false,
        timedOut: false,
        command: request.command,
      };
    }

    // Step 2: User approval if needed
    if (permission.requiresApproval || request.requiresApproval) {
      const approved = await this.approvalCallback({
        command: request.command,
        description: request.description,
        riskLevel: permission.riskLevel,
        reason: permission.reason,
      });

      if (!approved) {
        return {
          exitCode: 130,
          stdout: '',
          stderr: 'User declined to approve this command.',
          durationMs: 0,
          truncated: false,
          timedOut: false,
          command: request.command,
        };
      }
    }

    // Step 3: Execute
    const workDir = request.workingDirectory
      ? `${this.config.workspacePath}/${request.workingDirectory}`
      : this.config.workspacePath;
    const finalCommand = permission.sanitizedCommand || request.command;
    const timeout = request.timeout || this.config.maxExecutionTimeMs;

    // Streaming path: emit live events to renderer
    if (request.stream && this.streamCallback) {
      const emit = this.streamCallback;
      emit({ type: 'commandStart', command: finalCommand, description: request.description });
      return new Promise<CommandResult>((resolve) => {
        this.bridge.executeStreaming(finalCommand, {
          workingDirectory: workDir,
          timeout,
          onStdout: (line) => emit({ type: 'stdout', line }),
          onStderr: (line) => emit({ type: 'stderr', line }),
          onComplete: (result) => {
            emit({ type: 'commandEnd', exitCode: result.exitCode, durationMs: result.durationMs });
            resolve(result);
          },
        });
      });
    }

    return this.bridge.executeCommand(finalCommand, {
      workingDirectory: workDir,
      timeout,
      maxOutput: this.config.maxOutputSize,
    });
  }
}
