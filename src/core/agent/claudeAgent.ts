import { executeTool } from './toolExecutor';
import { PermissionManager, type PermissionRequest } from './permissions';
import { CostTracker, type CostSummary } from './costTracker';
import { getClaudeTools, getAllTools, setMCPTools } from './toolRegistry';
import { getMCPTools } from './mcpBridge';
import type { ModelAdapter, AgentModelProvider } from './modelAdapter';
import { createAdapter } from './adapters';
import { getModelProfile } from './modelProfiles';
import { Orchestrator } from './orchestrator';
import { Validator } from './validator';
import { checkpointManager } from './checkpoint';
import { sessionLearning } from './sessionLearning';
import { allocateModels, createEscalationPolicy } from './modelAllocator';
import { agentSessionManager } from './agentSession';
import { startNarrationSession, dispatchNarration } from './narrator';
import type { ExecutionPlan, PlanStep, ProgressCheckpoint, SynthesizedBrief } from './types';
import { HybridRouter, AGENT_MODE_CONFIG } from '../../services/router';
import type { ToolCallResult, FlashAttempt, RouterMessage } from '../../services/router';

const MAX_TURNS = 25;
const TOOL_TIMEOUT = 60000; // 60s — sandbox Python scripts need more time

export interface AgentStep {
  id: string;
  type: 'thinking' | 'tool_call' | 'tool_result' | 'permission' | 'text' | 'error';
  toolName?: string;
  toolInput?: Record<string, any>;
  result?: string;
  status: 'pending' | 'running' | 'waiting_permission' | 'completed' | 'denied' | 'error';
  description?: string;
  timestamp: number;
}

export interface AgentCallbacks {
  onStep: (step: AgentStep) => void;
  onTextDelta: (delta: string) => void;
  onTextComplete: (fullText: string) => void;
  onPermissionRequest: (req: PermissionRequest) => Promise<{
    decision: 'allow' | 'deny';
    scope: 'once' | 'session' | 'path';
    pathPattern?: string;
  }>;
  onAskUser?: (question: string, options?: string[]) => Promise<string>;
  onComplete: (steps: AgentStep[], cost: CostSummary) => void;
  /** Cost is the partial summary at the moment of failure — useful so the UI can show what an aborted run actually consumed. */
  onError: (error: string, cost?: CostSummary) => void;
  /** Orchestrator: plan was generated */
  onPlanGenerated?: (plan: ExecutionPlan) => void;
  /** Orchestrator: step status changed */
  onStepProgress?: (stepId: number, status: PlanStep['status']) => void;
  /** Orchestrator: progress checkpoint for preview UI */
  onProgressCheckpoint?: (checkpoint: ProgressCheckpoint) => void;
}

export class ClaudeAgent {
  private adapter: ModelAdapter;
  private permissions = new PermissionManager();
  private costTracker = new CostTracker();
  private aborted = false;
  private synthesisRouted = false; // set true once we route a final-synthesis turn to Claude

  // Hybrid router: routes turns between Flash (cheap) and Claude (powerful)
  private hybridRouter: HybridRouter | null = null;
  private flashAdapter: ModelAdapter | null = null;
  private claudeAdapter: ModelAdapter | null = null;

  constructor(apiKey: string, provider: AgentModelProvider = 'claude', modelId?: string) {
    this.adapter = createAdapter(provider, apiKey, modelId);
    this.costTracker.setModel(this.adapter.modelId);
  }

  /**
   * Enable hybrid routing. Creates both a Flash and Claude adapter.
   * The router decides per-turn which to use (Flash for simple, Claude for complex).
   * Call this after construction but before run().
   */
  enableHybridRouter(claudeApiKey: string, geminiApiKey: string): void {
    this.claudeAdapter = createAdapter('claude', claudeApiKey);
    this.flashAdapter = createAdapter('gemini', geminiApiKey);
    this.hybridRouter = new HybridRouter(AGENT_MODE_CONFIG);
    console.log('[ClaudeAgent] Hybrid router enabled — Flash + Claude per-turn routing');
  }

  getHybridRouter(): HybridRouter | null { return this.hybridRouter; }

  private pendingUserMessage: string | null = null;

  abort(): void { this.aborted = true; }
  getPermissions(): PermissionManager { return this.permissions; }
  getCostTracker(): CostTracker { return this.costTracker; }

  /** Inject a follow-up message from the user mid-workflow. Will be sent on next turn. */
  injectUserMessage(message: string): void {
    this.pendingUserMessage = message;
  }

  async run(
    userPrompt: string,
    screenshotBase64: string | null,
    windowContext: any,
    callbacks: AgentCallbacks,
    extraImages?: string[],
  ): Promise<void> {
    this.aborted = false;
    this.synthesisRouted = false;
    // Bump narration session — invalidates any in-flight narrations from prior runs.
    startNarrationSession();
    const profile = getModelProfile(this.adapter.modelId);

    // Load MCP tools from connected servers (non-blocking)
    try {
      const mcpTools = await getMCPTools();
      if (mcpTools.length > 0) {
        setMCPTools(mcpTools);
        console.log(`[ClaudeAgent] Loaded ${mcpTools.length} MCP tools`);
      }
    } catch { /* MCP not available, continue with local tools */ }

    // GLM smart model selection: auto-upgrade to vision model if task has screenshot
    if (this.adapter.provider === 'glm' && screenshotBase64 && !profile.supportsVision) {
      console.log('[ClaudeAgent] Auto-upgrading GLM to glm-5v-turbo for vision task');
      try {
        const apiKey = await (window as any).electron?.claudeKey?.get();
        if (apiKey) {
          this.adapter = createAdapter('glm', apiKey, 'glm-5v-turbo');
          this.costTracker.setModel('glm-5v-turbo');
        }
      } catch (err) {
        console.log('[ClaudeAgent] GLM auto-upgrade failed, continuing with original model:', err);
      }
    }

    if (profile.reliableToolCalling && profile.planningCapability === 'strong') {
      // Claude, GPT-4o, GLM-5, GLM-5V-Turbo → proven legacy loop
      return this.runLegacy(userPrompt, screenshotBase64, windowContext, callbacks, extraImages);
    }

    // Gemini Flash, GLM-4.x, weaker models → orchestrated execution
    return this.runOrchestrated(userPrompt, screenshotBase64, windowContext, callbacks, extraImages);
  }

  // ══════════════════════════════════════════════════════════════════════
  // LEGACY LOOP — For strong models (Claude, GPT-4o, GLM-5)
  // Extracted from original run() method — kept EXACTLY as-is.
  // ══════════════════════════════════════════════════════════════════════

  private async runLegacy(
    userPrompt: string,
    screenshotBase64: string | null,
    windowContext: any,
    callbacks: AgentCallbacks,
    extraImages?: string[],
  ): Promise<void> {
    const steps: AgentStep[] = [];

    const hasImages = !!screenshotBase64 || (extraImages && extraImages.length > 0);
    const imageCount = (extraImages?.length || 0) + (screenshotBase64 ? 1 : 0);

    // ── Task-specific rule injection (gated to keep prompts short) ──
    // Detect if the user prompt involves data analysis or report generation; load the
    // relevant rules conditionally so we don't bloat every system prompt.
    const lcPrompt = userPrompt.toLowerCase();
    const isDataTask = /\b(spreadsheet|excel|csv|xlsx|data|column|row|sheet|workbook|analyze|analysis)\b/.test(lcPrompt);
    const isReportTask = /\b(executive|exec)\b.*\b(report|summary|review|brief|deck|presentation)\b/.test(lcPrompt)
      || /\b(report|summary|brief|deck|presentation)\b.*\b(pdf|docx|pptx|word|powerpoint)\b/.test(lcPrompt)
      || /\b(generate|create|produce|build|make)\b.*\b(pdf|report|executive\s+summary|exec\s+summary)\b/.test(lcPrompt);

    const dataAnalysisRules = isDataTask ? [
      '',
      'DATA ANALYSIS RULES (spreadsheets / CSV):',
      '1. SCAN for summary/total rows BEFORE calculating — empty description with numbers, "total/grand total/subtotal/sum" rows, bottom aggregate rows. REMOVE before calculations or you double-count.',
      '2. CROSS-VALIDATE totals — sum line items in Python and compare with any total row found. If mismatched, REPORT the discrepancy.',
      '3. CLEAN data first — drop empty rows, treat #REF!/#N/A as missing, trim whitespace, normalize case in categories, flag duplicates.',
    ].join('\n') : '';

    const reportRules = isReportTask ? [
      '',
      'EXECUTIVE REPORT GENERATION:',
      '⚠ ONE PDF ONLY — produce a SINGLE consolidated PDF with all sections (overview, charts, tables, insights). Do NOT split into multiple files unless the user explicitly says "separate files". If you have already called generate_document this session, do NOT call it again.',
      '⚠ FILENAME — derive from the topic ("sales summary" → sales_summary.pdf; "Q3 budget review" → q3_budget_review.pdf). Default to klypix_report.pdf. NEVER use ask_user for filenames. NEVER use placeholder names like "wwwww.pdf" or "output1.pdf".',
      '⚠ MATPLOTLIB — ALWAYS plt.savefig(absolute_path, dpi=180, bbox_inches=\'tight\'); plt.close(\'all\'). NEVER plt.show() — there is no display in the sandbox; it opens a popup the user must close.',
      '⚠ NUMBER FORMATTING — Currency: f"${value:,.2f}" → $2,558,650.00 (NEVER scientific notation like 2.55865e+06). Percentages: f"{value:.1f}%". Format in Python BEFORE building the markdown table.',
      '⚠ EMBED CHARTS — After saving N chart PNGs, your generate_document markdown MUST contain N image tags: ![Title](C:/Users/HP/Desktop/chart.png). Use absolute paths. Count check: 4 PNGs = 4 ![] lines.',
      'STRUCTURE (3 pages): P1 DASHBOARD (title + 3-4 KPI cards + primary chart with $ AND % labels + 2-3 sentence insight). P2 ANALYSIS (secondary chart + insight + TOP 5 table). P3 DETAILS (breakdown table with bold total row + 4-5 specific insight bullets + footer).',
      'CHART STYLING: palette #0f7b6c/#2d6a4f/#40916c/#52b788/#95d5b2; white bg, no grids, drop top/right spines; show $ values on bars; ≥9pt fonts, 12pt bold titles.',
      'WRITING: lead with NUMBERS. Every paragraph contains a $ or %. Replace "significant" with the actual figure. Compare categories ("Machinery is 2.4x larger than Buildings"). Flag anomalies. End with 1-2 actionable observations, NOT generic summaries.',
    ].join('\n') : '';

    // ── Memory injection — sync fast-path skips sql.js init when memory is OFF ──
    let memorySection = '';
    try {
      const { isMemoryEnabled } = await import('../../services/memory');
      if (isMemoryEnabled()) {
        const { getMemoryManager } = await import('../../services/memory');
        const mgr = getMemoryManager();
        const memories = await mgr.getRelevantMemories(userPrompt);
        if (memories.length > 0) {
          memorySection = mgr.formatForPrompt(memories);
        }
      }
    } catch (err) {
      console.warn('[ClaudeAgent] Memory injection failed (continuing without):', err);
    }

    const systemPrompt = [
      'You are KLYPIX, an AI agent running on the user\'s Windows desktop.',
      dataAnalysisRules,
      reportRules,
      'You can see the user\'s screen, read/write files, run shell commands, and automate their browser.',
      '',
      memorySection ? `USER MEMORY (use this to personalize your response):\n${memorySection}\n` : '',
      hasImages ? `ATTACHED SCREENSHOTS: ${imageCount} screenshot(s) are attached to this message. ALWAYS analyze these images FIRST before using any tools. The user is asking about what is visible in these screenshots. Describe what you see in detail. Do NOT say you cannot see images — you CAN, they are attached.` : '',
      '',
      'READING FILES ON SCREEN:',
      '- Try read_active_file FIRST — it reads via COM automation (works for Excel, PDF, cloud files).',
      '- If read_active_file FAILS (wrong window detected), use this fallback chain:',
      '  1. get_all_open_files → lists all open files with their originalTitle',
      '  2. read_file_by_title with the originalTitle from step 1 (e.g. "CapEx Budget 2025.xlsx - Excel")',
      '     This reads via COM automation using the window title — works even when the file path is unknown.',
      '- NEVER give up after one failed attempt. ALWAYS try the fallback chain.',
      '- Do NOT use read_file with guessed paths — use read_file_by_title instead.',
      '',
      'BEHAVIOR RULES:',
      '- If screenshots are attached, analyze them visually before reaching for tools.',
      '- Be proactive: use tools to get information rather than asking the user.',
      '- NEVER give up or ask the user to paste data. If one tool fails, try another approach.',
      '- NEVER say "I cannot access" — you have tools. Use them.',
      '- NEVER ask for confirmation before acting. If the user asked to analyze, just analyze. If you found a file, read it. DO NOT ask "would you like me to...?" — just DO IT.',
      '- NEVER stop mid-execution with "I will now..." or "Next I\'ll...". After reading a file, your NEXT response MUST include the next tool call. Text-only responses are only allowed after ALL tools have been called and the output file exists.',
      '- Between tool calls, give a SHORT status update (5-10 words max). Example: "Reading spreadsheet..." or "Creating document now..."',
      '- Do NOT narrate your thinking process. No "Let me check...", "I\'ll now try..." — just brief status.',
      '',
      'PREFER NATIVE TOOLS OVER SHELL:',
      '- For reading file content at a known path (PDF, DOCX, XLSX, TXT, CSV, MD, JSON, HTML) — use read_file. It already handles PDF text extraction.',
      '- For writing files — use write_file. For editing — use edit_file. For listing — use list_directory.',
      '- Do NOT write a Python script via run_shell or sandbox_run_python just to read or list a file. That is the wrong tool.',
      '- Only reach for run_shell / sandbox_run_python when the task genuinely needs code execution (data crunching, image generation, format conversion that no built-in tool covers).',
      '',
      'FAILURE RECOVERY (anti-loop):',
      '- If a tool returns an error, your next call MUST be different — different tool, or different arguments. Never repeat the same call with the same inputs.',
      '- If 2 attempts at the same goal have failed, STOP retrying. Switch strategy entirely (different tool category) or use ask_user to surface the blocker.',
      '- Especially: if run_shell fails because of a missing binary or PATH issue, do NOT retry the same command — the environment will not change. Use a built-in tool instead.',
      '',
      'FINAL RESPONSE FORMAT (after all tools are done):',
      '- Start with a ## Results header',
      '- Summarize what was accomplished in 2-3 bullet points',
      '- If files were created, list them with paths',
      '- If data was found, present key findings clearly',
      '- End with a ## Suggestions section — 2-3 actionable next steps the user might want',
      '- Use markdown formatting: headers, bold, bullet points, tables where appropriate',
      '- Do NOT include your intermediate status messages in the final response',
      '- Keep it concise and scannable',
      '',
      'DOCUMENT VERSIONING:',
      '- When asked to modify/update an existing file, ALWAYS read it first with read_file.',
      '- For text files (txt, md, html, csv, json): read → modify content → write_file to same path or _v2 path.',
      '- For binary docs (docx, xlsx, pptx, pdf): read to understand content → regenerate via generate_document with updates → save as filename_v2.ext to preserve original.',
      '- Never silently overwrite — use _v2, _v3 suffix unless user explicitly says "overwrite".',
      '- If user says "update the report" or "add X to the document", check the CONTEXT section for previously created file paths.',
      '',
      'CLARIFYING QUESTIONS (ask_user tool):',
      '- If the task is ambiguous and you GENUINELY cannot proceed, use ask_user to ask the user.',
      '- Provide 2-5 short chip options when possible so the user can tap instead of type.',
      '- Max 3 questions per session — use them wisely.',
      '- Do NOT ask obvious questions. If the data is on screen, read it. If the format is implied, pick the best one.',
      '- Good: "Which data to chart?" with options from the file columns.',
      '- Bad: "What format?" when the user already said PDF.',
      '',
      'IMPORTANT: Some shell commands are blocked by security policy. If blocked, try an alternative.',
      (() => {
        const env = (window as any).klypixEnv;
        const desktop = env?.desktop || `C:\\Users\\${env?.username || 'user'}\\Desktop`;
        const userprofile = env?.userprofile || `C:\\Users\\${env?.username || 'user'}`;
        const working = `${userprofile}\\AppData\\Roaming\\klypix\\working`;
        return [
          `FILE SAVING (strict — keep the user's Desktop CLEAN):`,
          `- FINAL deliverable (the ONE PDF/DOCX/PPTX the user asked for) → ${desktop}`,
          `- INTERMEDIATE scratch files (CSVs, Python scripts, working PNGs, debug dumps) → ${working}`,
          `- For sandbox work, prefer sandbox_write_file (writes inside WSL workspace, never touches Windows).`,
          `- Do NOT write more than ONE final file to Desktop per session. The user does not want their Desktop polluted with 4 CSVs and a PDF — only the PDF.`,
          `- Do NOT guess the username or run a shell command to find paths.`,
        ].join('\n');
      })(),
      '',
      // Sandbox capabilities — only if sandbox tools are available
      getAllTools().some(t => t.name.startsWith('sandbox_')) ? [
        'SANDBOX EXECUTION (WSL2 Linux environment available):',
        '- You have access to sandbox_execute, sandbox_write_file, sandbox_read_file, sandbox_run_python tools.',
        '- Python has: pandas, matplotlib, openpyxl, pdfplumber, tabulate pre-installed.',
        '',
        'WHEN TO USE SANDBOX:',
        '- Data processing, calculations, CSV/Excel analysis, text extraction, format conversion.',
        '- Generating chart IMAGES (PNG) with matplotlib when data needs visualization.',
        '',
        'CRITICAL SANDBOX RULES:',
        '- NEVER embed large data (CSV, JSON) directly inside Python scripts as string literals. That wastes tokens and breaks.',
        '- Instead: sandbox_write_file to save data as a .csv file → then write a small Python script that reads from that file.',
        '- Keep Python scripts SHORT — under 50 lines. Write data to files, scripts read from files.',
        '- Example: sandbox_write_file("data.csv", csvContent) → sandbox_write_file("chart.py", script) → sandbox_run_python("chart.py")',
        '',
        'COMBINED WORKFLOW (best results for reports with charts):',
        '1. sandbox_write_file: Save data as CSV/JSON file in workspace.',
        '2. sandbox_write_file: Write a SHORT Python script that reads the data file and generates chart PNGs (save to /home/klypix/workspace/shared/).',
        '3. sandbox_run_python: Execute the script.',
        '4. sandbox_save_to_shared: Copy each chart PNG to the shared folder.',
        '5. generate_document: Create the final PDF/DOCX with ![Chart Title](chart_filename.png) markdown to embed the charts.',
        '',
        'IMAGE EMBEDDING IN DOCUMENTS:',
        '- generate_document PDF supports ![alt text](path/to/image.png) markdown syntax ONLY.',
        '- Do NOT use <img src="..."> HTML tags — they will NOT render. Use ![alt](path) ONLY.',
        '- Use ABSOLUTE paths: ![Chart](C:/Users/HP/Desktop/chart.png)',
        '- If you save charts to Desktop, reference them with the full Desktop path in the markdown.',
        '- Example: "## Revenue\\n![Monthly Revenue](C:/Users/HP/Desktop/revenue_chart.png)\\n\\nThe chart shows..."',
        '',
        'KEEP USING generate_document FOR:',
        '- Creating PPTX presentations, DOCX reports, XLSX spreadsheets, PDF documents.',
        '- generate_document is your primary output tool — sandbox ENHANCES it with data processing and chart generation.',
      ].join('\n') : '',
      windowContext ? `Active window: ${windowContext.title || windowContext.windowTitle} (${windowContext.process || windowContext.processName})` : '',
    ].filter(Boolean).join('\n');

    // Build initial message
    const userContent: any[] = [];
    // Add extra images first (earlier screenshots in the stack)
    if (extraImages && extraImages.length > 0) {
      for (const img of extraImages) {
        const mt = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
        userContent.push({ type: 'image', source: { type: 'base64', media_type: mt, data: img } });
      }
    }
    // Add primary screenshot (most recent)
    if (screenshotBase64) {
      const mediaType = screenshotBase64.startsWith('/9j/') ? 'image/jpeg'
        : screenshotBase64.startsWith('iVBOR') ? 'image/png'
        : 'image/jpeg';
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: screenshotBase64 },
      });
    }
    userContent.push({ type: 'text', text: userPrompt });

    const messages: any[] = [{ role: 'user', content: userContent }];

    // === THE AGENT LOOP (legacy — proven path for strong models) ===
    // Track Flash attempts for escalation context
    const flashAttempts: FlashAttempt[] = [];

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (this.aborted) { callbacks.onError('Agent stopped by user', this.costTracker.getSummary()); return; }

      if (this.pendingUserMessage) {
        messages.push({ role: 'user', content: this.pendingUserMessage });
        this.addStep(steps, {
          type: 'text', status: 'completed',
          description: `User: ${this.pendingUserMessage.substring(0, 60)}`,
        }, callbacks);
        this.pendingUserMessage = null;
      }

      // ── Hybrid Router: decide which model to use for this turn ──
      let activeAdapter = this.adapter;
      let routedModel: 'flash' | 'claude' | null = null;
      let flashSystemPrompt: string | null = null; // hardened prompt for Flash turns

      if (this.hybridRouter && this.flashAdapter && this.claudeAdapter) {
        // Build lightweight history for classifier
        const routerHistory: RouterMessage[] = messages
          .filter((m: any) => typeof m.content === 'string')
          .slice(-6)
          .map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }));

        const lastUserMsg = typeof messages[messages.length - 1]?.content === 'string'
          ? messages[messages.length - 1].content
          : userPrompt;

        // Detect if this is the likely final (synthesis) turn — route to Claude for polished output.
        // Signal: the IMMEDIATELY PREVIOUS tool call produced a user-facing output file
        // (generate_document or sandbox_save_to_shared — NOT write_file, which is used for
        // intermediate data files like CSV/Python scripts). Only trigger once per run — otherwise
        // every subsequent turn keeps routing to Claude and we burn tokens.
        // NOTE: write_file excluded because it's used for intermediate scratch files; only
        // generate_document + sandbox_save_to_shared represent "final output ready for user".
        const TERMINAL_TOOLS = ['generate_document', 'sandbox_save_to_shared'];
        // Find the MOST RECENT tool_result (not "any in last 6 steps" — too greedy).
        let mostRecentToolResult: AgentStep | undefined;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (steps[i].type === 'tool_result') { mostRecentToolResult = steps[i]; break; }
        }
        const immediatelyAfterTerminal = !!mostRecentToolResult &&
          mostRecentToolResult.status === 'completed' &&
          !!mostRecentToolResult.toolName &&
          TERMINAL_TOOLS.includes(mostRecentToolResult.toolName) &&
          !!mostRecentToolResult.result &&
          !/"error"|"success":\s*false/i.test(mostRecentToolResult.result);
        // Only trigger the synthesis routing ONCE — after the first synthesis turn, subsequent
        // turns should flow through normal routing (Flash unless complex).
        const justFinishedTerminalTool = immediatelyAfterTerminal && !this.synthesisRouted;
        if (justFinishedTerminalTool) this.synthesisRouted = true;
        // Also consider "last turn" when we're close to the turn budget — synthesize before running out
        const nearTurnLimit = turn >= MAX_TURNS - 2;
        const isLikelyLastTurn = turn > 0 && (justFinishedTerminalTool || nearTurnLimit);

        try {
          const decision = await this.hybridRouter.decideModel(
            lastUserMsg,
            routerHistory,
            turn === 0,  // isFirstTurn
            isLikelyLastTurn,  // isLastTurn — detected via terminal tool success or turn budget
          );
          routedModel = decision.model;
          activeAdapter = routedModel === 'flash' ? this.flashAdapter : this.claudeAdapter;

          // Use hardened Flash prompt when routing to Flash — append key context from main prompt
          if (routedModel === 'flash') {
            const taskCategory = decision.classification.taskCategory || 'general';
            flashSystemPrompt = this.hybridRouter.buildFlashSystemPrompt(taskCategory, true);
            // Append active window context + sandbox rules so Flash knows what's on screen
            const contextParts: string[] = [];
            if (windowContext) {
              contextParts.push(`Active window: ${windowContext.title || windowContext.windowTitle} (${windowContext.process || windowContext.processName})`);
            }
            if (getAllTools().some(t => t.name.startsWith('sandbox_'))) {
              contextParts.push('SANDBOX: sandbox_write_file, sandbox_run_python, sandbox_read_file are available. For data processing, write data to CSV file first, then write a short Python script that reads from it.');
            }
            if (contextParts.length > 0) {
              flashSystemPrompt += '\n\n' + contextParts.join('\n');
            }
          }

          console.log(`[HybridRouter] Turn ${turn + 1}: → ${routedModel} (${decision.classification.reason})`);
        } catch (err) {
          console.warn('[HybridRouter] Decision failed, using default adapter:', err);
        }
      }

      this.addStep(steps, {
        type: 'thinking', status: 'running',
        description: `Turn ${turn + 1}${routedModel ? ` [${routedModel}]` : ''}`,
      }, callbacks);

      let response: any;
      let retryCount = 0;
      const MAX_RETRIES = 3;

      while (retryCount <= MAX_RETRIES) {
        try {
          // Compress older tool_result content so we don't hit Claude's 200K
          // (or Gemini's request body) limit by turn 15-20.
          const compressedMessages = this.compressMessages(messages);
          const stream = activeAdapter.stream({
            system: flashSystemPrompt || systemPrompt, // Use hardened prompt for Flash
            messages: compressedMessages,
            tools: getAllTools(),
            maxTokens: 4096,
          });

          stream.onText((delta) => {
            if (!this.aborted) callbacks.onTextDelta(delta);
          });

          response = await stream.finalMessage();

          if (response.usage) {
            this.costTracker.addUsage(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheHitTokens, response.usage.cacheMissTokens);
          }
          break;
        } catch (err: any) {
          retryCount++;
          const isRetryable = err.status === 429 || err.status === 529 || err.status >= 500;
          const isStreamError = /parse|stream|chunk/i.test(err.message || '');

          // If Flash stream failed and we have Claude, escalate instead of crashing
          if (isStreamError && routedModel === 'flash' && this.claudeAdapter) {
            console.warn('[Agent] Flash stream error, escalating to Claude');
            console.warn('[Agent] Full error:', err);
            console.warn('[Agent] Error name:', err?.name, 'status:', err?.status, 'code:', err?.code);
            console.warn('[Agent] Stack:', err?.stack?.substring(0, 500));
            this.addStep(steps, {
              type: 'thinking', status: 'running',
              description: 'Flash stream error — switching to Claude...',
            }, callbacks);
            try {
              const escStream = this.claudeAdapter.stream({
                system: systemPrompt,
                messages: this.compressMessages(messages),
                tools: getAllTools(),
                maxTokens: 4096,
              });
              escStream.onText((delta) => { if (!this.aborted) callbacks.onTextDelta(delta); });
              response = await escStream.finalMessage();
              if (response?.usage) {
                this.costTracker.addUsage(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheHitTokens, response.usage.cacheMissTokens);
              }
              break;
            } catch (escErr) {
              console.warn('[Agent] Claude escalation also failed:', escErr);
              callbacks.onError(this.friendlyError(err), this.costTracker.getSummary());
              return;
            }
          }

          if (isRetryable && retryCount <= MAX_RETRIES) {
            const delay = Math.pow(2, retryCount - 1) * 1000;
            this.addStep(steps, {
              type: 'error', status: 'running',
              description: `API error ${err.status}, retrying in ${delay / 1000}s... (${retryCount}/${MAX_RETRIES})`,
            }, callbacks);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          callbacks.onError(this.friendlyError(err), this.costTracker.getSummary());
          return;
        }
      }

      if (!response) { callbacks.onError('Failed to get response after retries', this.costTracker.getSummary()); return; }

      // ── Hybrid Router: quality gate for Flash turns ──
      // SKIP quality gate if Flash made tool calls — it's executing correctly.
      // Only gate text-only responses (final answers) where Flash might have given up.
      const hasToolUseBlocks = response?.content?.some((b: any) => b.type === 'tool_use');

      if (this.hybridRouter && routedModel === 'flash' && response && !hasToolUseBlocks) {
        const turnText = response.content
          ?.filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('') || '';
        const turnToolCalls: ToolCallResult[] = [];
        const tokens = response.usage || { inputTokens: 0, outputTokens: 0 };

        const evaluation = this.hybridRouter.evaluateFlashTurn(
          userPrompt, turnText, turnToolCalls, { input: tokens.inputTokens, output: tokens.outputTokens },
        );

        if (evaluation.action === 'retry' && evaluation.retryPrompt && this.flashAdapter) {
          console.log('[HybridRouter] Flash quality gate failed — retrying with tighter prompt');
          this.addStep(steps, {
            type: 'thinking', status: 'running', description: 'Retrying with tighter prompt...',
          }, callbacks);

          try {
            const retryStream = this.flashAdapter.stream({
              system: systemPrompt,
              messages: this.compressMessages([...messages, { role: 'user', content: evaluation.retryPrompt }]),
              tools: getAllTools(),
              maxTokens: 4096,
            });
            retryStream.onText((delta) => { if (!this.aborted) callbacks.onTextDelta(delta); });
            const retryResponse = await retryStream.finalMessage();

            if (retryResponse.usage) {
              this.costTracker.addUsage(retryResponse.usage.inputTokens, retryResponse.usage.outputTokens, retryResponse.usage.cacheHitTokens, retryResponse.usage.cacheMissTokens);
            }

            const retryText = retryResponse.content
              ?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';
            const retryTokens = retryResponse.usage || { inputTokens: 0, outputTokens: 0 };
            const retryEval = this.hybridRouter.evaluateFlashRetry(
              userPrompt, retryText, turnToolCalls, { input: retryTokens.inputTokens, output: retryTokens.outputTokens },
            );

            if (retryEval.action === 'accept') {
              response = retryResponse; // use retry response
            } else {
              // Escalate: re-run with Claude
              flashAttempts.push({ response: turnText, toolCalls: turnToolCalls, qualityScore: evaluation.turnResult.qualityScore, failures: evaluation.turnResult.toolCalls.filter(t => !t.success).map(t => t.error || 'failed'), tokens });
              console.log('[HybridRouter] Flash retry failed — escalating to Claude');
              this.addStep(steps, { type: 'thinking', status: 'running', description: 'Escalating to Claude...' }, callbacks);

              const escContext = this.hybridRouter.getEscalationContext(flashAttempts);
              const escStream = this.claudeAdapter!.stream({
                system: systemPrompt + '\n\n' + escContext,
                messages: this.compressMessages(messages),
                tools: getAllTools(),
                maxTokens: 4096,
              });
              escStream.onText((delta) => { if (!this.aborted) callbacks.onTextDelta(delta); });
              response = await escStream.finalMessage();
              if (response.usage) {
                this.costTracker.addUsage(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheHitTokens, response.usage.cacheMissTokens);
                this.hybridRouter.recordClaudeTurn({ input: response.usage.inputTokens, output: response.usage.outputTokens });
              }
            }
          } catch (err) {
            console.warn('[HybridRouter] Retry/escalation failed, using original response:', err);
          }
        } else if (evaluation.action === 'escalate' && this.claudeAdapter) {
          // Direct escalation (no retry)
          flashAttempts.push({ response: turnText, toolCalls: turnToolCalls, qualityScore: evaluation.turnResult.qualityScore, failures: evaluation.turnResult.toolCalls.filter(t => !t.success).map(t => t.error || 'failed'), tokens });
          console.log('[HybridRouter] Flash quality gate failed — escalating directly to Claude');
          this.addStep(steps, { type: 'thinking', status: 'running', description: 'Escalating to Claude...' }, callbacks);

          try {
            const escContext = this.hybridRouter.getEscalationContext(flashAttempts);
            const escStream = this.claudeAdapter.stream({
              system: systemPrompt + '\n\n' + escContext,
              messages: this.compressMessages(messages),
              tools: getAllTools(),
              maxTokens: 4096,
            });
            escStream.onText((delta) => { if (!this.aborted) callbacks.onTextDelta(delta); });
            response = await escStream.finalMessage();
            if (response.usage) {
              this.costTracker.addUsage(response.usage.inputTokens, response.usage.outputTokens, response.usage.cacheHitTokens, response.usage.cacheMissTokens);
              this.hybridRouter.recordClaudeTurn({ input: response.usage.inputTokens, output: response.usage.outputTokens });
            }
          } catch (err) {
            console.warn('[HybridRouter] Escalation failed, using original Flash response:', err);
          }
        }
      } else if (this.hybridRouter && routedModel === 'flash' && hasToolUseBlocks && response?.usage) {
        // Flash made tool calls — execution turn, skip quality gate, just record cost
        this.hybridRouter.recordFlashToolTurn({ input: response.usage.inputTokens, output: response.usage.outputTokens });
      } else if (this.hybridRouter && routedModel === 'claude' && response?.usage) {
        this.hybridRouter.recordClaudeTurn({ input: response.usage.inputTokens, output: response.usage.outputTokens });
      }

      const toolResults: any[] = [];
      let hasToolUse = false;
      let turnText = '';

      for (const block of response.content) {
        if (this.aborted) break;

        if (block.type === 'text') {
          turnText += block.text;
          callbacks.onTextComplete(block.text);
        }

        if (block.type === 'tool_use') {
          hasToolUse = true;
          const { id, name, input } = block;

          this.addStep(steps, {
            type: 'tool_call', toolName: name,
            toolInput: input as Record<string, any>,
            status: 'pending', description: name,
          }, callbacks);

          // ── ask_user: pause agent, show question to user, wait for answer ──
          if (name === 'ask_user') {
            if (callbacks.onAskUser) {
              this.addStep(steps, {
                type: 'tool_call', toolName: 'ask_user',
                status: 'running', description: input.question as string,
              }, callbacks);
              const answer = await callbacks.onAskUser(
                input.question as string,
                input.options as string[] | undefined,
              );
              this.addStep(steps, {
                type: 'tool_result', toolName: 'ask_user',
                status: 'completed', result: answer,
              }, callbacks);
              toolResults.push({ type: 'tool_result', tool_use_id: id, content: `User answered: ${answer}` });
            } else {
              toolResults.push({ type: 'tool_result', tool_use_id: id, content: 'User interaction not available. Make your best judgment and proceed.' });
            }
            continue;
          }

          const perm = this.permissions.check(name, input as Record<string, any>);

          if (perm.needsPrompt && perm.request) {
            this.addStep(steps, {
              type: 'permission', toolName: name,
              status: 'waiting_permission', description: perm.request.description,
            }, callbacks);

            const decision = await callbacks.onPermissionRequest(perm.request);
            this.permissions.grant(name, decision.decision, decision.scope, decision.pathPattern);

            if (decision.decision === 'deny') {
              this.addStep(steps, { type: 'tool_result', toolName: name, status: 'denied', result: 'Denied' }, callbacks);
              toolResults.push({
                type: 'tool_result', tool_use_id: id,
                content: 'Permission denied by user. Try a different approach or ask what they prefer.',
              });
              continue;
            }
          } else if (!perm.allowed) {
            toolResults.push({ type: 'tool_result', tool_use_id: id, content: 'Tool not available.' });
            continue;
          }

          this.updateLastStep(steps, { status: 'running' }, callbacks);
          let result: string;
          try {
            result = await Promise.race([
              executeTool(name, input as Record<string, any>),
              new Promise<string>((_, reject) =>
                setTimeout(() => reject(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT / 1000}s`)), TOOL_TIMEOUT)
              ),
            ]);
          } catch (err: any) {
            result = JSON.stringify({ error: err.message });
          }

          this.addStep(steps, {
            type: 'tool_result', toolName: name, status: 'completed',
            result: result.substring(0, 16384),
          }, callbacks);

          let toolContent: any;
          try {
            const parsed = JSON.parse(result);
            if (parsed.image && parsed.type === 'screenshot') {
              const imgType = parsed.image.startsWith('/9j/') ? 'image/jpeg'
                : parsed.image.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
              toolContent = [{
                type: 'image',
                source: { type: 'base64', media_type: imgType, data: parsed.image },
              }];
            } else {
              toolContent = result;
            }
          } catch {
            toolContent = result;
          }

          toolResults.push({ type: 'tool_result', tool_use_id: id, content: toolContent });
        }
      }

      if ((response.stopReason === 'end_turn' || response.stop_reason === 'end_turn') && !hasToolUse) {
        callbacks.onComplete(steps, this.costTracker.getSummary());
        return;
      }

      if (toolResults.length > 0) {
        // Reasoning models (DeepSeek V4-Pro) require reasoning_content to be echoed
        // back on the assistant message in subsequent turns or the API 400s.
        const assistantMsg: any = { role: 'assistant', content: response.content };
        if ((response as any).reasoningContent) assistantMsg.reasoningContent = (response as any).reasoningContent;
        messages.push(assistantMsg);
        messages.push({ role: 'user', content: toolResults });

        // Fire-and-forget narration for the next turn — describes what's about to happen.
        // Never awaited; 500ms timeout inside dispatchNarration drops slow responses.
        // Pick the last tool call to feed the narrator (most recent action drives the next-step prediction).
        const lastTool = toolResults[toolResults.length - 1];
        const lastToolUse = response.content.find((c: any) => c.type === 'tool_use');
        if (lastToolUse) {
          const lastResultStr = typeof (lastTool as any)?.content === 'string'
            ? (lastTool as any).content
            : JSON.stringify((lastTool as any)?.content || '');
          dispatchNarration({
            goal: userPrompt,
            lastToolName: (lastToolUse as any).name,
            lastToolResult: lastResultStr,
            turnNumber: turn,
          });
        }
      } else {
        callbacks.onComplete(steps, this.costTracker.getSummary());
        return;
      }
    }

    callbacks.onError(`Max turns reached (${MAX_TURNS}). Agent stopped.`, this.costTracker.getSummary());
  }

  // ══════════════════════════════════════════════════════════════════════
  // ORCHESTRATED EXECUTION — For weak models (Gemini Flash, GLM-4.x)
  // 4-phase workflow: Plan → Execute → Validate → Final Response
  // ══════════════════════════════════════════════════════════════════════

  private async runOrchestrated(
    userPrompt: string,
    screenshotBase64: string | null,
    windowContext: any,
    callbacks: AgentCallbacks,
    extraImages?: string[],
  ): Promise<void> {
    const steps: AgentStep[] = [];
    const profile = getModelProfile(this.adapter.modelId);
    const orchestrator = new Orchestrator(this.permissions);
    const validator = new Validator();

    // Pass screenshots to orchestrator for step execution
    const allImages: string[] = [];
    if (extraImages) allImages.push(...extraImages);
    if (screenshotBase64) allImages.push(screenshotBase64);
    if (allImages.length > 0) orchestrator.setScreenshots(allImages);

    try {
      // ── Innovation #6: Ambient Context Intelligence ──
      this.addStep(steps, { type: 'thinking', status: 'running', description: 'Gathering context...' }, callbacks);
      await orchestrator.gatherAmbientContext();

      // ── Phase 1: Planning ──
      this.updateLastStep(steps, { description: 'Planning task...' }, callbacks);

      const plan = await orchestrator.generatePlan(userPrompt, this.adapter, profile);

      this.updateLastStep(steps, { status: 'completed', description: `Plan: ${plan.steps.length} steps` }, callbacks);
      callbacks.onPlanGenerated?.(plan);

      // ── Innovation #1: Model Allocation (log optimal allocation) ──
      const availableKeys: Partial<Record<AgentModelProvider, string | null>> = {};
      try {
        availableKeys.gemini = localStorage.getItem('gemini_api_key');
        availableKeys.claude = await (window as any).electron?.claudeKey?.get();
        // GLM/OpenAI keys would come from their respective storage
      } catch { /* best-effort */ }
      const allocation = allocateModels(plan, availableKeys, CostTracker.getDailyBudget() - CostTracker.getSessionSpend());
      const escalation = createEscalationPolicy(availableKeys);
      if (escalation) {
        console.log(`[ClaudeAgent] Escalation policy: ${escalation.startWith} → ${escalation.escalateTo} after ${escalation.escalateAfter} failures`);
      }
      console.log('[ClaudeAgent] Model allocation:', allocation);

      // ── Innovation #5: Try Streaming Artifact Creation for eligible tasks ──
      const pipelineUsed = await orchestrator.pipelineExecution(plan, this.adapter, callbacks, profile);
      if (pipelineUsed) {
        this.addStep(steps, { type: 'thinking', status: 'completed', description: 'Pipeline execution complete' }, callbacks);
      }

      // ── Phase 2: Step-by-step execution (skip if pipeline handled it) ──
      if (!pipelineUsed) {
      // Identify research vs creation steps for synthesis timing
      const researchStepIds = new Set<number>();
      const creationStepIds = new Set<number>();
      for (const s of plan.steps) {
        if (s.tools.includes('read_web_content') || s.tools.includes('read_file') || s.tools.includes('read_active_file')) {
          researchStepIds.add(s.id);
        }
        if (s.tools.includes('write_file') || s.tools.includes('generate_document')) {
          creationStepIds.add(s.id);
        }
      }
      const hasResearchAndCreation = researchStepIds.size > 0 && creationStepIds.size > 0;
      let synthesisBrief: SynthesizedBrief | null = null;
      let synthesisExecuted = false;

      for (const planStep of plan.steps) {
        if (this.aborted) break;
        if (planStep.status === 'skipped') continue;

        // Check dependencies
        const depsCompleted = planStep.depends.every(d =>
          plan.steps.find(s => s.id === d)?.status === 'completed' ||
          plan.steps.find(s => s.id === d)?.status === 'skipped'
        );
        if (!depsCompleted) {
          planStep.status = 'skipped';
          callbacks.onStepProgress?.(planStep.id, 'skipped');
          continue;
        }

        // ── Phase 2.5: Synthesis — run BETWEEN research and creation steps ──
        if (hasResearchAndCreation && !synthesisExecuted && creationStepIds.has(planStep.id)) {
          const allResearchDone = [...researchStepIds].every(id => {
            const s = plan.steps.find(ps => ps.id === id);
            return s?.status === 'completed' || s?.status === 'skipped';
          });
          if (allResearchDone) {
            this.addStep(steps, { type: 'thinking', status: 'running', description: 'Synthesizing research data...' }, callbacks);
            synthesisBrief = await orchestrator.synthesize(plan, this.adapter, profile);
            synthesisExecuted = true;

            // Try DIRECT output generation — bypass model entirely for structured data
            if (synthesisBrief && synthesisBrief.items.length >= 3) {
              const directPath = await orchestrator.generateOutputDirectly(plan, synthesisBrief);
              if (directPath) {
                this.addStep(steps, { type: 'thinking', status: 'completed', description: `File generated directly: ${directPath.split(/[/\\]/).pop()}` }, callbacks);
                // Mark remaining creation + verification steps as completed
                for (const s of plan.steps) {
                  if (s.status === 'pending' && (s.tools.includes('write_file') || s.tools.includes('generate_document') || s.tools.includes('list_directory'))) {
                    s.status = 'completed';
                    s.result = `File created at: ${directPath}`;
                    callbacks.onStepProgress?.(s.id, 'completed');
                  }
                }
                // Open the file
                try { await executeTool('system_open', { target: directPath }); } catch { /* ok */ }
                break; // Exit the step loop — file is done
              }
            }

            // Fallback: inject synthesis brief into creation step's context for model
            if (synthesisBrief && synthesisBrief.totalCount > 0) {
              const briefText = synthesisBrief.items.length > 0
                ? synthesisBrief.items.map((item, i) =>
                    `${i + 1}. "${item.title}"${item.source ? ` — ${item.source}` : ''}${item.url ? ` (${item.url})` : ''}`
                  ).join('\n')
                : synthesisBrief.textSummary;
              orchestrator.getContextManager().updateCollectedData(
                `Synthesized ${synthesisBrief.totalCount} items:\n${briefText}`
              );
            }
          }
        }

        // Detect parallel-ready steps (independent steps with no pending deps)
        const parallelGroup = this.findParallelSteps(plan, planStep);
        if (parallelGroup.length > 1) {
          // Execute parallel steps concurrently
          this.addStep(steps, { type: 'thinking', status: 'running', description: `Running ${parallelGroup.length} steps in parallel...` }, callbacks);
          const parallelResults = await Promise.all(
            parallelGroup.map(async (pStep) => {
              pStep.status = 'running';
              callbacks.onStepProgress?.(pStep.id, 'running');
              const result = await orchestrator.executeStep(pStep, this.adapter, callbacks, profile);
              this.trackStepCost(orchestrator);
              return { step: pStep, result };
            })
          );
          for (const { step: pStep, result } of parallelResults) {
            if (result.success) {
              pStep.status = 'completed';
              pStep.result = result.summary;
              callbacks.onStepProgress?.(pStep.id, 'completed');
            } else {
              pStep.status = 'failed';
              callbacks.onStepProgress?.(pStep.id, 'failed');
            }
            this.saveCheckpoint(orchestrator, plan, userPrompt);
          }
          // Skip these steps in the main loop (they're already done)
          continue;
        }

        planStep.status = 'running';
        callbacks.onStepProgress?.(planStep.id, 'running');
        this.addStep(steps, { type: 'thinking', status: 'running', description: `Step ${planStep.id}: ${planStep.action}` }, callbacks);

        // Execute step (1 attempt + maxRetries)
        let success = false;
        const result = await orchestrator.executeStep(planStep, this.adapter, callbacks, profile);
        this.trackStepCost(orchestrator);

        if (result.success) {
          planStep.status = 'completed';
          planStep.result = result.summary;
          callbacks.onStepProgress?.(planStep.id, 'completed');
          success = true;
        } else if (planStep.maxRetries > 0) {
          // Retry with a DIFFERENT approach — add all tools so model can pick alternative
          this.addStep(steps, { type: 'thinking', status: 'running', description: `Retrying step ${planStep.id} with different approach` }, callbacks);
          planStep.retries++;
          // Widen the tool set — if original step had limited tools, give it all tools
          const originalTools = [...planStep.tools];
          planStep.tools = []; // Empty = model picks from all available tools
          const retryResult = await orchestrator.executeStep(planStep, this.adapter, callbacks, profile);
          planStep.tools = originalTools; // Restore
          this.trackStepCost(orchestrator);
          if (retryResult.success) {
            planStep.status = 'completed';
            planStep.result = retryResult.summary;
            callbacks.onStepProgress?.(planStep.id, 'completed');
            success = true;
          }
        }

        if (!success) {
          planStep.status = 'failed';
          callbacks.onStepProgress?.(planStep.id, 'failed');
        }

        // Save checkpoint after each step
        this.saveCheckpoint(orchestrator, plan, userPrompt);

        // Stall detection every 2 steps
        if (steps.length > 4) {
          const stallCheck = orchestrator.detectStall(steps);
          if (stallCheck.isStalled) {
            console.log('[ClaudeAgent] Stall detected:', stallCheck.reason, stallCheck.recommendation);
            this.addStep(steps, { type: 'error', status: 'running', description: `Stall: ${stallCheck.recommendation}` }, callbacks);
          }
        }

        // Progress checkpoint for UI
        const completedCount = plan.steps.filter(s => s.status === 'completed').length;
        callbacks.onProgressCheckpoint?.({
          stepId: planStep.id,
          previewAvailable: !!planStep.result,
          previewType: 'text',
          previewContent: planStep.result || '',
          completionPercentage: Math.round((completedCount / plan.steps.length) * 100),
          estimatedRemainingTime: '',
        });
      }

      } // end if (!pipelineUsed)

      // ── Phase 3: Validation (+ Innovation #4: Screen-Diff Verification) ──
      this.addStep(steps, { type: 'thinking', status: 'running', description: 'Validating results...' }, callbacks);
      const validation = await validator.validate(plan, orchestrator.getToolResults());

      // Visual verification for file-creation and app-opening tasks
      const createdFiles = plan.steps.some(s =>
        s.status === 'completed' && (s.tools.includes('write_file') || s.tools.includes('generate_document'))
      );
      const openedApps = plan.steps.some(s =>
        s.status === 'completed' && s.tools.includes('system_open')
      );
      if (createdFiles || openedApps) {
        try {
          const taskType = openedApps ? 'app_opened' : 'file_created';
          const visualResult = await validator.visualVerification(taskType, profile.supportsVision ? this.adapter : undefined);
          validation.checks.push({
            name: `Visual verification (${taskType})`,
            passed: visualResult.verdict === 'PASS',
            details: visualResult.reason,
          });
          if (visualResult.verdict === 'FAIL') {
            validation.allPassed = false;
          }
        } catch (err) {
          console.log('[ClaudeAgent] Visual verification failed:', err);
        }
      }

      if (!validation.allPassed) {
        const failedChecks = validation.checks.filter(c => !c.passed);
        console.log('[ClaudeAgent] Validation failed:', failedChecks.map(c => c.name).join(', '));
        this.addStep(steps, { type: 'thinking', status: 'running', description: `Fixing ${failedChecks.length} issue(s)...` }, callbacks);

        // Re-execute failed steps (max 1 re-validation cycle)
        for (const check of failedChecks) {
          if (this.aborted) break;
          // Find the step related to this failed check and retry it
          const stepMatch = check.name.match(/Step (\d+)/);
          if (stepMatch) {
            const stepId = parseInt(stepMatch[1]);
            const failedStep = plan.steps.find(s => s.id === stepId);
            if (failedStep && failedStep.retries < failedStep.maxRetries) {
              failedStep.status = 'running';
              failedStep.retries++;
              const retryResult = await orchestrator.executeStep(failedStep, this.adapter, callbacks, profile);
              this.trackStepCost(orchestrator);
              failedStep.status = retryResult.success ? 'completed' : 'failed';
              failedStep.result = retryResult.summary;
            }
          }
        }
      }

      // ── Phase 4: Final Response ──
      this.addStep(steps, { type: 'thinking', status: 'completed', description: 'Generating summary...' }, callbacks);
      const completedSteps = plan.steps.filter(s => s.status === 'completed');
      const failedSteps = plan.steps.filter(s => s.status === 'failed');

      // Innovation #14: Smart suggestions
      const suggestions = orchestrator.generateSmartSuggestions();
      const suggestionsText = suggestions.length > 0
        ? `\n\nSuggested next steps:\n${suggestions.map(s => `- ${s.text}`).join('\n')}`
        : '';

      // Ask model for a human-friendly summary with reflection
      try {
        const summaryPrompt = `Task completed. Summarize and reflect.\n\nGoal: ${plan.goal}\nCompleted: ${completedSteps.length}/${plan.steps.length} steps\nFailed: ${failedSteps.length} steps\nValidation: ${validation.allPassed ? 'All checks passed' : validation.checks.filter(c => !c.passed).map(c => c.name).join(', ')}\n\nResults:\n${completedSteps.map(s => `- Step ${s.id} (${s.action}): ${s.result || 'done'}`).join('\n')}\n${suggestionsText}\n\nWrite a concise summary using markdown. Start with ## Results, include verification status, end with ## Suggestions.`;

        const stream = this.adapter.stream({
          system: 'You are KLYPIX. Write a brief, well-formatted summary of what was accomplished. Include what worked and what could be improved.',
          messages: [{ role: 'user', content: summaryPrompt }],
          tools: [],
          maxTokens: 1024,
        });

        stream.onText((delta) => {
          if (!this.aborted) callbacks.onTextDelta(delta);
        });

        const finalResponse = await stream.finalMessage();
        if (finalResponse.usage) {
          this.costTracker.addUsage(finalResponse.usage.inputTokens, finalResponse.usage.outputTokens, finalResponse.usage.cacheHitTokens, finalResponse.usage.cacheMissTokens);
        }
      } catch (err) {
        console.log('[ClaudeAgent] Final summary failed:', err);
        const fallback = `## Results\nCompleted ${completedSteps.length}/${plan.steps.length} steps.\n${completedSteps.map(s => `- ${s.action}: ${s.result || 'done'}`).join('\n')}${suggestions.length > 0 ? `\n\n## Suggestions\n${suggestions.map(s => `- ${s.text}`).join('\n')}` : ''}\n`;
        callbacks.onTextComplete(fallback);
      }

      // Clear checkpoint on successful completion
      checkpointManager.clear();

      // Session learning: extract patterns from this run
      const currentSession = agentSessionManager.getCurrent();
      if (currentSession) {
        sessionLearning.learnFromSession(currentSession);
      }

      callbacks.onComplete(steps, this.costTracker.getSummary());

    } catch (err: any) {
      callbacks.onError(this.friendlyError(err), this.costTracker.getSummary());
    }
  }

  /**
   * Find steps that can run in parallel with the given step.
   * Returns the parallel group (including the given step) if any steps
   * share no dependencies with each other.
   */
  private findParallelSteps(plan: ExecutionPlan, currentStep: PlanStep): PlanStep[] {
    // Find all pending steps whose dependencies are all completed
    const ready = plan.steps.filter(s =>
      s.status === 'pending' &&
      s.depends.every(d => {
        const dep = plan.steps.find(ps => ps.id === d);
        return dep?.status === 'completed' || dep?.status === 'skipped';
      })
    );

    if (ready.length <= 1) return [currentStep];

    // Group steps that don't depend on each other
    const group = ready.filter(s => {
      // s and currentStep are independent if neither depends on the other
      return !s.depends.includes(currentStep.id) && !currentStep.depends.includes(s.id);
    });

    return group.length > 1 ? group : [currentStep];
  }

  /**
   * Track actual cost from orchestrator's last usage data.
   */
  private trackStepCost(orchestrator: Orchestrator): void {
    const usage = orchestrator.consumeLastUsage();
    if (usage) {
      this.costTracker.addUsage(usage.inputTokens, usage.outputTokens);
    }
  }

  /**
   * Save a checkpoint after a step completes (Innovation #8).
   */
  private saveCheckpoint(orchestrator: Orchestrator, plan: ExecutionPlan, prompt: string): void {
    try {
      checkpointManager.save({
        planState: plan,
        completedResults: [...orchestrator.getToolResults().entries()],
        agentMemory: orchestrator.getMemory(),
        contextSummary: '',
        costSoFar: this.costTracker.getSummary(),
        turnCount: orchestrator.getTotalTurnsUsed(),
        timestamp: Date.now(),
        originalPrompt: prompt,
        modelId: this.adapter.modelId,
      });
    } catch (err) {
      console.log('[ClaudeAgent] Checkpoint save failed:', err);
    }
  }

  private addStep(steps: AgentStep[], partial: Partial<AgentStep>, callbacks: AgentCallbacks): AgentStep {
    const step: AgentStep = {
      id: `step_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(), type: 'text', status: 'pending', ...partial,
    };
    steps.push(step);
    callbacks.onStep(step);
    return step;
  }

  private updateLastStep(steps: AgentStep[], update: Partial<AgentStep>, callbacks: AgentCallbacks): void {
    const last = steps[steps.length - 1];
    if (last) { Object.assign(last, update); callbacks.onStep(last); }
  }

  private friendlyError(err: any): string {
    const msg = err.message || '';
    const status = err.status;

    if (msg.includes('credit balance is too low') || msg.includes('purchase credits')) {
      return 'Your Claude API credits have run out. Please top up at console.anthropic.com/settings/plans to continue using Agent mode.';
    }
    if (msg.includes('Insufficient balance') || msg.includes('no resource package')) {
      return 'Insufficient API balance. Please check your API provider account and add credits or switch to a different model.';
    }
    if (status === 401 || msg.includes('invalid x-api-key') || msg.includes('authentication_error')) {
      return 'Your Claude API key is invalid or expired. Please update it in Settings \u2192 Agent Engine.';
    }
    if (status === 429) {
      return 'Claude API rate limit reached. Please wait a moment and try again.';
    }
    if (status === 529 || status >= 500) {
      return 'Claude API is temporarily unavailable. Please try again in a few minutes.';
    }
    if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) {
      return 'Request timed out. Claude may be under heavy load \u2014 try again shortly.';
    }
    if (msg.includes('network') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
      return 'Network error \u2014 please check your internet connection.';
    }
    if (msg.includes('Unknown Model') || msg.includes('model_not_found') || msg.includes('does not exist')) {
      return `Model not available. The selected AI model may not be accessible with your API key. Try a different model in Settings \u2192 Agent Engine.`;
    }
    if (msg.includes('GLM API error 400')) {
      return 'GLM rejected the request format. This may be a tool schema compatibility issue.';
    }
    if (msg.includes('GLM API error 402') || msg.includes('insufficient_quota')) {
      return 'Z.ai API credits depleted. Top up at z.ai/console or switch models.';
    }
    if (msg.includes('content_filter') || msg.includes('sensitive_content')) {
      return 'Z.ai content filter triggered. Try rephrasing your request.';
    }
    if (msg.includes('GLM API error') || msg.includes('OpenAI API error')) {
      try {
        const jsonMatch = msg.match(/\{.*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          return `API error: ${parsed.error?.message || parsed.message || msg}`;
        }
      } catch {}
    }
    return `Agent error: ${msg.length > 150 ? msg.substring(0, 150) + '\u2026' : msg}`;
  }

  /**
   * Compress tool_result content in older messages to keep the context within
   * the model's window. Without this, every turn's tool results echo into the
   * next request and we hit Claude's 200K limit (or Gemini Flash's request
   * body limit) by turn 15-20.
   *
   * Strategy:
   *   - Keep the latest KEEP_INTACT messages fully intact (model needs recent context)
   *   - For older messages: replace tool_result content with a tiny summary
   *     "[<tool_name> result, NN bytes]" — the agent has already used the data,
   *     it doesn't need the raw bytes again
   *   - User text and assistant text are NEVER compressed — only tool_result blocks
   *
   * Mutates a copy of the messages array; does not touch the original.
   */
  private compressMessages(messages: any[]): any[] {
    const KEEP_INTACT = 6;          // last 6 messages stay full
    const MAX_INTACT_BYTES = 4000;  // single tool_result over 4KB also gets compressed even if recent
    const cutoff = Math.max(0, messages.length - KEEP_INTACT);

    return messages.map((msg, idx) => {
      const isRecent = idx >= cutoff;
      // Only user-role messages carry tool_result blocks (assistant has tool_use)
      if (msg.role !== 'user' || !Array.isArray(msg.content)) return msg;

      const newContent = msg.content.map((c: any) => {
        if (c?.type !== 'tool_result') return c;
        const original = typeof c.content === 'string'
          ? c.content
          : Array.isArray(c.content)
            ? JSON.stringify(c.content)
            : String(c.content || '');
        // Recent + small → keep as-is
        if (isRecent && original.length <= MAX_INTACT_BYTES) return c;
        // Otherwise compress: keep the head so the model can still recognize the shape,
        // and append a marker. ~500 chars head + marker = ~600 chars total per result.
        const head = original.substring(0, 500);
        const marker = original.length > 500
          ? `\n[... truncated, ${original.length} bytes total]`
          : '';
        return { ...c, content: head + marker };
      });
      return { ...msg, content: newContent };
    });
  }
}
