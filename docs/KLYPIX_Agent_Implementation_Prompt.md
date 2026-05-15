# ⚠️ SUPERSEDED — see CLAUDE.md

# KLYPIX Orchestration Enhancement — Coding Agent Directive

## YOUR MISSION

You are implementing a comprehensive orchestration enhancement for **KLYPIX**, an AI-powered Windows desktop overlay assistant (Electron 33 + React 19 + Vite 6 + TypeScript). The app runs an agent engine that chains LLM tool calls to complete tasks on the user's computer. Currently, Claude works great in agent mode but **Gemini Flash and GLM produce terrible results** — Gemini gives up after 3 turns on complex tasks.

Your job: **Transform the agent engine from a passive model-relay into an intelligent orchestration layer that closes the quality gap between ALL LLM providers.** After your implementation, Gemini Flash and GLM-4.x should complete the same multi-step tasks that currently only Claude can handle.

**You are also implementing 14 breakthrough innovations** that will make KLYPIX's agent superior to Cowork, Claude Code, Cursor, and Devin. Do NOT reduce scope due to complexity. Build the full vision.

**Attached companion document:** `KLYPIX_Orchestration_Enhancement_Plan.md` (3,326 lines) — This is your complete technical blueprint. It contains every interface, every code snippet, every decision rationale. **Read it thoroughly before writing any code.** The plan is your source of truth for architecture, file structure, interfaces, and expected behavior.

---

## CRITICAL AUDIT CORRECTIONS

Before implementing, apply these corrections to the plan's claims (the plan is 8.5/10 quality but has 6 factual errors):

1. **Tool count is 20, not 22.** The plan says "22 tools" in several places — the actual `toolRegistry.ts` defines **20 tools**. Adjust any references.

2. **`browser_click` permission level is `ask_every`, NOT `ask_first`.** The plan's tool categorization in Part 1.4 lists it under "Ask First" — it's actually "Ask Every". This doesn't affect implementation but correct it in any generated system prompts or documentation.

3. **No `runLegacy` method exists yet.** The plan references `this.runLegacy()` in `claudeAgent.ts` — you need to CREATE this method by extracting the current agent loop (lines ~114-276) into a `private async runLegacy(...)` method, then add a new `private async runOrchestrated(...)` method alongside it. The existing `run()` method becomes the router that checks the model profile and dispatches to the correct path.

4. **`geminiAdapter.ts` tool_result conversion** — The plan says the issue is at "line 33-38" but the actual structure may differ. Read the actual file and locate the `tool_result` handling yourself. The fix (convert from lossy text to native `functionResponse` format) is correct — just find the right lines.

5. **GLM-5 `supportsForceToolUse` should be `true`**, not `false` as the original Part 4 modelProfiles.ts shows. Part 12 corrects this. Use the Part 12 values.

6. **Cost tracking currently only has Claude models.** The plan correctly identifies this. Add Gemini, GLM (all variants), and OpenAI pricing as specified in Part 12.5.

---

## PROJECT STRUCTURE & KEY FILES

### Workspace Root
```
src/core/agent/           ← ALL implementation happens here
src/hooks/useClaudeAgent.ts  ← React hook (modify, don't break)
```

### Files You MUST Read First (Before Writing Any Code)
```
src/core/agent/claudeAgent.ts        (336 lines — the main agent loop)
src/core/agent/modelAdapter.ts       (84 lines — ModelAdapter interface)
src/core/agent/adapters/geminiAdapter.ts  (102 lines — HIGHEST PRIORITY FIX)
src/core/agent/adapters/glmAdapter.ts     (139 lines — SECOND PRIORITY FIX)
src/core/agent/adapters/openaiAdapter.ts  (138 lines — reference for correct patterns)
src/core/agent/adapters/claudeAdapter.ts  (46 lines — reference, do NOT modify)
src/core/agent/adapters/index.ts     (25 lines — factory function)
src/core/agent/toolRegistry.ts       (268 lines — 20 tool definitions)
src/core/agent/toolExecutor.ts       (137 lines — IPC call mapper)
src/core/agent/costTracker.ts        (94 lines — needs pricing expansion)
src/core/agent/permissions.ts        (112 lines — DO NOT MODIFY)
src/core/agent/shellGuard.ts         (64 lines — DO NOT MODIFY)
src/core/agent/agentSession.ts       (90 lines — needs plan tracking)
src/hooks/useClaudeAgent.ts          (241 lines — needs plan state exposure)
```

### Files to Create (11 new files)
```
src/core/agent/orchestrator.ts       — 4-phase orchestration engine (brain)
src/core/agent/planner.ts            — Rule-based + model-based task decomposition
src/core/agent/contextManager.ts     — 9-section context compression + token estimation
src/core/agent/validator.ts          — Adversarial validation (PASS/FAIL/PARTIAL verdicts)
src/core/agent/modelProfiles.ts      — Per-model capability profiles (all providers)
src/core/agent/types.ts              — Shared types (ExecutionPlan, AgentMemory, etc.)
src/core/agent/modelAllocator.ts     — Multi-model chaining within a single task
src/core/agent/toolCache.ts          — TTL-based tool result caching + deduplication
src/core/agent/checkpoint.ts         — Checkpoint & resume for crash recovery
src/core/agent/sessionLearning.ts    — Cross-session pattern extraction
src/core/agent/compoundTools.ts      — Atomic multi-tool chain operations
```

### Files to Modify (8 files)
```
src/core/agent/claudeAgent.ts        — Route to orchestrator vs legacy loop
src/core/agent/modelAdapter.ts       — Add forceToolUse, toolSubset to interface
src/core/agent/adapters/geminiAdapter.ts  — functionCallingConfig + functionResponse format
src/core/agent/adapters/glmAdapter.ts     — Vision support + tool_choice + multimodal
src/core/agent/toolExecutor.ts       — Add executeToolsParallel()
src/core/agent/costTracker.ts        — Add all model pricing
src/core/agent/agentSession.ts       — Add plan tracking + memory state
src/hooks/useClaudeAgent.ts          — Expose planSteps, currentStepIndex, synthesis state
```

### Files NOT Modified (6 files — leave these alone)
```
src/core/agent/toolRegistry.ts
src/core/agent/permissions.ts
src/core/agent/shellGuard.ts
src/core/agent/smartRouter.ts
src/core/agent/adapters/claudeAdapter.ts
src/core/agent/adapters/openaiAdapter.ts
```

---

## IMPLEMENTATION ORDER (PHASES)

Execute these phases IN ORDER. Each phase must compile and not break existing functionality before moving to the next.

### PHASE 0: ADAPTER CRITICAL FIXES (Do This First)

These are the highest-impact, lowest-risk changes. They fix real bugs that cripple Gemini and GLM right now.

**Step 0.1 — Fix `geminiAdapter.ts` (3 bugs):**

Bug 1: Add `functionCallingConfig` to force tool calling. When the orchestrator (or even current code) needs Gemini to call a tool, it currently has no way to enforce this. Add support for `mode: 'ANY'` (must call a tool) vs `'AUTO'` (default). The adapter's `stream()` should check `opts.forceToolUse` and set `toolConfig: { functionCallingConfig: { mode: 'ANY' } }` when true.

Bug 2: Convert tool results from lossy text format (`[Tool result for ${id}]: content`) to Gemini's native `functionResponse` format. This is critical — Gemini can't properly associate tool results with tool calls when they're just text strings. Use `{ functionResponse: { name: toolName, response: { result: content } } }`.

Bug 3: Ensure the adapter carries `tool_name` through the message conversion so `functionResponse` can reference the correct function name. Currently tool_result blocks may not carry the tool name — you may need to track tool_use names and match them to tool_result IDs.

**Step 0.2 — Fix `glmAdapter.ts` (4 bugs):**

Bug 1: Images are stripped to `[Image attached]` (line 30). Change `parts` from `string[]` to `any[]` and convert images to OpenAI-compatible `image_url` format: `{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,...' } }`. The OpenAI adapter already does this correctly — mirror that pattern.

Bug 2: `tool_choice` is never sent in the request body. Add `tool_choice: opts.forceToolUse ? 'required' : 'auto'` to the JSON body.

Bug 3: Message `content` must be an array (not joined string) when it contains images. When any part is an image_url object, send content as the array. When all parts are text, join into a string.

Bug 4: Handle GLM thinking mode tokens gracefully. If `delta.reasoning_content` appears in the stream, skip it (don't add to fullText) so the agent doesn't break.

**Step 0.3 — Extend `modelAdapter.ts` interface:**

Add `forceToolUse?: boolean` and `toolSubset?: string[]` to the `stream()` options. These are optional — existing adapters that don't use them should still work unchanged. The Gemini and GLM adapters will read `forceToolUse`. The orchestrator will use `toolSubset` to filter which tools get sent per step.

**Step 0.4 — Update `costTracker.ts` pricing:**

Add complete pricing for all models. See Part 12.5 in the plan for exact values:
- Gemini: `gemini-2.5-flash` ($0.15/$0.60), `gemini-2.5-pro` ($1.25/$10.00)
- GLM: `glm-5` ($1.20/$4.00), `glm-5v-turbo` ($1.20/$4.00), `glm-4.6` ($0.60/$2.00), `glm-4.5` ($0.60/$2.00), `glm-4.5-flash` ($0.15/$0.60), `glm-4-plus` ($0.40/$1.60)
- OpenAI: `gpt-4o` ($2.50/$10.00), `gpt-4o-mini` ($0.15/$0.60)

**Verification after Phase 0:**
```bash
npx tsc --noEmit --project tsconfig.json  # Must pass
npx vite build                            # Must pass
```
Existing agent functionality MUST still work exactly as before. You've only fixed bugs and extended interfaces.

---

### PHASE 1: FOUNDATION — Types, Profiles, Context Manager

**Step 1.1 — Create `types.ts`:**

Define all shared types used across the orchestration layer: `ExecutionPlan`, `PlanStep`, `SuccessCriterion`, `CriterionCheck`, `StepResult`, `ResultEvaluation`, `AgentMemory`, `CompressedContext`, `SynthesizedBrief`, `TurnBudget`, `StallDetection`, `Decision`, `Verdict`, `AmbientContext`, `ProgressCheckpoint`, `ModelAllocation`, `EscalationPolicy`, `LearnedPattern`. See Parts 4, 12, 13, 17, 18 of the plan for exact interface definitions.

**Step 1.2 — Create `modelProfiles.ts`:**

Define per-model capability profiles. This is the KEY to making the system model-aware. Every model gets a profile with these flags:
- `supportsForceToolUse`, `supportsNativeToolResults`, `supportsVision`, `reliableToolCalling`
- `maxContextTokens`, `contextCompressionThreshold`, `maxTokensPerStep`
- `planningCapability` ('strong' | 'moderate' | 'weak')
- `needsExplicitStepInstructions`, `needsProgressReminders`, `earlyTerminationRisk`
- `stepSystemPrompt`, `planSystemPrompt`, `forceToolSuffix`

**Use the CORRECTED profiles from Part 12.3** (not the original Part 4.5):
- Claude Sonnet 4: strong everything, low risk, no hand-holding needed
- GPT-4o: strong everything, low risk
- Gemini 2.5 Flash: `reliableToolCalling: false`, `earlyTerminationRisk: 'high'`, `needsExplicitStepInstructions: true`, aggressive system prompts that DEMAND tool use
- GLM-5: `reliableToolCalling: true`, `planningCapability: 'strong'` — USE LEGACY LOOP (like Claude)
- GLM-5V-Turbo: same as GLM-5 but `supportsVision: true`, 200K context
- GLM-4.x models: need orchestration, similar to Gemini Flash profiles
- Export `getModelProfile(modelId: string): ModelProfile` with safe default fallback

**Step 1.3 — Create `contextManager.ts`:**

Implement the 9-section context compression system (see Part 17.5):
- `compressToolResult(toolName, result, stepId)` — screenshots become `[Screenshot captured]`, large web reads get truncated, file reads get truncated
- `buildContextForStep(step, plan)` — returns compressed context string with plan progress, completed step summaries, dependency results
- `summarizeStep(stepId, toolResults)` — produces one-line summary per step
- `estimateTokens(messages)` — rough estimate (chars/4)
- `shouldCompress(messages, modelProfile)` — checks against model's threshold
- Maintain the 9-section `CompressedContext` structure: primaryRequest, technicalContext, fileOperations, errorsAndFixes, decisions, collectedData, pendingTasks, currentWork, suggestedNext

**Verification after Phase 1:**
```bash
npx tsc --noEmit --project tsconfig.json  # Must pass
```

---

### PHASE 2: PLANNING ENGINE + ORCHESTRATOR

This is the biggest and most important phase. Take your time and get it right.

**Step 2.1 — Create `planner.ts`:**

Implement rule-based task decomposition with at least 6 pattern templates:
1. "Find/search/get N items about X and create/make Y" → Research → Extract → Create → Verify
2. "Organize/sort/clean up [files/folder]" → List → Categorize → Create folders → Move → Verify
3. "Read/analyze [file] and [do something]" → Read → Process → Output → Verify
4. "Create/make/write/build [something]" → Gather context → Create → Verify
5. "Compare/diff [X] and [Y]" → Read both → Analyze → Output comparison
6. "Convert [file] to [format]" → Read → Convert → Write → Verify

Each template generates a full `ExecutionPlan` with steps, dependencies, tool mappings, and success criteria. Include the generic fallback plan (single step + verify) for unmatched prompts.

Export `ruleBasedPlan(prompt: string): ExecutionPlan`.

**Step 2.2 — Create `orchestrator.ts`:**

This is the BRAIN of the system. It replaces the dumb loop for weak models. Implement:

**The 4-Phase Workflow:**

Phase 1 — PLANNING:
- `generatePlan(prompt, adapter, modelProfile)` — Tries model-based planning first (sends a strategic prompt asking for JSON plan). If model returns invalid JSON, falls back to `ruleBasedPlan()`. JSON extraction should try: raw parse → extract from markdown fences → regex extraction.
- The strategic planning prompt should ask the model to output: intent analysis, approach selection, risk assessment, steps with tools/dependencies/success signals/failure actions, success criteria, estimated turns.

Phase 2 — EXECUTION (step by step):
- `executeStep(step, adapter, callbacks, modelProfile)` — Builds a micro-prompt for this specific step. Sends compressed context (not full history). Filters tools to only those relevant for this step. Sets `forceToolUse: true` for action steps on weak models. Collects tool results. Handles retries per step (max 3).
- Micro-prompts for weak models (Gemini Flash) must be extremely directive: "Your task: X. Use tool Y. Call it NOW. Do not write a summary."
- For strong models (Claude, GLM-5), micro-prompts can be lighter: "Execute: X"
- Include progress context for models that need reminders: "Progress: Step 3 of 7 (2 completed)"

Phase 2.5 — SYNTHESIS (the critical gap — see Part 17.3):
- `synthesize(researchResults, plan, profile)` — Runs BETWEEN research and implementation phases. For strong models: ask model to digest raw results into structured brief. For weak models: code-based extraction (find titles, URLs, dates via regex/string matching). The creation step gets pre-digested data, NOT raw tool dumps.
- **THE SYNTHESIS MANDATE:** Never send "based on what you found, create X". Instead send "Create X with these specific items: [pre-extracted list]". This single pattern is the biggest quality improvement for Gemini Flash.

Phase 3 — VALIDATION:
- Calls `validator.validate()` (from the validator file). If validation fails, re-enters Phase 2 for failed criteria only.

Phase 4 — FINAL RESPONSE:
- One final model call to write a human-friendly summary of everything accomplished.

**The 4 Cognitive Loops (see Part 13):**

Loop 1 — Strategic: Intent analysis, approach selection, risk assessment (happens in planning phase).

Loop 2 — Tactical: `evaluateStepContext(step, plan)` — Before each step, assess data progress, failure rate, remaining budget, whether to skip or retry aggressively.

Loop 3 — Reactive: `evaluateResult(toolName, result, step, plan)` — After every tool call, classify result (success/partial/empty/error), count extracted items, detect if target is met, dynamically modify plan (skip remaining search steps if target reached, add steps if duplicates found).

Loop 4 — Meta: `detectStall(recentSteps)` — Every 2-3 turns, check for stall patterns: same tool called 3+ times with same input, 3+ consecutive errors, text-only turns (narrating instead of acting), context growing too fast. If stalled, pivot strategy.

**Additional orchestrator capabilities:**
- `AgentMemory` state tracking: goal, constraints, decisions (with rationale), open questions, verification state — updated after every step, fed into every model call
- Dynamic plan modification (replanning): add steps, skip steps, reorder steps based on results
- Adaptive turn budgeting: allocate turns per step based on complexity, with per-model multipliers for weak models
- Ambient context gathering: `gatherAmbientContext()` runs parallel read-only tool calls BEFORE planning (screenshot, active window, active file, open files, clipboard) to give the planner rich context
- Parallel step detection and execution: identify independent steps (no shared dependencies) and run them concurrently

**Step 2.3 — Modify `claudeAgent.ts`:**

This is the critical integration point. Do NOT rewrite the file. Make surgical changes:

1. Extract the current agent loop (the `for` loop in the `run()` method, approximately lines 114-276) into a new `private async runLegacy(...)` method. Keep it EXACTLY as-is — this is the proven path for Claude and GPT-4o.

2. Create a new `private async runOrchestrated(...)` method that uses the `Orchestrator`, `ContextManager`, and `Validator` classes.

3. Modify the existing `run()` method to become a router:
```typescript
async run(userPrompt, screenshotBase64, windowContext, callbacks): Promise<void> {
  const profile = getModelProfile(this.adapter.modelId);

  if (profile.reliableToolCalling && profile.planningCapability === 'strong') {
    // Claude, GPT-4o, GLM-5, GLM-5V-Turbo → proven legacy loop
    return this.runLegacy(userPrompt, screenshotBase64, windowContext, callbacks);
  }

  // Gemini Flash, GLM-4.x, weaker models → orchestrated execution
  return this.runOrchestrated(userPrompt, screenshotBase64, windowContext, callbacks);
}
```

4. Add callbacks for plan state: `onPlanGenerated`, `onStepProgress`, `onProgressCheckpoint` — these propagate to the React hook for UI rendering.

5. GLM smart model selection: if provider is GLM, task has a screenshot, and model is text-only (e.g., `glm-5`), auto-upgrade to `glm-5v-turbo`. Implement in `run()` before dispatching.

6. Expand `friendlyError()` with GLM-specific error messages (see Part 12.8).

**Step 2.4 — Add `executeToolsParallel()` to `toolExecutor.ts`:**

```typescript
export async function executeToolsParallel(
  calls: Array<{ name: string; input: Record<string, any>; id: string }>,
  timeoutMs?: number,
): Promise<Array<{ id: string; name: string; result: string; error?: string }>>
```

Uses `Promise.all` with per-call timeout. Returns results array in same order as input.

**Verification after Phase 2:**
```bash
npx tsc --noEmit --project tsconfig.json
npx vite build
```
Test: Claude agent must still work IDENTICALLY to before (it uses the legacy loop). The orchestrated path is new — it won't be triggered unless a Gemini/GLM-4.x model is selected.

---

### PHASE 3: VALIDATION & SELF-CORRECTION

**Step 3.1 — Create `validator.ts`:**

Implement adversarial validation with PASS/FAIL/PARTIAL verdicts (see Parts 4.4, 17.4):

- `validate(plan, toolResults)` — Runs all checks: success criteria, step completion, file existence (via `list_directory`), data count matching, content quality (size/format checks)
- `adversarialValidate(filePath)` — For every file the agent creates: check exists, check non-empty, check valid format (HTML has `<html`, DOCX is > 10KB, etc.)
- `visualVerification(taskType)` — Screen-diff verification: take "after" screenshot, ask model if task appears completed (Innovation #4)
- Anti-rationalization: never accept "looks correct by inspection" — EXECUTE verification tools

**Step 3.2 — Wire validation into `orchestrator.ts`:**

After Phase 2 (execution) completes, run Phase 3 (validation). If any criterion fails:
1. Identify which steps need re-execution
2. Re-enter Phase 2 for ONLY those steps
3. Maximum 1 re-validation cycle (prevent infinite loops)

---

### PHASE 4: THE 14 INNOVATIONS

Implement these in the order specified in Part 18.17 of the plan. Each innovation is described with full code in Part 18.

**Wave 1 (Implement with core — highest impact):**

1. **Ambient Context Intelligence (#6)** — `gatherAmbientContext()` in orchestrator. Parallel pre-fetch of screenshot, active window, active file, open files, clipboard. Feed into planner for smarter plans. Already has code pattern in Part 18.6.

2. **Tool Result Caching (#3)** — Create `toolCache.ts`. TTL-based cache per tool type (web reads: 5min, file reads: 30s, screenshots: never cache). Check cache before IPC call. Deduplication detection. See Part 18.3.

3. **Compound Tool Operations (#13)** — Create `compoundTools.ts`. Pre-built multi-tool chains: `read_and_summarize`, `create_and_open`, `find_desktop_path`, `safe_write`. Reduces tool-call count for weak models. See Part 18.13.

4. **Adaptive Turn Budgeting (#7)** — In orchestrator. Per-step turn allocation based on tool type and model weakness. Replace fixed 25-turn limit with dynamic budget. See Part 18.7.

**Wave 2 (Implement after core works):**

5. **Multi-Model Chaining (#1)** — Create `modelAllocator.ts`. Allocate different models to different phases: Claude plans+synthesizes, Gemini researches+verifies. Requires multiple API keys. See Part 18.1.

6. **Auto Model Escalation (#12)** — In orchestrator. Start with cheapest model, auto-escalate on N consecutive failures. See Part 18.12.

7. **Checkpoint & Resume (#8)** — Create `checkpoint.ts`. Save plan state to localStorage after each step. On app reopen, detect resumable checkpoint (< 1 hour old). See Part 18.8.

8. **Screen-Diff Verification (#4)** — In validator. Before/after screenshots compared via model call. See Part 18.4.

**Wave 3 (Polish — competitive moat):**

9. **Session Learning (#9)** — Create `sessionLearning.ts`. Extract patterns (blocked URLs, preferred paths, tool failures) after each session. Feed patterns as constraints into future planners. See Part 18.9.

10. **Progressive Disclosure (#10)** — In orchestrator. Emit `ProgressCheckpoint` events after each major step with preview data. See Part 18.10.

11. **Streaming Artifact Creation (#5)** — In orchestrator. For data-gathering tasks, start writing the output file as data arrives instead of waiting for all data. See Part 18.5.

12. **Speculative Execution (#2)** — In orchestrator. While waiting for a tool result, speculatively start the next read-only step. See Part 18.2.

13. **Smart Post-Task Suggestions (#14)** — In orchestrator. Data-driven suggestions based on what was created/discovered. See Part 18.14.

14. **Cross-App Orchestration (#11)** — Plan templates for cross-app workflows (Excel → AI → PowerPoint). See Part 18.11.

---

### PHASE 5: UI INTEGRATION

**Step 5.1 — Modify `useClaudeAgent.ts`:**

Add to hook state:
```typescript
const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
const [currentStepIndex, setCurrentStepIndex] = useState(0);
const [synthesisState, setSynthesisState] = useState<'idle' | 'synthesizing' | 'done'>('idle');
```

Add new callbacks that the orchestrator emits:
- `onPlanGenerated(plan)` → set plan steps
- `onStepProgress(stepId, status)` → update specific step
- `onProgressCheckpoint(checkpoint)` → store for preview UI

Return new fields (ADDITIVE ONLY — do not remove or rename existing return values):
```typescript
return {
  ...existing,
  planSteps,
  currentStepIndex,
  synthesisState,
};
```

**Step 5.2 — Update `agentSession.ts`:**

Add plan tracking and memory state to the session manager:
- `setPlan(plan: ExecutionPlan)` — stores current plan
- `updateStepStatus(stepId, status)` — updates step in stored plan
- `setMemory(memory: AgentMemory)` — stores agent memory state
- These persist in the session for display in WorkflowPanel

**Step 5.3 — Update `modelAdapter.ts` AGENT_MODELS and GLM_MODELS:**

Change GLM default from `glm-5` to `glm-5v-turbo`. Expand `GLM_MODELS` array to include all variants (glm-5v-turbo, glm-5, glm-4.6, glm-4.5, glm-4.5-flash, glm-4-plus) with display names and descriptions. See Part 12.6.

---

## ARCHITECTURAL CONSTRAINTS (NON-NEGOTIABLE)

1. **Must work with ALL 4 adapters** — The orchestrator only calls `ModelAdapter.stream()`, never provider SDKs directly.

2. **Must NOT break Claude** — Claude and GPT-4o use the legacy loop (the EXACT current code, just extracted to `runLegacy()`). Only weak models go through the orchestrator. Test this: Claude must produce identical behavior to before.

3. **Must keep streaming** — User sees live text updates (`onTextDelta`) during each step. The orchestrator must propagate streaming callbacks through each phase.

4. **Permission system UNCHANGED** — The orchestrator calls the same `permissionManager.check()` and `callbacks.onPermissionRequest()` before each tool execution. No shortcuts, no bypasses.

5. **30s per tool timeout** — This limit applies per tool call, not per plan. A 7-step plan can have many tool calls, each with its own 30s timeout.

6. **25 turns max HARD CEILING** — Adaptive budgeting can allocate fewer turns, but never more than 25 total turns across all steps.

7. **`useClaudeAgent` hook interface — ADDITIVE ONLY** — Existing return values must not change type, name, or behavior. New fields are additions.

8. **No new Electron IPC handlers** — The orchestrator runs in the renderer process. It uses existing tool definitions and `executeTool()` / `executeToolsParallel()`. No new main process code.

9. **Build must pass:**
```bash
npx tsc --noEmit --project tsconfig.json
npx vite build
```

10. **All imports must resolve** — New files must export/import correctly. Use relative imports within `src/core/agent/`.

---

## CODING STANDARDS

- **TypeScript strict mode** — No `any` unless wrapping external API responses. Use proper generics and interfaces.
- **Consistent patterns** — Follow the existing adapter pattern (functional factory) for new adapters. Follow the existing class pattern for new services.
- **Error handling** — Every `async` function must have try/catch. Tool execution failures must not crash the orchestrator — they get classified and handled.
- **Logging** — Use `console.log('[Orchestrator]', ...)`, `console.log('[Planner]', ...)`, etc. for debug logging. Match the existing pattern in adapters.
- **No external dependencies** — Everything is built with TypeScript, existing Node APIs, and existing project dependencies. Do NOT add npm packages.
- **Comments** — Add JSDoc comments on all public methods. Add inline comments for complex logic (especially the cognitive loops and plan modification).

---

## SUCCESS CRITERIA

When you're done, this is what should be true:

1. **Gemini Flash completes multi-step tasks** — "Find 20 AI news articles and create an HTML file" should work with Gemini Flash, taking 8-14 orchestrated turns instead of giving up after 3.

2. **GLM-5V-Turbo sees screenshots** — Tasks involving screenshots work with GLM because images are no longer stripped to `[Image attached]`.

3. **GLM-5 uses forced tool calling** — `tool_choice: 'required'` is sent when the orchestrator needs guaranteed tool use.

4. **Claude/GPT-4o unchanged** — They use the legacy loop and behave identically to before.

5. **Context doesn't explode** — 10-turn tasks use ~15K compressed tokens instead of ~120K raw tokens.

6. **Files are verified** — Every file the agent claims to create is checked with `list_directory` and `read_file`.

7. **Agent recovers from failures** — Empty web results → tries different URL. Tool call skipped → re-sends with forced tool use. File write fails → creates parent directories first.

8. **Cost tracking works for all models** — Budget display shows correct estimates for Gemini, GLM, OpenAI, not just Claude.

9. **Build passes** — `npx tsc --noEmit && npx vite build` succeeds with zero errors.

10. **14 innovations implemented** — All features from Part 18 are in the codebase, even if some are behind feature flags for later activation.

---

## HOW TO APPROACH THIS

1. **Read the plan document first.** It's 3,326 lines — read ALL of it. Every interface, code snippet, and rationale is there for a reason.

2. **Start with Phase 0.** The adapter fixes are surgical, low-risk, and high-impact. Get them done and verify the build.

3. **Phase 1 creates the foundation.** Types and profiles are used everywhere — get them right.

4. **Phase 2 is the big one.** The orchestrator is ~600-800 lines. The planner is ~200 lines. Take your time. The cognitive loops and synthesis mandate are the difference between "works" and "works WELL".

5. **Test incrementally.** After each phase, run `npx tsc --noEmit`. After Phases 0 and 2, run `npx vite build`. If Claude's behavior changes at all, something is wrong.

6. **When in doubt, refer to the plan.** Parts 4, 12, 13, 17, and 18 are the implementation-heavy sections. Parts 2 and 5 explain WHY things are designed the way they are.

---

## FINAL NOTE

This is not a trivial enhancement — it's a ground-up intelligence layer that transforms a basic agent loop into a cognitive architecture. The plan document gives you everything: the exact interfaces, the code patterns, the decision taxonomy, the failure modes, the edge cases, and the test matrix. Your job is to turn that blueprint into working, type-safe, production-ready TypeScript.

Do not simplify. Do not cut corners. Do not skip innovations because they seem complex. The user explicitly stated: **"please don't care about how long it will take to develop or hard it is.. don't take into account the complexities... yes we need something complex and innovative to excel, of course also simple for user."**

Build it all. Build it right. Make KLYPIX the best agent engine on any desktop.
