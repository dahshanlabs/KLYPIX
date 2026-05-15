import type { ScratchpadPlan, ScratchpadStep, FlashEngineConfig } from './types';

// ── Scratchpad system prompt ─────────────────────────────────────────────────
// Forces Flash to plan before executing — single biggest improvement.
// Flash's weakness: tries everything in one shot, gets confused, gives up.
// Scratchpad gives it a roadmap to follow step-by-step.

export const SCRATCHPAD_SYSTEM_PROMPT = `
You are an AI assistant with access to tools. Before taking ANY action, you MUST first create a plan.

## MANDATORY PLANNING PHASE

Before using any tools or providing your final answer, output your plan in this EXACT format:

<scratchpad>
TASK: [Restate what the user wants in one sentence]
STEPS:
1. [First action] → Tool: [tool_name or "reasoning"]
2. [Second action] → Tool: [tool_name or "reasoning"]
3. [Continue as needed...]
EXPECTED OUTPUT: [What the final deliverable looks like]
</scratchpad>

## EXECUTION RULES

After your plan, execute each step IN ORDER:
- Complete step 1 before starting step 2
- If a step fails, note the error and try an alternative approach
- Do NOT skip steps
- Do NOT give up after one failure
- After completing all steps, provide the final answer

## CRITICAL RULES

- NEVER respond with just a plan and no execution
- NEVER apologize and give up — always try at least one alternative
- NEVER say "I cannot" without first attempting the task with tools
- If you run out of steps, summarize what you accomplished and what remains
`;

// ── Scratchpad parser ────────────────────────────────────────────────────────

export function parseScratchpad(response: string): ScratchpadPlan | null {
  const scratchpadMatch = response.match(/<scratchpad>([\s\S]*?)<\/scratchpad>/);
  if (!scratchpadMatch) return null;

  const content = scratchpadMatch[1];

  // Parse TASK line
  const taskMatch = content.match(/TASK:\s*(.+)/);
  const taskUnderstanding = taskMatch ? taskMatch[1].trim() : '';

  // Parse STEPS
  const stepsRegex = /(\d+)\.\s*(.+?)→\s*Tool:\s*(.+)/g;
  const steps: ScratchpadStep[] = [];
  let match;
  while ((match = stepsRegex.exec(content)) !== null) {
    steps.push({
      stepNumber: parseInt(match[1]),
      action: match[2].trim(),
      tool: match[3].trim() === 'reasoning' ? null : match[3].trim(),
      dependsOn: parseInt(match[1]) > 1 ? parseInt(match[1]) - 1 : null,
    });
  }

  // Parse EXPECTED OUTPUT
  const outputMatch = content.match(/EXPECTED OUTPUT:\s*(.+)/);
  const expectedOutput = outputMatch ? outputMatch[1].trim() : '';

  // Extract tool names (deduplicated)
  const toolsNeeded = [...new Set(
    steps.filter(s => s.tool !== null).map(s => s.tool as string),
  )];

  return { taskUnderstanding, steps, toolsNeeded, expectedOutput };
}

// ── Scratchpad validation ────────────────────────────────────────────────────

export interface PlanValidation {
  valid: boolean;
  issues: string[];
}

export function validatePlan(
  plan: ScratchpadPlan,
  availableTools: string[],
  config: FlashEngineConfig,
): PlanValidation {
  const issues: string[] = [];

  if (plan.steps.length === 0) {
    issues.push('Plan has no steps');
  }

  if (plan.steps.length > config.scratchpadMaxSteps) {
    issues.push(`Plan has ${plan.steps.length} steps, max is ${config.scratchpadMaxSteps}. Simplify.`);
  }

  for (const tool of plan.toolsNeeded) {
    if (!availableTools.includes(tool)) {
      issues.push(`Plan references tool "${tool}" which doesn't exist. Available: ${availableTools.join(', ')}`);
    }
  }

  if (plan.taskUnderstanding.length < 10) {
    issues.push('Task understanding is too vague');
  }

  if (plan.expectedOutput.length < 5) {
    issues.push('No expected output defined');
  }

  return { valid: issues.length === 0, issues };
}

// ── Re-plan prompt ───────────────────────────────────────────────────────────

export function buildReplanPrompt(plan: ScratchpadPlan, issues: string[]): string {
  return `Your plan has issues that need to be fixed before execution:
${issues.map(i => `- ${i}`).join('\n')}

Original plan:
${JSON.stringify(plan, null, 2)}

Please create a corrected <scratchpad> plan and then execute it.`;
}
