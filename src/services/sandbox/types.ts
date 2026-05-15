// Sandbox types — shared between renderer (tool definitions) and main process (execution)

export interface SandboxConfig {
  wslDistro: string;
  workspacePath: string;
  sharedFolderWindows: string;
  sharedFolderWSL: string;

  // Security
  allowedCommands: string[];
  blockedCommands: string[];
  blockedPaths: string[];
  maxFileSize: number;
  maxExecutionTimeMs: number;
  requireApprovalFor: string[];

  // Resource limits
  maxConcurrentCommands: number;
  maxOutputSize: number;
  maxDiskUsageMB: number;

  // Capabilities
  allowNetworkAccess: boolean;
  allowPackageInstall: boolean;
  allowScriptExecution: boolean;
  allowFileDelete: boolean;
}

export interface SandboxStatus {
  available: boolean;
  distro: string | null;
  running: boolean;
  workspaceReady: boolean;
  diskUsageMB: number;
  error: string | null;
}

export interface CommandRequest {
  command: string;
  workingDirectory?: string;
  timeout?: number;
  requiresApproval: boolean;
  description: string;
  stream: boolean;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
  timedOut: boolean;
  command: string;
}

export interface FileOperation {
  type: 'read' | 'write' | 'append' | 'delete' | 'list' | 'move' | 'copy' | 'exists' | 'mkdir';
  path: string;
  content?: string;
  destination?: string;
}

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

export interface ApprovalRequest {
  command: string;
  description: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked';
  reason: string;
}

export interface PermissionCheck {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  sanitizedCommand?: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked';
}

export interface StreamEvent {
  type: 'command_start' | 'stdout' | 'stderr' | 'command_end' | 'approval_request' | 'file_created' | 'progress';
  timestamp: number;
  data: any;
}
