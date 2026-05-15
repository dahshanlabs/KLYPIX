import { useState, useRef, useCallback } from 'react';
import { ClaudeAgent, type AgentStep, type AgentCallbacks } from '../core/agent/claudeAgent';
import { CostTracker, type CostSummary } from '../core/agent/costTracker';
import { type PermissionRequest } from '../core/agent/permissions';
import { agentSessionManager } from '../core/agent/agentSession';
import { setSandboxAvailable } from '../core/agent/toolRegistry';
import type { PlanStep, ExecutionPlan, ProgressCheckpoint } from '../core/agent/types';

export type AgentState = 'idle' | 'routing' | 'running' | 'waiting_permission' | 'waiting_user_answer' | 'done' | 'stopped' | 'error';

export interface UserQuestion {
  question: string;
  options?: string[];
}

export interface AgentFile {
  path: string;
  name: string;
  format: string;
  size?: number;
  source: 'generate_document' | 'write_file' | 'run_shell';
}

export function useClaudeAgent() {
  const [state, setState] = useState<AgentState>('idle');
  const [steps, setSteps] = useState<AgentStep[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [cost, setCost] = useState<CostSummary | null>(null);
  const [permissionRequest, setPermissionRequest] = useState<PermissionRequest | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [producedFiles, setProducedFiles] = useState<AgentFile[]>([]);
  const previousFilesRef = useRef<AgentFile[]>([]); // Persists across runs for follow-ups

  // Orchestrator state (additive — existing return values unchanged)
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [synthesisState, setSynthesisState] = useState<'idle' | 'synthesizing' | 'done'>('idle');

  // ask_user state
  const [userQuestion, setUserQuestion] = useState<UserQuestion | null>(null);
  const userAnswerResolverRef = useRef<((answer: string) => void) | null>(null);

  const agentRef = useRef<ClaudeAgent | null>(null);
  const permissionResolverRef = useRef<((result: any) => void) | null>(null);

  const startAgent = useCallback(
    async (
      prompt: string,
      screenshot: string | null,
      windowContext: any,
      extraImages?: string[],
    ): Promise<void> => {
      // Save previous session files for follow-up awareness
      if (producedFiles.length > 0) {
        previousFilesRef.current = [...previousFilesRef.current, ...producedFiles];
      }
      setState('routing');
      setSteps([]);
      setStreamingText('');
      setErrorMessage('');
      setCost(null);
      setProducedFiles([]);
      setPlanSteps([]);
      setCurrentStepIndex(0);
      setSynthesisState('idle');

      try {
        // Step 1: Tier check
        const user = await (window as any).electron?.auth?.getUser();
        if (user?.tier === 'free') {
          throw new Error('Agent mode requires Pro tier or higher');
        }

        // Step 2: Get API key for configured provider
        const provider = localStorage.getItem('klypix:agentProvider') || 'claude';
        let apiKey: string | null = null;
        if (provider === 'gemini') {
          // Check all possible Gemini key locations, including hardcoded fallback
          apiKey = localStorage.getItem('gemini_api_key')
            || await (window as any).electron?.apiKey?.get()
            || 'AIzaSyD4ETYT7RkSLt_sE_U6ltBz0a2CdFFx5pg'; // Fallback key (same as chat)
        } else if (provider === 'deepseek') {
          apiKey = await (window as any).electron?.deepseekKey?.get();
        } else {
          apiKey = await (window as any).electron?.claudeKey?.get();
        }
        if (!apiKey) {
          const names: Record<string, string> = { claude: 'Claude', gemini: 'Gemini', openai: 'OpenAI', glm: 'GLM', deepseek: 'DeepSeek' };
          throw new Error(`No ${names[provider] || provider} API key. Add it in Settings → Agent Engine.`);
        }

        // Step 3: Check budget
        if (CostTracker.isOverBudget()) {
          const spend = CostTracker.getDailyBudget();
          throw new Error(`Daily budget exceeded ($${spend.toFixed(2)})`);
        }

        // Step 5: Check agent enabled
        const isEnabled = await (window as any).electron?.agentSettings?.getEnabled?.();
        if (isEnabled === false) {
          throw new Error('Agent mode is disabled in settings');
        }

        // Step 5b: Check sandbox availability and register sandbox tools
        try {
          const sandboxStatus = await (window as any).electron?.sandbox?.getStatus?.();
          if (sandboxStatus?.available) {
            setSandboxAvailable(true);
            console.log('[useClaudeAgent] Sandbox tools registered (WSL2 available)');
          }
        } catch { /* sandbox not available */ }

        // Step 6: Start agent
        setState('running');
        agentSessionManager.start(prompt);

        // Get configured provider from settings
        const savedProvider = localStorage.getItem('klypix:agentProvider') || 'claude';
        // Provider-specific model override (e.g. DeepSeek lets user pick V4-Pro vs V4-Flash).
        // Migrate V3-era IDs that DeepSeek silently routes to v4-flash.
        let savedModelId: string | undefined;
        if (savedProvider === 'deepseek') {
          const raw = localStorage.getItem('klypix:deepseekModel');
          savedModelId = raw === 'deepseek-reasoner' ? 'deepseek-v4-pro'
            : raw === 'deepseek-chat' ? 'deepseek-v4-flash'
            : (raw || 'deepseek-v4-pro');
        }
        const agent = new ClaudeAgent(apiKey, savedProvider as any, savedModelId);
        // Sync trust mode from UI state to agent's permission manager
        const savedTrust = localStorage.getItem('klypix:trustMode') === '1';
        if (savedTrust) agent.getPermissions().setTrustMode(true);

        // Enable hybrid routing if both Claude and Gemini keys are available
        const hybridEnabled = localStorage.getItem('klypix:hybridRouter') !== '0'; // enabled by default
        if (hybridEnabled) {
          try {
            const claudeKey = await (window as any).electron?.claudeKey?.get();
            const geminiKey = localStorage.getItem('gemini_api_key')
              || await (window as any).electron?.apiKey?.get()
              || 'AIzaSyD4ETYT7RkSLt_sE_U6ltBz0a2CdFFx5pg';
            if (claudeKey && geminiKey) {
              agent.enableHybridRouter(claudeKey, geminiKey);
            }
          } catch (err) {
            console.log('[useClaudeAgent] Hybrid router not available (missing keys):', err);
          }
        }

        agentRef.current = agent;

        // Expose router metrics on window for dev console: window.klypixRouterMetrics()
        (window as any).klypixRouterMetrics = () => {
          const router = agentRef.current?.getHybridRouter();
          if (!router) { console.log('[Router] Not active — hybrid router is disabled or no keys'); return null; }
          const m = router.getMetrics();
          const last = router.getLastClassification();
          console.table({
            'Total turns': m.totalTurns,
            'Flash turns': m.flashTurns,
            'Claude turns': m.claudeTurns,
            'Escalations': m.escalations,
            'Retries': m.retries,
            'Session cost': `$${m.totalCostUSD.toFixed(4)}`,
            'Flash %': m.totalTurns > 0 ? `${Math.round((m.flashTurns / m.totalTurns) * 100)}%` : 'N/A',
          });
          if (last) console.log('[Router] Last classification:', last);
          return m;
        };

        let currentTurnText = '';
        let allTurnsText = ''; // Full text for final commit
        let finalSummaryText = ''; // Only the Phase 4 summary (for orchestrated mode)
        let inFinalSummary = false;
        let turnHasToolUse = false; // Track if current turn called tools (intermediate = suppress)

        const callbacks: AgentCallbacks = {
          onStep: (step) => {
            setSteps(prev => [...prev, step]);
            agentSessionManager.addStep(step);
            // New turn starts — reset current turn text so only latest status shows
            if (step.type === 'thinking') {
              currentTurnText = '';
              turnHasToolUse = false;
              // Detect final summary phase in orchestrated mode
              if (step.description?.includes('Generating summary')) {
                inFinalSummary = true;
                finalSummaryText = '';
              }
            }
            // Mark current turn as having tool use — its narration is intermediate
            // Clear the streaming text since this turn is just tool execution, not a final answer
            if (step.type === 'tool_call') {
              turnHasToolUse = true;
              setStreamingText('');
            }
            // Track files produced by agent
            if (step.type === 'tool_result' && step.status === 'completed' && step.result) {
              try {
                const parsed = JSON.parse(step.result);
                if (step.toolName === 'generate_document' && parsed.path) {
                  const ext = parsed.path.split('.').pop() || '';
                  setProducedFiles(prev => [...prev, {
                    path: parsed.path, name: parsed.path.split(/[/\\]/).pop() || `generated.${ext}`,
                    format: ext, size: parsed.size, source: 'generate_document',
                  }]);
                } else if (step.toolName === 'write_file' && parsed.success && parsed.path) {
                  const ext = parsed.path.split('.').pop() || '';
                  const docExts = ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'md', 'json', 'html'];
                  if (docExts.includes(ext)) {
                    setProducedFiles(prev => [...prev, {
                      path: parsed.path, name: parsed.path.split(/[/\\]/).pop() || `file.${ext}`,
                      format: ext, size: parsed.size, source: 'write_file',
                    }]);
                  }
                }
              } catch {}
            }
          },
          onTextDelta: (delta) => {
            currentTurnText += delta;
            allTurnsText += delta;
            if (inFinalSummary) finalSummaryText += delta;
            // Strip scratchpad XML from Flash hardened prompts before showing to user
            const cleanText = currentTurnText
              .replace(/<scratchpad>[\s\S]*?<\/scratchpad>\s*/g, '')
              .replace(/<scratchpad>[\s\S]*/g, ''); // partial (still streaming)
            // Only show text to user if this is the final summary OR a text-only turn (no tool calls).
            // Intermediate turns that call tools are just narration — suppress them.
            if (inFinalSummary || !turnHasToolUse) {
              setStreamingText(cleanText);
            }
            // If this turn already used tools, show a brief status instead
            // (the WorkflowPanel shows tool details, so the main area stays clean)
          },
          onTextComplete: (_text) => {
            // Current turn text already set via deltas
          },
          onAskUser: async (question, options) => {
            setUserQuestion({ question, options });
            setState('waiting_user_answer');
            return new Promise<string>((resolve) => {
              userAnswerResolverRef.current = resolve;
            });
          },
          onPermissionRequest: async (req) => {
            setPermissionRequest(req);
            setState('waiting_permission');
            return new Promise((resolve) => {
              permissionResolverRef.current = resolve;
            });
          },
          onComplete: (finalSteps, finalCost) => {
            setCost(finalCost);
            setSteps(finalSteps);
            // Show ONLY the last turn's text (the actual answer), not all accumulated chatter.
            // For orchestrated mode, prefer finalSummaryText. For legacy loop, use currentTurnText.
            // Fall back to allTurnsText only if nothing else is available.
            const rawFinal = finalSummaryText || currentTurnText || allTurnsText;
            let cleanFinal = rawFinal
              .replace(/<scratchpad>[\s\S]*?<\/scratchpad>\s*/g, '')  // strip scratchpad
              .replace(/```python[\s\S]*?```\s*/g, '')                // strip Python code blocks
              .replace(/```[\s\S]*?```\s*/g, '')                      // strip any code blocks
              .replace(/import\s+pandas[\s\S]{0,500}?(?=\n\n|\n[A-Z])/g, '') // strip inline Python
              .replace(/^\s*Step\s+\d+:.*$/gm, '')                    // strip "Step N:" narration
              .replace(/\n{3,}/g, '\n\n')                             // collapse blank lines
              .trim();
            // If cleaning stripped everything, try allTurnsText with lighter cleaning
            if (!cleanFinal && allTurnsText.trim()) {
              cleanFinal = allTurnsText
                .replace(/<scratchpad>[\s\S]*?<\/scratchpad>\s*/g, '')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
            }
            // Still empty? Show a minimal completion message
            if (!cleanFinal) {
              cleanFinal = 'Task completed.';
            }
            setStreamingText(cleanFinal);
            CostTracker.addSessionSpend(finalCost.estimatedCost);
            CostTracker.addDailySpend(finalCost.estimatedCost);
            (window as any).electron?.agentSettings?.addDailySpend?.(finalCost.estimatedCost);
            agentSessionManager.complete(cleanFinal, finalCost, 'completed');
            setState('done');

            // ── Memory: end-of-session extraction (fire-and-forget, gated by isMemoryEnabled) ──
            (async () => {
              try {
                const { isMemoryEnabled } = await import('../services/memory');
                if (!isMemoryEnabled()) return;
                const { getMemoryManager } = await import('../services/memory');
                const mgr = getMemoryManager();
                await mgr.runSessionEndExtraction([
                  { role: 'user', content: prompt },
                  { role: 'assistant', content: cleanFinal },
                ]);
              } catch (err) {
                console.warn('[useClaudeAgent] Memory extraction failed:', err);
              }
            })();
          },
          onError: (error, partialCost) => {
            setErrorMessage(error);
            if (partialCost) {
              setCost(partialCost);
              // Burn the partial spend so the daily-budget bar reflects what failed runs cost too.
              if (partialCost.estimatedCost > 0) {
                CostTracker.addSessionSpend(partialCost.estimatedCost);
                CostTracker.addDailySpend(partialCost.estimatedCost);
                (window as any).electron?.agentSettings?.addDailySpend?.(partialCost.estimatedCost);
              }
            }
            agentSessionManager.complete('', partialCost, 'error');
            setState('error');
          },
          // Orchestrator callbacks (only fired for weak models)
          onPlanGenerated: (plan: ExecutionPlan) => {
            setPlanSteps(plan.steps);
            setCurrentStepIndex(0);
            agentSessionManager.setPlan?.(plan);
          },
          onStepProgress: (stepId: number, status: PlanStep['status']) => {
            setPlanSteps(prev => prev.map(s =>
              s.id === stepId ? { ...s, status } : s
            ));
            const idx = planSteps.findIndex(s => s.id === stepId);
            if (idx >= 0) setCurrentStepIndex(idx);
            agentSessionManager.updateStepStatus?.(stepId, status);
          },
          onProgressCheckpoint: (_checkpoint: ProgressCheckpoint) => {
            // Available for WorkflowPanel to show progress previews
          },
        };

        // Inject previous file context for follow-up awareness
        let enrichedPrompt = prompt;
        if (previousFilesRef.current.length > 0) {
          const fileList = previousFilesRef.current
            .map(f => `- ${f.name} (${f.format}) at: ${f.path}`)
            .join('\n');
          enrichedPrompt = `${prompt}\n\n[CONTEXT: Previously created files in this session:\n${fileList}\nIf the user asks to modify/update a file, read the existing file first using read_file, then create an updated version. For binary formats (docx/xlsx/pptx/pdf), regenerate with generate_document incorporating changes. Save updated files with _v2, _v3 suffix to preserve originals.]`;
        }

        await agent.run(enrichedPrompt, screenshot, windowContext, callbacks, extraImages);
      } catch (error: any) {
        setErrorMessage(error.message);
        setState('error');
      }
    },
    [streamingText],
  );

  const approvePermission = useCallback((scope: 'once' | 'session' | 'path', pathPattern?: string) => {
    if (permissionResolverRef.current) {
      permissionResolverRef.current({ decision: 'allow', scope, pathPattern });
      permissionResolverRef.current = null;
      setPermissionRequest(null);
      setState('running');
    }
  }, []);

  const denyPermission = useCallback(() => {
    if (permissionResolverRef.current) {
      permissionResolverRef.current({ decision: 'deny', scope: 'once' });
      permissionResolverRef.current = null;
      setPermissionRequest(null);
      setState('running');
    }
  }, []);

  const abort = useCallback(() => {
    agentRef.current?.abort();
    // Use 'stopped' state so the UI can show a clear "Stopped by user" badge
    // instead of either silently disappearing (state='idle') or looking like an
    // error ('error' state shows red Agent Stopped panel meant for crashes).
    setState('stopped');
  }, []);

  // Reset agent state — clears the card from UI
  // Soft reset — clears UI state but keeps file history for follow-ups
  const reset = useCallback(() => {
    setState('idle');
    setSteps([]);
    setStreamingText('');
    setCost(null);
    setPermissionRequest(null);
    setErrorMessage('');
    setProducedFiles([]);
    setPlanSteps([]);
    setCurrentStepIndex(0);
    setSynthesisState('idle');
    agentRef.current = null;
  }, []);

  // Hard reset — clears everything including file history (used on CLEAR)
  const clearHistory = useCallback(() => {
    reset();
    previousFilesRef.current = [];
  }, [reset]);

  // Send a follow-up message to the running agent
  const sendFollowUp = useCallback((message: string) => {
    if (agentRef.current && state === 'running') {
      agentRef.current.injectUserMessage(message);
    }
  }, [state]);

  // Sync trust mode to running agent in real-time
  const setTrustMode = useCallback((enabled: boolean) => {
    localStorage.setItem('klypix:trustMode', enabled ? '1' : '0');
    // If agent is running, update its PermissionManager immediately
    if (agentRef.current) {
      agentRef.current.getPermissions().setTrustMode(enabled);
    }
  }, []);

  // Answer an ask_user question from the agent
  const answerQuestion = useCallback((answer: string) => {
    if (userAnswerResolverRef.current) {
      userAnswerResolverRef.current(answer);
      userAnswerResolverRef.current = null;
    }
    setUserQuestion(null);
    setState('running');
  }, []);

  // Expose router metrics for dev UI
  const getRouterMetrics = useCallback(() => {
    return agentRef.current?.getHybridRouter()?.getMetrics() ?? null;
  }, []);

  return {
    state, steps, streamingText, cost, permissionRequest, errorMessage, producedFiles,
    userQuestion, answerQuestion,
    startAgent, approvePermission, denyPermission, abort, reset, clearHistory, setTrustMode, sendFollowUp,
    // Orchestrator state (additive)
    planSteps,
    currentStepIndex,
    synthesisState,
    // Hybrid router metrics
    getRouterMetrics,
  };
}
