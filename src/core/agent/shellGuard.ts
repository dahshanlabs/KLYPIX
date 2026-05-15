export interface AuditLog {
  timestamp: number;
  command: string;
  reason: string;
  blocked: boolean;
}

class ShellGuard {
  private auditLog: AuditLog[] = [];
  private readonly blockedPatterns = [
    /del\s+\/[sfq]/i,
    /format\s+[a-z]:/i,
    /rm\s+-rf\s+\//,
    /erase\s+/i,
    /shutdown\s+\/[srhg]/i,
    /taskkill\s+\/f/i,
    /bcdedit/i,
    /bootrec/i,
    /reg\s+delete/i,
    /reg\s+add.*run/i,
    /system32/i,
    /windows\\system/i,
    /netsh\s+firewall/i,
    /Remove-Item.*-Recurse.*-Force/i,
    /Stop-Computer/i,
    /Restart-Computer/i,
    /Set-ExecutionPolicy/i,
    /Invoke-Expression/i,
    /Invoke-WebRequest.*\|\s*iex/i,
    /Start-Process.*-Verb\s+RunAs/i,
    /netsh\s+advfirewall/i,
    /cipher\s+\/[eE]/i,
  ];

  guard(command: string): { allowed: boolean; reason: string } {
    for (const pattern of this.blockedPatterns) {
      if (pattern.test(command)) {
        this.auditLog.push({
          timestamp: Date.now(),
          command: command.slice(0, 60),
          reason: pattern.toString(),
          blocked: true,
        });
        if (this.auditLog.length > 1000) this.auditLog.shift();
        return { allowed: false, reason: `Blocked by pattern: ${pattern.toString()}` };
      }
    }

    this.auditLog.push({
      timestamp: Date.now(),
      command: command.slice(0, 60),
      reason: 'passed',
      blocked: false,
    });
    if (this.auditLog.length > 1000) this.auditLog.shift();
    return { allowed: true, reason: 'OK' };
  }

  getAuditLog(limit = 100): AuditLog[] {
    return this.auditLog.slice(-limit);
  }
}

export const shellGuard = new ShellGuard();
