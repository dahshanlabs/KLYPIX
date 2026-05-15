import React, { useEffect, useRef, useState } from 'react';
import type { AgentStep } from '../core/agent/claudeAgent';
import type { CostSummary } from '../core/agent/costTracker';
import { useNarration } from '../hooks/useNarration';

function AnimatedDots() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setCount(prev => (prev + 1) % 4);
    }, 400);
    return () => clearInterval(interval);
  }, []);
  // Fixed-width: always render 3 chars, hide inactive dots with opacity
  return (
    <span style={{ fontFamily: 'monospace', letterSpacing: 1 }}>
      {[0, 1, 2].map(i => (
        <span key={i} style={{ opacity: i < count ? 1 : 0 }}>.</span>
      ))}
    </span>
  );
}

interface RouterMetrics {
  totalTurns: number;
  flashTurns: number;
  claudeTurns: number;
  escalations: number;
  retries: number;
  totalCostUSD: number;
}

interface WorkflowPanelProps {
  steps: AgentStep[];
  cost: CostSummary | null;
  isRunning: boolean;
  /** True when the user pressed Stop. Shown in header instead of "Complete". */
  wasStopped?: boolean;
  onAbort: () => void;
  trustMode: boolean;
  onTrustModeChange: (enabled: boolean) => void;
  onFollowUp?: (message: string) => void;
  fileCount?: number;
  routerMetrics?: RouterMetrics | null;
}

const STATUS_ICON: Record<string, string> = {
  pending: '\u2026', running: '\u25B6', completed: '\u2713',
  denied: '\u2717', error: '!', waiting_permission: '?',
};

export const WorkflowPanel: React.FC<WorkflowPanelProps> = ({
  steps, cost, isRunning, wasStopped = false, onAbort, trustMode, onTrustModeChange, onFollowUp, fileCount = 0, routerMetrics,
}) => {
  const narration = useNarration();
  const [followUpText, setFollowUpText] = useState('');
  const [collapsed, setCollapsed] = useState(true); // Collapsed by default
  const scrollRef = useRef<HTMLDivElement>(null);
  const [elapsed, setElapsed] = useState(0);
  const startTimeRef = useRef(Date.now());

  useEffect(() => {
    if (isRunning) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      const interval = setInterval(() => {
        setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [isRunning]);

  useEffect(() => {
    if (scrollRef.current && !collapsed) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [steps, collapsed]);

  const formatTime = (s: number) => {
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const liveTokens = cost
    ? { input: cost.inputTokens, output: cost.outputTokens, total: cost.totalTokens }
    : { input: 0, output: 0, total: 0 };

  return (
    <div className="flex flex-col glass rounded-xl border border-emerald-500/20 overflow-hidden">
      {/* Header — always visible */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-white/10 cursor-pointer select-none"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="flex items-center gap-2">
          {/* Terminal icon with cursor blink when working */}
          <div className={`w-5 h-5 flex items-center justify-center rounded ${isRunning ? 'text-purple-400' : 'text-gray-500'}`}>
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 4L6 7L2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="7" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                {isRunning && <animate attributeName="opacity" values="1;0.3;1" dur="1s" repeatCount="indefinite" />}
              </line>
            </svg>
          </div>
          <div className="flex flex-col">
            <span className={`text-sm font-medium leading-tight ${wasStopped ? 'text-amber-300' : 'text-white'}`}>
              {isRunning ? (
                <>Agent Working<span className="inline-flex w-[18px]" style={{ fontFamily: 'monospace' }}><AnimatedDots /></span></>
              ) : wasStopped ? (
                'Agent Stopped'
              ) : 'Agent Complete'}
            </span>
            <div className="flex items-center gap-2 text-[10px] font-mono text-gray-500 leading-tight">
              <span className={isRunning ? 'text-purple-400' : 'text-gray-500'}>{formatTime(elapsed)}</span>
              <span>&middot;</span>
              <span>{liveTokens.total.toLocaleString()} tok</span>
              {fileCount > 0 && (
                <>
                  <span>&middot;</span>
                  <span className="text-purple-400">{fileCount} file{fileCount > 1 ? 's' : ''}</span>
                </>
              )}
              {cost && (
                <>
                  <span>&middot;</span>
                  <span className="text-emerald-400">${cost.estimatedCost.toFixed(4)}</span>
                </>
              )}
            </div>
            {/* Narrator line — fire-and-forget Gemini Flash status between turns. */}
            {/* Only shown while running; clears on session end. Silent if narration timed out. */}
            {isRunning && narration && (
              <span className="text-[10px] italic text-purple-300/70 leading-tight mt-0.5 truncate max-w-[280px]" title={narration}>
                {narration}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2" onClick={e => e.stopPropagation()}>
          <label className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-colors ${
            trustMode ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40' : 'bg-white/5 text-gray-500 border border-white/10'
          }`}>
            <input type="checkbox" checked={trustMode} onChange={e => onTrustModeChange(e.target.checked)}
              className="w-3 h-3 accent-amber-500" />
            Trust
          </label>
          {/* Collapse chevron */}
          <button
            onClick={(e) => { e.stopPropagation(); setCollapsed(!collapsed); }}
            className="p-1 text-gray-500 hover:text-white transition-colors"
            title={collapsed ? 'Expand console' : 'Collapse console'}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" className={`transition-transform ${collapsed ? 'rotate-180' : ''}`}>
              <path d="M2 4 L6 8 L10 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
          {isRunning && (
            <button
              onClick={onAbort}
              className="text-xs px-2.5 py-1 rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30 transition-colors"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Collapsible body */}
      {!collapsed && (
        <>
          {/* Steps */}
          <div ref={scrollRef} className="overflow-y-auto px-4 py-2 space-y-1.5" style={{ maxHeight: 180 }}>
            {steps.filter(s => {
              // Show orchestrator status steps (descriptive text like "Planning task...", "Step 2: Read source...")
              // Hide generic legacy-loop "Turn N" entries (those are just loop counters)
              if (s.type === 'thinking') return s.description && !s.description.match(/^Turn \d+$/);
              return true;
            }).map((step, idx) => (
              <div key={`${step.id}_${idx}`} className={`flex items-start gap-2 text-xs ${step.type === 'text' && step.description?.startsWith('User:') ? 'bg-purple-500/10 rounded-lg px-2 py-1.5 -mx-2 border border-purple-500/20' : ''}`}>
                <span className="flex-shrink-0 w-4 text-center font-mono opacity-70">
                  {step.type === 'text' && step.description?.startsWith('User:') ? '\uD83D\uDCAC' : (STATUS_ICON[step.status] || '\u2022')}
                </span>
                <div className="flex-1 min-w-0">
                  <span className={
                    step.type === 'text' && step.description?.startsWith('User:') ? 'text-purple-300 font-medium' :
                    step.status === 'completed' ? 'text-gray-400' :
                    step.status === 'running' ? 'text-emerald-400' :
                    step.status === 'denied' ? 'text-red-400' :
                    step.status === 'error' ? 'text-red-400' :
                    step.status === 'waiting_permission' ? 'text-yellow-400' :
                    'text-gray-300'
                  }>
                    {step.toolName && (
                      <span className="font-mono text-[10px] bg-white/5 px-1 rounded mr-1.5">{step.toolName}</span>
                    )}
                    {/* Hybrid Router: show model badge for routed turns */}
                    {step.description?.includes('[flash]') && (
                      <span className="text-[9px] font-bold bg-amber-500/20 text-amber-400 px-1 rounded mr-1.5">⚡ FLASH</span>
                    )}
                    {step.description?.includes('[claude]') && (
                      <span className="text-[9px] font-bold bg-purple-500/20 text-purple-300 px-1 rounded mr-1.5">🧠 CLAUDE</span>
                    )}
                    {(step.description || step.type).replace(/\s*\[(flash|claude)\]/g, '')}
                  </span>
                  {step.result && step.type === 'tool_result' && (
                    <p className="text-[10px] text-gray-500 truncate mt-0.5">{step.result.slice(0, 120)}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Follow-up input */}
          {isRunning && onFollowUp && (
            <div className="px-3 py-2 border-t border-white/10">
              <form onSubmit={e => {
                e.preventDefault();
                if (followUpText.trim()) {
                  onFollowUp(followUpText.trim());
                  setFollowUpText('');
                }
              }} className="flex gap-2">
                <input
                  type="text"
                  value={followUpText}
                  onChange={e => setFollowUpText(e.target.value)}
                  placeholder="Tell agent something..."
                  className="flex-1 px-3 py-1.5 bg-purple-500/5 border border-purple-500/20 rounded-lg text-xs text-white placeholder-purple-300/30 focus:outline-none focus:border-purple-500/40 transition-colors"
                />
                <button
                  type="submit"
                  disabled={!followUpText.trim()}
                  className="px-3 py-1.5 bg-purple-500/20 border border-purple-500/30 rounded-lg text-xs text-purple-300 hover:bg-purple-500/30 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Send
                </button>
              </form>
            </div>
          )}
        </>
      )}

      {/* Footer — only in/out tokens, no duplicate time/cost */}
      {cost && !isRunning && (
        <div className="px-4 py-1.5 border-t border-white/10 text-[10px] text-gray-500 font-mono text-center">
          {cost.inputTokens.toLocaleString()} in / {cost.outputTokens.toLocaleString()} out &middot; {cost.turns} turns
        </div>
      )}
      {/* Hybrid Router stats */}
      {routerMetrics && !isRunning && routerMetrics.totalTurns > 0 && (
        <div className="px-4 py-1.5 border-t border-white/10 text-[10px] font-mono text-center flex items-center justify-center gap-2">
          <span className="text-amber-400">⚡ {routerMetrics.flashTurns}</span>
          <span className="text-gray-600">/</span>
          <span className="text-purple-300">🧠 {routerMetrics.claudeTurns}</span>
          {routerMetrics.escalations > 0 && (
            <span className="text-orange-400">↑{routerMetrics.escalations} esc</span>
          )}
          <span className="text-gray-600">·</span>
          <span className="text-emerald-400">${routerMetrics.totalCostUSD.toFixed(4)}</span>
          <span className="text-gray-600">router</span>
        </div>
      )}
    </div>
  );
};
