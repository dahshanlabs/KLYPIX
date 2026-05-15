// Builds a tighter prompt when Flash fails quality gate
// Goal: force Flash to try harder on retry before escalating to Claude

export function buildRetryPrompt(
  originalMessage: string,
  failedResponse: string,
  qualityFailures: string[],
): string {
  return `IMPORTANT: Your previous attempt was insufficient. Specific issues:
${qualityFailures.map(f => `- ${f}`).join('\n')}

Requirements for this attempt:
1. You MUST use the available tools to complete this task. Do not guess or speculate.
2. If a tool call fails, try an alternative approach rather than giving up.
3. Provide a complete, actionable response — not a summary or apology.
4. Break the task into steps and execute each one.

Original request: ${originalMessage}

Previous failed response (DO NOT repeat this):
${failedResponse.substring(0, 200)}...

Now complete the task properly.`;
}
