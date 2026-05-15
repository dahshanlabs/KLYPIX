import { TOOL_REGISTRY, type PermissionLevel } from './toolRegistry';

export interface PermissionRequest {
  toolName: string;
  description: string;
  input: Record<string, any>;
  level: PermissionLevel;
}

export interface PermissionDecision {
  toolName: string;
  decision: 'allow' | 'deny';
  scope: 'once' | 'session' | 'path';
  pathPattern?: string;
  timestamp: number;
}

export class PermissionManager {
  private sessionGrants = new Map<string, PermissionDecision>();
  private trustMode = false;

  constructor() {
    this.trustMode = localStorage.getItem('klypix:trustMode') === '1';
  }

  check(toolName: string, input: Record<string, any>): {
    needsPrompt: boolean;
    allowed: boolean;
    request?: PermissionRequest;
  } {
    const toolDef = TOOL_REGISTRY[toolName];
    if (!toolDef) return { needsPrompt: false, allowed: false };

    if (this.trustMode) return { needsPrompt: false, allowed: true };

    if (toolDef.permissionLevel === 'always_allow') return { needsPrompt: false, allowed: true };

    // Check session grants for ask_first tools
    const requestId = this.makeRequestId(toolName, input);
    const sessionGrant = this.sessionGrants.get(requestId);
    if (sessionGrant && sessionGrant.scope === 'session') {
      return { needsPrompt: false, allowed: sessionGrant.decision === 'allow' };
    }

    // Check tool-level session grant (not input-specific)
    const toolGrant = this.sessionGrants.get(`${toolName}:session:`);
    if (toolGrant && toolGrant.scope === 'session') {
      return { needsPrompt: false, allowed: toolGrant.decision === 'allow' };
    }

    // Check localStorage for persistent grants
    const persisted = this.getPersistedGrant(toolName);
    if (persisted && persisted.scope === 'session') {
      this.sessionGrants.set(requestId, persisted);
      return { needsPrompt: false, allowed: persisted.decision === 'allow' };
    }

    return {
      needsPrompt: true,
      allowed: false,
      request: {
        toolName,
        description: toolDef.description,
        input,
        level: toolDef.permissionLevel,
      },
    };
  }

  grant(toolName: string, decision: 'allow' | 'deny', scope: 'once' | 'session' | 'path', pathPattern?: string): void {
    const requestId = `${toolName}:${scope}:${pathPattern || ''}`;
    const grant: PermissionDecision = { toolName, decision, scope, pathPattern, timestamp: Date.now() };

    this.sessionGrants.set(requestId, grant);

    if (scope === 'session') {
      const key = `klypix:perm:${toolName}:session`;
      localStorage.setItem(key, JSON.stringify(grant));
    } else if (scope === 'path' && pathPattern) {
      const key = `klypix:perm:${toolName}:path`;
      const existing = JSON.parse(localStorage.getItem(key) || '{}');
      existing[pathPattern] = decision;
      localStorage.setItem(key, JSON.stringify(existing));
    }
  }

  setTrustMode(enabled: boolean): void {
    this.trustMode = enabled;
    localStorage.setItem('klypix:trustMode', enabled ? '1' : '0');
  }

  isTrustMode(): boolean {
    return this.trustMode;
  }

  reset(): void {
    this.sessionGrants.clear();
    this.trustMode = false;
    localStorage.removeItem('klypix:trustMode');
  }

  private getPersistedGrant(toolName: string): PermissionDecision | null {
    const key = `klypix:perm:${toolName}:session`;
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }

  private makeRequestId(toolName: string, input: Record<string, any>): string {
    const inputStr = JSON.stringify(input).slice(0, 50);
    return `${toolName}:${inputStr}`;
  }
}
