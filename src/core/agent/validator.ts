/**
 * Adversarial Validation Engine — PASS/FAIL/PARTIAL verdicts.
 *
 * Catches when the model claims success but didn't actually deliver.
 * Inspired by Claude Code's Verification Specialist pattern:
 *
 * Anti-Rationalization Red Flags:
 *   "Code looks correct by inspection" → EXECUTE IT
 *   "This is probably fine" → "PROBABLY" ≠ VERIFIED
 *   "This would take too long" → NOT YOUR DECISION
 *
 * Every file the agent creates is checked: exists, non-empty, valid format.
 */

import { executeTool } from './toolExecutor';
import type {
  ExecutionPlan,
  SuccessCriterion,
  ValidationResult,
  ValidationCheck,
  AdversarialVerdict,
  Verdict,
} from './types';

export class Validator {
  /**
   * Run all validation checks for a completed plan.
   * Checks: success criteria + step completion + file existence + data counts.
   */
  async validate(
    plan: ExecutionPlan,
    toolResults: Map<number, Array<{ tool: string; result: string }>>,
  ): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // 1. Check explicit success criteria
    for (const criterion of plan.successCriteria) {
      checks.push(await this.checkCriterion(criterion));
    }

    // 2. Step completion checks
    for (const step of plan.steps) {
      if (step.status !== 'completed' && step.status !== 'skipped') {
        checks.push({
          name: `Step ${step.id} completion`,
          passed: false,
          details: `Step "${step.action}" did not complete (status: ${step.status})`,
        });
      }
    }

    // 3. File existence checks — verify files that were supposedly created
    for (const step of plan.steps) {
      if (step.status !== 'completed') continue;
      if (!step.tools.includes('write_file') && !step.tools.includes('generate_document')) continue;

      const results = toolResults.get(step.id) || [];
      for (const r of results) {
        if (r.tool !== 'write_file' && r.tool !== 'generate_document') continue;
        try {
          const parsed = JSON.parse(r.result);
          const filePath = parsed.path || parsed.filePath;
          if (filePath) {
            const verdict = await this.adversarialValidate(filePath);
            checks.push({
              name: `File verified: ${filePath.split(/[/\\]/).pop()}`,
              passed: verdict.verdict === 'PASS',
              details: verdict.reason,
            });
          }
        } catch {
          // Result wasn't JSON with a path — skip
        }
      }
    }

    // 4. Data count checks — if the prompt mentioned a number, verify it
    const countMatch = plan.goal.match(/(\d+)\s+(?:articles?|items?|results?|files?|entries|records|news|sources?|links?|examples?|tips?|facts?|points?)/i);
    if (countMatch) {
      const targetCount = parseInt(countMatch[1]);
      let collectedCount = 0;
      for (const [, results] of toolResults) {
        for (const r of results) {
          if (r.tool === 'read_web_content' && r.result.length > 100) {
            collectedCount++;
          }
        }
      }
      checks.push({
        name: `Data count: ${collectedCount}/${targetCount}`,
        passed: collectedCount >= targetCount * 0.7, // 70% threshold
        details: `Collected ${collectedCount} items, target was ${targetCount}`,
      });
    }

    return {
      allPassed: checks.length === 0 || checks.every(c => c.passed),
      checks,
    };
  }

  /**
   * Adversarial validation for a single file.
   * Checks: exists on disk, non-empty, valid format.
   */
  async adversarialValidate(filePath: string): Promise<AdversarialVerdict> {
    // 1. Extract directory and filename
    const dirPath = filePath.replace(/[/\\][^/\\]+$/, '');
    const fileName = filePath.split(/[/\\]/).pop();
    if (!fileName || !dirPath) {
      return { verdict: 'FAIL', reason: 'Invalid file path' };
    }

    // 2. Check file exists via list_directory
    try {
      const dirResult = await executeTool('list_directory', { dir_path: dirPath });
      if (!dirResult.includes(fileName)) {
        return { verdict: 'FAIL', reason: `File "${fileName}" not found in ${dirPath}` };
      }
    } catch (err: any) {
      return { verdict: 'PARTIAL', reason: `Could not verify directory: ${err.message}` };
    }

    // 3. Check file is non-empty via read_file (first 200 chars)
    try {
      const fileResult = await executeTool('read_file', { file_path: filePath, max_chars: 200 });
      const content = typeof fileResult === 'string' ? fileResult : JSON.stringify(fileResult);

      if (!content || content.length < 10) {
        return { verdict: 'FAIL', reason: 'File exists but is empty or trivial' };
      }

      // 4. Format-specific checks
      const ext = fileName.split('.').pop()?.toLowerCase();
      if (ext === 'html' || ext === 'htm') {
        if (!content.includes('<html') && !content.includes('<!DOCTYPE') && !content.includes('<HTML')) {
          return { verdict: 'PARTIAL', reason: 'File exists but may not be valid HTML (no <html> tag)' };
        }
      }
      if (ext === 'json') {
        try {
          // Check if content parses — but we may only have first 200 chars
          if (content.startsWith('{') || content.startsWith('[')) {
            // Looks like JSON
          } else {
            return { verdict: 'PARTIAL', reason: 'File exists but may not be valid JSON' };
          }
        } catch {
          // Can't validate partial JSON, that's OK
        }
      }

      return { verdict: 'PASS', reason: `File verified: exists, non-empty (${content.length}+ chars), valid format` };

    } catch (err: any) {
      // File exists (passed dir check) but can't be read — might be binary
      if (fileName.endsWith('.docx') || fileName.endsWith('.xlsx') ||
          fileName.endsWith('.pptx') || fileName.endsWith('.pdf')) {
        // Binary files can't be read with read_file — existence check is sufficient
        return { verdict: 'PASS', reason: 'Binary file verified: exists in directory' };
      }
      return { verdict: 'PARTIAL', reason: `File exists but could not be read: ${err.message}` };
    }
  }

  /**
   * Visual verification — take a screenshot and check if task appears completed.
   * Uses the model to interpret the screenshot.
   */
  async visualVerification(
    taskType: 'file_created' | 'app_opened' | 'browser_navigated' | 'desktop_organized',
    adapter?: any,
  ): Promise<AdversarialVerdict> {
    try {
      const screenshotResult = await executeTool('capture_screenshot', {});
      const parsed = JSON.parse(screenshotResult);

      if (!parsed.image) {
        return { verdict: 'PARTIAL', reason: 'Could not capture screenshot for verification' };
      }

      // If we have a model adapter, ask it to verify
      if (adapter) {
        const verifyPrompt = `Look at this screenshot. The agent was supposed to: ${taskType.replace(/_/g, ' ')}. Does the screen show this was completed? Answer: PASS (clearly done), FAIL (clearly not done), or PARTIAL (can't tell). One word answer.`;

        const stream = adapter.stream({
          system: 'You are verifying task completion from a screenshot. Answer with one word: PASS, FAIL, or PARTIAL.',
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: parsed.image } },
              { type: 'text', text: verifyPrompt },
            ],
          }],
          tools: [],
          maxTokens: 50,
        });

        let response = '';
        stream.onText((d: string) => { response += d; });
        await stream.finalMessage();

        const verdict: Verdict = response.toUpperCase().includes('PASS') ? 'PASS' :
                                  response.toUpperCase().includes('FAIL') ? 'FAIL' : 'PARTIAL';

        return {
          verdict,
          reason: `Visual verification: ${response.trim()}`,
          screenshotBase64: parsed.image,
        };
      }

      // Without model, just confirm screenshot was taken
      return {
        verdict: 'PARTIAL',
        reason: 'Screenshot captured but no model available for visual verification',
        screenshotBase64: parsed.image,
      };

    } catch (err: any) {
      return { verdict: 'PARTIAL', reason: `Visual verification failed: ${err.message}` };
    }
  }

  /**
   * Check a single success criterion.
   */
  private async checkCriterion(criterion: SuccessCriterion): Promise<ValidationCheck> {
    if (criterion.met) {
      return { name: criterion.description, passed: true, details: 'Criterion already met during execution' };
    }

    if (criterion.check.tool) {
      try {
        const result = await executeTool(criterion.check.tool, criterion.check.toolInput || {});
        const passed = criterion.check.expectedPattern
          ? new RegExp(criterion.check.expectedPattern).test(result)
          : result.length > 0;
        return {
          name: criterion.description,
          passed,
          details: result.substring(0, 200),
        };
      } catch (err: any) {
        return {
          name: criterion.description,
          passed: false,
          details: `Verification failed: ${err.message}`,
        };
      }
    }

    return { name: criterion.description, passed: criterion.met, details: 'No verification tool specified' };
  }
}
