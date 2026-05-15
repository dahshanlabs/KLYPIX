import type { FlashEngineConfig, FlashValidationResult, ScratchpadPlan, ToolCallAttempt } from './types';

// ── Output validator ─────────────────────────────────────────────────────────
// Final check before Flash's response goes to the Quality Gate in the router.
// Catches: incomplete plans, missing tool use, hallucinated URLs, etc.

export function validateFlashOutput(
  response: string,
  userMessage: string,
  scratchpadPlan: ScratchpadPlan | null,
  toolAttempts: ToolCallAttempt[],
  config: FlashEngineConfig,
): FlashValidationResult {
  const issues: string[] = [];

  // Check 1: Response is not empty or too short
  if (response.trim().length < config.enforceMinResponseLength) {
    issues.push('Response too short for the task complexity');
  }

  // Check 2: If scratchpad had N steps, check Flash addressed them
  if (scratchpadPlan && scratchpadPlan.steps.length > 2) {
    let stepsAddressed = 0;
    for (const step of scratchpadPlan.steps) {
      const keywords = step.action.split(' ').filter(w => w.length > 4);
      if (keywords.some(kw => response.toLowerCase().includes(kw.toLowerCase()))) {
        stepsAddressed++;
      }
    }
    const coverage = stepsAddressed / scratchpadPlan.steps.length;
    if (coverage < 0.5) {
      issues.push(`Only ${Math.round(coverage * 100)}% of planned steps appear in response`);
    }
  }

  // Check 3: If tools were available but none used for an action task
  if (config.requireToolUseForActionTasks) {
    const isActionTask = /\b(search|find|read|create|write|analyze|compare|look\s*up|fetch)\b/i.test(userMessage);
    if (isActionTask && toolAttempts.length === 0) {
      issues.push('Action task but no tools were used');
    }
  }

  // Check 4: All tool calls failed and response doesn't acknowledge it
  const allFailed = toolAttempts.length > 0 && toolAttempts.every(t => !t.success);
  if (allFailed && !/(could not|unable|error|failed|unfortunately)/i.test(response)) {
    issues.push("All tools failed but response doesn't acknowledge the limitation");
  }

  // Check 5: Hallucinated URLs (not from tool results)
  const urlsInResponse = response.match(/https?:\/\/[^\s)]+/g) || [];
  const urlsFromTools = toolAttempts
    .filter(t => t.success && t.output)
    .flatMap(t => t.output!.match(/https?:\/\/[^\s)]+/g) || []);

  const fabricatedUrls = urlsInResponse.filter(u => !urlsFromTools.includes(u));
  if (fabricatedUrls.length > 0) {
    issues.push(`Response contains ${fabricatedUrls.length} URLs not from tool results — possible hallucination`);
  }

  // Determine suggested action
  let suggestedAction: 'pass' | 'retry_flash' | 'escalate' = 'pass';
  if (issues.length >= 3) {
    suggestedAction = 'escalate';
  } else if (issues.length >= 1) {
    suggestedAction = 'retry_flash';
  }

  return { valid: issues.length === 0, issues, suggestedAction };
}
