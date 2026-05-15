import React, { useState, useEffect } from 'react';
import type { PermissionRequest } from '../core/agent/permissions';

interface PermissionTabsProps {
  request: PermissionRequest | null;
  onAllow: (scope: 'once' | 'session') => void;
  onDeny: () => void;
  trustMode: boolean;
  onTrustModeChange: (enabled: boolean) => void;
}

export const PermissionTabs: React.FC<PermissionTabsProps> = ({
  request, onAllow, onDeny, trustMode, onTrustModeChange,
}) => {
  // ALL HOOKS BEFORE CONDITIONAL RETURN
  const [waitSeconds, setWaitSeconds] = useState(30);
  const [autoAllowTimer, setAutoAllowTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!request) { setWaitSeconds(30); return; }
    const interval = setInterval(() => {
      setWaitSeconds(s => {
        if (s <= 1) { onDeny(); return 30; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [request, onDeny]);

  const isHighRisk = request?.level === 'ask_every';
  const isTrusted = trustMode && request?.level === 'ask_first';

  useEffect(() => {
    if (isTrusted && request && !autoAllowTimer) {
      const timer = setTimeout(() => onAllow('session'), 500);
      setAutoAllowTimer(timer);
      return () => { clearTimeout(timer); setAutoAllowTimer(null); };
    }
  }, [isTrusted, request, onAllow, autoAllowTimer]);

  // CONDITIONAL RETURN AFTER ALL HOOKS
  if (!request) return null;

  const borderClass = isHighRisk ? 'border-red-500/40' : 'border-yellow-500/40';
  const bgClass = isHighRisk ? 'bg-red-500/5' : 'bg-yellow-500/5';
  const accentClass = isHighRisk ? 'text-red-400' : 'text-yellow-400';

  return (
    <div className={`glass rounded-xl p-4 border ${borderClass} ${bgClass} animate-slideIn`}>
      <div className="flex items-start justify-between mb-3">
        <div>
          <h4 className="font-semibold text-white text-sm mb-0.5">Permission Required</h4>
          <p className={`text-xs ${accentClass}`}>{isHighRisk ? 'High Risk' : 'Medium Risk'}</p>
        </div>
        {!isHighRisk && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={trustMode}
              onChange={e => onTrustModeChange(e.target.checked)}
              className="w-3.5 h-3.5 accent-emerald-500"
            />
            <span className="text-gray-400">Trust mode</span>
          </label>
        )}
      </div>

      <div className="bg-black/20 rounded-lg p-3 mb-3 text-xs font-mono space-y-1">
        <p className="text-gray-400">Tool: <span className="text-cyan-400">{request.toolName}</span></p>
        <details className="text-gray-500">
          <summary className="cursor-pointer hover:text-gray-300">View input</summary>
          <pre className="mt-1 text-[10px] max-h-20 overflow-auto text-gray-400">
            {JSON.stringify(request.input, null, 2)}
          </pre>
        </details>
      </div>

      <p className="text-xs text-gray-400 mb-3">{request.description}</p>

      {isTrusted && (
        <div className="text-xs text-emerald-400 mb-3">Auto-approving (trust mode)...</div>
      )}

      <div className="flex gap-2">
        <button
          onClick={() => onAllow('once')}
          className="flex-1 px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors"
        >
          Allow
        </button>
        {!isHighRisk && (
          <button
            onClick={() => onAllow('session')}
            className="flex-1 px-3 py-2 rounded-lg bg-emerald-600/30 hover:bg-emerald-600/50 text-emerald-400 text-xs font-medium border border-emerald-600/50 transition-colors"
          >
            Allow Session
          </button>
        )}
        <button
          onClick={onDeny}
          className="px-3 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/40 text-red-400 text-xs font-medium border border-red-600/30 transition-colors"
        >
          Deny ({waitSeconds}s)
        </button>
      </div>
    </div>
  );
};
