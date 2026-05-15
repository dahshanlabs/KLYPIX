export interface SandboxConfig {
  wslDistro: string;
  workspacePath: string;
  sharedFolderWindows: string;
  sharedFolderWSL: string;
  allowedCommands: string[];
  blockedCommands: string[];
  blockedPaths: string[];
  maxFileSize: number;
  maxExecutionTimeMs: number;
  requireApprovalFor: string[];
  maxConcurrentCommands: number;
  maxOutputSize: number;
  maxDiskUsageMB: number;
  allowNetworkAccess: boolean;
  allowPackageInstall: boolean;
  allowScriptExecution: boolean;
  allowFileDelete: boolean;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  wslDistro: 'Ubuntu',
  workspacePath: '/home/klypix/workspace',
  sharedFolderWindows: '%APPDATA%\\klypix\\sandbox',
  sharedFolderWSL: '/home/klypix/workspace/shared',

  allowedCommands: [
    'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'sed', 'awk',
    'cp', 'mv', 'mkdir', 'touch', 'chmod',
    'sort', 'uniq', 'cut', 'tr', 'diff', 'jq', 'csvtool',
    'python3', 'pip3', 'node', 'npm', 'npx',
    'pandoc', 'pdftotext', 'convert', 'ffmpeg',
    'curl', 'wget',
    'date', 'whoami', 'pwd', 'which', 'echo', 'printf',
    'tar', 'zip', 'unzip', 'gzip',
  ],

  blockedCommands: [
    'rm -rf /', 'mkfs', 'dd', 'fdisk', 'parted',
    'sudo', 'su', 'passwd', 'chown',
    'systemctl', 'service', 'init', 'shutdown', 'reboot',
    'nmap', 'netcat', 'nc',
    'kill', 'killall', 'pkill',
    'wsl.exe', 'cmd.exe', 'powershell.exe',
    '> /dev/sda', '> /dev/null',
  ],

  blockedPaths: [
    '/etc/passwd', '/etc/shadow', '/etc/sudoers',
    '/root', '/boot', '/sys', '/proc',
    '/mnt/c/Windows', '/mnt/c/Program Files',
    '/mnt/c/Users/*/AppData',
  ],

  maxFileSize: 50 * 1024 * 1024,
  maxExecutionTimeMs: 60000,
  requireApprovalFor: [
    'rm', 'pip3 install', 'npm install',
    'curl', 'wget', 'chmod',
  ],

  maxConcurrentCommands: 3,
  maxOutputSize: 100000,
  maxDiskUsageMB: 500,

  allowNetworkAccess: true,
  allowPackageInstall: true,
  allowScriptExecution: true,
  allowFileDelete: true,
};
