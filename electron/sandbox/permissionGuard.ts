import type { SandboxConfig } from './sandboxConfig';

export interface PermissionCheck {
  allowed: boolean;
  requiresApproval: boolean;
  reason: string;
  sanitizedCommand?: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked';
}

// Escape detection patterns
const ESCAPE_PATTERNS = [
  /wsl\.exe/i,
  /cmd\.exe/i,
  /powershell/i,
  /\/mnt\/c\/Windows/i,
  /\$\(.*wsl/i,
  /`.*wsl/i,
  /;\s*wsl/i,
  /\|\s*wsl/i,
];

// Dangerous command patterns
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /rm\s+(-[rf]+\s+)?\//, reason: 'Recursive delete from root' },
  { pattern: />\s*\/dev\//, reason: 'Writing to device files' },
  { pattern: /chmod\s+777/, reason: 'Setting overly permissive permissions' },
  { pattern: /\|\s*sh\b/, reason: 'Piping to shell' },
  { pattern: /eval\s/, reason: 'Eval execution' },
  { pattern: /:\(\)\{\s*:\|:&\s*\};:/, reason: 'Fork bomb detected' },
  { pattern: /mkfifo.*\|.*bash/, reason: 'Reverse shell pattern' },
  { pattern: /\/dev\/tcp\//, reason: 'Network device access' },
];

export function checkPermission(command: string, config: SandboxConfig): PermissionCheck {
  const normalizedCommand = command.trim().toLowerCase();

  // Blocked commands
  for (const blocked of config.blockedCommands) {
    if (normalizedCommand.includes(blocked.toLowerCase())) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Command contains blocked operation: "${blocked}"`,
        riskLevel: 'blocked',
      };
    }
  }

  // Blocked paths
  for (const blockedPath of config.blockedPaths) {
    const pathRegex = new RegExp(
      blockedPath.replace(/\*/g, '[^/]+').replace(/\//g, '\\/'),
      'i',
    );
    if (pathRegex.test(command)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Command accesses blocked path: "${blockedPath}"`,
        riskLevel: 'blocked',
      };
    }
  }

  // Escape attempts
  for (const pattern of ESCAPE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: 'Command appears to attempt sandbox escape',
        riskLevel: 'blocked',
      };
    }
  }

  // Dangerous patterns
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        requiresApproval: false,
        reason: `Dangerous pattern detected: ${reason}`,
        riskLevel: 'dangerous',
      };
    }
  }

  // Capability checks
  if (!config.allowNetworkAccess &&
      (normalizedCommand.includes('curl') || normalizedCommand.includes('wget'))) {
    return { allowed: false, requiresApproval: false, reason: 'Network access is disabled', riskLevel: 'blocked' };
  }

  if (!config.allowPackageInstall &&
      (normalizedCommand.includes('pip install') || normalizedCommand.includes('npm install'))) {
    return { allowed: false, requiresApproval: false, reason: 'Package installation is disabled', riskLevel: 'blocked' };
  }

  if (!config.allowFileDelete && normalizedCommand.includes('rm ')) {
    return { allowed: false, requiresApproval: false, reason: 'File deletion is disabled', riskLevel: 'blocked' };
  }

  // Approval required
  for (const approvalCmd of config.requireApprovalFor) {
    if (normalizedCommand.startsWith(approvalCmd.toLowerCase()) ||
        normalizedCommand.includes(` ${approvalCmd.toLowerCase()}`)) {
      return {
        allowed: true,
        requiresApproval: true,
        reason: `"${approvalCmd}" requires user approval`,
        sanitizedCommand: command,
        riskLevel: 'moderate',
      };
    }
  }

  // Check whitelist
  const baseCommand = normalizedCommand.split(/\s+/)[0].split('/').pop() || '';
  const isWhitelisted = config.allowedCommands.some(cmd => baseCommand === cmd.toLowerCase());

  if (!isWhitelisted) {
    return {
      allowed: true,
      requiresApproval: true,
      reason: `Command "${baseCommand}" is not in the whitelist. Requesting user approval.`,
      sanitizedCommand: command,
      riskLevel: 'moderate',
    };
  }

  return {
    allowed: true,
    requiresApproval: false,
    reason: 'Command is whitelisted and safe',
    sanitizedCommand: command,
    riskLevel: 'safe',
  };
}
