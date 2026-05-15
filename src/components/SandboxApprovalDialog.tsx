import React, { useEffect, useState } from 'react';
import { AlertTriangle, Shield, CheckCircle, XCircle } from 'lucide-react';

interface ApprovalRequest {
  command: string;
  description: string;
  riskLevel: 'safe' | 'moderate' | 'dangerous' | 'blocked';
  reason: string;
}

interface StreamEvent {
  type: 'commandStart' | 'stdout' | 'stderr' | 'commandEnd';
  command?: string;
  description?: string;
  line?: string;
  exitCode?: number;
  durationMs?: number;
}

const RISK_STYLES: Record<string, { bg: string; border: string; text: string; icon: React.ReactNode }> = {
  safe: {
    bg: 'bg-emerald-500/10', border: 'border-emerald-500/30', text: 'text-emerald-300',
    icon: <CheckCircle size={16} className="text-emerald-400" />,
  },
  moderate: {
    bg: 'bg-yellow-500/10', border: 'border-yellow-500/30', text: 'text-yellow-300',
    icon: <Shield size={16} className="text-yellow-400" />,
  },
  dangerous: {
    bg: 'bg-red-500/10', border: 'border-red-500/30', text: 'text-red-300',
    icon: <AlertTriangle size={16} className="text-red-400" />,
  },
  blocked: {
    bg: 'bg-red-600/20', border: 'border-red-600/40', text: 'text-red-400',
    icon: <XCircle size={16} className="text-red-500" />,
  },
};

export function SandboxApprovalDialog() {
  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [streamLines, setStreamLines] = useState<Array<{ type: 'stdout' | 'stderr'; line: string }>>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const electron = (window as any).electron;
    if (!electron?.sandbox) return;

    electron.sandbox.onApprovalRequest((req: ApprovalRequest) => {
      setRequest(req);
      setStreamLines([]);
      setRunning(false);
    });

    electron.sandbox.onStream((event: StreamEvent) => {
      if (event.type === 'commandStart') {
        setStreamLines([]);
        setRunning(true);
      } else if (event.type === 'stdout' && event.line) {
        setStreamLines(prev => [...prev.slice(-200), { type: 'stdout', line: event.line! }]);
      } else if (event.type === 'stderr' && event.line) {
        setStreamLines(prev => [...prev.slice(-200), { type: 'stderr', line: event.line! }]);
      } else if (event.type === 'commandEnd') {
        setRunning(false);
      }
    });
  }, []);

  const handleAllow = async () => {
    const electron = (window as any).electron;
    await electron?.sandbox?.approvalResponse(true);
    setRequest(null);
  };

  const handleDeny = async () => {
    const electron = (window as any).electron;
    await electron?.sandbox?.approvalResponse(false);
    setRequest(null);
    setStreamLines([]);
  };

  if (!request && streamLines.length === 0 && !running) return null;

  const style = request ? RISK_STYLES[request.riskLevel] : RISK_STYLES.safe;

  return (
    <div className="mb-3 space-y-2">
      {/* Approval card */}
      {request && (
        <div className={`${style.bg} ${style.border} border rounded-xl p-3 animate-slideIn`}>
          <div className="flex items-start gap-2 mb-2">
            {style.icon}
            <div className="flex-1 min-w-0">
              <p className={`${style.text} text-[11px] font-medium uppercase tracking-wider`}>
                Sandbox Command — {request.riskLevel}
              </p>
              <p className="text-white/80 text-[13px] mt-0.5">{request.description}</p>
            </div>
          </div>
          <div className="bg-black/30 border border-white/10 rounded-lg px-2.5 py-1.5 mb-2">
            <code className="text-[11px] text-white/70 font-mono break-all">{request.command}</code>
          </div>
          {request.reason && (
            <p className="text-white/40 text-[10px] mb-2 italic">{request.reason}</p>
          )}
          <div className="flex gap-1.5 justify-end">
            <button
              onClick={handleDeny}
              className="px-3 py-1 text-xs rounded-lg bg-white/5 border border-white/10 text-white/70 hover:bg-red-500/15 hover:border-red-500/30 hover:text-red-300 transition-all cursor-pointer"
            >
              Deny
            </button>
            <button
              onClick={handleAllow}
              disabled={request.riskLevel === 'blocked'}
              className="px-3 py-1 text-xs rounded-lg bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/30 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Allow
            </button>
          </div>
        </div>
      )}

      {/* Streaming output */}
      {(streamLines.length > 0 || running) && (
        <div className="bg-black/40 border border-white/10 rounded-xl p-2 animate-slideIn">
          <div className="flex items-center justify-between mb-1 px-1">
            <span className="text-[10px] text-white/40 uppercase tracking-wider">
              {running ? 'Running…' : 'Output'}
            </span>
            {running && (
              <span className="flex gap-0.5">
                <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse" />
                <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse" style={{ animationDelay: '150ms' }} />
                <span className="w-1 h-1 bg-emerald-400 rounded-full animate-pulse" style={{ animationDelay: '300ms' }} />
              </span>
            )}
          </div>
          <pre className="text-[10px] font-mono text-white/70 max-h-[160px] overflow-y-auto whitespace-pre-wrap">
            {streamLines.map((l, i) => (
              <div key={i} className={l.type === 'stderr' ? 'text-red-400/80' : ''}>{l.line}</div>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}
