# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Agent Engine: Orchestration Enhancement Plan

## Complete Architecture Analysis & Implementation Blueprint

**Date:** April 4, 2026
**Author:** Claude Opus (Cowork Analysis)
**Scope:** Transform the KLYPIX agent loop from a passive model-relay into an intelligent orchestration layer that closes the quality gap between Claude and weaker models (Gemini Flash, GLM, GPT-4o).

---

## PART 1: CURRENT ARCHITECTURE DEEP-DIVE

### 1.1 File Inventory (1,955 Lines Total)

| File | Lines | Role |
|------|-------|------|
| `src/core/agent/claudeAgent.ts` | 336 | Main agent loop, system prompt, retry logic |
| `src/core/agent/modelAdapter.ts` | 84 | Provider-agnostic interface (`ModelAdapter`) |
| `src/core/agent/toolRegistry.ts` | 268 | 22 tool definitions with JSON schemas + permission levels |
| `src/core/agent/toolExecutor.ts` | 137 | Maps tool names to Electron IPC calls |
| `src/core/agent/permissions.ts` | 112 | Session/path grants, trust mode |
| `src/core/agent/costTracker.ts` | 94 | Token counting, daily budget enforcement |
| `src/core/agent/shellGuard.ts` | 64 | PowerShell command blocklist (22 patterns) |
| `src/core/agent/smartRouter.ts` | 79 | Gemini Flash classifier (CHAT vs AGENT) |
| `src/core/agent/agentSession.ts` | 90 | Session manager with history persistence |
| `src/core/agent/adapters/claudeAdapter.ts` | 46 | Anthropic SDK streaming adapter |
| `src/core/agent/adapters/geminiAdapter.ts` | 102 | Google Generative AI SDK adapter |
| `src/core/agent/adapters/openaiAdapter.ts` | 138 | OpenAI-compatible fetch adapter |
| `src/core/agent/adapters/glmAdapter.ts` | 139 | Z.ai/ZhipuAI fetch adapter |
| `src/core/agent/adapters/index.ts` | 25 | Factory: `createAdapter(provider, key, model)` |
| `src/hooks/useClaudeAgent.ts` | 241 | React hook: lifecycle, permissions, file tracking |

### 1.2 Current Agent Loop Flow (claudeAgent.ts)

```
User sends prompt + screenshot + windowContext
          |
          v
   ┌─────────────────────────────────┐
   │  for turn = 0 to 24 (MAX_TURNS) │
   │                                   │
   │  1. Check for injected follow-up  │
   │  2. Call adapter.stream()         │
   │     - system prompt (static)      │
   │     - full message history        │
   │     - all 22 tools                │
   │     - maxTokens: 4096             │
   │  3. Collect streaming text deltas │
   │  4. await stream.finalMessage()   │
   │  5. For each tool_use block:      │
   │     a. Permission check           │
   │     b. Execute tool (30s timeout) │
   │     c. Collect result             │
   │  6. If no tool_use -> DONE        │
   │  7. If tool_use -> append results │
   │     to messages[] and LOOP        │
   │                                   │
   │  Retry: 3x with exp backoff on   │
   │  429/529/5xx errors               │
   └─────────────────────────────────┘
```

### 1.3 The ModelAdapter Interface

```typescript
interface ModelAdapter {
  readonly provider: string;
  readonly modelId: string;
  stream(opts: {
    system: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
  }): {
    onText: (cb: (delta: string) => void) => void;
    finalMessage: () => Promise<MessageComplete>;
  };
}
```

All 4 adapters implement this identically. The agent loop never touches provider SDKs directly. This is good design -- the orchestration layer can sit between `ClaudeAgent` and the adapters without breaking anything.

### 1.4 The 22 Tools

**Always Allow (no permission prompt):** `capture_screenshot`, `get_active_window`, `read_active_file`, `get_all_open_files`, `clipboard_read`, `clipboard_write`

**Ask First (once per session):** `read_file`, `list_directory`, `browser_navigate`, `read_web_content`, `system_open`

**Ask Every (every invocation):** `write_file`, `edit_file`, `file_move`, `file_delete`, `run_shell`, `browser_click`, `browser_fill`, `system_type`, `generate_document`

### 1.5 Adapter-Specific Issues

**Claude Adapter (46 lines):** Thin wrapper around `@anthropic-ai/sdk`. Tool calling is native -- Anthropic's API was designed for tool_use blocks. Works perfectly.

**Gemini Adapter (102 lines):**
- Converts Claude-format messages to Gemini format (history + lastParts)
- Tool results are converted to text: `[Tool result for ${id}]: ${content}` -- this is lossy
- Images get converted to `inlineData` format
- `functionCalls()` extraction works but Gemini often returns text-only responses when it should have called tools
- No `functionCallingConfig` is set -- Gemini defaults to `AUTO` mode which lets it skip tools freely

**OpenAI Adapter (138 lines):** SSE streaming with tool_call delta accumulation. Solid implementation. Message format conversion handles assistant tool_calls and tool results correctly.

**GLM Adapter (139 lines):** Nearly identical to OpenAI adapter (Z.ai uses OpenAI-compatible API). Images are flattened to `[Image attached]` text -- vision is lost.

---

## PART 2: ROOT CAUSE ANALYSIS -- WHY GEMINI FAILS

### 2.1 The Core Problem

When Claude gets "Find 20 AI news articles and create an HTML file", it internally plans:
1. Search for AI news sources
2. Read each source
3. Compile data
4. Create HTML
5. Write file
6. Verify

Claude does this because it has strong "agentic reasoning" -- it understands multi-step tasks require sequential tool use and self-drives through them.

Gemini Flash gets the same prompt and:
1. Calls `run_shell` to get the date (easy, obvious tool call)
2. Calls `read_web_content` on one URL (got one result, feels like progress)
3. Returns text saying "Here are the articles" -- **stops calling tools, gives up**

### 2.2 Specific Failure Modes

| Failure | Root Cause | Frequency |
|---------|-----------|-----------|
| **Early termination** | Model returns `end_turn` with text instead of continuing tool calls. Flash's instruct-tuning optimizes for fast responses, not thorough task completion. | Very common (>50% of multi-step tasks) |
| **Tool call avoidance** | Gemini's `functionCallingConfig` defaults to `AUTO` -- model freely chooses to NOT call tools even when the system prompt says to. | Common |
| **Lost tool context** | Tool results are converted to `[Tool result for ID]: content` text strings. Gemini doesn't maintain the structured tool-result association that Claude's native API does. | Every turn |
| **No self-correction** | When `read_web_content` returns an error or empty content, model just reports the error instead of trying a different URL or approach. | Common |
| **Shallow execution** | "Find 20 articles" -- model finds 3, calls it done. No awareness that the task specified 20. | Very common |
| **No output verification** | Model says "I've created the file" but never called `write_file`. Or calls `write_file` but doesn't verify with `list_directory`. | Common |
| **Context window bloat** | After 5+ turns with screenshots (each ~500KB base64), context fills up. Model gets confused by old tool results. | On long tasks |
| **Image blindness (GLM)** | GLM adapter converts images to `[Image attached]` -- model has no visual context at all. | Always with GLM |

### 2.3 What the Current Code Does NOT Do

1. **No planning phase** -- prompt goes straight to the model with "do everything"
2. **No step tracking** -- the loop doesn't know what the model has accomplished vs. what remains
3. **No completion criteria** -- no way to check "did the model actually do what was asked?"
4. **No context management** -- full message history sent every turn (O(n^2) token growth)
5. **No tool-call forcing** -- can't tell Gemini "you MUST call a tool on this turn"
6. **No parallel execution** -- independent tools run sequentially
7. **No retry intelligence** -- retries on API errors but not on logical failures (empty results, wrong approach)
8. **No model-aware prompting** -- same system prompt for Claude and Flash despite vastly different capabilities

---

## PART 3: THE ENHANCEMENT ARCHITECTURE

### 3.1 New Component Map

```
src/core/agent/
  claudeAgent.ts         → MODIFY (add orchestrator integration)
  modelAdapter.ts        → MODIFY (add forceToolUse option)
  toolExecutor.ts        → MODIFY (add parallel execution)
  toolRegistry.ts        → NO CHANGE
  permissions.ts         → NO CHANGE
  costTracker.ts         → MODIFY (add per-step cost tracking)
  shellGuard.ts          → NO CHANGE
  smartRouter.ts         → NO CHANGE
  agentSession.ts        → MODIFY (add plan tracking)

  orchestrator.ts        → NEW (planning, step execution, self-correction)
  planner.ts             → NEW (task decomposition engine)
  contextManager.ts      → NEW (compression, summarization, context windowing)
  validator.ts           → NEW (output validation, completion checking)
  modelProfiles.ts       → NEW (per-model capability profiles and prompt tuning)

  adapters/
    geminiAdapter.ts     → MODIFY (add functionCallingConfig, fix tool results)
    glmAdapter.ts        → MODIFY (fix image handling)
    claudeAdapter.ts     → NO CHANGE
    openaiAdapter.ts     → NO CHANGE
    index.ts             → NO CHANGE

src/hooks/
  useClaudeAgent.ts      → MODIFY (expose plan state, step progress)
```

### 3.2 High-Level Flow (Enhanced)

```
User sends prompt + screenshot + windowContext
          |
          v
   ┌──────────────────────────────────────────┐
   │  PHASE 1: PLANNING (orchestrator.ts)      │
   │                                            │
   │  Ask model to output a structured plan:    │
   │  { goal, steps[], successCriteria }        │
   │                                            │
   │  If model fails to produce valid plan →    │
   │  Use RULE-BASED fallback planner           │
   │  (keyword matching on prompt)              │
   └──────────────┬───────────────────────────┘
                  |
                  v
   ┌──────────────────────────────────────────┐
   │  PHASE 2: STEP-BY-STEP EXECUTION         │
   │                                            │
   │  for each step in plan:                    │
   │    1. Build micro-prompt for this step     │
   │    2. Call adapter.stream() with:          │
   │       - Compressed context (not full hist) │
   │       - Only relevant tools for this step  │
   │       - forceToolUse if step requires it   │
   │    3. Execute returned tool calls          │
   │    4. Validate step result                 │
   │    5. If failed → self-correction (3 tries)│
   │    6. Update plan progress                 │
   │    7. Compress turn into summary           │
   └──────────────┬───────────────────────────┘
                  |
                  v
   ┌──────────────────────────────────────────┐
   │  PHASE 3: VALIDATION (validator.ts)       │
   │                                            │
   │  Check every success criterion:            │
   │  - Files created? → list_directory check   │
   │  - Data found? → non-empty check           │
   │  - Count match? → "20 articles" check      │
   │  - Content quality? → size/format check    │
   │                                            │
   │  If validation fails → re-enter Phase 2    │
   │  for failed criteria only                  │
   └──────────────┬───────────────────────────┘
                  |
                  v
   ┌──────────────────────────────────────────┐
   │  PHASE 4: FINAL RESPONSE                  │
   │                                            │
   │  Ask model to write final summary using    │
   │  accumulated results (not raw tool output) │
   └──────────────────────────────────────────┘
```

---

## PART 4: DETAILED IMPLEMENTATION SPECS

### 4.1 NEW FILE: `orchestrator.ts`

This is the brain. It replaces the dumb loop in `claudeAgent.ts` with intelligent step-by-step execution.

```typescript
// orchestrator.ts — Core orchestration engine

export interface ExecutionPlan {
  goal: string;
  steps: PlanStep[];
  successCriteria: SuccessCriterion[];
  estimatedTurns: number;
}

export interface PlanStep {
  id: number;
  action: string;           // Human-readable description
  tools: string[];           // Which tools this step likely needs
  depends: number[];         // Step IDs that must complete first
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  result?: string;           // Compressed result summary
  retries: number;
  maxRetries: number;        // Default 3
}

export interface SuccessCriterion {
  type: 'file_exists' | 'data_count' | 'data_nonempty' | 'content_contains' | 'custom';
  description: string;
  check: CriterionCheck;     // How to verify
  met: boolean;
}

export interface CriterionCheck {
  tool?: string;              // Tool to use for verification
  toolInput?: Record<string, any>;
  expectedPattern?: string;   // Regex or substring to find in result
  minCount?: number;          // For data_count checks
}

export class Orchestrator {
  private plan: ExecutionPlan | null = null;
  private completedResults: Map<number, string> = new Map();
  private contextSummary: string = '';

  /**
   * PHASE 1: Generate a plan from the user's prompt.
   * Tries the model first. Falls back to rule-based planner.
   */
  async generatePlan(
    prompt: string,
    adapter: ModelAdapter,
    modelProfile: ModelProfile
  ): Promise<ExecutionPlan> {
    // Attempt 1: Ask the model to plan
    const planPrompt = this.buildPlanPrompt(prompt, modelProfile);
    // ... (call adapter, parse JSON response)

    // Attempt 2: If model returns garbage, use rule-based planner
    if (!validPlan) {
      return this.ruleBasedPlan(prompt);
    }

    return plan;
  }

  /**
   * PHASE 2: Execute plan step by step.
   * Each step gets its own micro-prompt and tool subset.
   */
  async executeStep(
    step: PlanStep,
    adapter: ModelAdapter,
    callbacks: AgentCallbacks,
    modelProfile: ModelProfile
  ): Promise<StepResult> {
    const microPrompt = this.buildStepPrompt(step);
    const relevantTools = this.filterTools(step.tools);
    const compressedContext = this.getCompressedContext();

    // Call model with focused context
    const response = await adapter.stream({
      system: modelProfile.stepSystemPrompt,
      messages: [
        { role: 'user', content: compressedContext + '\n\n' + microPrompt }
      ],
      tools: relevantTools,
      maxTokens: modelProfile.maxTokensPerStep,
      // Key: force tool use for action steps
      ...(step.tools.length > 0 && modelProfile.supportsForceToolUse
        ? { toolChoice: { type: 'any' } }
        : {})
    });

    // ... execute tools, collect results
    // ... compress result into summary
    // ... update plan progress
  }

  /**
   * PHASE 3: Validate success criteria.
   */
  async validate(
    criteria: SuccessCriterion[],
    adapter: ModelAdapter
  ): Promise<ValidationResult> {
    for (const criterion of criteria) {
      if (criterion.check.tool) {
        // Use tool to verify (e.g., list_directory to check file exists)
        const result = await executeTool(criterion.check.tool, criterion.check.toolInput!);
        criterion.met = this.evaluateCriterion(criterion, result);
      }
    }
    return { allMet: criteria.every(c => c.met), failed: criteria.filter(c => !c.met) };
  }
}
```

### 4.2 NEW FILE: `planner.ts`

Rule-based fallback planner for when the model can't produce a valid plan. This is critical for Gemini Flash.

```typescript
// planner.ts — Rule-based task decomposition

interface PlanTemplate {
  pattern: RegExp;
  generate: (match: RegExpMatchArray, prompt: string) => ExecutionPlan;
}

const PLAN_TEMPLATES: PlanTemplate[] = [
  {
    // "Find/search/get N items about X and create/make Y"
    pattern: /(?:find|search|get|collect|gather)\s+(\d+)?\s*(.+?)\s+(?:and|then)\s+(?:create|make|build|generate|write)\s+(?:an?\s+)?(.+)/i,
    generate: (match, prompt) => ({
      goal: prompt,
      steps: [
        { id: 1, action: 'Search for sources', tools: ['read_web_content', 'run_shell'], depends: [], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 2, action: `Read and extract data from each source (target: ${match[1] || 'multiple'} items)`, tools: ['read_web_content'], depends: [1], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 3, action: `Create ${match[3]}`, tools: ['write_file', 'generate_document'], depends: [2], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 4, action: 'Verify output file exists and has content', tools: ['list_directory', 'read_file'], depends: [3], status: 'pending', retries: 0, maxRetries: 2 },
      ],
      successCriteria: [
        { type: 'file_exists', description: 'Output file was created', check: {}, met: false },
        ...(match[1] ? [{ type: 'data_count' as const, description: `At least ${match[1]} items collected`, check: { minCount: parseInt(match[1]) }, met: false }] : []),
      ],
      estimatedTurns: 8,
    }),
  },
  {
    // "Organize/sort/clean up [files/folder]"
    pattern: /(?:organize|sort|clean\s*up|tidy|arrange)\s+(?:my\s+)?(.+)/i,
    generate: (match, prompt) => ({
      goal: prompt,
      steps: [
        { id: 1, action: `List contents of ${match[1]}`, tools: ['list_directory'], depends: [], status: 'pending', retries: 0, maxRetries: 2 },
        { id: 2, action: 'Analyze file types and propose organization', tools: [], depends: [1], status: 'pending', retries: 0, maxRetries: 1 },
        { id: 3, action: 'Create folder structure', tools: ['run_shell'], depends: [2], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 4, action: 'Move files to appropriate folders', tools: ['file_move'], depends: [3], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 5, action: 'Verify final structure', tools: ['list_directory'], depends: [4], status: 'pending', retries: 0, maxRetries: 1 },
      ],
      successCriteria: [
        { type: 'custom', description: 'Files were moved to organized folders', check: {}, met: false },
      ],
      estimatedTurns: 10,
    }),
  },
  {
    // "Read/analyze [file] and [do something]"
    pattern: /(?:read|analyze|look at|check|review|open)\s+(?:the\s+)?(.+?)\s+(?:and|then)\s+(.+)/i,
    generate: (match, prompt) => ({
      goal: prompt,
      steps: [
        { id: 1, action: `Read ${match[1]}`, tools: ['read_file', 'read_active_file'], depends: [], status: 'pending', retries: 0, maxRetries: 2 },
        { id: 2, action: match[2], tools: ['write_file', 'generate_document', 'clipboard_write', 'run_shell'], depends: [1], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 3, action: 'Verify output', tools: ['list_directory', 'read_file'], depends: [2], status: 'pending', retries: 0, maxRetries: 1 },
      ],
      successCriteria: [],
      estimatedTurns: 5,
    }),
  },
  {
    // "Create/make/write/build [something]"
    pattern: /(?:create|make|write|build|generate)\s+(?:me\s+)?(?:an?\s+)?(.+)/i,
    generate: (match, prompt) => ({
      goal: prompt,
      steps: [
        { id: 1, action: 'Gather any needed context (screenshot, active files)', tools: ['capture_screenshot', 'get_active_window', 'read_active_file'], depends: [], status: 'pending', retries: 0, maxRetries: 1 },
        { id: 2, action: `Create ${match[1]}`, tools: ['write_file', 'generate_document', 'run_shell'], depends: [1], status: 'pending', retries: 0, maxRetries: 3 },
        { id: 3, action: 'Verify output', tools: ['list_directory', 'read_file'], depends: [2], status: 'pending', retries: 0, maxRetries: 1 },
      ],
      successCriteria: [
        { type: 'file_exists', description: 'Output file was created', check: {}, met: false },
      ],
      estimatedTurns: 5,
    }),
  },
];

/**
 * Generic fallback: treats the entire prompt as a single step.
 * Still better than nothing -- at least adds verification.
 */
function genericPlan(prompt: string): ExecutionPlan {
  return {
    goal: prompt,
    steps: [
      { id: 1, action: prompt, tools: [], depends: [], status: 'pending', retries: 0, maxRetries: 5 },
      { id: 2, action: 'Verify results', tools: ['list_directory', 'read_file', 'capture_screenshot'], depends: [1], status: 'pending', retries: 0, maxRetries: 1 },
    ],
    successCriteria: [],
    estimatedTurns: 8,
  };
}

export function ruleBasedPlan(prompt: string): ExecutionPlan {
  for (const template of PLAN_TEMPLATES) {
    const match = prompt.match(template.pattern);
    if (match) return template.generate(match, prompt);
  }
  return genericPlan(prompt);
}
```

### 4.3 NEW FILE: `contextManager.ts`

Manages context window to prevent bloat and keep the model focused.

```typescript
// contextManager.ts — Context compression and windowing

export interface ContextWindow {
  systemPrompt: string;
  planSummary: string;          // Current plan state
  completedStepSummaries: string[]; // Compressed results of previous steps
  currentStepContext: string;   // Full detail for current step only
  recentToolResults: string[];  // Last 2-3 tool results (full)
}

export class ContextManager {
  private stepSummaries: Map<number, string> = new Map();
  private rawToolResults: Array<{ stepId: number; toolName: string; result: string; timestamp: number }> = [];

  /**
   * After each tool result, decide whether to keep full or compress.
   * Rules:
   * - Screenshot results: always compress (replace base64 with "[Screenshot captured: description]")
   * - Large text results (>2000 chars): summarize to 500 chars
   * - Recent results (last 3): keep full
   * - Older results: keep summary only
   */
  compressToolResult(toolName: string, result: string, stepId: number): string {
    // Screenshots -- remove base64, keep metadata
    if (toolName === 'capture_screenshot') {
      return '[Screenshot captured successfully]';
    }

    // Web content -- truncate long pages
    if (toolName === 'read_web_content' && result.length > 3000) {
      return result.substring(0, 2000) + '\n...[truncated, ' + result.length + ' chars total]';
    }

    // File reads -- truncate large files
    if (toolName === 'read_file' && result.length > 5000) {
      return result.substring(0, 3000) + '\n...[truncated, ' + result.length + ' chars total]';
    }

    // List directory -- keep as is (usually small)
    return result;
  }

  /**
   * Build a compressed context for the current step.
   * Instead of sending the entire message history (which grows O(n^2)),
   * send: plan summary + compressed previous results + full current context.
   */
  buildContextForStep(step: PlanStep, plan: ExecutionPlan): string {
    const parts: string[] = [];

    // Plan progress
    parts.push('## Current Task Progress');
    parts.push(`Goal: ${plan.goal}`);
    for (const s of plan.steps) {
      const icon = s.status === 'completed' ? '[DONE]' :
                   s.status === 'running' ? '[NOW]' :
                   s.status === 'failed' ? '[FAILED]' : '[ ]';
      parts.push(`${icon} Step ${s.id}: ${s.action}`);
      if (s.status === 'completed' && s.result) {
        parts.push(`   Result: ${s.result}`);
      }
    }

    // Previous step results (compressed)
    if (this.stepSummaries.size > 0) {
      parts.push('\n## Previous Results (Summaries)');
      for (const [id, summary] of this.stepSummaries) {
        parts.push(`Step ${id}: ${summary}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Summarize a step's results into a compact form.
   * Called after each step completes.
   */
  summarizeStep(stepId: number, toolResults: Array<{ tool: string; result: string }>): string {
    // For web reads: extract just the key data points
    // For file operations: just the path and success/fail
    // For shell commands: just stdout summary
    const summaries = toolResults.map(tr => {
      if (tr.tool === 'read_web_content') {
        // Take first 300 chars as summary
        return `Web content read (${tr.result.length} chars): ${tr.result.substring(0, 300)}...`;
      }
      if (tr.tool === 'write_file' || tr.tool === 'generate_document') {
        try {
          const parsed = JSON.parse(tr.result);
          return `File created: ${parsed.path || 'unknown'} (${parsed.size || '?'} bytes)`;
        } catch {
          return `File operation: ${tr.result.substring(0, 100)}`;
        }
      }
      if (tr.tool === 'run_shell') {
        return `Shell: ${tr.result.substring(0, 200)}`;
      }
      return `${tr.tool}: ${tr.result.substring(0, 200)}`;
    });

    const summary = summaries.join(' | ');
    this.stepSummaries.set(stepId, summary);
    return summary;
  }

  /**
   * Estimate current context size in tokens (rough: 1 token ~ 4 chars).
   * Used to decide when aggressive compression is needed.
   */
  estimateTokens(messages: any[]): number {
    const json = JSON.stringify(messages);
    return Math.ceil(json.length / 4);
  }

  /**
   * If context exceeds threshold, aggressively compress old results.
   * Threshold depends on model:
   * - Gemini Flash: 100K context window, aim for <60K tokens
   * - Claude: 200K context, aim for <100K tokens
   */
  shouldCompress(messages: any[], modelProfile: ModelProfile): boolean {
    const tokens = this.estimateTokens(messages);
    return tokens > modelProfile.contextCompressionThreshold;
  }
}
```

### 4.4 NEW FILE: `validator.ts`

Output validation -- catches when the model claims success but didn't actually deliver.

```typescript
// validator.ts — Output validation engine

export interface ValidationResult {
  allPassed: boolean;
  checks: ValidationCheck[];
}

export interface ValidationCheck {
  name: string;
  passed: boolean;
  details: string;
}

export class Validator {
  /**
   * Run all validation checks for a completed plan.
   */
  async validate(plan: ExecutionPlan, toolResults: Map<number, string[]>): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // 1. Check all success criteria
    for (const criterion of plan.successCriteria) {
      checks.push(await this.checkCriterion(criterion));
    }

    // 2. Implicit checks based on plan steps
    for (const step of plan.steps) {
      if (step.status !== 'completed') {
        checks.push({
          name: `Step ${step.id} completion`,
          passed: false,
          details: `Step "${step.action}" did not complete (status: ${step.status})`,
        });
      }
    }

    // 3. File existence checks
    // If any step used write_file or generate_document, verify the file exists
    for (const step of plan.steps) {
      if (step.tools.includes('write_file') || step.tools.includes('generate_document')) {
        const results = toolResults.get(step.id) || [];
        for (const result of results) {
          try {
            const parsed = JSON.parse(result);
            if (parsed.path) {
              const dirCheck = await executeTool('list_directory', {
                dir_path: parsed.path.replace(/[/\\][^/\\]+$/, '')
              });
              const fileName = parsed.path.split(/[/\\]/).pop();
              const exists = dirCheck.includes(fileName!);
              checks.push({
                name: `File exists: ${fileName}`,
                passed: exists,
                details: exists ? 'File verified on disk' : 'File NOT found on disk after write',
              });
            }
          } catch {}
        }
      }
    }

    // 4. Data count checks
    // If the prompt mentioned a number, check we got close
    const countMatch = plan.goal.match(/(\d+)\s+(?:articles?|items?|results?|files?|entries|records)/i);
    if (countMatch) {
      const targetCount = parseInt(countMatch[1]);
      // Count how many data items were collected across all read_web_content calls
      let collectedCount = 0;
      for (const [, results] of toolResults) {
        for (const r of results) {
          if (r.length > 100) collectedCount++; // Non-trivial result = a data item
        }
      }
      checks.push({
        name: `Data count: ${collectedCount}/${targetCount}`,
        passed: collectedCount >= targetCount * 0.7, // 70% threshold
        details: `Collected ${collectedCount} items, target was ${targetCount}`,
      });
    }

    return {
      allPassed: checks.every(c => c.passed),
      checks,
    };
  }

  private async checkCriterion(criterion: SuccessCriterion): Promise<ValidationCheck> {
    if (criterion.check.tool) {
      try {
        const result = await executeTool(criterion.check.tool, criterion.check.toolInput || {});
        const passed = criterion.check.expectedPattern
          ? new RegExp(criterion.check.expectedPattern).test(result)
          : result.length > 0;
        return { name: criterion.description, passed, details: result.substring(0, 200) };
      } catch (err: any) {
        return { name: criterion.description, passed: false, details: `Check failed: ${err.message}` };
      }
    }
    return { name: criterion.description, passed: criterion.met, details: 'Manual check' };
  }
}
```

### 4.5 NEW FILE: `modelProfiles.ts`

Per-model tuning profiles. This is the KEY to making weaker models perform.

```typescript
// modelProfiles.ts — Per-model capability profiles and prompt tuning

export interface ModelProfile {
  provider: string;
  modelId: string;

  // Capability flags
  supportsForceToolUse: boolean;    // Can we set tool_choice: 'any'?
  supportsNativeToolResults: boolean; // Does the API natively support tool result messages?
  supportsVision: boolean;           // Can it process images?
  reliableToolCalling: boolean;      // Does it consistently call tools when asked?
  maxContextTokens: number;          // Total context window
  contextCompressionThreshold: number; // When to start compressing

  // Orchestration tuning
  maxTokensPerStep: number;          // Lower for focused steps
  planningCapability: 'strong' | 'moderate' | 'weak';
  needsExplicitStepInstructions: boolean; // Flash needs "Call read_web_content NOW"
  needsProgressReminders: boolean;   // "You have completed 3/7 steps"
  earlyTerminationRisk: 'low' | 'medium' | 'high';

  // System prompt variants
  stepSystemPrompt: string;          // System prompt for step execution
  planSystemPrompt: string;          // System prompt for planning phase
  forceToolSuffix: string;           // Appended to micro-prompts when tool use is required
}

export const MODEL_PROFILES: Record<string, ModelProfile> = {
  'claude-sonnet-4-20250514': {
    provider: 'claude',
    modelId: 'claude-sonnet-4-20250514',
    supportsForceToolUse: true,
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 200000,
    contextCompressionThreshold: 100000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: 'You are KLYPIX agent. Execute the current step. Be concise.',
    planSystemPrompt: 'Analyze the task and create a step-by-step plan as JSON.',
    forceToolSuffix: '',
  },

  'gemini-2.5-flash': {
    provider: 'gemini',
    modelId: 'gemini-2.5-flash',
    supportsForceToolUse: true,   // Gemini supports functionCallingConfig: { mode: 'ANY' }
    supportsNativeToolResults: false, // Tool results become text strings
    supportsVision: true,
    reliableToolCalling: false,   // Often skips tool calls
    maxContextTokens: 1000000,    // 1M but effective focus is much lower
    contextCompressionThreshold: 60000, // Compress early despite large window
    maxTokensPerStep: 2048,       // Keep responses short and action-focused
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'high',
    stepSystemPrompt: [
      'You are an AI agent executing ONE specific step of a larger task.',
      'You MUST use the provided tools to complete this step.',
      'Do NOT write a final summary. Do NOT say you are done.',
      'Do NOT skip the tool call. Your ONLY job is to call the right tool.',
      'After the tool call, report the result in 1-2 sentences MAX.',
    ].join('\n'),
    planSystemPrompt: [
      'Create a step-by-step plan as a JSON object.',
      'Each step must specify which tools to use.',
      'Return ONLY the JSON, no explanation.',
    ].join('\n'),
    forceToolSuffix: '\n\nIMPORTANT: You MUST call a tool in this response. Do not respond with text only.',
  },

  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    supportsForceToolUse: true,   // tool_choice: 'required'
    supportsNativeToolResults: true,
    supportsVision: true,
    reliableToolCalling: true,
    maxContextTokens: 128000,
    contextCompressionThreshold: 60000,
    maxTokensPerStep: 4096,
    planningCapability: 'strong',
    needsExplicitStepInstructions: false,
    needsProgressReminders: false,
    earlyTerminationRisk: 'low',
    stepSystemPrompt: 'You are KLYPIX agent. Execute the current step. Be concise.',
    planSystemPrompt: 'Analyze the task and create a step-by-step plan as JSON.',
    forceToolSuffix: '',
  },

  'glm-5': {
    provider: 'glm',
    modelId: 'glm-5',
    supportsForceToolUse: false,  // Z.ai API doesn't support tool_choice
    supportsNativeToolResults: true,
    supportsVision: false,        // Adapter strips images to [Image attached]
    reliableToolCalling: false,
    maxContextTokens: 128000,
    contextCompressionThreshold: 40000,
    maxTokensPerStep: 2048,
    planningCapability: 'moderate',
    needsExplicitStepInstructions: true,
    needsProgressReminders: true,
    earlyTerminationRisk: 'high',
    stepSystemPrompt: [
      'You are an AI agent executing ONE specific step.',
      'You MUST use the provided tools.',
      'Call the tool, then report the result briefly.',
    ].join('\n'),
    planSystemPrompt: 'Create a step-by-step plan as JSON. Return ONLY the JSON.',
    forceToolSuffix: '\n\nYou MUST call a tool now. Do not respond with only text.',
  },
};

// GLM sub-models inherit the base profile with overrides
for (const id of ['glm-4-plus', 'glm-4.5', 'glm-4.5-flash', 'glm-4.6']) {
  MODEL_PROFILES[id] = { ...MODEL_PROFILES['glm-5'], modelId: id };
}

export function getModelProfile(modelId: string): ModelProfile {
  return MODEL_PROFILES[modelId] || MODEL_PROFILES['gemini-2.5-flash']; // Safe default
}
```

### 4.6 MODIFIED: `geminiAdapter.ts` — Critical Fixes

The Gemini adapter has 3 bugs that cripple tool calling:

**Fix 1: Add `functionCallingConfig`**

Currently the adapter never sets this, so Gemini defaults to `AUTO` (it can freely skip tools). For orchestrated steps that REQUIRE tool use, we need `ANY` mode.

```typescript
// In stream() method, when constructing the model:
const model = genAI.getGenerativeModel({
  model: modelId,
  systemInstruction: opts.system,
  tools: [{
    functionDeclarations: opts.tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    } as FunctionDeclaration)),
  }],
  // NEW: Force tool use when orchestrator requests it
  toolConfig: opts.forceToolUse ? {
    functionCallingConfig: { mode: 'ANY' as any }
  } : undefined,
});
```

**Fix 2: Proper tool result format**

Currently tool results are sent as plain text: `[Tool result for ${id}]: ${content}`. Gemini's API actually supports `functionResponse` parts. This is critical for Gemini to understand it received a tool result and should continue working.

```typescript
// When converting tool_result messages:
if (c.type === 'tool_result') {
  // USE NATIVE FUNCTION RESPONSE instead of text
  return {
    functionResponse: {
      name: c.tool_name || 'unknown',
      response: { content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) }
    }
  };
}
```

**Fix 3: Handle Gemini's multi-part responses**

Gemini sometimes returns both text AND function calls in the same response. The current code handles this but assigns `end_turn` when there are no function calls, even if the model's text suggests it wants to continue. The orchestrator handles this at a higher level, but the adapter should correctly report `stopReason`.

### 4.7 MODIFIED: `glmAdapter.ts` — Image Support

```typescript
// Current (broken):
if (c.type === 'image') parts.push('[Image attached]');

// Fixed: Use base64 data URL for models that support vision
if (c.type === 'image') {
  parts.push({
    type: 'image_url',
    image_url: { url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data}` }
  });
}
```

Note: This only works if the GLM model supports vision (GLM-4V does, GLM-5 may). The `modelProfile.supportsVision` flag controls whether images are sent or stripped.

### 4.8 MODIFIED: `modelAdapter.ts` — Extended Interface

```typescript
export interface ModelAdapter {
  readonly provider: string;
  readonly modelId: string;

  stream(opts: {
    system: string;
    messages: ModelMessage[];
    tools: ToolDefinition[];
    maxTokens?: number;
    forceToolUse?: boolean;     // NEW: hint for adapters that support it
    toolSubset?: string[];      // NEW: only include these tools (by name)
  }): {
    onText: (cb: (delta: string) => void) => void;
    finalMessage: () => Promise<MessageComplete>;
  };
}
```

### 4.9 MODIFIED: `toolExecutor.ts` — Parallel Execution

```typescript
/**
 * Execute multiple independent tools in parallel.
 * Used when plan step has multiple tools with no dependencies.
 */
export async function executeToolsParallel(
  calls: Array<{ name: string; input: Record<string, any>; id: string }>,
  timeoutMs: number = 30000,
): Promise<Array<{ id: string; name: string; result: string; error?: string }>> {
  return Promise.all(
    calls.map(async (call) => {
      try {
        const result = await Promise.race([
          executeTool(call.name, call.input),
          new Promise<string>((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
          ),
        ]);
        return { id: call.id, name: call.name, result };
      } catch (err: any) {
        return { id: call.id, name: call.name, result: '', error: err.message };
      }
    })
  );
}
```

### 4.10 MODIFIED: `claudeAgent.ts` — Integration with Orchestrator

The existing agent loop becomes a "legacy mode" for Claude (which works fine without orchestration). For weaker models, the orchestrator takes over.

```typescript
async run(userPrompt, screenshotBase64, windowContext, callbacks): Promise<void> {
  const profile = getModelProfile(this.adapter.modelId);

  if (profile.reliableToolCalling && profile.planningCapability === 'strong') {
    // Claude/GPT-4o: use existing loop (it works well)
    return this.runLegacy(userPrompt, screenshotBase64, windowContext, callbacks);
  }

  // Weaker models: orchestrated execution
  const orchestrator = new Orchestrator();
  const contextManager = new ContextManager();
  const validator = new Validator();

  // Phase 1: Plan
  callbacks.onTextDelta('Planning task...\n');
  const plan = await orchestrator.generatePlan(userPrompt, this.adapter, profile);
  callbacks.onStep({ type: 'thinking', status: 'completed', description: `Plan: ${plan.steps.length} steps` });

  // Phase 2: Execute step by step
  for (const step of plan.steps) {
    if (this.aborted) break;

    // Check dependencies
    const depsCompleted = step.depends.every(d =>
      plan.steps.find(s => s.id === d)?.status === 'completed'
    );
    if (!depsCompleted) { step.status = 'skipped'; continue; }

    step.status = 'running';
    callbacks.onTextDelta(`Step ${step.id}: ${step.action}\n`);

    // Build focused context
    const context = contextManager.buildContextForStep(step, plan);
    const microPrompt = profile.needsExplicitStepInstructions
      ? `Your current task: ${step.action}\nTools available: ${step.tools.join(', ')}\n${profile.forceToolSuffix}`
      : step.action;

    // Execute with retries
    let success = false;
    for (let retry = 0; retry <= step.maxRetries && !success; retry++) {
      const result = await orchestrator.executeStep(step, this.adapter, callbacks, profile);
      if (result.success) {
        step.status = 'completed';
        step.result = contextManager.summarizeStep(step.id, result.toolResults);
        success = true;
      } else if (retry < step.maxRetries) {
        callbacks.onTextDelta(`Retrying step ${step.id} (attempt ${retry + 2})...\n`);
        step.retries++;
      }
    }

    if (!success) step.status = 'failed';
  }

  // Phase 3: Validate
  const validation = await validator.validate(plan, orchestrator.getToolResults());
  if (!validation.allPassed) {
    callbacks.onTextDelta('Fixing incomplete steps...\n');
    // Re-execute failed criteria...
  }

  // Phase 4: Final response
  // Ask model to write a summary using all collected results
  // ... (one final model call with compressed context)

  callbacks.onComplete(steps, this.costTracker.getSummary());
}
```

### 4.11 MODIFIED: `useClaudeAgent.ts` — Plan State Exposure

```typescript
// Add to the hook's state:
const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
const [currentStepIndex, setCurrentStepIndex] = useState(0);

// Add to callbacks:
onPlanGenerated: (plan: ExecutionPlan) => {
  setPlanSteps(plan.steps);
},
onStepProgress: (stepId: number, status: PlanStep['status']) => {
  setPlanSteps(prev => prev.map(s =>
    s.id === stepId ? { ...s, status } : s
  ));
},

// Return from hook:
return {
  ...existing,
  planSteps,         // For UI to render step checklist
  currentStepIndex,  // For UI to highlight current step
};
```

---

## PART 5: SELF-CORRECTION ENGINE

### 5.1 Retry Strategies by Failure Type

| Failure | Detection | Correction Strategy |
|---------|-----------|-------------------|
| **Empty web content** | `read_web_content` returns empty or error | Try a different URL; fall back to `run_shell` with `curl`; try Google cache URL |
| **Tool call skipped** | Model responds with text only when tools were expected | Re-send with `forceToolUse: true`; add explicit instruction; on 3rd fail, use rule-based execution |
| **File write failed** | `write_file` returns error | Check path exists with `list_directory`; create parent dirs with `run_shell mkdir -p`; retry write |
| **Wrong tool called** | Model calls irrelevant tool | Remove that tool from available list; re-prompt with explicit tool name |
| **Partial data** | Got 5/20 items | Continue collection with "You have 5 so far, need 15 more" prompt |
| **Malformed output** | JSON parse fails on plan | Fall back to rule-based planner |
| **Context overflow** | Token estimate exceeds threshold | Aggressive compression; drop old screenshots; summarize all tool results |

### 5.2 Self-Correction Flow

```
Step execution returns result
         |
         v
   ┌─────────────────────┐
   │  Classify result:    │
   │  SUCCESS / FAIL      │
   │  PARTIAL / EMPTY     │
   └─────────┬───────────┘
             |
     ┌───────┼───────┐
     v       v       v
  SUCCESS  PARTIAL  FAIL/EMPTY
     |       |       |
     |       |       v
     |       |   ┌──────────────────────┐
     |       |   │ Choose correction:    │
     |       |   │ - Change tool         │
     |       |   │ - Change input params │
     |       |   │ - Add prerequisite    │
     |       |   │   step (mkdir, etc.)  │
     |       |   │ - Force tool use      │
     |       |   └──────────┬───────────┘
     |       |              |
     |       v              v
     |   ┌───────────────────────────┐
     |   │ Re-prompt with correction  │
     |   │ context + retry count      │
     |   │                             │
     |   │ Max 3 retries per step      │
     |   │ After 3: mark step FAILED   │
     |   │ and continue to next step   │
     |   └───────────────────────────┘
     |
     v
  Continue to next step
```

---

## PART 6: THE MICRO-PROMPT ENGINE

### 6.1 How Micro-Prompts Work

Instead of sending ONE big prompt ("Find 20 AI articles and create HTML"), the orchestrator sends FOCUSED micro-prompts per step:

**Step 1 Micro-Prompt (for Gemini Flash):**
```
Your task: Search for AI news sources.
Use read_web_content to fetch content from these URLs (try them in order):
1. https://news.ycombinator.com
2. https://techcrunch.com/category/artificial-intelligence/
3. https://www.theverge.com/ai-artificial-intelligence

Call read_web_content NOW with the first URL. Do not write a summary. Just call the tool.
```

**Step 2 Micro-Prompt:**
```
Previous step found these sources: [compressed summary]
Your task: Extract article titles and URLs from the content.
You have 3 articles so far. Target: 20.
Call read_web_content on the next source URL.
```

**Step 3 Micro-Prompt:**
```
You have collected 18 articles: [list]
Your task: Create an HTML file displaying these articles.
Use write_file to save to C:\Users\USERNAME\Desktop\ai_news.html
The HTML must include: title, date, source link for each article.
Call write_file NOW.
```

**Step 4 Micro-Prompt:**
```
Your task: Verify the file was created.
Call list_directory with dir_path: "C:\Users\USERNAME\Desktop"
Check that ai_news.html exists in the listing.
```

### 6.2 Micro-Prompt Template

```typescript
function buildMicroPrompt(step: PlanStep, plan: ExecutionPlan, profile: ModelProfile): string {
  let prompt = `Your task: ${step.action}\n`;

  // Add progress context for models that need reminders
  if (profile.needsProgressReminders) {
    const completed = plan.steps.filter(s => s.status === 'completed').length;
    prompt += `\nProgress: Step ${step.id} of ${plan.steps.length} (${completed} completed)\n`;
  }

  // Add dependency results
  for (const depId of step.depends) {
    const depStep = plan.steps.find(s => s.id === depId);
    if (depStep?.result) {
      prompt += `\nFrom previous step: ${depStep.result}\n`;
    }
  }

  // Add tool-specific instructions for weak models
  if (profile.needsExplicitStepInstructions && step.tools.length > 0) {
    prompt += `\nYou must use one of these tools: ${step.tools.join(', ')}\n`;
    prompt += profile.forceToolSuffix;
  }

  return prompt;
}
```

---

## PART 7: PARALLEL EXECUTION STRATEGY

### 7.1 When to Parallelize

The orchestrator identifies independent steps (no shared dependencies) and executes them concurrently:

```
Plan:
  Step 1: Search HackerNews      [depends: none]
  Step 2: Search TechCrunch      [depends: none]
  Step 3: Search The Verge       [depends: none]
  Step 4: Compile results         [depends: 1, 2, 3]
  Step 5: Create HTML file        [depends: 4]
  Step 6: Verify file             [depends: 5]

Execution:
  Turn 1: Steps 1, 2, 3 run in PARALLEL (3 concurrent read_web_content calls)
  Turn 2: Step 4 (compile)
  Turn 3: Step 5 (write file)
  Turn 4: Step 6 (verify)

  Total: 4 turns instead of 6
```

### 7.2 Parallel Tool Execution

When the model returns multiple tool_use blocks in a single response, or when the orchestrator identifies parallel steps:

```typescript
// In orchestrator.ts
async executeParallelSteps(steps: PlanStep[], ...): Promise<void> {
  // Group independent steps
  const independent = steps.filter(s =>
    s.depends.every(d => plan.steps.find(ss => ss.id === d)?.status === 'completed')
  );

  // Execute each step's tools concurrently
  const results = await Promise.all(
    independent.map(step => this.executeStep(step, adapter, callbacks, profile))
  );

  // Process results
  for (let i = 0; i < independent.length; i++) {
    const step = independent[i];
    step.status = results[i].success ? 'completed' : 'failed';
    step.result = results[i].summary;
  }
}
```

---

## PART 8: IMPLEMENTATION PHASES

### Phase 1: Foundation (Estimated 2-3 days)

**Files to create:**
- `src/core/agent/modelProfiles.ts` (model capability profiles)
- `src/core/agent/contextManager.ts` (context compression)

**Files to modify:**
- `src/core/agent/adapters/geminiAdapter.ts` (3 critical fixes)
- `src/core/agent/modelAdapter.ts` (add `forceToolUse` to interface)

**Why first:** These fixes alone will improve Gemini by ~30%. The `functionCallingConfig` fix is the single biggest win -- it forces Gemini to actually call tools instead of writing text about what tools it would call.

### Phase 2: Planning Engine (Estimated 3-4 days)

**Files to create:**
- `src/core/agent/planner.ts` (rule-based task decomposition)
- `src/core/agent/orchestrator.ts` (step-by-step execution engine)

**Files to modify:**
- `src/core/agent/claudeAgent.ts` (integrate orchestrator for non-Claude models)

**Why second:** The planning engine is the biggest quality leap. Even without self-correction, breaking tasks into explicit steps and force-feeding them to the model one at a time prevents the "gives up after 3 turns" problem entirely.

### Phase 3: Validation & Self-Correction (Estimated 2-3 days)

**Files to create:**
- `src/core/agent/validator.ts` (output validation)

**Files to modify:**
- `src/core/agent/orchestrator.ts` (add retry/correction logic)

**Why third:** Validation catches the cases where the model "completes" but didn't actually deliver. Self-correction handles the cases where a tool fails and the model needs to try an alternative approach.

### Phase 4: Parallel Execution (Estimated 1-2 days)

**Files to modify:**
- `src/core/agent/toolExecutor.ts` (add `executeToolsParallel`)
- `src/core/agent/orchestrator.ts` (parallel step detection and execution)

**Why last:** Parallelization is a performance optimization, not a correctness fix. It reduces total execution time by 30-50% for multi-source tasks.

### Phase 5: UI Integration (Estimated 1-2 days)

**Files to modify:**
- `src/hooks/useClaudeAgent.ts` (expose plan state)
- `src/components/WorkflowPanel.tsx` (render step checklist)

---

## PART 9: CRITICAL CONSTRAINTS

1. **Must work with ALL 4 adapters** -- the orchestrator uses `ModelAdapter` interface only, never provider SDKs
2. **Must not break Claude** -- Claude's existing loop works great; use orchestrator only when `reliableToolCalling === false`
3. **Must keep streaming** -- user sees live text updates during each step
4. **Permission system unchanged** -- the orchestrator calls the same permission check before each tool execution
5. **30s per tool, 25 turns max** -- these limits apply per-step, not per-plan; a 7-step plan can use up to 25 total turns across all steps
6. **useClaudeAgent hook interface** -- existing return values must not change; new fields are additive only
7. **No new IPC handlers** -- the orchestrator runs in renderer, uses existing Electron IPC surface
8. **Build must pass** -- `npx vite build && npx tsc --noEmit --project tsconfig.json`

---

## PART 10: EXPECTED OUTCOMES

### Before Enhancement

| Task | Claude | Gemini Flash | GLM-5 | GLM-4.5-Flash |
|------|--------|-------------|-------|---------------|
| "Find 20 AI news, make HTML" | 8-10 turns, completes | 3 turns, gives up | 4 turns, partial (blind to screenshot) | 3 turns, gives up |
| "Organize my Desktop" | 12 turns, completes | 2 turns, lists only | 3 turns, lists only | 2 turns, text advice |
| "Read this PDF and make a summary DOCX" | 5 turns, completes | 2 turns, text only | 2 turns, text only | 1 turn, text only |
| "Analyze what's on my screen" | 3 turns, completes | 2 turns, completes | FAILS (images stripped) | FAILS |

### After Enhancement

| Task | Claude | Gemini Flash | GLM-5V-Turbo | GLM-5 | GLM-4.5-Flash |
|------|--------|-------------|-------------|-------|---------------|
| "Find 20 AI news, make HTML" | 8-10 turns | 8-12 turns (orchestrated) | 8-10 turns (legacy loop) | 8-10 turns (legacy loop) | 10-14 turns (orchestrated) |
| "Organize my Desktop" | 12 turns | 10-14 turns (orchestrated) | 10-12 turns (legacy loop) | 10-12 turns (legacy loop) | 12-16 turns (orchestrated) |
| "Read this PDF and make a summary DOCX" | 5 turns | 5-7 turns (orchestrated) | 4-6 turns (legacy loop) | 4-6 turns (legacy loop) | 5-7 turns (orchestrated) |
| "Analyze what's on my screen" | 3 turns | 2-3 turns | 2-3 turns (sees screenshot!) | N/A (auto-upgrades to 5V) | N/A |

**Key insights:**
1. GLM-5 and GLM-5V-Turbo are strong enough to use the legacy (direct) loop — like Claude. They DON'T need the orchestrator's hand-holding.
2. GLM-5V-Turbo with fixed image support becomes a genuine Claude alternative at 1/3 the cost.
3. GLM-4.x models still need full orchestration like Gemini Flash.
4. When a user selects GLM-5 (text-only) but the task has a screenshot, the system auto-upgrades to GLM-5V-Turbo.

---

## PART 11: GEMINI-SPECIFIC ADAPTER FIX DETAIL

This section documents every exact change needed in `geminiAdapter.ts` since this is the highest-impact fix:

### Current geminiAdapter.ts Problems

**Problem 1 (Line 19-25):** No `functionCallingConfig` -- Gemini freely ignores tools.

**Problem 2 (Line 33-38):** Tool results converted to lossy text format:
```typescript
// CURRENT (lossy):
if (c.type === 'tool_result') return {
  text: `[Tool result for ${c.tool_use_id}]: ${typeof c.content === 'string' ? c.content : JSON.stringify(c.content)}`
};

// NEEDED (native Gemini format):
if (c.type === 'tool_result') return {
  functionResponse: {
    name: c.tool_name || 'unknown_tool',
    response: { result: typeof c.content === 'string' ? c.content : JSON.stringify(c.content) }
  }
};
```

**Problem 3 (Line 28-53):** The history/lastParts split doesn't handle the case where the last message is an assistant message with tool_use blocks followed by a user message with tool_results. Gemini needs these as a single multi-turn exchange, not split into history + lastParts.

**Problem 4:** No handling of `tool_result` messages that contain images (screenshot results). When a screenshot tool returns a base64 image, the current adapter converts it to text, losing the visual context entirely.

### How `functionCallingConfig` Solves Early Termination

Without it:
```
Orchestrator: "Step 2: Read content from this URL"
Gemini: "Sure, I can read that URL for you. The URL appears to be..." [end_turn, no tool call]
```

With `functionCallingConfig: { mode: 'ANY' }`:
```
Orchestrator: "Step 2: Read content from this URL"
Gemini: [calls read_web_content(url)] → returns actual content
```

The `ANY` mode tells Gemini: "You MUST call at least one function. Text-only responses are not allowed." This is the single most impactful fix for Gemini.

### When to Use `ANY` vs `AUTO`

- **Planning phase:** Use `AUTO` (model should return JSON text, not tool calls)
- **Step execution with tools:** Use `ANY` (model must call a tool)
- **Final summary phase:** Use `NONE` or `AUTO` (model should write text)

The orchestrator controls this per-phase via the `forceToolUse` flag in the adapter options.

---

## PART 12: GLM DEEP-DIVE — FIRST-CLASS SUPPORT

### 12.1 GLM Ecosystem (As of April 2026)

Based on research, Z.ai's model lineup relevant to KLYPIX:

| Model | ID | Vision | Tool Calling | tool_choice | Context | Pricing (input/output per 1M) |
|-------|-----|--------|-------------|-------------|---------|-------------------------------|
| GLM-5 | `glm-5` | No (text only) | Yes | `auto`, `required`, `{"type":"function",...}` | 128K+ | ~$1.20 / $4.00 |
| GLM-5V-Turbo | `glm-5v-turbo` | **Yes** (images, video, files) | Yes | Same | 200K | ~$1.20 / $4.00 |
| GLM-4.6 | `glm-4.6` | No | Yes | `auto` | 128K | Cheaper |
| GLM-4.5-Flash | `glm-4.5-flash` | No | Yes | `auto` | 128K | Cheapest |
| GLM-4-Plus | `glm-4-plus` | No | Yes | `auto` | 128K | Mid-tier |

**Critical discovery: GLM-5 DOES support `tool_choice: "required"`!** This is the OpenAI-compatible parameter that forces the model to call at least one tool. The original plan marked `supportsForceToolUse: false` for GLM — this must be changed to `true`.

**Critical discovery: GLM-5V-Turbo exists and supports vision + tool calling together.** This is the model KLYPIX should default to for GLM agent mode — it's a native multimodal agent model, not a text model with vision bolted on.

### 12.2 Current GLM Adapter Bugs (glmAdapter.ts)

**Bug 1 — Images completely stripped (Line 30):**
```typescript
// CURRENT (broken):
if (c.type === 'image') parts.push('[Image attached]');

// NEEDED: OpenAI-compatible vision format
if (c.type === 'image') {
  // Switch from string parts to multimodal content array
  return {
    type: 'image_url',
    image_url: {
      url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data}`
    }
  };
}
```
The Z.ai API uses the exact same `image_url` format as OpenAI — `data:image/jpeg;base64,{data}`. Your OpenAI adapter already does this correctly (line 29), but the GLM adapter strips it to text.

**Bug 2 — `tool_choice` never sent:**
```typescript
// CURRENT (missing):
body: JSON.stringify({
  model: modelId,
  messages,
  tools: tools.length > 0 ? tools : undefined,
  max_tokens: opts.maxTokens || 4096,
  stream: true,
  // tool_choice is MISSING
})

// NEEDED:
body: JSON.stringify({
  model: modelId,
  messages,
  tools: tools.length > 0 ? tools : undefined,
  max_tokens: opts.maxTokens || 4096,
  stream: true,
  tool_choice: opts.forceToolUse ? 'required' : 'auto',
})
```

**Bug 3 — Message format for multimodal content:**
When sending images, the message content must be an array (OpenAI multimodal format), not a joined string:
```typescript
// CURRENT (broken for images):
const parts: string[] = [];  // String array can't hold image objects
parts.push('[Image attached]');
messages.push({ role: msg.role, content: parts.join('\n') });

// NEEDED:
const parts: any[] = [];  // Mixed content array
if (c.type === 'image') {
  parts.push({
    type: 'image_url',
    image_url: { url: `data:${c.source?.media_type || 'image/jpeg'};base64,${c.source?.data}` }
  });
} else if (c.type === 'text') {
  parts.push({ type: 'text', text: c.text });
}
// Send as content array for multimodal, string for text-only
messages.push({
  role: msg.role,
  content: parts.some(p => p.type === 'image_url') ? parts : parts.map(p => p.text || '').join('\n')
});
```

**Bug 4 — No model-aware routing for vision:**
The adapter uses whatever `modelId` is passed in. If the user configured `glm-5` (text-only) but the task involves screenshots, the adapter should auto-upgrade to `glm-5v-turbo` for that request, or at minimum strip images gracefully instead of sending `[Image attached]` which confuses the model.

### 12.3 GLM Model Profile Update (modelProfiles.ts)

The original plan's GLM profile was too pessimistic. Updated with research findings:

```typescript
'glm-5': {
  provider: 'glm',
  modelId: 'glm-5',
  supportsForceToolUse: true,       // CHANGED: GLM-5 supports tool_choice: 'required'
  supportsNativeToolResults: true,
  supportsVision: false,             // GLM-5 base is text-only
  reliableToolCalling: true,         // CHANGED: GLM-5 is built for agentic tasks
  maxContextTokens: 128000,
  contextCompressionThreshold: 60000,
  maxTokensPerStep: 4096,
  planningCapability: 'strong',      // CHANGED: GLM-5 (744B MoE) has strong reasoning
  needsExplicitStepInstructions: false, // CHANGED: GLM-5 can self-plan
  needsProgressReminders: false,
  earlyTerminationRisk: 'low',       // CHANGED: designed for long-horizon tasks
  stepSystemPrompt: 'You are KLYPIX agent. Execute the current step. Be concise.',
  planSystemPrompt: 'Analyze the task and create a step-by-step plan as JSON.',
  forceToolSuffix: '',
  // GLM-5 with orchestration may actually be close to Claude quality
},

'glm-5v-turbo': {
  provider: 'glm',
  modelId: 'glm-5v-turbo',
  supportsForceToolUse: true,
  supportsNativeToolResults: true,
  supportsVision: true,              // Native multimodal — images, video, files
  reliableToolCalling: true,
  maxContextTokens: 200000,          // 200K context window
  contextCompressionThreshold: 100000,
  maxTokensPerStep: 4096,
  planningCapability: 'strong',
  needsExplicitStepInstructions: false,
  needsProgressReminders: false,
  earlyTerminationRisk: 'low',
  stepSystemPrompt: 'You are KLYPIX agent. Execute the current step. Be concise.',
  planSystemPrompt: 'Analyze the task and create a step-by-step plan as JSON.',
  forceToolSuffix: '',
},

// Lighter GLM models still need orchestration help
'glm-4.5-flash': {
  provider: 'glm',
  modelId: 'glm-4.5-flash',
  supportsForceToolUse: true,       // Supports tool_choice: auto at minimum
  supportsNativeToolResults: true,
  supportsVision: false,
  reliableToolCalling: false,        // Flash models are less reliable
  maxContextTokens: 128000,
  contextCompressionThreshold: 40000,
  maxTokensPerStep: 2048,
  planningCapability: 'moderate',
  needsExplicitStepInstructions: true,
  needsProgressReminders: true,
  earlyTerminationRisk: 'high',
  stepSystemPrompt: [
    'You are an AI agent executing ONE specific step.',
    'You MUST use the provided tools.',
    'Call the tool, then report the result briefly.',
  ].join('\n'),
  planSystemPrompt: 'Create a step-by-step plan as JSON. Return ONLY the JSON.',
  forceToolSuffix: '\n\nYou MUST call a tool now. Do not respond with only text.',
},
```

### 12.4 GLM Smart Model Selection

Add auto-selection logic that picks the right GLM model based on task:

```typescript
// In orchestrator.ts or a new glmModelSelector.ts

export function selectGLMModel(
  baseModelId: string,
  hasScreenshot: boolean,
  taskComplexity: 'simple' | 'medium' | 'complex'
): string {
  // If task involves vision and user chose a non-vision GLM model, upgrade
  if (hasScreenshot) {
    if (!baseModelId.includes('v') && !baseModelId.includes('V')) {
      console.log('[GLM] Auto-upgrading to glm-5v-turbo for vision task');
      return 'glm-5v-turbo';
    }
  }

  // If user chose glm-5 but task is simple, downgrade to flash for speed/cost
  if (taskComplexity === 'simple' && baseModelId === 'glm-5') {
    return 'glm-4.5-flash';
  }

  return baseModelId;
}
```

### 12.5 GLM Cost Tracking Update (costTracker.ts)

Current `MODEL_PRICING` only has Claude models. Add GLM:

```typescript
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Claude
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  // Gemini (free tier exists, but for tracking)
  'gemini-2.5-flash': { input: 0.15, output: 0.60 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  // GLM (Z.ai pricing)
  'glm-5': { input: 1.20, output: 4.00 },
  'glm-5v-turbo': { input: 1.20, output: 4.00 },
  'glm-4.6': { input: 0.60, output: 2.00 },
  'glm-4.5': { input: 0.60, output: 2.00 },
  'glm-4.5-flash': { input: 0.15, output: 0.60 },
  'glm-4-plus': { input: 0.40, output: 1.60 },
  // OpenAI
  'gpt-4o': { input: 2.50, output: 10.00 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
};
```

### 12.6 GLM AGENT_MODELS Registry Update (modelAdapter.ts)

```typescript
// Current (only has glm-5):
glm: { displayName: 'GLM-5', modelId: 'glm-5', keyPrefix: '' },

// Updated:
glm: { displayName: 'GLM-5V-Turbo', modelId: 'glm-5v-turbo', keyPrefix: '' },

// And expand GLM_MODELS for settings UI:
export const GLM_MODELS = [
  { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', desc: 'Vision + agent (recommended)' },
  { id: 'glm-5', name: 'GLM-5', desc: 'Most advanced text model' },
  { id: 'glm-4.6', name: 'GLM-4.6', desc: 'Latest generation' },
  { id: 'glm-4.5', name: 'GLM-4.5', desc: 'Newer, smarter' },
  { id: 'glm-4.5-flash', name: 'GLM-4.5-Flash', desc: 'Fast, lightweight' },
  { id: 'glm-4-plus', name: 'GLM-4-Plus', desc: 'Reliable, high concurrency' },
];
```

### 12.7 GLM Thinking Mode

GLM-5 supports a "thinking mode" similar to Claude's extended thinking. The Z.ai API may return thinking tokens before the actual response. The adapter should handle this gracefully — either strip thinking tokens from the response or pass them through as a separate event type.

This is a future enhancement but the adapter should at minimum not break if thinking tokens appear in the stream:

```typescript
// In GLM adapter's stream parsing:
if (delta.reasoning_content) {
  // GLM thinking mode — optionally surface to UI
  // For now, just skip (don't add to fullText)
  continue;
}
```

### 12.8 GLM Error Handling Improvements

Z.ai returns different error formats than OpenAI in some cases. The existing `friendlyError` method in `claudeAgent.ts` already handles some GLM errors (line 324-333), but needs expansion:

```typescript
// Add to friendlyError():
if (msg.includes('GLM API error 400')) {
  // Often means tool schema issue — GLM is stricter about JSON Schema
  return 'GLM rejected the request format. This may be a tool schema compatibility issue.';
}
if (msg.includes('GLM API error 402') || msg.includes('insufficient_quota')) {
  return 'Z.ai API credits depleted. Top up at z.ai/console or switch models.';
}
if (msg.includes('content_filter') || msg.includes('sensitive_content')) {
  return 'Z.ai content filter triggered. Try rephrasing your request.';
}
```

### 12.9 GLM Orchestration Decision Matrix

With the new research, GLM-5 is much stronger than initially assumed. Here's the updated decision:

| GLM Model | Use Orchestrator? | Why |
|-----------|------------------|-----|
| GLM-5 | **No** (like Claude) | 744B MoE, designed for agentic tasks, strong reasoning. Use legacy loop. |
| GLM-5V-Turbo | **No** (like Claude) | Same strong reasoning + native vision. Use legacy loop. |
| GLM-4.6 | **Yes** (light) | Good but not agentic-grade. Use orchestrator with moderate hand-holding. |
| GLM-4.5 | **Yes** (moderate) | Needs planning + micro-prompts. |
| GLM-4.5-Flash | **Yes** (full) | Like Gemini Flash — needs full orchestration. |
| GLM-4-Plus | **Yes** (moderate) | Reliable but not agentic. Moderate orchestration. |

This means `claudeAgent.ts` routing logic becomes:

```typescript
const profile = getModelProfile(this.adapter.modelId);

if (profile.reliableToolCalling && profile.planningCapability === 'strong') {
  // Claude, GPT-4o, GLM-5, GLM-5V-Turbo: legacy loop
  return this.runLegacy(userPrompt, screenshotBase64, windowContext, callbacks);
}

// Gemini Flash, GLM-4.x, weaker models: orchestrated execution
return this.runOrchestrated(userPrompt, screenshotBase64, windowContext, callbacks);
```

### 12.10 GLM-Specific Integration Summary

| Fix | File | Impact |
|-----|------|--------|
| Add vision support (image_url format) | `glmAdapter.ts` | Screenshots now visible to GLM-5V-Turbo |
| Add `tool_choice: 'required'` | `glmAdapter.ts` | Forced tool calling for action steps |
| Auto-upgrade to glm-5v-turbo for vision tasks | `orchestrator.ts` or new file | Right model for the job |
| Fix multimodal message format (array not string) | `glmAdapter.ts` | Images + text in same message work |
| Add GLM pricing to costTracker | `costTracker.ts` | Accurate budget tracking |
| Add GLM-5V-Turbo to model registry | `modelAdapter.ts` | Available in settings UI |
| Handle thinking mode tokens | `glmAdapter.ts` | No crashes when GLM uses thinking mode |
| Expand error handling | `claudeAgent.ts` | Better user-facing error messages |
| Model profiles for all GLM variants | `modelProfiles.ts` | Orchestrator knows each model's strengths |
| Default GLM to glm-5v-turbo | `modelAdapter.ts` | Best out-of-box experience |

---

## PART 13: COGNITIVE ARCHITECTURE — HOW THE AGENT THINKS

This section defines the reasoning engine — the decision-making layer that separates a toy agent from a production-grade autonomous system. The goal: an agent that reasons like a senior engineer, not a script following instructions.

### 13.1 The Four Cognitive Loops

Best-in-class agents operate on four nested loops, each at a different timescale:

```
┌──────────────────────────────────────────────────────────────────────┐
│  LOOP 1: STRATEGIC (once per task)                                    │
│  "What is the user really asking for, and what's the best approach?" │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │  LOOP 2: TACTICAL (once per step)                              │   │
│  │  "What's the best tool and input for THIS step?"               │   │
│  │                                                                 │   │
│  │  ┌──────────────────────────────────────────────────────────┐  │   │
│  │  │  LOOP 3: REACTIVE (once per tool result)                  │  │   │
│  │  │  "Did it work? What do I do with this result?"            │  │   │
│  │  │                                                            │  │   │
│  │  │  ┌──────────────────────────────────────────────────────┐ │  │   │
│  │  │  │  LOOP 4: META (continuous)                           │ │  │   │
│  │  │  │  "Am I making progress? Am I stuck? Should I pivot?" │ │  │   │
│  │  │  └──────────────────────────────────────────────────────┘ │  │   │
│  │  └──────────────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### 13.2 LOOP 1: Strategic Reasoning (The Planner)

**When:** Before any tool calls. Happens once per task.
**Purpose:** Understand intent, decompose, choose approach.

The agent doesn't just parse keywords — it REASONS about what the user wants:

```
User: "Find 20 AI news articles and create an HTML file"

Strategic reasoning:
  1. INTENT ANALYSIS:
     - Primary goal: Create an HTML file (output artifact)
     - Secondary goal: Content must be real AI news (data gathering)
     - Implicit: "20" means the user wants comprehensive coverage, not 5 results
     - Implicit: "HTML file" means saved to disk, not displayed in chat

  2. APPROACH SELECTION:
     - Option A: Use read_web_content on AI news sites → extract data → write HTML
     - Option B: Use run_shell to curl an API → parse JSON → write HTML
     - Option C: Use read_web_content on Google News → follow links → extract
     - DECISION: Option A — most reliable, doesn't depend on external APIs
     - FALLBACK: If A fails (sites blocked), try B

  3. RISK ASSESSMENT:
     - Risk: Some news sites may block/return garbage → need 30+ source URLs to get 20 good ones
     - Risk: HTML file might be huge → cap article summaries at 200 words each
     - Risk: User didn't specify Desktop path → ask via run_shell first

  4. RESOURCE ESTIMATE:
     - Turns needed: ~10 (3 for searching, 5 for reading, 1 for writing, 1 for verify)
     - Cost estimate: ~$0.08 on Claude, ~$0.02 on Gemini
```

**Implementation — The Strategic Prompt:**

```typescript
// In orchestrator.ts
private buildStrategicPrompt(userPrompt: string, windowContext: any): string {
  return `You are planning an autonomous task. Before executing anything, THINK carefully.

USER REQUEST: "${userPrompt}"
${windowContext ? `ACTIVE WINDOW: ${windowContext.title} (${windowContext.process})` : ''}

Respond with a JSON plan:
{
  "intent": {
    "primary_goal": "What the user explicitly wants",
    "implicit_goals": ["Things they didn't say but clearly expect"],
    "output_type": "file | data | action | information",
    "output_path_hint": "Where should output be saved (Desktop if unspecified)"
  },
  "approach": {
    "strategy": "High-level approach in 1-2 sentences",
    "fallback": "Alternative if primary approach fails",
    "risks": ["Potential failure points"]
  },
  "steps": [
    {
      "id": 1,
      "action": "What to do",
      "tools": ["which tools to use"],
      "depends": [],
      "success_signal": "How to know this step worked",
      "failure_action": "What to do if it fails"
    }
  ],
  "success_criteria": [
    { "check": "Description of what must be true when done", "verification_tool": "tool to verify" }
  ],
  "estimated_turns": 8,
  "estimated_cost_usd": 0.05
}`;
}
```

### 13.3 LOOP 2: Tactical Reasoning (The Step Executor)

**When:** Before each tool call within a step.
**Purpose:** Choose the optimal tool invocation.

The agent doesn't just follow the plan blindly — it adapts based on accumulated context:

```
Step 2: "Read content from TechCrunch AI page"

Tactical reasoning:
  1. TOOL SELECTION:
     - Plan says: read_web_content
     - Context from Step 1: HackerNews returned 8 articles (good data)
     - Accumulated count: 8/20 articles
     - DECISION: Proceed with read_web_content on TechCrunch

  2. INPUT OPTIMIZATION:
     - URL: https://techcrunch.com/category/artificial-intelligence/
     - Title hint: "TechCrunch AI" (helps CDP fallback)

  3. PRE-EMPTIVE FAILURE HANDLING:
     - If TechCrunch blocks → skip, move to next source (don't waste 3 retries)
     - If TechCrunch returns <500 chars → treat as blocked, skip

  4. PROGRESS AWARENESS:
     - 8/20 collected, 4 sources remaining in plan
     - At current rate (8 per source), we'll overshoot → good
     - If this source fails, we still have 3 more → no panic
```

**Implementation — The Tactical Evaluator:**

```typescript
// In orchestrator.ts
private evaluateStepContext(step: PlanStep, plan: ExecutionPlan): StepContext {
  const completedSteps = plan.steps.filter(s => s.status === 'completed');
  const failedSteps = plan.steps.filter(s => s.status === 'failed');
  const remainingSteps = plan.steps.filter(s => s.status === 'pending');

  // Calculate data accumulation (for data-gathering tasks)
  const dataCount = this.countCollectedItems();
  const targetCount = this.extractTargetCount(plan.goal);

  return {
    dataProgress: targetCount ? `${dataCount}/${targetCount} items` : null,
    failureRate: failedSteps.length / (completedSteps.length + failedSteps.length + 0.01),
    remainingBudget: remainingSteps.length,
    shouldSkipOnFailure: remainingSteps.length > 2, // Skip failed step if we have backup
    shouldRetryAggressively: remainingSteps.length <= 1, // Retry hard if this is our last chance
  };
}
```

### 13.4 LOOP 3: Reactive Reasoning (The Result Evaluator)

**When:** After every tool result.
**Purpose:** Classify result, decide next action, extract useful data.

This is where most agents fail — they treat tool results as pass/fail. A best-in-class agent INTERPRETS results:

```
Tool: read_web_content("https://techcrunch.com/category/artificial-intelligence/")
Result: HTML content, 45,000 chars

Reactive reasoning:
  1. RESULT CLASSIFICATION:
     - Not an error → success path
     - Content length 45K → substantial (not a paywall/block page)
     - Contains article elements → useful data

  2. DATA EXTRACTION:
     - Found 12 article titles in the content
     - 4 are from today, 5 from this week, 3 are older
     - Keep all 12 — user asked for "AI news", not "today's AI news"

  3. ACCUMULATION:
     - Previous: 8 articles (from HackerNews)
     - New: 12 articles (from TechCrunch)
     - Total: 20 articles — TARGET MET

  4. PLAN ADJUSTMENT:
     - We have 20/20 → skip remaining search steps
     - Advance directly to "Create HTML file" step
     - DYNAMIC PLAN MODIFICATION: Remove steps 3-4 (search Verge, search ArsTechnica)
```

**Implementation — The Result Evaluator:**

```typescript
// In orchestrator.ts
interface ResultEvaluation {
  success: boolean;
  dataQuality: 'good' | 'partial' | 'empty' | 'error';
  extractedItems: number;
  shouldContinueStep: boolean;
  shouldModifyPlan: boolean;
  planModification?: {
    skipSteps?: number[];
    addSteps?: PlanStep[];
    modifyStep?: { id: number; changes: Partial<PlanStep> };
  };
}

private evaluateResult(
  toolName: string,
  result: string,
  step: PlanStep,
  plan: ExecutionPlan,
): ResultEvaluation {
  // Parse result
  let parsed: any;
  try { parsed = JSON.parse(result); } catch { parsed = null; }

  // Classification
  const isError = parsed?.error || result.includes('"error"') || result.length < 50;
  const isEmpty = result.length < 100 && !result.includes('success');

  if (isError || isEmpty) {
    return {
      success: false,
      dataQuality: isError ? 'error' : 'empty',
      extractedItems: 0,
      shouldContinueStep: step.retries < step.maxRetries,
      shouldModifyPlan: false,
    };
  }

  // For data-gathering steps, count what we got
  const targetCount = this.extractTargetCount(plan.goal);
  const totalCollected = this.countCollectedItems() + this.countItemsInResult(result);

  if (targetCount && totalCollected >= targetCount) {
    // Target met — skip remaining search steps
    const searchSteps = plan.steps.filter(s =>
      s.status === 'pending' && s.tools.includes('read_web_content')
    );
    return {
      success: true,
      dataQuality: 'good',
      extractedItems: this.countItemsInResult(result),
      shouldContinueStep: false,
      shouldModifyPlan: searchSteps.length > 0,
      planModification: {
        skipSteps: searchSteps.map(s => s.id),
      },
    };
  }

  return {
    success: true,
    dataQuality: result.length > 1000 ? 'good' : 'partial',
    extractedItems: this.countItemsInResult(result),
    shouldContinueStep: false,
    shouldModifyPlan: false,
  };
}
```

### 13.5 LOOP 4: Meta-Reasoning (The Progress Monitor)

**When:** Continuously, after every 2-3 turns.
**Purpose:** Detect stalls, pivots, budget exhaustion, infinite loops.

This is the layer that prevents the agent from spinning wheels:

```
After turn 8:

Meta-reasoning:
  1. PROGRESS CHECK:
     - Plan has 7 steps, 4 completed, 1 running, 2 pending
     - We've used 8/25 turns — on track
     - No step has failed more than once — healthy

  2. STALL DETECTION:
     - Last 3 tool calls all returned useful data → not stalled
     - Context size: ~40K tokens → within budget
     - No repeated tool calls with same input → no infinite loop

  3. COST CHECK:
     - Spent ~$0.04 so far (8 turns)
     - Daily budget: $5.00 → fine
     - Estimated remaining: $0.03 → total ~$0.07 → fine

  4. QUALITY CHECK:
     - Collected 20 articles (target met)
     - All have titles + URLs (structured data)
     - Ready for HTML generation → proceed
```

**Stall Detection Patterns:**

```typescript
// In orchestrator.ts
private detectStall(recentSteps: AgentStep[]): StallDetection {
  const last5 = recentSteps.slice(-5);

  // Pattern 1: Same tool called 3+ times with same input
  const toolInputPairs = last5
    .filter(s => s.type === 'tool_call')
    .map(s => `${s.toolName}:${JSON.stringify(s.toolInput).slice(0, 50)}`);
  const hasDuplicates = new Set(toolInputPairs).size < toolInputPairs.length;

  // Pattern 2: 3+ consecutive errors
  const consecutiveErrors = last5.filter(s => s.status === 'error').length >= 3;

  // Pattern 3: No progress in last 3 turns (no completed steps, no new data)
  const recentCompletions = last5.filter(s => s.type === 'tool_result' && s.status === 'completed');
  const noProgress = recentCompletions.length === 0;

  // Pattern 4: Context growing too fast (model narrating instead of acting)
  const textOnlyTurns = last5.filter(s => s.type === 'text' && !s.toolName);
  const tooMuchTalking = textOnlyTurns.length >= 3;

  return {
    isStalled: hasDuplicates || consecutiveErrors || (noProgress && tooMuchTalking),
    reason: hasDuplicates ? 'repeated_tool_calls' :
            consecutiveErrors ? 'consecutive_errors' :
            tooMuchTalking ? 'narrating_not_acting' : 'none',
    recommendation: hasDuplicates ? 'Change tool input or skip step' :
                    consecutiveErrors ? 'Try alternative approach' :
                    tooMuchTalking ? 'Force tool use, reduce maxTokens' : 'Continue',
  };
}
```

### 13.6 Decision Taxonomy — The 11 Decisions the Agent Makes

Every turn, the orchestrator makes up to 11 decisions. This is the complete taxonomy:

| # | Decision | When | Options |
|---|----------|------|---------|
| 1 | **Decompose or direct?** | Task start | Break into steps OR send as single prompt |
| 2 | **Which model to use?** | Task start | Auto-select based on task (vision → GLM-5V, simple → Flash) |
| 3 | **Plan via model or rules?** | Planning phase | Ask model for plan OR use template matcher |
| 4 | **Which step next?** | Between steps | Next in sequence OR parallel group OR skip |
| 5 | **Force tool or let model choose?** | Before each model call | `tool_choice: required` OR `auto` |
| 6 | **Which tools to expose?** | Before each model call | All 22 OR filtered subset for this step |
| 7 | **Compress context?** | Before each model call | Keep full history OR compress old turns |
| 8 | **Interpret result** | After each tool call | Success / partial / empty / error |
| 9 | **Retry, skip, or pivot?** | After failure | Same approach again OR skip step OR change strategy |
| 10 | **Modify plan?** | After result evaluation | Continue as-is OR skip steps OR add steps |
| 11 | **Done or continue?** | After each turn | Task complete OR more work needed |

### 13.7 The Confidence System

Each decision has a confidence score. When confidence is low, the agent takes the safer/more cautious path:

```typescript
interface Decision {
  choice: string;
  confidence: number;  // 0.0 to 1.0
  reasoning: string;
}

// Example: "Should I retry or skip?"
function decideRetryOrSkip(step: PlanStep, context: StepContext): Decision {
  if (step.retries >= step.maxRetries) {
    return { choice: 'skip', confidence: 1.0, reasoning: 'Max retries reached' };
  }
  if (context.shouldSkipOnFailure) {
    return { choice: 'skip', confidence: 0.8, reasoning: 'Backup steps available' };
  }
  if (context.failureRate > 0.5) {
    return { choice: 'pivot', confidence: 0.6, reasoning: 'High failure rate, strategy may be wrong' };
  }
  return { choice: 'retry', confidence: 0.7, reasoning: 'First failure, worth retrying' };
}
```

### 13.8 Dynamic Plan Modification (The Replanner)

The plan is not sacred — it adapts as the agent learns:

```
Original plan (7 steps):
  1. Search HackerNews        [DONE - got 8 articles]
  2. Search TechCrunch         [DONE - got 12 articles, total: 20]
  3. Search The Verge          [PENDING]
  4. Search ArsTechnica        [PENDING]
  5. Compile all articles      [PENDING]
  6. Create HTML file          [PENDING]
  7. Verify file               [PENDING]

After Step 2, reactive evaluator says: "Target of 20 met"

Modified plan (5 steps):
  1. Search HackerNews        [DONE]
  2. Search TechCrunch        [DONE]
  3. Search The Verge         [SKIPPED - target already met]
  4. Search ArsTechnica       [SKIPPED - target already met]
  5. Compile all articles     [NOW RUNNING]
  6. Create HTML file         [PENDING]
  7. Verify file              [PENDING]

Saved: 2 turns, ~$0.02, 30 seconds
```

This replanning also works in the opposite direction — adding steps:

```
Original: "Organize my Desktop"
Plan: List → Categorize → Create folders → Move files → Verify

After Step 1 (list), result shows 200+ files including duplicates.

Replanner adds step:
  1. List Desktop             [DONE]
  1.5 Identify duplicates     [NEW - found 15 duplicate pairs]
  2. Categorize               [PENDING]
  3. Create folders           [PENDING]
  4. Move files               [PENDING]
  4.5 Delete/merge duplicates [NEW]
  5. Verify                   [PENDING]
```

### 13.9 The Reflection Prompt

After task completion, the agent generates a self-evaluation (stored in agentSession, visible in WorkflowPanel):

```typescript
private buildReflectionPrompt(plan: ExecutionPlan, results: Map<number, string[]>): string {
  return `The task is complete. Reflect briefly:
1. What went well?
2. What failed or was slow?
3. What would you do differently next time?
4. Confidence in result quality (0-10)?

Task: ${plan.goal}
Steps completed: ${plan.steps.filter(s => s.status === 'completed').length}/${plan.steps.length}
Steps failed: ${plan.steps.filter(s => s.status === 'failed').length}
Total turns used: ${this.turnCount}

Respond in 3-4 sentences max.`;
}
```

This reflection is NOT just for display — it feeds into future runs in the same session. If the agent reflects "TechCrunch blocked me, should use Google News next time," and the user later says "now find 20 sports articles," the agent's context includes that learning.

### 13.10 How This Compares to Cowork / Claude Code / Other Agents

| Capability | KLYPIX (after) | Claude Code | Cowork | Devin | OpenAI Codex |
|-----------|----------------|-------------|--------|-------|-------------|
| Planning before execution | Yes (model + rule-based) | Yes (model only) | Yes | Yes | Partial |
| Dynamic plan modification | Yes (replanning) | No (static) | No | Yes | No |
| Self-correction on failure | Yes (3 retries + strategy pivot) | Limited | Limited | Yes | Limited |
| Output validation | Yes (file/data checks) | No | No | Yes | No |
| Context compression | Yes (per model profile) | No (uses full context) | No | Yes | N/A |
| Meta-reasoning (stall detection) | Yes | No | No | Yes | No |
| Multi-model support | 4 models, auto-profiled | Claude only | Claude only | Claude only | GPT only |
| Forced tool calling | Yes (per-model) | Native Claude | Native Claude | Yes | Yes |
| Parallel tool execution | Yes | Yes | No | Yes | Yes |
| Cost awareness per step | Yes | Yes | No | No | N/A |
| Confidence scoring | Yes | No | No | No | No |

**Where KLYPIX can genuinely surpass Cowork:**
1. Multi-model — run the same task on Claude OR Gemini OR GLM, with automatic profiling
2. Dynamic replanning — Cowork follows a static plan; KLYPIX adapts mid-execution
3. Stall detection — Cowork doesn't detect when it's spinning wheels
4. Smart model auto-selection — vision tasks auto-upgrade to vision models
5. Budget-aware execution — stops before burning through API credits, something Cowork doesn't track at all

---

## PART 14: EDGE CASES & FAILURE MODES

### 14.1 What If the Model Produces an Invalid Plan?

Fallback chain:
1. Try parsing as JSON → if valid JSON with `steps` array, use it
2. Try extracting JSON from markdown fences → parse again
3. Try the rule-based planner (`planner.ts`) → always produces a valid plan
4. Ultimate fallback: single-step generic plan (just the original prompt as one step + verify)

### 14.2 What If a Step's Tool Call Produces an Infinite Loop?

Each step has `maxRetries` (default 3). After 3 failed attempts:
- Mark step as `failed`
- Check if subsequent steps can proceed without this step
- If all remaining steps depend on the failed step, abort with error
- If some steps are independent, continue with those

### 14.3 What If Context Gets Too Large Mid-Execution?

The `contextManager` monitors estimated token count after each turn. When it exceeds the model's `contextCompressionThreshold`:
1. Replace all screenshot base64 with `[Screenshot captured]`
2. Replace all tool results older than 3 turns with compressed summaries
3. If still too large, drop tool results entirely and keep only step summaries
4. If STILL too large (shouldn't happen), truncate the oldest messages

### 14.4 What If the User Sends a Follow-Up Mid-Plan?

The existing `injectUserMessage` mechanism works with the orchestrator:
1. Pause current step execution
2. Insert user message into context
3. Ask model: "The user said: [message]. Should we modify the plan? Respond with: CONTINUE (no change), MODIFY (adjust remaining steps), or ABORT."
4. If MODIFY: re-plan remaining steps with user's new input
5. If CONTINUE: resume current step
6. If ABORT: stop and return results so far

### 14.5 What About Permission Prompts Breaking the Flow?

Permission checks happen INSIDE step execution, exactly as they do now. The orchestrator doesn't bypass permissions -- it just wraps the same `permissionManager.check()` and `callbacks.onPermissionRequest()` flow. The step waits for permission resolution, then continues or skips.

### 14.6 What If Budget Runs Out Mid-Plan?

Check `CostTracker.isOverBudget()` before each step. If over budget:
1. Complete the current step (don't abandon mid-tool-call)
2. Report partial results to user
3. Show which steps remain unfinished
4. Offer to continue when budget is replenished

---

## PART 15: TESTING STRATEGY

Since there's no test suite, validation must be manual:

### Test Matrix

| Test Case | Model | Steps | Expected |
|-----------|-------|-------|----------|
| "What time is it?" (no tools) | All 4 | 0 | Direct text response, no orchestration |
| "Take a screenshot" (1 tool) | All 4 | 1 | Single tool call, works without orchestration |
| "Find 5 AI news articles and save as HTML" | Gemini Flash | 4-6 | Orchestrator creates plan, executes step by step, verifies file |
| "Organize my Desktop by file type" | Gemini Flash | 5-7 | Lists files, creates folders, moves files, verifies |
| "Read the active file and summarize it in a DOCX" | GLM-5 | 3-4 | Reads file, generates DOCX, verifies |
| Same tasks as above | Claude | - | Should use legacy loop, same performance as before |
| "Create a React component" (mid-complexity) | Gemini Flash | 3-4 | Writes .tsx file, verifies |
| Task with permission denials | All | - | Orchestrator handles deny gracefully, tries alternative |
| Task that exceeds 10 turns | Gemini Flash | - | Context compression kicks in, no quality degradation |

---

## PART 16: QUICK REFERENCE — WHAT TO HAND TO CLAUDE CODE

### Files to Create (5 new files):
1. `src/core/agent/orchestrator.ts` — Main orchestration engine
2. `src/core/agent/planner.ts` — Rule-based task decomposition
3. `src/core/agent/contextManager.ts` — Context compression
4. `src/core/agent/validator.ts` — Output validation
5. `src/core/agent/modelProfiles.ts` — Per-model capability profiles

### Files to Modify (7 files):
1. `src/core/agent/claudeAgent.ts` — Route to orchestrator for weak models
2. `src/core/agent/modelAdapter.ts` — Add `forceToolUse` to interface
3. `src/core/agent/adapters/geminiAdapter.ts` — 3 critical fixes
4. `src/core/agent/adapters/glmAdapter.ts` — Image support fix
5. `src/core/agent/toolExecutor.ts` — Add parallel execution
6. `src/core/agent/costTracker.ts` — Per-step cost tracking
7. `src/hooks/useClaudeAgent.ts` — Expose plan state

### Files NOT Modified (6 files):
1. `src/core/agent/toolRegistry.ts` — Tool definitions are fine
2. `src/core/agent/permissions.ts` — Permission system is fine
3. `src/core/agent/shellGuard.ts` — Command blocklist is fine
4. `src/core/agent/smartRouter.ts` — Routing is fine
5. `src/core/agent/adapters/claudeAdapter.ts` — Works perfectly
6. `src/core/agent/adapters/openaiAdapter.ts` — Works well

### Build & Verify Commands:
```bash
npx tsc --noEmit --project tsconfig.json   # Type check
npx vite build                              # Frontend build
npm run dev                                 # Full dev test
```

---

## PART 17: LEARNINGS FROM CLAUDE CODE'S PROMPT ARCHITECTURE

A [community-authored repo](https://github.com/repowise-dev/claude-code-prompts) reverse-engineered and independently reimplemented the 26 prompts that power Claude Code's internal agent system. These patterns are directly applicable to KLYPIX's orchestration enhancement. Here's what we can steal.

### 17.1 The Multi-Agent Model (What Claude Code Actually Does)

Claude Code doesn't run a single agent. It runs a **coordinator + 5 specialized sub-agents**:

| Agent | Role | KLYPIX Equivalent |
|-------|------|-------------------|
| **Coordinator** | Routes tasks, synthesizes results, never delegates comprehension | `orchestrator.ts` (our new file) |
| **Explorer** | Read-only codebase analysis, finds patterns | Step 1 of our planner ("gather context") |
| **Solution Architect** | Designs implementation plan before any code runs | Our `planner.ts` (plan generation phase) |
| **Verification Specialist** | Adversarial testing — tries to BREAK the output | Our `validator.ts` (but we should make it stronger) |
| **Documentation Guide** | Explains what happened | Our final response generation phase |
| **General Purpose** | Fallback for anything that doesn't fit | Our generic plan fallback |

**What KLYPIX can adopt:** We don't need literal sub-agents (that's Claude Code's architecture because it has a Claude API budget). We need the **mindset** — the orchestrator should think in phases that mirror these roles.

### 17.2 The Four-Phase Workflow (Coordinator Pattern)

Claude Code's coordinator runs every task through exactly 4 phases:

```
PHASE 1: RESEARCH (parallel, read-only)
  Multiple workers explore simultaneously — safe because no writes.
  → KLYPIX: Our Steps 1-2 (gather context, read files, search web)

PHASE 2: SYNTHESIS (coordinator alone, no delegation)
  "Read every finding. Understand the problem space. Craft specifications."
  The coordinator NEVER says "based on what you found, figure it out."
  It PROVES understanding by citing specific details.
  → KLYPIX: This is the CRITICAL gap. Currently our orchestrator
    passes raw tool results to the model and says "continue."
    We need a synthesis step where the orchestrator (or a dedicated
    model call) digests all results into a structured brief before
    proceeding to creation.

PHASE 3: IMPLEMENTATION (workers execute the synthesized plan)
  Workers get explicit file paths, line numbers, concrete criteria.
  → KLYPIX: Our Steps 3-5 (create file, write content, etc.)

PHASE 4: VERIFICATION (independent workers, adversarial)
  Don't rubber-stamp self-assessments. Test independently.
  → KLYPIX: Our validator.ts — but needs the adversarial mindset.
```

**Key insight for KLYPIX:** We're missing **Phase 2 (Synthesis)**. Currently after gathering data, we jump straight to "create the file." We should add a synthesis turn where the model (or orchestrator code) compiles gathered data into a structured brief, THEN feeds that brief to the creation step. This is why Claude Code produces higher quality output — it doesn't just pipe raw data through.

### 17.3 The Synthesis Mandate

The single most powerful rule from Claude Code's coordinator:

> **"NEVER write phrases like 'based on what you discovered' — those phrases delegate comprehension and produce inferior results."**

Translation for KLYPIX: After the research phase, the orchestrator should NOT say to the model:

```
BAD: "Based on the web content you read, create an HTML file"
```

Instead it should say:

```
GOOD: "Create an HTML file with these 20 articles:
1. 'AI Regulation Update' — TechCrunch, Apr 3 2026, https://...
2. 'New GPT-5 Benchmark Results' — ArsTechnica, Apr 2 2026, https://...
[... all 20 articles pre-extracted and structured ...]
Use this HTML template: <provided>"
```

The orchestrator does the comprehension. The model does the execution. This is especially critical for Gemini Flash — give it pre-digested data and it executes perfectly. Ask it to "figure out what you found" and it gives up.

**Implementation:** Add a `synthesize()` method to `orchestrator.ts`:

```typescript
/**
 * Phase 2: Synthesize raw tool results into structured data.
 * This runs BETWEEN research steps and creation steps.
 * Can be done by the model (for Claude) or by code (for Flash).
 */
async synthesize(
  researchResults: Map<number, string[]>,
  plan: ExecutionPlan,
  profile: ModelProfile,
): Promise<SynthesizedBrief> {
  if (profile.planningCapability === 'strong') {
    // Claude/GLM-5: ask the model to synthesize
    return this.modelSynthesize(researchResults, plan);
  } else {
    // Gemini Flash: code-based extraction
    return this.codeSynthesize(researchResults, plan);
  }
}

private codeSynthesize(results: Map<number, string[]>, plan: ExecutionPlan): SynthesizedBrief {
  // Extract structured data from raw web content
  // - Find article titles (lines starting with #, <h1>, <h2>)
  // - Find URLs (href patterns)
  // - Find dates (date patterns)
  // - Deduplicate
  // - Sort by relevance
  // Returns clean structured data the creation step can use directly
}
```

### 17.4 The Adversarial Verification Pattern

Claude Code's Verification Specialist has a set of rules that KLYPIX's `validator.ts` should adopt:

**Anti-Rationalization Red Flags:**
- "Code looks correct by inspection" → EXECUTE IT
- "Their tests already pass" → TEST INDEPENDENTLY
- "This is probably fine" → "PROBABLY" ≠ VERIFIED
- "This would take too long" → NOT YOUR DECISION

**Mandatory Adversarial Probes (run at least 1 before any PASS):**
- Boundary values: 0, -1, empty string, extremely long strings, MAX_INT
- Idempotency: submit same request twice
- Orphan operations: reference something that doesn't exist

**Verdict format (adopt exactly):**
```
VERDICT: PASS    — All checks executed with real output
VERDICT: FAIL    — At least one check produced unexpected output
VERDICT: PARTIAL — Environmental blocker prevented complete verification
```

**For KLYPIX this means:**

```typescript
// In validator.ts, after every file creation:
async adversarialValidate(filePath: string): Promise<Verdict> {
  // 1. Does the file exist?
  const dirResult = await executeTool('list_directory', {
    dir_path: filePath.replace(/[/\\][^/\\]+$/, '')
  });
  const fileName = filePath.split(/[/\\]/).pop()!;
  if (!dirResult.includes(fileName)) return { verdict: 'FAIL', reason: 'File not found on disk' };

  // 2. Is the file non-empty?
  const fileResult = await executeTool('read_file', { file_path: filePath, max_chars: 100 });
  if (!fileResult || fileResult.length < 10) return { verdict: 'FAIL', reason: 'File is empty or trivial' };

  // 3. For HTML: does it contain expected structure?
  if (filePath.endsWith('.html')) {
    if (!fileResult.includes('<html') && !fileResult.includes('<!DOCTYPE'))
      return { verdict: 'PARTIAL', reason: 'File exists but may not be valid HTML' };
  }

  // 4. For generated docs: check file size is reasonable
  // (a 20-article HTML should be >5KB, a DOCX should be >10KB)

  return { verdict: 'PASS', reason: 'File verified: exists, non-empty, valid format' };
}
```

### 17.5 The 9-Section Context Compression

Claude Code compresses conversation context into exactly 9 sections. KLYPIX's `contextManager.ts` should use a similar structure:

```typescript
interface CompressedContext {
  // Section 1: What the user asked for
  primaryRequest: string;

  // Section 2: Key technical details discovered
  technicalContext: string;

  // Section 3: Files read/created with paths
  fileOperations: Array<{ path: string; action: 'read' | 'write' | 'create'; summary: string }>;

  // Section 4: Errors encountered and how they were resolved
  errorsAndFixes: Array<{ error: string; resolution: string }>;

  // Section 5: Decision log (why we chose this approach)
  decisions: Array<{ decision: string; reason: string }>;

  // Section 6: Data collected (summaries, not raw content)
  collectedData: string;

  // Section 7: Pending tasks (what remains)
  pendingTasks: string[];

  // Section 8: Current active work
  currentWork: string;

  // Section 9: Suggested next step
  suggestedNext: string;
}
```

This replaces raw message history. When the orchestrator sends context to the model for step N, it doesn't send turns 1 through N-1 — it sends this 9-section compressed summary plus the full context for step N only.

**Token savings estimate:**
- 10-turn task with screenshots: ~120K tokens raw → ~15K tokens compressed (87% reduction)
- 20-turn task: ~300K tokens raw → ~20K tokens compressed (93% reduction)

### 17.6 The Memory Extraction Pattern

Claude Code extracts 5 compact elements after every major step:

1. **Goal** — what must be delivered (doesn't change)
2. **Constraints** — non-negotiable rules (from user prompt or system)
3. **Decisions** — choices made + short rationale (grows each step)
4. **Open questions** — unresolved items blocking confidence
5. **Verification state** — what's been tested, what remains

KLYPIX should maintain this as a running state object in `orchestrator.ts`:

```typescript
interface AgentMemory {
  goal: string;
  constraints: string[];
  decisions: Array<{ what: string; why: string; stepId: number }>;
  openQuestions: string[];
  verificationState: {
    tested: string[];
    untested: string[];
    verdicts: Array<{ check: string; verdict: 'PASS' | 'FAIL' | 'PARTIAL' }>;
  };
}
```

Updated after every step. Fed into every model call. This is how the agent maintains coherence across 15+ turns without repeating itself or contradicting earlier decisions.

### 17.7 Mapping to KLYPIX's New File Structure

| Claude Code Pattern | KLYPIX Implementation |
|--------------------|-----------------------|
| Coordinator prompt | `orchestrator.ts` — 4-phase workflow |
| Solution Architect | `planner.ts` — plan generation with options analysis |
| Explorer agent | Research phase in orchestrator (parallel read-only steps) |
| Verification Specialist | `validator.ts` — adversarial probes + PASS/FAIL/PARTIAL |
| Conversation Summary | `contextManager.ts` — 9-section compression |
| Memory Extraction | `AgentMemory` object in orchestrator state |
| Synthesis Mandate | `orchestrator.synthesize()` — digest before delegate |
| Tool-specific prompts | `modelProfiles.ts` — per-model system prompt tuning |
| Anti-rationalization | Validator red flag checklist |
| Risk-stratified testing | `validator.ts` — check severity scales with operation risk |

### 17.8 What This Means for the Implementation Phases

**Phase 1 (Foundation)** — unchanged, still the adapter fixes.

**Phase 2 (Planning)** — enhanced: the planner now produces options + trade-offs (Solution Architect pattern), not just a step list.

**Phase 2.5 (NEW: Synthesis Phase)** — add `orchestrator.synthesize()` between research and implementation. This is the single highest-impact addition from the Claude Code patterns. Without it, weak models get raw data dumps and fumble the creation step.

**Phase 3 (Validation)** — significantly enhanced: adopt the full adversarial verification pattern with PASS/FAIL/PARTIAL verdicts, anti-rationalization checks, mandatory probes.

**Phase 4 (Parallel)** — unchanged, same parallel execution.

**Phase 5 (Context)** — enhanced: adopt 9-section compression + 5-element memory extraction. Replace raw history with structured context.

---

## APPENDIX: COMPLETE FILE CHANGE LIST (UPDATED)

### New Files (6):
1. `src/core/agent/orchestrator.ts` — 4-phase orchestration + synthesis + memory
2. `src/core/agent/planner.ts` — Rule-based + model-based task decomposition
3. `src/core/agent/contextManager.ts` — 9-section compression + token estimation
4. `src/core/agent/validator.ts` — Adversarial validation + PASS/FAIL/PARTIAL
5. `src/core/agent/modelProfiles.ts` — Per-model profiles (all GLM variants included)
6. `src/core/agent/types.ts` — Shared types (ExecutionPlan, AgentMemory, etc.)

### Modified Files (8):
1. `src/core/agent/claudeAgent.ts` — Route to orchestrator + legacy mode split
2. `src/core/agent/modelAdapter.ts` — Add `forceToolUse`, `toolSubset` to interface
3. `src/core/agent/adapters/geminiAdapter.ts` — functionCallingConfig + tool result format
4. `src/core/agent/adapters/glmAdapter.ts` — Vision support + tool_choice + multimodal messages
5. `src/core/agent/toolExecutor.ts` — Add `executeToolsParallel`
6. `src/core/agent/costTracker.ts` — Add all model pricing (Gemini, GLM, OpenAI)
7. `src/core/agent/agentSession.ts` — Add plan tracking + memory state
8. `src/hooks/useClaudeAgent.ts` — Expose plan steps + synthesis state

### Unchanged Files (6):
1. `src/core/agent/toolRegistry.ts`
2. `src/core/agent/permissions.ts`
3. `src/core/agent/shellGuard.ts`
4. `src/core/agent/smartRouter.ts`
5. `src/core/agent/adapters/claudeAdapter.ts`
6. `src/core/agent/adapters/openaiAdapter.ts`

---

## PART 18: THE 100x INNOVATIONS — WHAT NO OTHER AGENT HAS

Everything in Parts 1-17 brings KLYPIX to parity with the best agents. This section is what puts it *beyond* them. These are innovations that Cowork, Claude Code, Cursor, Devin, and Codex fundamentally cannot do because of their architecture. KLYPIX can do them because it runs on the user's Windows desktop with full system access, multi-model support, and screen vision.

### 18.1 INNOVATION 1: Multi-Model Chaining Within a Single Task

**What it is:** Use different models for different phases of the SAME task. Flash for cheap classification, Claude for complex reasoning, GLM-5V for vision analysis — automatically, within one execution.

**Why no one else has it:** Cowork is Claude-only. Cursor is Claude/GPT only. Devin is Claude-only. They're locked to one model per session.

**How it works:**

```typescript
// In orchestrator.ts
interface ModelAllocation {
  planning: AgentModelProvider;      // Who plans? (strong model)
  research: AgentModelProvider;      // Who gathers data? (cheap model)
  synthesis: AgentModelProvider;     // Who synthesizes? (strong model)
  implementation: AgentModelProvider; // Who creates files? (depends on complexity)
  verification: AgentModelProvider;  // Who verifies? (cheap model — verification is simple)
}

function allocateModels(
  task: ExecutionPlan,
  availableKeys: Record<AgentModelProvider, string | null>,
  budgetRemaining: number,
): ModelAllocation {
  const hasClaudeKey = !!availableKeys.claude;
  const hasGeminiKey = !!availableKeys.gemini;
  const hasGLMKey = !!availableKeys.glm;

  // Optimal: Claude plans + synthesizes, Gemini researches + verifies
  if (hasClaudeKey && hasGeminiKey) {
    return {
      planning: 'claude',           // $0.003 — worth it for good plan
      research: 'gemini',           // FREE — just reading web pages
      synthesis: 'claude',          // $0.005 — critical quality step
      implementation: 'claude',     // $0.01 — file creation needs quality
      verification: 'gemini',       // FREE — just checking file exists
    };
    // Total: ~$0.02 instead of ~$0.08 all-Claude
    // Quality: 95% of all-Claude because research+verification don't need it
  }

  // Budget: GLM-5 plans + synthesizes, Gemini Flash does grunt work
  if (hasGLMKey && hasGeminiKey) {
    return {
      planning: 'glm',
      research: 'gemini',
      synthesis: 'glm',
      implementation: 'glm',
      verification: 'gemini',
    };
  }

  // Single model fallback
  const primary = hasClaudeKey ? 'claude' : hasGLMKey ? 'glm' : 'gemini';
  return {
    planning: primary, research: primary, synthesis: primary,
    implementation: primary, verification: primary,
  };
}
```

**User-facing impact:** "Use my Claude key for thinking, Gemini for grunt work" — 75% cost reduction with 95% quality.

**New file needed:** `src/core/agent/modelAllocator.ts`

### 18.2 INNOVATION 2: Speculative Execution (Parallel Betting)

**What it is:** While waiting for a tool result that might fail, start working on the likely next step simultaneously. If the tool succeeds, the speculative work saves time. If it fails, discard it.

**Why no one else has it:** Requires managing multiple execution branches simultaneously. Most agents are single-threaded loops.

**How it works:**

```typescript
// In orchestrator.ts
async executeWithSpeculation(
  currentStep: PlanStep,
  nextStep: PlanStep,
  adapter: ModelAdapter,
): Promise<void> {
  // Start current step
  const currentPromise = this.executeStep(currentStep, adapter);

  // If next step doesn't depend on current step's RESULT (only on its completion),
  // we can speculatively start it
  const canSpeculate = nextStep.depends.length === 0 ||
    (nextStep.depends.includes(currentStep.id) && nextStep.tools.every(t =>
      ['capture_screenshot', 'get_active_window', 'list_directory'].includes(t)
    ));

  let speculativePromise: Promise<any> | null = null;
  if (canSpeculate) {
    // Start next step speculatively (read-only tools only — safe to discard)
    speculativePromise = this.executeStep(nextStep, adapter).catch(() => null);
  }

  const currentResult = await currentPromise;

  if (currentResult.success && speculativePromise) {
    // Speculation paid off — use the result
    const specResult = await speculativePromise;
    if (specResult?.success) {
      nextStep.status = 'completed';
      nextStep.result = specResult.summary;
      // Saved one full round-trip
    }
  }
}
```

**Savings:** 20-40% execution time on multi-step tasks.

### 18.3 INNOVATION 3: Tool Result Caching + Deduplication

**What it is:** If the agent reads the same URL or file twice (common in multi-step tasks), serve the cached result instead of making another IPC call. Also deduplicate identical tool calls that the model makes when it "forgets" it already called them.

**Why no one else has it:** Most agents send raw tool calls without checking history.

```typescript
// NEW: src/core/agent/toolCache.ts

interface CacheEntry {
  toolName: string;
  inputHash: string;
  result: string;
  timestamp: number;
  ttlMs: number;
}

class ToolCache {
  private cache = new Map<string, CacheEntry>();

  // Different TTLs per tool
  private readonly TTL: Record<string, number> = {
    'read_web_content': 5 * 60 * 1000,   // 5 min — web pages don't change fast
    'read_file': 30 * 1000,               // 30s — files change during editing
    'list_directory': 60 * 1000,           // 1 min — directory listings
    'capture_screenshot': 0,               // Never cache — screen always changes
    'get_active_window': 0,                // Never cache
    'run_shell': 0,                        // Never cache — commands have side effects
    'clipboard_read': 0,                   // Never cache
  };

  get(toolName: string, input: Record<string, any>): string | null {
    const hash = this.hash(toolName, input);
    const entry = this.cache.get(hash);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > entry.ttlMs) {
      this.cache.delete(hash);
      return null;
    }
    return entry.result;
  }

  set(toolName: string, input: Record<string, any>, result: string): void {
    const ttl = this.TTL[toolName] ?? 0;
    if (ttl === 0) return; // Don't cache non-cacheable tools
    const hash = this.hash(toolName, input);
    this.cache.set(hash, { toolName, inputHash: hash, result, timestamp: Date.now(), ttlMs: ttl });
  }

  // Detect when model calls same tool with same input twice
  isDuplicate(toolName: string, input: Record<string, any>): boolean {
    return this.get(toolName, input) !== null;
  }

  private hash(toolName: string, input: Record<string, any>): string {
    return `${toolName}:${JSON.stringify(input)}`;
  }
}
```

**Impact:** Eliminates 30-50% of redundant tool calls on complex tasks. Especially important for Gemini Flash which often "forgets" it already read a file.

### 18.4 INNOVATION 4: Screen-Diff Verification

**What it is:** Take a screenshot BEFORE the task, another AFTER, and visually compare them to verify the agent's work. No other agent does visual before/after verification.

**Why KLYPIX can do this:** It has `capture_screenshot` as a native tool. Cowork doesn't have screen access.

```typescript
// In validator.ts
async visualVerification(
  taskType: 'file_created' | 'app_opened' | 'browser_navigated' | 'desktop_organized',
): Promise<VisualVerdict> {
  // Take "after" screenshot
  const afterScreenshot = await executeTool('capture_screenshot', {});
  const afterParsed = JSON.parse(afterScreenshot);

  // Ask the model: "Compare what the user's screen looks like now
  // vs what they asked for. Does the task appear completed?"
  // This catches things code-based validation misses:
  // - File created but not in the right location
  // - Browser opened but showing error page
  // - Desktop "organized" but files are just renamed, not moved

  return {
    verdict: 'PASS',
    visualEvidence: 'Screenshot shows new file on Desktop',
    screenshotBase64: afterParsed.image,
  };
}
```

**User-facing:** The WorkflowPanel shows before/after screenshots with a visual diff highlighting what changed. The user can SEE the agent's work was done correctly.

### 18.5 INNOVATION 5: Streaming Artifact Creation (Pipeline Execution)

**What it is:** Instead of gathering ALL data THEN creating the file, start creating the file while still gathering data. Like a factory assembly line — each article gets added to the HTML as it's found, not after all 20 are collected.

**Why no one else has it:** Requires treating file creation as a stream, not a batch operation.

```typescript
// In orchestrator.ts
async pipelineExecution(plan: ExecutionPlan): Promise<void> {
  // For tasks like "find 20 articles and create HTML":
  // 1. Create the HTML skeleton immediately (header, CSS, empty body)
  // 2. As each article is found, append it to the HTML
  // 3. When done, write the closing tags

  const isStreamable = this.detectStreamableTask(plan);
  if (!isStreamable) return this.batchExecution(plan);

  // Create skeleton
  let htmlContent = this.generateSkeleton(plan.goal);
  await executeTool('write_file', {
    file_path: this.outputPath,
    content: htmlContent,
  });
  callbacks.onTextDelta('Created initial file, adding content...\n');

  // Stream data into the file as it arrives
  for (const researchStep of plan.steps.filter(s => s.tools.includes('read_web_content'))) {
    const result = await this.executeStep(researchStep, adapter);
    if (result.success) {
      const extractedItems = this.extractItems(result);
      htmlContent = this.appendToHtml(htmlContent, extractedItems);
      // Overwrite file with updated content
      await executeTool('write_file', {
        file_path: this.outputPath,
        content: htmlContent,
      });
      callbacks.onTextDelta(`Added ${extractedItems.length} items (${this.totalItems} total)\n`);
    }
  }

  // Finalize
  htmlContent = this.finalizeHtml(htmlContent);
  await executeTool('write_file', { file_path: this.outputPath, content: htmlContent });
}
```

**User-facing:** The user can open the file WHILE the agent is still working and see partial results. If they're happy at 15/20 articles, they can abort and keep what's there.

### 18.6 INNOVATION 6: Ambient Context Intelligence

**What it is:** Before the user even asks anything, KLYPIX already knows what they're working on. When they trigger Alt+Space, the agent has pre-analyzed their active window, open files, clipboard content, and recent browser tabs. The orchestrator uses this to generate a smarter plan.

**Your code already has the pieces:** `getActiveWindowContext()`, `readActiveFile()`, `getAllOpenFiles()`, `readClipboard()`, `contextIntelligence.ts` (detects 50+ app categories). The problem is the agent engine ignores most of this — it only gets `windowContext` and a screenshot.

```typescript
// Enhanced: Inject rich ambient context into the orchestrator

interface AmbientContext {
  activeWindow: WindowContext;
  screenshot: string;
  activeFileContent: string | null;
  openFiles: DiscoveredFile[];
  clipboardText: string | null;
  recentBrowserTabs: Array<{ title: string; url: string }>;
  detectedCategory: string;  // From contextIntelligence.ts
  suggestedActions: Suggestion[];  // From contextIntelligence.ts
}

// In orchestrator.ts, BEFORE planning:
async gatherAmbientContext(): Promise<AmbientContext> {
  // Run these in parallel — all are read-only, all are fast
  const [window, screenshot, activeFile, openFiles, clipboard] = await Promise.all([
    executeTool('get_active_window', {}),
    executeTool('capture_screenshot', {}),
    executeTool('read_active_file', {}).catch(() => null),
    executeTool('get_all_open_files', {}).catch(() => '[]'),
    executeTool('clipboard_read', {}).catch(() => null),
  ]);

  return { /* ... structured context ... */ };
}
```

**The planner then uses this:**
- User is in VS Code editing `api.ts` → agent knows it's a coding task
- Clipboard has a URL → agent might need to fetch that
- Browser tab shows Stack Overflow → user might be debugging
- 3 Excel files are open → task might involve spreadsheet data

This makes the plan 10x smarter before the model even runs.

### 18.7 INNOVATION 7: Adaptive Turn Budgeting

**What it is:** Instead of fixed 25-turn limit for everything, dynamically allocate turns based on task complexity and what the model actually needs.

```typescript
// In orchestrator.ts
interface TurnBudget {
  total: number;
  perStep: Map<number, number>;
  used: number;
  hardCeiling: number;  // Never exceed this (default 25)
}

function allocateTurnBudget(plan: ExecutionPlan, profile: ModelProfile): TurnBudget {
  const budget: TurnBudget = {
    total: 0,
    perStep: new Map(),
    used: 0,
    hardCeiling: 25,
  };

  for (const step of plan.steps) {
    let stepBudget: number;

    if (step.tools.includes('read_web_content')) {
      // Web reads: 1-2 turns each, may need retry
      stepBudget = 2;
    } else if (step.tools.includes('write_file') || step.tools.includes('generate_document')) {
      // File creation: 1 turn usually, but complex content needs 2
      stepBudget = 2;
    } else if (step.tools.includes('run_shell')) {
      // Shell commands: unpredictable, budget 3 for retry
      stepBudget = 3;
    } else if (step.tools.length === 0) {
      // Thinking/synthesis step: 1 turn
      stepBudget = 1;
    } else {
      stepBudget = 2;
    }

    // Weak models need more turns per step
    if (profile.earlyTerminationRisk === 'high') {
      stepBudget = Math.ceil(stepBudget * 1.5);
    }

    budget.perStep.set(step.id, stepBudget);
    budget.total += stepBudget;
  }

  // Add verification budget
  budget.total += 2;

  // Clamp to ceiling
  budget.total = Math.min(budget.total, budget.hardCeiling);

  return budget;
}
```

**Benefit:** Simple tasks get 5 turns (fast, cheap). Complex tasks get 20+ turns (thorough). No more one-size-fits-all.

### 18.8 INNOVATION 8: Checkpoint & Resume

**What it is:** Save agent state to disk after each step. If the app crashes, the user closes the window, or the API times out — resume from the last checkpoint instead of starting over.

```typescript
// NEW: src/core/agent/checkpoint.ts

interface Checkpoint {
  planState: ExecutionPlan;
  completedResults: Map<number, string>;
  agentMemory: AgentMemory;
  contextSummary: string;
  costSoFar: CostSummary;
  turnCount: number;
  timestamp: number;
}

class CheckpointManager {
  private readonly storageKey = 'klypix:agentCheckpoint';

  save(checkpoint: Checkpoint): void {
    localStorage.setItem(this.storageKey, JSON.stringify(checkpoint));
  }

  load(): Checkpoint | null {
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return null;
    const cp = JSON.parse(raw);
    // Expire checkpoints older than 1 hour
    if (Date.now() - cp.timestamp > 3600000) {
      this.clear();
      return null;
    }
    return cp;
  }

  clear(): void {
    localStorage.removeItem(this.storageKey);
  }

  hasResumable(): boolean {
    return this.load() !== null;
  }
}
```

**User-facing:** When the user opens KLYPIX and there's an incomplete task, show: "Your previous task was interrupted at Step 4/7: Creating HTML file. Resume?" — one click to continue exactly where they left off.

### 18.9 INNOVATION 9: Session Learning (Cross-Task Intelligence)

**What it is:** Analyze past agent sessions to improve future plans. If TechCrunch blocked the agent 3 times this week, don't include it in future web scraping plans. If the user always saves files to `D:\Projects\`, default there instead of Desktop.

```typescript
// NEW: src/core/agent/sessionLearning.ts

interface LearnedPattern {
  type: 'blocked_url' | 'preferred_path' | 'tool_failure' | 'user_correction';
  pattern: string;
  confidence: number;
  lastSeen: number;
  count: number;
}

class SessionLearning {
  private patterns: LearnedPattern[] = [];

  constructor() {
    this.patterns = JSON.parse(localStorage.getItem('klypix:learnedPatterns') || '[]');
  }

  /**
   * After each session, extract patterns from what happened.
   */
  learnFromSession(session: AgentSession): void {
    // Pattern: URLs that consistently fail
    for (const step of session.steps) {
      if (step.toolName === 'read_web_content' && step.status === 'error') {
        const url = step.toolInput?.url;
        if (url) this.recordPattern('blocked_url', new URL(url).hostname);
      }
    }

    // Pattern: Where user's files end up
    for (const step of session.steps) {
      if (step.toolName === 'write_file' && step.status === 'completed') {
        const dir = step.toolInput?.file_path?.replace(/[/\\][^/\\]+$/, '');
        if (dir) this.recordPattern('preferred_path', dir);
      }
    }

    // Pattern: Tools that consistently fail on this system
    for (const step of session.steps) {
      if (step.status === 'error' && step.toolName) {
        this.recordPattern('tool_failure', step.toolName);
      }
    }

    this.persist();
  }

  /**
   * Before planning, inject learned patterns as constraints.
   */
  getConstraints(): string[] {
    const constraints: string[] = [];

    // Blocked URLs
    const blockedDomains = this.patterns
      .filter(p => p.type === 'blocked_url' && p.count >= 2)
      .map(p => p.pattern);
    if (blockedDomains.length > 0) {
      constraints.push(`AVOID these domains (historically blocked): ${blockedDomains.join(', ')}`);
    }

    // Preferred save path
    const pathCounts = this.patterns
      .filter(p => p.type === 'preferred_path')
      .sort((a, b) => b.count - a.count);
    if (pathCounts.length > 0) {
      constraints.push(`User's preferred save location: ${pathCounts[0].pattern}`);
    }

    return constraints;
  }

  private recordPattern(type: LearnedPattern['type'], pattern: string): void {
    const existing = this.patterns.find(p => p.type === type && p.pattern === pattern);
    if (existing) {
      existing.count++;
      existing.lastSeen = Date.now();
      existing.confidence = Math.min(1.0, existing.confidence + 0.1);
    } else {
      this.patterns.push({ type, pattern, confidence: 0.3, lastSeen: Date.now(), count: 1 });
    }
  }

  private persist(): void {
    // Keep only last 100 patterns, expire after 7 days
    this.patterns = this.patterns
      .filter(p => Date.now() - p.lastSeen < 7 * 24 * 3600000)
      .slice(-100);
    localStorage.setItem('klypix:learnedPatterns', JSON.stringify(this.patterns));
  }
}
```

**Impact:** The agent gets smarter over time. After 10 sessions, it knows the user's patterns, avoids known-bad URLs, defaults to their preferred paths, and skips tools that don't work on their system.

### 18.10 INNOVATION 10: Progressive Disclosure + Early Preview

**What it is:** Don't wait until the task is 100% done to show results. After each major step, generate a preview and ask the user if they want to continue or adjust.

```typescript
// In orchestrator.ts
interface ProgressCheckpoint {
  stepId: number;
  previewAvailable: boolean;
  previewType: 'file' | 'data_table' | 'screenshot' | 'text';
  previewContent: string;
  completionPercentage: number;
  estimatedRemainingTime: string;
}

// After each phase, emit a checkpoint
callbacks.onProgressCheckpoint({
  stepId: 3,
  previewAvailable: true,
  previewType: 'data_table',
  previewContent: '| # | Title | Source |\n|---|-------|--------|\n| 1 | AI Regulation... | TechCrunch |\n...(15 rows)',
  completionPercentage: 60,
  estimatedRemainingTime: '~30 seconds',
});
```

**User-facing in WorkflowPanel:** A live preview card appears mid-execution:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  📊 Progress: 60% (Step 3 of 5)
  Found 15/20 articles so far

  [Preview Data]  [Continue]  [Good Enough — Stop Here]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

No other agent gives the user this level of mid-execution control.

### 18.11 INNOVATION 11: Cross-Application Orchestration

**What it is:** The agent can read from one app and write to another in a coordinated flow. Read data from an open Excel spreadsheet → search the web to enrich it → create a PowerPoint from the results → open it in PowerPoint.

**Why KLYPIX can do this:** It has both `readActiveFile()` (reads from any foreground app via UIAutomation), `executeAction` (opens apps, types text), AND `generate_document` (creates Office docs). No other agent has all three.

```typescript
// Cross-app workflow example:
// "Take the data from this Excel and make a presentation"

const crossAppPlan: ExecutionPlan = {
  goal: 'Convert Excel data to PowerPoint presentation',
  steps: [
    { id: 1, action: 'Read the active Excel file', tools: ['read_active_file'], depends: [] },
    { id: 2, action: 'Parse spreadsheet data into structured format', tools: [], depends: [1] },
    { id: 3, action: 'Generate PPTX with parsed data', tools: ['generate_document'], depends: [2] },
    { id: 4, action: 'Open the generated PPTX file', tools: ['system_open'], depends: [3] },
    { id: 5, action: 'Verify PowerPoint opened correctly', tools: ['capture_screenshot'], depends: [4] },
  ],
  successCriteria: [
    { type: 'file_exists', description: 'PPTX file was created', check: {}, met: false },
  ],
  estimatedTurns: 6,
};
```

**This is KLYPIX's killer feature.** No other desktop agent can seamlessly read from Excel, process through AI, create a PowerPoint, and open it — all in one automated flow.

### 18.12 INNOVATION 12: Smart Model Auto-Escalation

**What it is:** Start with the cheapest model. If it fails or produces poor results, automatically escalate to a stronger model — without the user knowing or intervening.

```typescript
// In orchestrator.ts
interface EscalationPolicy {
  startWith: AgentModelProvider;
  escalateTo: AgentModelProvider;
  escalateAfter: number;        // N consecutive failures
  escalateOnQuality: boolean;   // Escalate if result quality is poor
}

async executeWithEscalation(
  step: PlanStep,
  policy: EscalationPolicy,
): Promise<StepResult> {
  let currentProvider = policy.startWith;
  let adapter = createAdapter(currentProvider, this.getKey(currentProvider));

  for (let attempt = 0; attempt < step.maxRetries + 1; attempt++) {
    const result = await this.executeStep(step, adapter);

    if (result.success) return result;

    // After N failures on cheap model, escalate
    if (attempt >= policy.escalateAfter - 1 && currentProvider !== policy.escalateTo) {
      const escalateKey = this.getKey(policy.escalateTo);
      if (escalateKey) {
        callbacks.onTextDelta(`Escalating to ${policy.escalateTo} for better results...\n`);
        currentProvider = policy.escalateTo;
        adapter = createAdapter(currentProvider, escalateKey);
      }
    }
  }

  return { success: false, reason: 'All attempts failed including escalation' };
}
```

**Example:** "Find 20 articles" starts with Gemini Flash (free). If Flash fails 3 times to produce good data, auto-escalate to Claude for that step only, then switch back to Flash for the next step.

### 18.13 INNOVATION 13: Compound Tool Operations

**What it is:** Pre-built tool chains that combine multiple IPC calls into a single atomic operation. Instead of the model calling 3 separate tools, it calls one compound tool.

```typescript
// Add to toolRegistry.ts (or a new compoundTools.ts)

const COMPOUND_TOOLS = {
  'read_and_summarize': {
    description: 'Read a web page and return a structured summary with title, date, key points',
    steps: [
      { tool: 'read_web_content', inputMap: { url: 'url' } },
      { transform: 'extractArticleMetadata' },  // Code-based extraction, no model call
    ],
  },
  'create_and_open': {
    description: 'Create a document file and open it in the default application',
    steps: [
      { tool: 'generate_document', inputMap: { format: 'format', spec: 'spec' } },
      { tool: 'system_open', inputMap: { target: '{{previous.path}}' } },
    ],
  },
  'find_desktop_path': {
    description: 'Get the user Desktop path (resolves %USERPROFILE%\\Desktop)',
    steps: [
      { tool: 'run_shell', input: { command: 'echo $env:USERPROFILE\\Desktop' } },
      { transform: 'trimOutput' },
    ],
  },
  'safe_write': {
    description: 'Write a file with automatic versioning (appends _v2 if file exists)',
    steps: [
      { tool: 'list_directory', inputMap: { dir_path: '{{dirname(file_path)}}' } },
      { transform: 'resolveVersionedPath' },
      { tool: 'write_file', inputMap: { file_path: '{{resolved_path}}', content: 'content' } },
    ],
  },
};
```

**Why this helps weak models:** Instead of needing 3 separate tool calls (each one a chance for Gemini to give up), compound tools execute the entire chain in one orchestrator-managed operation. The model makes ONE decision ("I need to create and open this file"), and the orchestrator handles the 3 IPC calls atomically.

### 18.14 INNOVATION 14: Proactive Suggestions Engine

**What it is:** After completing a task, the agent doesn't just say "done." It analyzes the results and proactively suggests meaningful next steps based on what it discovered.

Your system prompt already says `End with a ## Suggestions section`. But these suggestions are model-generated and often generic. The orchestrator should generate data-driven suggestions:

```typescript
// In orchestrator.ts, after task completion:
function generateSmartSuggestions(
  plan: ExecutionPlan,
  results: Map<number, string[]>,
  ambientContext: AmbientContext,
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // If we created a file → suggest sharing, converting, or editing it
  const createdFiles = this.getCreatedFiles(results);
  for (const file of createdFiles) {
    if (file.endsWith('.html')) {
      suggestions.push({ text: 'Open this HTML in browser', action: `system_open ${file}` });
      suggestions.push({ text: 'Convert to PDF', action: `convert ${file} to pdf` });
    }
    if (file.endsWith('.xlsx')) {
      suggestions.push({ text: 'Create charts from this data', action: `chart ${file}` });
      suggestions.push({ text: 'Generate presentation from data', action: `make pptx from ${file}` });
    }
  }

  // If we gathered web data → suggest deeper analysis
  const webReads = results.get('read_web_content')?.length || 0;
  if (webReads > 5) {
    suggestions.push({ text: 'Summarize the key trends found', action: 'analyze trends' });
    suggestions.push({ text: 'Create a comparison table', action: 'compare articles' });
  }

  // If desktop was scanned → suggest organization
  if (plan.goal.toLowerCase().includes('desktop') || plan.goal.toLowerCase().includes('organize')) {
    suggestions.push({ text: 'Set up auto-organization schedule', action: 'schedule weekly cleanup' });
  }

  return suggestions.slice(0, 3); // Max 3 actionable suggestions
}
```

### 18.15 THE 100x SUMMARY — Feature Comparison Matrix

| Feature | Cowork | Claude Code | Cursor | Devin | **KLYPIX (After)** |
|---------|--------|-------------|--------|-------|-------------------|
| Multi-model chaining | No | No | Partial | No | **Yes — mix models per phase** |
| Speculative execution | No | No | No | No | **Yes — parallel betting** |
| Tool result caching | No | No | No | Yes | **Yes — TTL-based per tool** |
| Screen-diff verification | No | No | No | Partial | **Yes — before/after screenshots** |
| Streaming artifact creation | No | No | No | No | **Yes — progressive file building** |
| Ambient context pre-analysis | No | No | Partial | No | **Yes — 5 parallel context calls** |
| Adaptive turn budgeting | No | No | No | No | **Yes — per-step allocation** |
| Checkpoint & resume | No | No | No | Yes | **Yes — localStorage persisted** |
| Cross-session learning | No | No | No | Partial | **Yes — pattern extraction** |
| Progressive disclosure | No | No | No | Partial | **Yes — mid-execution previews** |
| Cross-app orchestration | No | No | No | Partial | **Yes — Excel→AI→PowerPoint** |
| Auto model escalation | No | No | No | No | **Yes — cheap→strong on failure** |
| Compound tool operations | No | No | No | No | **Yes — atomic multi-tool chains** |
| Smart post-task suggestions | Basic | Basic | Basic | Basic | **Yes — data-driven, actionable** |
| Windows desktop native | No | Terminal only | Editor only | Cloud VM | **Yes — full system access** |
| 4 model providers | 1 (Claude) | 1 (Claude) | 2 | 1 | **4 (Claude/Gemini/OpenAI/GLM)** |
| Forced tool calling | N/A | Native | N/A | N/A | **Yes — per-model API flags** |
| Adversarial self-verification | No | Limited | No | No | **Yes — PASS/FAIL/PARTIAL** |
| 9-section context compression | No | No | No | Yes | **Yes — structured compression** |
| Dynamic plan replanning | No | No | No | Yes | **Yes — add/skip/modify steps** |
| Cost-optimal model allocation | N/A | N/A | N/A | N/A | **Yes — Claude thinks, Flash grinds** |

**KLYPIX's unique moat:** It's the ONLY agent that combines Windows desktop access + multi-model support + vision + Office document generation + browser automation in a single tool. No one else can do "read my Excel, search the web, create a PowerPoint, and open it" in one automated flow across 4 different AI providers.

### 18.16 Updated New File List

The 14 innovations above add these new files:

| # | File | Innovation |
|---|------|-----------|
| 7 | `src/core/agent/modelAllocator.ts` | Multi-model chaining (#1) |
| 8 | `src/core/agent/toolCache.ts` | Tool result caching (#3) |
| 9 | `src/core/agent/checkpoint.ts` | Checkpoint & resume (#8) |
| 10 | `src/core/agent/sessionLearning.ts` | Cross-session learning (#9) |
| 11 | `src/core/agent/compoundTools.ts` | Compound tool operations (#13) |

Innovations #2, #4, #5, #6, #7, #10, #11, #12, #14 are implemented within existing new files (`orchestrator.ts`, `validator.ts`, `contextManager.ts`, `modelProfiles.ts`).

### 18.17 Implementation Priority for the 14 Innovations

**Wave 1 (Implement with core orchestration — highest impact):**
1. Ambient context intelligence (#6) — uses existing tools, just needs parallel pre-fetch
2. Tool result caching (#3) — simple cache, prevents redundant calls
3. Compound tool operations (#13) — reduces tool-call count for weak models
4. Adaptive turn budgeting (#7) — replaces fixed 25-turn limit

**Wave 2 (Implement after core works — differentiators):**
5. Multi-model chaining (#1) — needs multiple API keys configured
6. Auto model escalation (#12) — builds on multi-model
7. Checkpoint & resume (#8) — safety net for long tasks
8. Screen-diff verification (#4) — visual proof of completion

**Wave 3 (Polish — competitive moat):**
9. Session learning (#9) — improves over time
10. Progressive disclosure (#10) — mid-execution previews
11. Streaming artifact creation (#5) — pipeline execution
12. Speculative execution (#2) — performance optimization
13. Smart suggestions (#14) — post-task intelligence
14. Cross-app orchestration (#11) — killer demo feature
