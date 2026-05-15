import type { FlashAttempt } from './types';

// Builds the escalation context that tells Claude what Flash tried and why it failed.
// This helps Claude avoid the same mistakes and deliver on the first attempt.

export function buildEscalationContext(flashAttempts: FlashAttempt[]): string {
  return `The user's request was first attempted with a lightweight model which failed.
Here's what was tried and why it failed:
${flashAttempts.map((a, i) => `
Attempt ${i + 1}:
- Response quality: ${a.qualityScore.toFixed(2)}/1.0
- Issues: ${a.failures.join(', ')}
- Tool calls attempted: ${a.toolCalls.length} (${a.toolCalls.filter(t => t.success).length} succeeded)
`).join('')}

Please handle this request thoroughly. The user is expecting a complete result.`;
}
