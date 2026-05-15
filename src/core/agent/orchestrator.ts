/**
 * Orchestrator — The brain of KLYPIX's agent engine.
 *
 * Replaces the passive model-relay with intelligent step-by-step execution
 * for weak models (Gemini Flash, GLM-4.x). Strong models (Claude, GPT-4o,
 * GLM-5) use the legacy loop unchanged.
 *
 * 4-Phase Workflow:
 *   Phase 1: PLANNING — decompose task into steps
 *   Phase 2: EXECUTION — execute each step with micro-prompts
 *   Phase 2.5: SYNTHESIS — digest research into structured brief
 *   Phase 3: VALIDATION — verify outputs with adversarial checks
 *   Phase 4: FINAL RESPONSE — produce human-friendly summary
 *
 * 4 Cognitive Loops:
 *   Loop 1 (Strategic): Intent analysis, approach selection — planning phase
 *   Loop 2 (Tactical): evaluateStepContext() — before each step
 *   Loop 3 (Reactive): evaluateResult() — after each tool call
 *   Loop 4 (Meta): detectStall() — every 2-3 turns
 */

import { executeTool } from './toolExecutor';
import { ContextManager } from './contextManager';
import { ToolCache } from './toolCache';
import { ruleBasedPlan, classifiedPlan, parseModelPlan, buildClassifierPrompt, parseClassifierResponse } from './planner';
import type { IntentCategory } from './planner';
import { getAllTools } from './toolRegistry';
import { PermissionManager } from './permissions';
import { sessionLearning } from './sessionLearning';
import type { ModelAdapter, ModelMessage } from './modelAdapter';
import type { ModelProfile } from './modelProfiles';
import type { AgentCallbacks, AgentStep } from './claudeAgent';
import type {
  ExecutionPlan,
  PlanStep,
  StepResult,
  ResultEvaluation,
  StallDetection,
  AgentMemory,
  SynthesizedBrief,
  TurnBudget,
  AmbientContext,
} from './types';

const TOOL_TIMEOUT = 30000;

/** Safely extract hostname from a URL string */
function safeHostname(url: string): string | undefined {
  try { return new URL(url).hostname; } catch { return undefined; }
}

/** Navigation/boilerplate patterns to filter out from title extraction */
const NAV_PATTERNS = /^(menu|nav|skip|sign|log|search|home|about|contact|cookie|privacy|terms|subscribe|newsletter|follow|share|advertisement|sponsored)/i;

export class Orchestrator {
  private plan: ExecutionPlan | null = null;
  private completedResults: Map<number, Array<{ tool: string; result: string }>> = new Map();
  private contextManager = new ContextManager();
  private toolCache = new ToolCache();
  private permissions: PermissionManager | null = null;
  private memory: AgentMemory;
  private turnBudget: TurnBudget = { total: 25, perStep: new Map(), used: 0, hardCeiling: 25 };
  private totalTurnsUsed = 0;
  private aborted = false;
  private ambientContext: AmbientContext | null = null;
  private lastUsage: { inputTokens: number; outputTokens: number } | null = null;
  private screenshots: string[] = [];
  private screenshotsConsumed = false;

  constructor(permissions?: PermissionManager) {
    this.permissions = permissions || null;
    this.memory = {
      goal: '',
      constraints: [],
      decisions: [],
      openQuestions: [],
      verificationState: { tested: [], untested: [], verdicts: [] },
    };
  }

  /** Store screenshots for injection into step execution */
  setScreenshots(images: string[]): void {
    this.screenshots = images;
  }

  /** Allow external abort signal */
  abort(): void {
    this.aborted = true;
  }

  /** Get all collected tool results (for validation) */
  getToolResults(): Map<number, Array<{ tool: string; result: string }>> {
    return this.completedResults;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1: PLANNING
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Generate a plan from the user's prompt.
   * Tries model-based planning first, falls back to rule-based planner.
   */
  /**
   * Innovation #6: Ambient Context Intelligence.
   * Gather read-only context BEFORE planning for smarter plans.
   * Runs: screenshot, active window, active file, open files, clipboard in parallel.
   */
  async gatherAmbientContext(): Promise<AmbientContext> {
    const ctx: AmbientContext = {
      activeWindow: '',
      screenshot: null,
      activeFileContent: null,
      openFiles: [],
      clipboardText: null,
    };

    try {
      const results = await Promise.allSettled([
        executeTool('get_active_window', {}),
        executeTool('capture_screenshot', {}),
        executeTool('read_active_file', {}),
        executeTool('get_all_open_files', {}),
        executeTool('clipboard_read', {}),
      ]);

      if (results[0].status === 'fulfilled') ctx.activeWindow = results[0].value;
      if (results[1].status === 'fulfilled') {
        try {
          const parsed = JSON.parse(results[1].value);
          ctx.screenshot = parsed.image || null;
        } catch { /* not JSON */ }
      }
      if (results[2].status === 'fulfilled') ctx.activeFileContent = results[2].value;
      if (results[3].status === 'fulfilled') {
        try { ctx.openFiles = JSON.parse(results[3].value) || []; } catch { /* */ }
      }
      if (results[4].status === 'fulfilled') {
        try {
          const parsed = JSON.parse(results[4].value);
          ctx.clipboardText = parsed.text || null;
        } catch { ctx.clipboardText = results[4].value; }
      }
    } catch (err) {
      console.log('[Orchestrator] Ambient context gathering failed:', err);
    }

    this.ambientContext = ctx;
    return ctx;
  }

  async generatePlan(
    prompt: string,
    adapter: ModelAdapter,
    profile: ModelProfile,
  ): Promise<ExecutionPlan> {
    this.memory.goal = prompt;
    this.contextManager.init(prompt);

    // Inject session learning constraints
    const constraints = sessionLearning.getConstraints();
    if (constraints.length > 0) {
      this.memory.constraints = constraints;
      console.log('[Orchestrator] Injected', constraints.length, 'learned constraints');
    }

    // ── Option B: Intent classifier (cheap 1-call classification) ──
    // For weak planners, run a tiny classifier call FIRST to normalize intent,
    // then use classified plan. This handles natural language variations that
    // regex alone misses ("can you put all my PDFs together" → merge_files).
    // Cost: ~30 tokens in, ~5 tokens out = ~$0.000003 per call.
    if (profile.planningCapability === 'weak') {
      console.log('[Orchestrator] Weak planner — running intent classifier');
      let classifiedCategory: IntentCategory | null = null;

      try {
        const classifierPrompt = buildClassifierPrompt(prompt);
        const classifierStream = adapter.stream({
          system: 'You are a task classifier. Reply with ONLY the category name. No explanation.',
          messages: [{ role: 'user', content: classifierPrompt }],
          tools: [],
          maxTokens: 20, // Only need a single word back
        });

        let classifierText = '';
        classifierStream.onText((delta) => { classifierText += delta; });
        const classifierResponse = await classifierStream.finalMessage();

        // Extract text from response
        for (const block of classifierResponse.content) {
          if (block.type === 'text') classifierText = block.text;
        }

        classifiedCategory = parseClassifierResponse(classifierText);
        console.log('[Orchestrator] Classifier result:', classifiedCategory, '(raw:', classifierText.trim(), ')');
      } catch (err) {
        console.log('[Orchestrator] Classifier failed, falling through to regex:', err);
      }

      // Use classified plan (Option B) with regex fallback (Option A)
      const plan = classifiedPlan(classifiedCategory, prompt);
      this.plan = plan;
      this.allocateTurnBudget(plan, profile);
      return plan;
    }

    // ── Strong planners: try model-based JSON plan ──
    try {
      const planPrompt = this.buildStrategicPrompt(prompt);
      const stream = adapter.stream({
        system: profile.planSystemPrompt,
        messages: [{ role: 'user', content: planPrompt }],
        tools: [],
        maxTokens: 2048,
      });

      let rawText = '';
      stream.onText((delta) => { rawText += delta; });
      const response = await stream.finalMessage();

      // Extract the full text from response
      for (const block of response.content) {
        if (block.type === 'text') rawText = block.text;
      }

      const modelPlan = parseModelPlan(rawText);
      if (modelPlan && modelPlan.steps.length > 0) {
        // Fill in the goal if model didn't set it
        if (!modelPlan.goal) modelPlan.goal = prompt;
        console.log('[Orchestrator] Model-generated plan:', modelPlan.steps.length, 'steps');
        this.plan = modelPlan;
        this.allocateTurnBudget(modelPlan, profile);
        return modelPlan;
      }
    } catch (err) {
      console.log('[Orchestrator] Model planning failed, using rule-based fallback:', err);
    }

    // Fallback to rule-based planner (Option A regex matching)
    console.log('[Orchestrator] Using rule-based plan fallback');
    const plan = ruleBasedPlan(prompt);
    this.plan = plan;
    this.allocateTurnBudget(plan, profile);
    return plan;
  }

  /**
   * Build the strategic planning prompt (Loop 1: Strategic Reasoning).
   */
  private buildStrategicPrompt(prompt: string): string {
    // Inject ambient context if available
    let contextSection = '';
    if (this.ambientContext) {
      const parts: string[] = [];
      if (this.ambientContext.activeWindow) {
        try {
          const w = JSON.parse(this.ambientContext.activeWindow);
          parts.push(`Active window: ${w.title || w.windowTitle} (${w.process || w.processName})`);
        } catch { parts.push(`Active window: ${this.ambientContext.activeWindow.substring(0, 100)}`); }
      }
      if (this.ambientContext.clipboardText) {
        parts.push(`Clipboard: ${this.ambientContext.clipboardText.substring(0, 200)}`);
      }
      if (this.ambientContext.openFiles && this.ambientContext.openFiles.length > 0) {
        parts.push(`Open files: ${JSON.stringify(this.ambientContext.openFiles).substring(0, 200)}`);
      }
      if (parts.length > 0) contextSection = `\nCONTEXT:\n${parts.join('\n')}\n`;
    }

    // Inject learned constraints
    let constraintSection = '';
    if (this.memory.constraints.length > 0) {
      constraintSection = `\nCONSTRAINTS (from past experience):\n${this.memory.constraints.join('\n')}\n`;
    }

    return `You are planning an autonomous task. Analyze what needs to be done and return a JSON plan.

USER REQUEST: "${prompt}"
${contextSection}${constraintSection}
IMPORTANT: If the user has a file open on screen (Excel, PDF, etc.), the FIRST step must use read_active_file to get its content. Do NOT use read_file with guessed paths.

Respond with ONLY a JSON object (no explanation before or after):
{
  "goal": "What the user wants accomplished",
  "steps": [
    {
      "id": 1,
      "action": "Description of what to do",
      "tools": ["tool_name_1", "tool_name_2"],
      "depends": [],
      "success_signal": "How to know this step worked",
      "failure_action": "What to do if it fails"
    }
  ],
  "success_criteria": [
    { "description": "What must be true when done", "type": "file_exists" }
  ],
  "estimated_turns": 8
}

Available tools: capture_screenshot, get_active_window, read_active_file, get_all_open_files, read_file, write_file, edit_file, list_directory, file_move, file_delete, run_shell, browser_navigate, browser_click, browser_fill, read_web_content, system_open, system_type, clipboard_read, clipboard_write, generate_document, ask_user${getAllTools().some(t => t.name.startsWith('sandbox_')) ? ', sandbox_write_file, sandbox_read_file, sandbox_run_python, sandbox_execute, sandbox_copy_from_shared, sandbox_save_to_shared' : ''}.
${getAllTools().some(t => t.name.startsWith('sandbox_')) ? `
SANDBOX (WSL2 Linux with Python, pandas, matplotlib):
- For data processing, CSV analysis, chart generation → use sandbox tools instead of run_shell.
- NEVER embed large data in Python strings. Instead: sandbox_write_file("data.csv", data) → sandbox_write_file("script.py", code) → sandbox_run_python("script.py").
- For charts: sandbox generates PNG to shared/ folder → sandbox_save_to_shared → generate_document with ![Chart Title](filename.png) embeds them.
- generate_document resolves image paths from the sandbox shared folder automatically.
` : ''}
Return ONLY the JSON.`;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2: STEP-BY-STEP EXECUTION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Execute a single step of the plan.
   * Builds micro-prompt, filters tools, forces tool use for weak models.
   * Handles retries within the step.
   */
  async executeStep(
    step: PlanStep,
    adapter: ModelAdapter,
    callbacks: AgentCallbacks,
    profile: ModelProfile,
  ): Promise<StepResult> {
    const toolResults: Array<{ tool: string; result: string }> = [];
    let turnsUsed = 0;
    const maxStepTurns = this.turnBudget.perStep.get(step.id) || 3;

    // Build micro-prompt
    const microPrompt = this.buildMicroPrompt(step, profile);
    const context = this.contextManager.buildContextForStep(step, this.plan!);

    // Filter tools to only those relevant for this step
    // Always include sandbox tools if available — they complement any step that does data/Python work
    const allTools = getAllTools();
    const sandboxToolNames = new Set(allTools.filter(t => t.name.startsWith('sandbox_')).map(t => t.name));
    const relevantTools = step.tools.length > 0
      ? allTools.filter(t => step.tools.includes(t.name) || sandboxToolNames.has(t.name))
      : allTools; // Empty tools list = let model choose

    // Should we force tool use?
    // FIX: The old check `step.tools.length > 0` was always false for generic plans
    // which had tools: []. Now generic plans always have tools assigned, but we also
    // force tool use whenever we have ANY relevant tools for weak models.
    const shouldForce = relevantTools.length > 0 &&
      profile.supportsForceToolUse &&
      (profile.needsExplicitStepInstructions || !profile.reliableToolCalling);

    // Build messages for this step — include screenshots on first step only
    const stepContent = context + '\n\n' + microPrompt;
    let userContent: any;
    if (this.screenshots.length > 0 && !this.screenshotsConsumed) {
      // Build multimodal content with images + text
      const parts: any[] = [];
      for (const img of this.screenshots) {
        const mt = img.startsWith('/9j/') ? 'image/jpeg' : img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg';
        parts.push({ type: 'image', source: { type: 'base64', media_type: mt, data: img } });
      }
      parts.push({ type: 'text', text: `[${this.screenshots.length} screenshot(s) attached — analyze these images to answer the user\'s question]\n\n${stepContent}` });
      userContent = parts;
      this.screenshotsConsumed = true;
    } else {
      userContent = stepContent;
    }
    const messages: ModelMessage[] = [
      { role: 'user', content: userContent },
    ];

    // Step execution loop (may need multiple turns for multi-tool steps)
    for (let turn = 0; turn < maxStepTurns; turn++) {
      if (this.aborted) break;
      if (this.totalTurnsUsed >= this.turnBudget.hardCeiling) break;

      this.totalTurnsUsed++;
      turnsUsed++;

      try {
        const stream = adapter.stream({
          system: profile.stepSystemPrompt,
          messages,
          tools: relevantTools,
          maxTokens: profile.maxTokensPerStep,
          forceToolUse: shouldForce && turn === 0,
        });

        let turnText = '';
        stream.onText((delta) => {
          turnText += delta;
          if (!this.aborted) callbacks.onTextDelta(delta);
        });

        const response = await stream.finalMessage();

        // Track actual cost from response usage
        if (response.usage) {
          this.lastUsage = {
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
          };
        }

        // Process response blocks
        let hasToolUse = false;
        const turnToolResults: any[] = [];

        for (const block of response.content) {
          if (this.aborted) break;

          if (block.type === 'tool_use') {
            hasToolUse = true;
            const { id, name, input } = block;

            // Permission check (uses real PermissionManager)
            const perm = this.permissions
              ? this.permissions.check(name, input as Record<string, any>)
              : { needsPrompt: false, allowed: true, request: undefined };

            if (perm.needsPrompt && perm.request) {
              callbacks.onStep({
                id: `step_${Date.now()}_perm`,
                timestamp: Date.now(),
                type: 'permission',
                toolName: name,
                status: 'waiting_permission',
                description: perm.request.description,
              });

              const decision = await callbacks.onPermissionRequest(perm.request);
              this.permissions?.grant(name, decision.decision, decision.scope, decision.pathPattern);
              if (decision.decision === 'deny') {
                turnToolResults.push({
                  type: 'tool_result',
                  tool_use_id: id,
                  content: 'Permission denied by user. Try a different approach.',
                });
                toolResults.push({ tool: name, result: 'Permission denied' });
                continue;
              }
            }

            // Execute tool with timeout (check cache first)
            callbacks.onStep({
              id: `step_${Date.now()}_tool`,
              timestamp: Date.now(),
              type: 'tool_call',
              toolName: name,
              toolInput: input as Record<string, any>,
              status: 'running',
              description: name,
            });

            let result: string;
            let rawResult: string; // Uncompressed for synthesis
            const cachedResult = this.toolCache.get(name, input as Record<string, any>);
            if (cachedResult) {
              result = cachedResult;
              rawResult = cachedResult;
              console.log(`[Orchestrator] Cache hit for ${name}`);
            } else {
              try {
                result = await Promise.race([
                  executeTool(name, input as Record<string, any>),
                  new Promise<string>((_, reject) =>
                    setTimeout(() => reject(new Error(`Tool ${name} timed out after ${TOOL_TIMEOUT / 1000}s`)), TOOL_TIMEOUT)
                  ),
                ]);
                rawResult = result; // Preserve original before compression
                // Save to cache
                this.toolCache.set(name, input as Record<string, any>, result);
                // Invalidate read cache after writes
                if (name === 'write_file' || name === 'edit_file') {
                  this.toolCache.invalidate('read_file');
                  this.toolCache.invalidate('list_directory');
                  if ((input as any).file_path) this.toolCache.invalidatePath((input as any).file_path);
                }
              } catch (err: any) {
                result = JSON.stringify({ error: err.message });
                rawResult = result;
              }
            }

            // Store raw result for synthesis pipeline (before compression)
            this.contextManager.storeRawResult(step.id, name, rawResult!);

            // Compress for context window (model sees compressed version)
            const compressed = this.contextManager.compressToolResult(name, result, step.id);
            toolResults.push({ tool: name, result: compressed });

            callbacks.onStep({
              id: `step_${Date.now()}_result`,
              timestamp: Date.now(),
              type: 'tool_result',
              toolName: name,
              status: 'completed',
              result: compressed.substring(0, 16384),
            });

            // Handle screenshot results (send as image)
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
                toolContent = compressed;
              }
            } catch {
              toolContent = compressed;
            }

            turnToolResults.push({ type: 'tool_result', tool_use_id: id, content: toolContent });

            // Loop 3: Reactive — evaluate result
            const evaluation = this.evaluateResult(name, result, step, this.plan!);
            if (evaluation.shouldModifyPlan && evaluation.planModification) {
              this.applyPlanModification(evaluation.planModification);
            }
          }
        }

        // If model called tools, send results back for possible continuation
        if (hasToolUse && turnToolResults.length > 0) {
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: turnToolResults });

          // Check if model should continue (more tools to call in this step)
          if (response.stopReason === 'tool_use') {
            continue; // Let the model make another tool call
          }
        }

        // Step complete (either got tools or text-only response)
        break;

      } catch (err: any) {
        console.log(`[Orchestrator] Step ${step.id} turn ${turn} error:`, err.message);
        if (turn >= maxStepTurns - 1) {
          return { success: false, toolResults, summary: `Error: ${err.message}`, turnsUsed };
        }
      }
    }

    // Summarize step results
    const summary = toolResults.length > 0
      ? this.contextManager.summarizeStep(step.id, toolResults)
      : 'No tool results (text-only response)';

    // Store results for later phases
    this.completedResults.set(step.id, toolResults);

    // Update memory
    this.memory.decisions.push({
      what: `Step ${step.id}: ${step.action}`,
      why: toolResults.length > 0 ? 'Completed with tool calls' : 'Text-only response',
      stepId: step.id,
    });

    return {
      success: toolResults.length > 0 || step.tools.length === 0,
      toolResults,
      summary,
      turnsUsed,
    };
  }

  /**
   * Build a micro-prompt for a specific step.
   * Weak models get extremely directive prompts.
   * Strong models get lighter prompts.
   */
  private buildMicroPrompt(step: PlanStep, profile: ModelProfile): string {
    let prompt = `Your task: ${step.action}\n`;

    // THE SYNTHESIS MANDATE: inject structured data + format template for creation steps
    if (step.tools.includes('write_file') || step.tools.includes('generate_document')) {
      const collectedData = this.contextManager.getCompressedContext().collectedData;
      const goal = this.plan?.goal.toLowerCase() || '';

      if (collectedData) {
        prompt += `\nDATA TO INCLUDE (use EVERY item below — do NOT invent or summarize):\n${collectedData}\n`;
      }

      // Inject format-specific templates so the model knows EXACTLY what to produce
      if (step.tools.includes('write_file') && (goal.includes('html') || step.action.toLowerCase().includes('html'))) {
        prompt += `\nFORMAT: Create a well-structured HTML file. Use this structure:
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>[Title]</title>
<style>body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 20px;background:#1a1a2e;color:#eee}
h1{color:#10b981}h2{color:#0ea5e9;border-bottom:1px solid #333;padding-bottom:8px}
.article{margin:20px 0;padding:15px;background:#16213e;border-radius:8px;border-left:3px solid #10b981}
.article h3{margin:0 0 8px}a{color:#38bdf8}.source{color:#888;font-size:0.85em}</style></head>
<body><h1>[Title]</h1>
[For each item, create a div.article with h3 title (linked if URL exists), p summary, span.source]
</body></html>

CRITICAL: Each item from the DATA above must be a separate <div class="article"> block. Do NOT dump raw text. Format each as: title, summary, source link.\n`;
      }

      if (step.tools.includes('generate_document')) {
        prompt += `\nFORMAT: Create the document using generate_document tool. Include ALL data items from above as structured content, not placeholders like "Observation 1". Use the ACTUAL data.\n`;
      }

      prompt += `\nIMPORTANT: Do NOT create placeholder content. Do NOT use generic text like "Item 1", "Observation 1". Use the REAL data provided above.\n`;
    }

    // Progress context for models that need reminders
    if (profile.needsProgressReminders && this.plan) {
      const completed = this.plan.steps.filter(s => s.status === 'completed').length;
      prompt += `\nProgress: Step ${step.id} of ${this.plan.steps.length} (${completed} completed)\n`;
    }

    // Dependency results — but NOT for creation steps (they get synthesized data instead)
    const isCreationStep = step.tools.includes('write_file') || step.tools.includes('generate_document');
    if (!isCreationStep) {
      for (const depId of step.depends) {
        const depStep = this.plan?.steps.find(s => s.id === depId);
        if (depStep?.result) {
          prompt += `\nFrom previous step: ${depStep.result}\n`;
        }
      }
    }

    // Explicit tool instructions for weak models
    if (profile.needsExplicitStepInstructions && step.tools.length > 0) {
      // Check for MCP search tools (Tavily, Brave) — much better than read_web_content for research
      const availableTools = getAllTools();
      const tavilySearch = availableTools.find(t => t.name.includes('tavily') && t.name.includes('search'));
      const braveSearch = availableTools.find(t => t.name.includes('brave') && t.name.includes('search'));
      const searchMCPTool = tavilySearch || braveSearch;

      if (searchMCPTool && step.tools.includes('read_web_content')) {
        // Prefer MCP search over manual URL reading — returns structured results instantly
        const targetCount = this.extractTargetCount(this.plan?.goal || '') || 10;
        const searchQuery = this.plan?.goal.replace(/find|search|get|collect|gather|and.*$/gi, '').trim() || 'news';
        prompt += `\nYou have a SEARCH tool available: ${searchMCPTool.name}
Call it with: {"query": "${searchQuery}", "max_results": ${targetCount}}
This will return ${targetCount} results with titles, URLs, and snippets in ONE call.
This is MUCH better than reading individual web pages. USE THIS TOOL.\n`;
        prompt += `\nYou must use one of these tools: ${searchMCPTool.name}, ${step.tools.join(', ')}\n`;
      } else {
        prompt += `\nYou must use one of these tools: ${step.tools.join(', ')}\n`;
      }

      // Provide concrete URLs as fallback for web research steps (when no MCP search)
      if (step.tools.includes('read_web_content') && !searchMCPTool) {
        const goal = this.plan?.goal.toLowerCase() || '';
        let suggestedUrls: string[] = [];

        if (goal.includes('ai') || goal.includes('artificial intelligence')) {
          suggestedUrls = [
            'https://news.ycombinator.com',
            'https://www.theverge.com/ai-artificial-intelligence',
            'https://techcrunch.com/category/artificial-intelligence/',
            'https://arstechnica.com/ai/',
            'https://www.wired.com/tag/artificial-intelligence/',
            'https://venturebeat.com/category/ai/',
            'https://www.technologyreview.com/topic/artificial-intelligence/',
          ];
        } else if (goal.includes('tech') || goal.includes('technology')) {
          suggestedUrls = [
            'https://news.ycombinator.com',
            'https://www.theverge.com/tech',
            'https://techcrunch.com',
            'https://arstechnica.com',
            'https://www.wired.com',
            'https://venturebeat.com',
          ];
        } else if (goal.includes('sport')) {
          suggestedUrls = [
            'https://www.espn.com',
            'https://www.bbc.com/sport',
            'https://sports.yahoo.com',
          ];
        } else if (goal.includes('news')) {
          suggestedUrls = [
            'https://news.google.com',
            'https://www.bbc.com/news',
            'https://www.reuters.com',
          ];
        }

        if (suggestedUrls.length > 0) {
          const alreadyRead = [...this.completedResults.values()].flat()
            .filter(r => r.tool === 'read_web_content')
            .map(r => r.result).join(' ');
          const unused = suggestedUrls.filter(u => !alreadyRead.includes(u));
          if (unused.length > 0) {
            prompt += `\nCall read_web_content NOW with one of these URLs:\n${unused.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n`;
          }
        } else {
          prompt += '\nCall read_web_content with a relevant URL for the topic.\n';
        }
      } // end if (!searchMCPTool)
      if (step.tools.includes('write_file') && step.tools.includes('system_open')) {
        prompt += '\nTip: After creating the file with write_file, use system_open to open it.\n';
      }
      if (step.tools.includes('write_file') && !step.action.toLowerCase().includes('overwrite')) {
        prompt += '\nTip: If the file already exists, use a _v2 suffix to avoid overwriting.\n';
      }

      prompt += profile.forceToolSuffix;
    }

    // Memory context (inject agent's running state)
    if (this.memory.decisions.length > 0) {
      const recentDecisions = this.memory.decisions.slice(-3);
      prompt += `\nRecent decisions: ${recentDecisions.map(d => d.what).join('; ')}\n`;
    }

    return prompt;
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2.5: SYNTHESIS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * THE SYNTHESIS MANDATE:
   * Never send "based on what you found, create X".
   * Instead, pre-digest data into structured brief.
   *
   * For strong models: ask model to synthesize.
   * For weak models: code-based extraction.
   */
  async synthesize(
    plan: ExecutionPlan,
    adapter: ModelAdapter,
    profile: ModelProfile,
  ): Promise<SynthesizedBrief> {
    // Collect all research results — use RAW (uncompressed) data for synthesis
    const allResults: string[] = [];
    const rawResults = this.contextManager.getRawResults();
    for (const step of plan.steps) {
      if (step.status === 'completed') {
        const results = rawResults.get(step.id);
        if (results) {
          for (const r of results) {
            if (r.tool === 'read_web_content' || r.tool === 'read_file' || r.tool === 'read_active_file') {
              allResults.push(r.result);
            }
          }
        }
      }
    }

    if (allResults.length === 0) {
      return { items: [], textSummary: '', totalCount: 0 };
    }

    if (profile.planningCapability === 'strong') {
      return this.modelSynthesize(allResults, plan, adapter, profile);
    }

    // For weak models: try code-based extraction first
    const codeBrief = this.codeSynthesize(allResults, plan);
    const targetCount = this.extractTargetCount(plan.goal);

    // If code extraction found very few items, fall back to model-based extraction
    // (even weak models can extract from a focused prompt)
    if (targetCount && codeBrief.totalCount < targetCount * 0.5 && allResults.join('').length > 500) {
      console.log(`[Orchestrator] Code synthesis found only ${codeBrief.totalCount}/${targetCount} items, trying model synthesis`);
      try {
        return await this.modelSynthesize(allResults, plan, adapter, profile);
      } catch {
        return codeBrief; // Fall back to code results if model fails
      }
    }
    return codeBrief;
  }

  /**
   * Model-based synthesis — ask a strong model to digest results.
   */
  private async modelSynthesize(
    results: string[],
    plan: ExecutionPlan,
    adapter: ModelAdapter,
    profile: ModelProfile,
  ): Promise<SynthesizedBrief> {
    const combinedText = results.join('\n---\n').substring(0, 30000); // Cap at 30K chars

    const targetCount = this.extractTargetCount(plan.goal);

    try {
      const stream = adapter.stream({
        system: 'You are a data extraction assistant. Extract INDIVIDUAL items from web page content. Return ONLY valid JSON.',
        messages: [{
          role: 'user',
          content: `TASK: Extract ${targetCount || 'all'} individual articles/items from this web content.

RAW WEB DATA:
${combinedText}

Extract each SEPARATE article/item. Look for:
- Article titles (headings, link text, list items)
- URLs/links associated with each article
- Source website names
- Brief descriptions or summaries

Return ONLY this JSON (no other text):
{"items":[{"title":"Full article title","url":"https://...","source":"website.com","summary":"1-2 sentence description"}],"textSummary":"Overall summary"}

RULES:
- Each item must have a REAL title from the content, not generic text
- Extract at least ${targetCount || 5} items if available
- Do NOT merge multiple articles into one
- Do NOT use placeholder text like "Article 1"`,
        }],
        tools: [],
        maxTokens: 2048,
      });

      let rawText = '';
      stream.onText((d) => { rawText += d; });
      await stream.finalMessage();

      try {
        const parsed = JSON.parse(rawText.match(/\{[\s\S]*\}/)?.[0] || '{}');
        return {
          items: parsed.items || [],
          textSummary: parsed.textSummary || rawText.substring(0, 500),
          totalCount: parsed.items?.length || 0,
        };
      } catch {
        return { items: [], textSummary: rawText.substring(0, 500), totalCount: 0 };
      }
    } catch {
      // Fall back to code synthesis
      return this.codeSynthesize(results, plan);
    }
  }

  /**
   * Code-based synthesis — regex/string extraction for weak models.
   * Extracts titles, URLs, dates from raw text without a model call.
   */
  /**
   * Code-based synthesis — multi-strategy extraction from raw web content.
   * Uses 5 strategies to handle different web page formats:
   * markdown headings, HN-style posts, HTML tags, link text, and fallback lines.
   */
  private codeSynthesize(
    results: string[],
    _plan: ExecutionPlan,
  ): SynthesizedBrief {
    const items: SynthesizedBrief['items'] = [];
    const combined = results.join('\n');

    // Extract all URLs for association with titles
    const urlPattern = /https?:\/\/[^\s"'<>\])+]+/g;
    const urls = [...new Set(combined.match(urlPattern) || [])];

    let match: RegExpExecArray | null;

    // Strategy 0: Parse structured MCP search results (Tavily/Brave return JSON)
    for (const resultText of results) {
      try {
        const parsed = JSON.parse(resultText);
        // Tavily format: { results: [{ title, url, content, score }] }
        if (parsed.results && Array.isArray(parsed.results)) {
          for (const r of parsed.results) {
            if (r.title && !this.isDuplicateTitle(items, r.title)) {
              items.push({
                title: r.title,
                url: r.url,
                source: r.url ? safeHostname(r.url) : undefined,
                summary: r.content?.substring(0, 200) || r.snippet || r.description || '',
                date: r.published_date || r.date,
              });
            }
          }
        }
        // Brave format: { web: { results: [{ title, url, description }] } }
        if (parsed.web?.results && Array.isArray(parsed.web.results)) {
          for (const r of parsed.web.results) {
            if (r.title && !this.isDuplicateTitle(items, r.title)) {
              items.push({
                title: r.title,
                url: r.url,
                source: r.url ? safeHostname(r.url) : undefined,
                summary: r.description || '',
              });
            }
          }
        }
        // Direct array of results: [{ title, url, ... }]
        if (Array.isArray(parsed)) {
          for (const r of parsed) {
            if (r.title && !this.isDuplicateTitle(items, r.title)) {
              items.push({
                title: r.title,
                url: r.url,
                source: r.url ? safeHostname(r.url) : undefined,
                summary: r.content?.substring(0, 200) || r.snippet || r.description || '',
              });
            }
          }
        }
      } catch {
        // Not JSON — fall through to regex strategies
      }
    }

    // If structured parsing found enough items, return early
    if (items.length >= 5) {
      console.log(`[Orchestrator] codeSynthesize: ${items.length} items from structured MCP results`);
      return { items, textSummary: items.map(i => i.title).join(', '), totalCount: items.length };
    }

    // Strategy 1: Markdown-style headings (# Title, 1. Title, - Title)
    const markdownPattern = /^(?:#{1,3}\s+|(?:\d+[\.\)]\s+)|(?:[-*]\s+))(.{10,120})$/gm;
    while ((match = markdownPattern.exec(combined)) !== null) {
      const title = match[1].trim();
      if (!NAV_PATTERNS.test(title)) {
        items.push(this.matchTitleToUrl(title, match.index, combined, urls));
      }
    }

    // Strategy 2: Hacker News-style: "Title (domain.com)" on its own line
    const hnPattern = /^(.{15,120})\s*\([\w.-]+\.\w+\)\s*$/gm;
    while ((match = hnPattern.exec(combined)) !== null) {
      const title = match[1].trim();
      if (!NAV_PATTERNS.test(title) && !this.isDuplicateTitle(items, title)) {
        items.push(this.matchTitleToUrl(title, match.index, combined, urls));
      }
    }

    // Strategy 3: HTML heading tags (<h1>, <h2>, <h3>, <title>)
    const htmlHeadingPattern = /<(?:h[1-3]|title)[^>]*>([^<]{10,150})<\//gi;
    while ((match = htmlHeadingPattern.exec(combined)) !== null) {
      const title = match[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      if (!NAV_PATTERNS.test(title) && !this.isDuplicateTitle(items, title)) {
        items.push(this.matchTitleToUrl(title, match.index, combined, urls));
      }
    }

    // Strategy 4: Link text — [Title](url) and <a href="...">Title</a>
    const mdLinkPattern = /\[([^\]]{10,120})\]\(([^)]+)\)/g;
    while ((match = mdLinkPattern.exec(combined)) !== null) {
      const title = match[1].trim();
      if (!NAV_PATTERNS.test(title) && !this.isDuplicateTitle(items, title)) {
        items.push({ title, url: match[2], source: safeHostname(match[2]) });
      }
    }

    const htmlLinkPattern = /<a[^>]+href="([^"]+)"[^>]*>([^<]{10,120})<\/a>/gi;
    while ((match = htmlLinkPattern.exec(combined)) !== null) {
      const title = match[2].trim();
      if (!NAV_PATTERNS.test(title) && !this.isDuplicateTitle(items, title)) {
        items.push({ title, url: match[1], source: safeHostname(match[1]) });
      }
    }

    // Strategy 5 (fallback): Substantive lines that look like article titles
    if (items.length < 5) {
      const lines = combined.split('\n')
        .map(l => l.trim())
        .filter(l =>
          l.length > 25 && l.length < 150 &&
          !l.startsWith('http') &&
          !NAV_PATTERNS.test(l) &&
          !l.match(/^\d+\s*(points?|comments?|replies|views|shares|ago)/i) &&
          !l.match(/^(by |submitted |posted )/i) &&
          // Must start with a capital letter or number (looks like a title)
          /^[A-Z0-9"']/.test(l)
        );
      for (const line of lines.slice(0, 30)) {
        const cleaned = line.replace(/^[-*•|>]\s*/, '').replace(/^\d+\.\s*/, '');
        if (cleaned.length > 25 && !this.isDuplicateTitle(items, cleaned)) {
          items.push(this.matchTitleToUrl(cleaned, combined.indexOf(line), combined, urls));
        }
      }
    }

    // Deduplicate by title
    const seen = new Set<string>();
    const unique = items.filter(item => {
      const key = item.title.toLowerCase().substring(0, 50);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log(`[Orchestrator] codeSynthesize extracted ${unique.length} items from ${results.length} sources`);

    return {
      items: unique,
      textSummary: combined.substring(0, 500),
      totalCount: unique.length,
    };
  }

  /** Check if a title already exists in the items list */
  private isDuplicateTitle(items: SynthesizedBrief['items'], title: string): boolean {
    const lower = title.toLowerCase().substring(0, 50);
    return items.some(i => i.title.toLowerCase().substring(0, 50) === lower);
  }

  /** Match a title to the nearest URL in the combined text */
  private matchTitleToUrl(
    title: string,
    titlePos: number,
    combined: string,
    urls: string[],
  ): SynthesizedBrief['items'][0] {
    const nearbyUrl = urls.find(url => {
      const urlPos = combined.indexOf(url, Math.max(0, titlePos - 300));
      return urlPos >= 0 && urlPos < titlePos + 500;
    });
    return { title, url: nearbyUrl, source: nearbyUrl ? safeHostname(nearbyUrl) : undefined };
  }

  // ══════════════════════════════════════════════════════════════════════
  // DIRECT OUTPUT GENERATION (bypass model for structured data)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * When we have structured data (from MCP search or synthesis), generate
   * the output file directly in code instead of asking the model.
   * This produces reliable, high-quality output regardless of model capability.
   *
   * Returns the file path if generated, null if not applicable.
   */
  async generateOutputDirectly(
    plan: ExecutionPlan,
    brief: SynthesizedBrief,
  ): Promise<string | null> {
    const goal = plan.goal.toLowerCase();
    const wantsHTML = goal.includes('html') || goal.includes('web page') || goal.includes('webpage');
    const wantsFile = wantsHTML || goal.includes('file') || goal.includes('report') || goal.includes('list');

    if (!wantsFile || brief.items.length === 0) return null;

    // Find the Desktop path
    let outputDir = '';
    try {
      const result = await executeTool('run_shell', { command: 'echo $env:USERPROFILE\\Desktop' });
      const parsed = JSON.parse(result);
      outputDir = (parsed.stdout || parsed.output || '').trim();
    } catch {
      outputDir = 'C:\\Users\\Default\\Desktop';
    }

    // Generate filename from goal
    const fileBase = plan.goal
      .replace(/find|search|get|collect|gather|create|make|build|generate|write|and|an?|the|into|from/gi, '')
      .trim().replace(/\s+/g, '_').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 40) || 'output';

    if (wantsHTML) {
      return this.generateHTMLDirect(brief, outputDir, fileBase);
    }

    return null;
  }

  /**
   * Generate a styled HTML file directly from structured data.
   * No model involved — pure code generation.
   */
  private async generateHTMLDirect(
    brief: SynthesizedBrief,
    outputDir: string,
    fileBase: string,
  ): Promise<string> {
    const items = brief.items;
    const title = this.plan?.goal || 'Results';

    const articleCards = items.map((item, i) => {
      const titleHtml = item.url
        ? `<a href="${this.escapeHtml(item.url)}" target="_blank">${this.escapeHtml(item.title)}</a>`
        : this.escapeHtml(item.title);
      const summaryHtml = item.summary ? `<p>${this.escapeHtml(item.summary)}</p>` : '';
      const sourceHtml = item.source ? `<span class="source">${this.escapeHtml(item.source)}</span>` :
                         item.url ? `<span class="source">${this.escapeHtml(item.url)}</span>` : '';
      const dateHtml = item.date ? `<span class="date">${this.escapeHtml(item.date)}</span>` : '';

      return `    <div class="article">
      <h3>${titleHtml}</h3>
      ${summaryHtml}
      <div class="meta">${sourceHtml}${dateHtml ? ' &middot; ' + dateHtml : ''}</div>
    </div>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${this.escapeHtml(title)}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f172a; color: #e2e8f0;
      max-width: 900px; margin: 0 auto; padding: 40px 20px;
    }
    h1 { color: #10b981; font-size: 2rem; margin-bottom: 8px; }
    .subtitle { color: #64748b; margin-bottom: 32px; font-size: 0.9rem; }
    .article {
      background: #1e293b; border-radius: 12px; padding: 20px;
      margin-bottom: 16px; border-left: 4px solid #10b981;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    .article:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 25px rgba(16, 185, 129, 0.15);
    }
    .article h3 { font-size: 1.1rem; margin-bottom: 8px; line-height: 1.4; }
    .article h3 a { color: #38bdf8; text-decoration: none; }
    .article h3 a:hover { text-decoration: underline; }
    .article p { color: #94a3b8; font-size: 0.95rem; line-height: 1.6; margin-bottom: 8px; }
    .meta { color: #64748b; font-size: 0.8rem; }
    .source { background: #334155; padding: 2px 8px; border-radius: 4px; }
    .footer { text-align: center; color: #475569; margin-top: 40px; font-size: 0.8rem; }
  </style>
</head>
<body>
  <h1>${this.escapeHtml(title)}</h1>
  <p class="subtitle">Generated by KLYPIX Agent &middot; ${items.length} items &middot; ${new Date().toLocaleDateString()}</p>
${articleCards}
  <div class="footer">Generated by KLYPIX Agent</div>
</body>
</html>`;

    const filePath = `${outputDir}\\${fileBase}.html`;

    try {
      await executeTool('write_file', { file_path: filePath, content: html });
      this.contextManager.recordFileOperation(filePath, 'create', `HTML with ${items.length} items`);
      console.log(`[Orchestrator] Direct HTML generation: ${filePath} (${items.length} items)`);
      return filePath;
    } catch (err: any) {
      // Try without dir path
      const fallbackPath = `${fileBase}.html`;
      await executeTool('write_file', { file_path: fallbackPath, content: html });
      return fallbackPath;
    }
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ══════════════════════════════════════════════════════════════════════
  // COGNITIVE LOOPS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Loop 3: Reactive — Evaluate a tool result after execution.
   * Classifies result quality, counts extracted items, decides plan modifications.
   */
  private evaluateResult(
    toolName: string,
    result: string,
    step: PlanStep,
    plan: ExecutionPlan,
  ): ResultEvaluation {
    let parsed: any;
    try { parsed = JSON.parse(result); } catch { parsed = null; }

    const isError = parsed?.error || result.includes('"error"') || result.length < 50;
    const isNullContent = parsed?.content === null || result === '{"content":null}' || result.includes('"content":null');
    const isEmpty = (result.length < 100 && !result.includes('success')) || isNullContent;

    // Web content quality check — reject navigation/login pages
    if (toolName === 'read_web_content' && !isError && !isEmpty && result.length > 100) {
      const first300 = result.substring(0, 300).toLowerCase();
      const isLoginPage = /sign\s*in|log\s*in|create\s*account|subscribe\s*to|cookie\s*consent|accept\s*all/i.test(first300);
      const sentenceCount = (result.match(/[.!?]\s+[A-Z]/g) || []).length;
      const isNavOnly = result.length < 400 && sentenceCount < 2;

      if (isLoginPage || isNavOnly) {
        console.log(`[Orchestrator] Low-quality web content detected (login/nav page), marking as partial`);
        this.contextManager.recordError(
          `${toolName} returned low-quality content (login/navigation page)`,
          step.retries < step.maxRetries ? 'Will retry with different URL' : 'Moving on',
        );
        return {
          success: false,
          dataQuality: 'partial',
          extractedItems: 0,
          shouldContinueStep: step.retries < step.maxRetries,
          shouldModifyPlan: false,
        };
      }
    }

    if (isError || isEmpty) {
      // Record error for context
      this.contextManager.recordError(
        `${toolName} returned ${isError ? 'error' : 'empty'}`,
        step.retries < step.maxRetries ? 'Will retry' : 'Moving on',
      );
      return {
        success: false,
        dataQuality: isError ? 'error' : 'empty',
        extractedItems: 0,
        shouldContinueStep: step.retries < step.maxRetries,
        shouldModifyPlan: false,
      };
    }

    // For data-gathering steps, check if target count is met
    const targetCount = this.extractTargetCount(plan.goal);
    if (targetCount) {
      const totalCollected = this.countCollectedItems();
      if (totalCollected >= targetCount) {
        // Target met — skip remaining search steps
        const searchSteps = plan.steps.filter(s =>
          s.status === 'pending' && s.tools.includes('read_web_content')
        );
        if (searchSteps.length > 0) {
          return {
            success: true,
            dataQuality: 'good',
            extractedItems: totalCollected,
            shouldContinueStep: false,
            shouldModifyPlan: true,
            planModification: { skipSteps: searchSteps.map(s => s.id) },
          };
        }
      }
    }

    return {
      success: true,
      dataQuality: result.length > 1000 ? 'good' : 'partial',
      extractedItems: 0,
      shouldContinueStep: false,
      shouldModifyPlan: false,
    };
  }

  /**
   * Loop 4: Meta — Detect if the agent is stalled.
   */
  detectStall(recentSteps: AgentStep[]): StallDetection {
    const last5 = recentSteps.slice(-5);

    // Pattern 1: Same tool called 3+ times with same input
    const toolInputPairs = last5
      .filter(s => s.type === 'tool_call')
      .map(s => `${s.toolName}:${JSON.stringify(s.toolInput || {}).slice(0, 50)}`);
    const hasDuplicates = toolInputPairs.length > 2 &&
      new Set(toolInputPairs).size < toolInputPairs.length - 1;

    // Pattern 2: 3+ consecutive errors
    const consecutiveErrors = last5.filter(s => s.status === 'error').length >= 3;

    // Pattern 3: Text-only turns (narrating instead of acting)
    const textOnlyTurns = last5.filter(s => s.type === 'text' && !s.toolName);
    const tooMuchTalking = textOnlyTurns.length >= 3;

    const isStalled = hasDuplicates || consecutiveErrors || tooMuchTalking;

    return {
      isStalled,
      reason: hasDuplicates ? 'repeated_tool_calls' :
              consecutiveErrors ? 'consecutive_errors' :
              tooMuchTalking ? 'narrating_not_acting' : 'none',
      recommendation: hasDuplicates ? 'Change tool input or skip step' :
                      consecutiveErrors ? 'Try alternative approach' :
                      tooMuchTalking ? 'Force tool use, reduce maxTokens' : 'Continue',
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // INNOVATION #2: SPECULATIVE EXECUTION (Parallel Betting)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * While executing the current step, speculatively start the next step
   * if it only uses read-only tools and doesn't depend on the current step's RESULT.
   * If the current step succeeds, speculative work saves time. If it fails, discard.
   */
  async executeWithSpeculation(
    currentStep: PlanStep,
    nextStep: PlanStep | undefined,
    adapter: ModelAdapter,
    callbacks: AgentCallbacks,
    profile: ModelProfile,
  ): Promise<{ currentResult: StepResult; specResult: StepResult | null }> {
    // Determine if we can speculate on the next step
    const readOnlyTools = ['capture_screenshot', 'get_active_window', 'read_active_file',
      'get_all_open_files', 'clipboard_read', 'read_file', 'list_directory', 'read_web_content'];

    const canSpeculate = nextStep &&
      nextStep.status === 'pending' &&
      !nextStep.depends.includes(currentStep.id) &&
      nextStep.tools.every(t => readOnlyTools.includes(t));

    // Start current step
    const currentPromise = this.executeStep(currentStep, adapter, callbacks, profile);

    let specPromise: Promise<StepResult> | null = null;
    if (canSpeculate && nextStep) {
      console.log(`[Orchestrator] Speculative execution: starting step ${nextStep.id} in parallel`);
      specPromise = this.executeStep(nextStep, adapter, callbacks, profile).catch((err): StepResult => {
        console.log(`[Orchestrator] Speculative step ${nextStep.id} failed:`, err);
        return { success: false, toolResults: [], summary: 'Speculative execution failed', turnsUsed: 0 };
      });
    }

    const currentResult = await currentPromise;

    let specResult: StepResult | null = null;
    if (currentResult.success && specPromise) {
      specResult = await specPromise;
      if (specResult.success) {
        console.log(`[Orchestrator] Speculative step ${nextStep!.id} succeeded — saved a round trip`);
      }
    }

    return { currentResult, specResult };
  }

  // ══════════════════════════════════════════════════════════════════════
  // INNOVATION #5: STREAMING ARTIFACT CREATION (Pipeline Execution)
  // ══════════════════════════════════════════════════════════════════════

  /**
   * For data-gathering tasks, start writing the output file as data arrives
   * instead of waiting for all data. Each research result gets appended.
   *
   * Returns true if pipeline execution was used, false if not applicable.
   */
  async pipelineExecution(
    plan: ExecutionPlan,
    adapter: ModelAdapter,
    callbacks: AgentCallbacks,
    profile: ModelProfile,
  ): Promise<boolean> {
    // Only applicable for "find N items and create file" patterns
    const targetCount = this.extractTargetCount(plan.goal);
    if (!targetCount) return false;

    const researchSteps = plan.steps.filter(s => s.tools.includes('read_web_content'));
    const creationSteps = plan.steps.filter(s =>
      s.tools.includes('write_file') || s.tools.includes('generate_document')
    );
    if (researchSteps.length === 0 || creationSteps.length === 0) return false;

    console.log('[Orchestrator] Using pipeline execution: streaming artifact creation');

    // Determine output path
    let outputPath = '';
    try {
      const desktopResult = await executeTool('run_shell', { command: 'echo $env:USERPROFILE\\Desktop' });
      const parsed = JSON.parse(desktopResult);
      outputPath = (parsed.stdout || parsed.output || '').trim() + '\\output.html';
    } catch {
      outputPath = 'C:\\Users\\Default\\Desktop\\output.html';
    }

    // Create HTML skeleton
    let htmlContent = `<!DOCTYPE html>\n<html>\n<head><meta charset="UTF-8"><title>${plan.goal}</title>\n<style>body{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;padding:0 20px}h1{color:#10b981}.item{border-bottom:1px solid #eee;padding:15px 0}</style>\n</head>\n<body>\n<h1>${plan.goal}</h1>\n<p>Collecting data...</p>\n<div id="items">\n`;

    await executeTool('write_file', { file_path: outputPath, content: htmlContent + '</div></body></html>' });
    console.log(`[Orchestrator] Pipeline: created initial file ${outputPath}`);
    this.toolCache.invalidate('read_file');
    this.toolCache.invalidate('list_directory');

    // Execute research steps, appending to file as data arrives
    let itemCount = 0;
    for (const step of researchSteps) {
      if (this.aborted) break;
      if (itemCount >= targetCount) {
        step.status = 'skipped';
        continue;
      }

      step.status = 'running';
      const result = await this.executeStep(step, adapter, callbacks, profile);

      if (result.success) {
        step.status = 'completed';
        step.result = result.summary;
        this.completedResults.set(step.id, result.toolResults);

        // Append extracted items to HTML
        for (const tr of result.toolResults) {
          if (tr.tool === 'read_web_content' && tr.result.length > 100) {
            itemCount++;
            htmlContent += `<div class="item"><strong>Item ${itemCount}</strong><br>${tr.result.substring(0, 500).replace(/</g, '&lt;')}</div>\n`;
          }
        }

        // Update file with new content
        await executeTool('write_file', {
          file_path: outputPath,
          content: htmlContent + '</div>\n<p><em>Updated: ' + itemCount + ' items collected</em></p>\n</body></html>',
        });
        console.log(`[Orchestrator] Pipeline: added items (${itemCount} total)`);
      } else {
        step.status = 'failed';
      }
    }

    // Finalize the HTML
    htmlContent += '</div>\n<p><em>Total: ' + itemCount + ' items</em></p>\n</body></html>';
    await executeTool('write_file', { file_path: outputPath, content: htmlContent });
    this.contextManager.recordFileOperation(outputPath, 'create', `HTML with ${itemCount} items`);

    // Skip creation steps (we already created the file)
    for (const step of creationSteps) {
      step.status = 'completed';
      step.result = `File already created via pipeline: ${outputPath}`;
    }

    console.log(`[Orchestrator] Pipeline complete: ${outputPath} (${itemCount} items)`);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ADAPTIVE TURN BUDGETING
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Allocate turns per step based on tool type and model weakness.
   */
  private allocateTurnBudget(plan: ExecutionPlan, profile: ModelProfile): void {
    let total = 0;

    for (const step of plan.steps) {
      let stepBudget: number;

      if (step.tools.includes('read_web_content')) {
        stepBudget = 2;
      } else if (step.tools.includes('write_file') || step.tools.includes('generate_document')) {
        stepBudget = 2;
      } else if (step.tools.includes('run_shell')) {
        stepBudget = 3;
      } else if (step.tools.length === 0) {
        stepBudget = 1;
      } else {
        stepBudget = 2;
      }

      // Weak models need more turns per step
      if (profile.earlyTerminationRisk === 'high') {
        stepBudget = Math.ceil(stepBudget * 1.5);
      }

      this.turnBudget.perStep.set(step.id, stepBudget);
      total += stepBudget;
    }

    // Add verification budget
    total += 2;

    // Clamp to hard ceiling
    this.turnBudget.total = Math.min(total, this.turnBudget.hardCeiling);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PLAN MODIFICATION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Apply dynamic plan modifications (skip/add steps).
   */
  private applyPlanModification(mod: ResultEvaluation['planModification']): void {
    if (!mod || !this.plan) return;

    if (mod.skipSteps) {
      for (const id of mod.skipSteps) {
        const step = this.plan.steps.find(s => s.id === id);
        if (step && step.status === 'pending') {
          step.status = 'skipped';
          console.log(`[Orchestrator] Skipping step ${id}: target met`);
          this.memory.decisions.push({
            what: `Skipped step ${id}`,
            why: 'Target count already met',
            stepId: id,
          });
        }
      }
    }

    if (mod.addSteps) {
      for (const newStep of mod.addSteps) {
        this.plan.steps.push(newStep);
        console.log(`[Orchestrator] Added step ${newStep.id}: ${newStep.action}`);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Extract a numeric target count from the plan goal.
   * E.g., "Find 20 AI news articles" → 20
   */
  private extractTargetCount(goal: string): number | null {
    const match = goal.match(/(\d+)\s+(?:articles?|items?|results?|files?|entries|records|news|sources?|links?|examples?|tips?|facts?|points?)/i);
    return match ? parseInt(match[1]) : null;
  }

  /**
   * Count how many substantive data items have been collected.
   */
  private countCollectedItems(): number {
    let count = 0;
    for (const [, results] of this.completedResults) {
      for (const r of results) {
        if (r.tool === 'read_web_content' && r.result.length > 100) {
          count++;
        }
      }
    }
    return count;
  }

  /** Get the current plan */
  getPlan(): ExecutionPlan | null { return this.plan; }

  /** Get current turn usage */
  getTotalTurnsUsed(): number { return this.totalTurnsUsed; }

  /** Get agent memory */
  getMemory(): AgentMemory { return this.memory; }

  /** Get context manager */
  getContextManager(): ContextManager { return this.contextManager; }

  /** Get last response usage (for cost tracking) and reset */
  consumeLastUsage(): { inputTokens: number; outputTokens: number } | null {
    const usage = this.lastUsage;
    this.lastUsage = null;
    return usage;
  }

  /** Get the tool cache */
  getToolCache(): ToolCache { return this.toolCache; }

  /**
   * Innovation #14: Generate data-driven post-task suggestions
   * based on what was created/discovered during execution.
   */
  generateSmartSuggestions(): Array<{ text: string; action: string }> {
    const suggestions: Array<{ text: string; action: string }> = [];
    if (!this.plan) return suggestions;

    // Check what files were created
    for (const [, results] of this.completedResults) {
      for (const r of results) {
        if (r.tool === 'write_file' || r.tool === 'generate_document') {
          try {
            const parsed = JSON.parse(r.result);
            const filePath = parsed.path || parsed.filePath || '';
            if (filePath.endsWith('.html')) {
              suggestions.push({ text: 'Open HTML in browser', action: `Open ${filePath}` });
              suggestions.push({ text: 'Convert to PDF', action: `Convert ${filePath} to PDF` });
            } else if (filePath.endsWith('.xlsx')) {
              suggestions.push({ text: 'Create charts from this data', action: `Create charts from ${filePath}` });
              suggestions.push({ text: 'Generate presentation', action: `Make a PPTX from ${filePath}` });
            } else if (filePath.endsWith('.docx') || filePath.endsWith('.pdf')) {
              suggestions.push({ text: 'Translate this document', action: `Translate ${filePath}` });
            }
          } catch { /* */ }
        }
      }
    }

    // If web data was gathered
    const webReads = [...this.completedResults.values()]
      .flat().filter(r => r.tool === 'read_web_content').length;
    if (webReads > 3) {
      suggestions.push({ text: 'Summarize key trends', action: 'Analyze the trends from the data gathered' });
    }

    // If desktop was scanned
    if (this.plan.goal.toLowerCase().includes('desktop') || this.plan.goal.toLowerCase().includes('organize')) {
      suggestions.push({ text: 'Schedule weekly cleanup', action: 'Set up auto-organization schedule' });
    }

    return suggestions.slice(0, 3);
  }
}
