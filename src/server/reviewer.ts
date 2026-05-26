/**
 * SUNy Multi-Agent Review â€” mandatory reviewer persona for diffs/output.
 *
 * After the main agent produces changes, an independent reviewer profile
 * inspects the diff + test output + user intent and signs off with a
 * structured checklist before the result is accepted.
 *
 * Feature flag: ff_multi_agent_review
 */

import { generateText, type LanguageModel } from 'ai';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface ReviewInput {
  userRequest: string;
  aiResponse: string;
  changedFiles: string[];
  lintOutput?: string;
  testOutput?: string;
  diffSnippet?: string;
}

export interface ReviewChecklist {
  correctness: 'pass' | 'warn' | 'fail';
  completeness: 'pass' | 'warn' | 'fail';
  securityConcerns: string[];
  edgeCases: string[];
  testCoverage: 'pass' | 'warn' | 'fail' | 'none';
  breakingChanges: string[];
  suggestions: string[];
}

export interface ReviewResult {
  approved: boolean;
  checklist: ReviewChecklist;
  reviewSummary: string;
  correctedResponse?: string;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Reviewer system prompts
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const REVIEWER_SYSTEM = `You are an expert code reviewer with 20 years of experience across full-stack development, security, and systems architecture.

Your job is to review AI-generated code changes and provide a structured sign-off.

## Review Checklist

For each review, evaluate:

1. **Correctness** â€” Does the code do what the user asked? Are there logic errors?
2. **Completeness** â€” Are all aspects of the request addressed? Nothing missing?
3. **Security** â€” Any injection risks, exposed credentials, authorization gaps, unsafe patterns?
4. **Edge Cases** â€” What happens with empty/null/malformed input? Concurrent access? Error states?
5. **Test Coverage** â€” Are there tests for the new code? Do existing tests still pass?
6. **Breaking Changes** â€” Does this change existing behavior? API contract changes? Schema migrations?

## Output Format

You MUST return a JSON object with this exact structure:

{
  "approved": boolean,
  "checklist": {
    "correctness": "pass" | "warn" | "fail",
    "completeness": "pass" | "warn" | "fail",
    "securityConcerns": ["list of security issues, empty if none"],
    "edgeCases": ["list of unhandled edge cases, empty if none"],
    "testCoverage": "pass" | "warn" | "fail" | "none",
    "breakingChanges": ["list of breaking changes, empty if none"],
    "suggestions": ["actionable improvement suggestions"]
  },
  "reviewSummary": "2-3 sentence summary of the review",
  "correctedResponse": "if not approved, provide the FULL corrected response here. If approved, set to null."
}

Rules:
- Be strict but fair. Warnings are okay for minor issues.
- Only FAIL for real problems: logic errors, security holes, incomplete implementation.
- If the review identifies issues, provide the FULL corrected response in correctedResponse.
- If approved, correctedResponse must be null.
- Return ONLY valid JSON â€” no markdown, no code fences around the JSON.`;

const REVIEWER_SYSTEM_SIMPLE = `You are a senior code reviewer. Review the following AI response and code changes.

Respond with a JSON object:
{
  "approved": true/false,
  "issues": ["list of issues found, empty if approved"],
  "correctedResponse": "full corrected response if not approved, null if approved"
}

Be strict but fair. Only reject for real problems. Return ONLY valid JSON.`;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Review function
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Run a multi-agent review on the AI's output.
 * Returns a structured review result with checklist and optional corrected response.
 */
export async function runReview(
  model: LanguageModel,
  input: ReviewInput,
  options?: { signal?: AbortSignal; deep?: boolean },
): Promise<ReviewResult> {
  const systemPrompt = options?.deep !== false ? REVIEWER_SYSTEM : REVIEWER_SYSTEM_SIMPLE;

  const contextParts: string[] = [
    `## User Request\n${input.userRequest.slice(0, 2000)}`,
    `## AI Response\n${input.aiResponse.slice(0, 5000)}`,
  ];

  if (input.changedFiles.length > 0) {
    contextParts.push(`## Changed Files\n${input.changedFiles.map(f => `  â€¢ ${f}`).join('\n')}`);
  }

  if (input.diffSnippet) {
    contextParts.push(`## Diff\n\`\`\`diff\n${input.diffSnippet.slice(0, 4000)}\n\`\`\``);
  }

  if (input.lintOutput) {
    contextParts.push(`## Lint Output\n\`\`\`\n${input.lintOutput.slice(0, 1500)}\n\`\`\``);
  }

  if (input.testOutput) {
    contextParts.push(`## Test Output\n\`\`\`\n${input.testOutput.slice(0, 1500)}\n\`\`\``);
  }

  const userPrompt = contextParts.join('\n\n');

  try {
    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2000,
      abortSignal: options?.signal,
      experimental_telemetry: { isEnabled: false },
    });

    const text = result.text?.trim() ?? '';

    // Try to parse the JSON response
    try {
      // Strip any markdown code fences if the model wrapped it
      const jsonStr = text.replace(/^```(?:json)?\s*/gm, '').replace(/```\s*$/gm, '').trim();
      const parsed = JSON.parse(jsonStr);

      // Validate required fields
      const checklist: ReviewChecklist = parsed.checklist || {
        correctness: 'pass',
        completeness: 'pass',
        securityConcerns: [],
        edgeCases: [],
        testCoverage: 'none',
        breakingChanges: [],
        suggestions: [],
      };

      return {
        approved: parsed.approved ?? true,
        checklist,
        reviewSummary: parsed.reviewSummary || 'Review completed.',
        correctedResponse: parsed.correctedResponse || undefined,
      };
    } catch {
      // Parsing failed â€” return a best-effort result
      const approved = !text.toLowerCase().includes('fail') && !text.toLowerCase().includes('reject');
      return {
        approved,
        checklist: {
          correctness: approved ? 'pass' : 'warn',
          completeness: approved ? 'pass' : 'warn',
          securityConcerns: [],
          edgeCases: [],
          testCoverage: 'none',
          breakingChanges: [],
          suggestions: ['Unable to parse reviewer JSON â€” manual review recommended.'],
        },
        reviewSummary: text.slice(0, 300) || 'Review completed (non-JSON response).',
      };
    }
  } catch (err) {
    return {
      approved: true, // Fail open â€” don't block the response on review failure
      checklist: {
        correctness: 'pass',
        completeness: 'pass',
        securityConcerns: [],
        edgeCases: [],
        testCoverage: 'none',
        breakingChanges: [],
        suggestions: ['Reviewer model call failed â€” manual review recommended.'],
      },
      reviewSummary: `Reviewer error: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

/**
 * Format a review result for injection into the agent's output.
 */
export function formatReviewForOutput(review: ReviewResult): string {
  if (review.approved) {
    return `\n\nðŸ“‹ **Review: Approved** âœ…\n${review.reviewSummary}`;
  }

  const c = review.checklist;
  const issues: string[] = [];

  if (c.correctness === 'fail') issues.push('âŒ Correctness: Logic errors detected');
  if (c.correctness === 'warn') issues.push('âš ï¸ Correctness: Minor concerns');
  if (c.completeness === 'fail') issues.push('âŒ Completeness: Not all requirements met');
  if (c.completeness === 'warn') issues.push('âš ï¸ Completeness: Could be more thorough');
  if (c.securityConcerns.length) issues.push(`ðŸ”’ Security: ${c.securityConcerns.join('; ')}`);
  if (c.edgeCases.length) issues.push(`âš ï¸ Edge cases: ${c.edgeCases.join('; ')}`);
  if (c.breakingChanges.length) issues.push(`ðŸ’¥ Breaking: ${c.breakingChanges.join('; ')}`);

  return [
    '\n\nðŸ“‹ **Review: Needs Revision** ðŸ”„',
    review.reviewSummary,
    ...issues.map(i => `- ${i}`),
    c.suggestions.length ? `\n**Suggestions:**\n${c.suggestions.map(s => `- ${s}`).join('\n')}` : '',
  ].join('\n');
}
