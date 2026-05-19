/**
 * SUNy Error Auto-Correction — a `self_heal` tool that the AI can call
 * when it encounters errors (build failures, test failures, tool errors).
 *
 * Key difference from the existing lint/test retry loop:
 *   The lint loop is POST-HOC (runs after all changes are made).
 *   The self_heal tool is PROACTIVE (AI calls it mid-task when it detects
 *   a specific error and needs guidance).
 *
 * The tool uses the same LLM to analyze the error and suggest targeted fixes.
 */

import { generateText, tool, type LanguageModel } from 'ai';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface HealContext {
  model: LanguageModel;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// System prompt for the healer
// ─────────────────────────────────────────────────────────────────────────────

const HEALER_SYSTEM = `You are an expert debugger. Your only job is to analyze errors and suggest precise fixes.

Given an error message and context, you must:
1. Identify the ROOT CAUSE (not symptoms)
2. Suggest the MINIMAL fix (one change, not a rewrite)
3. Provide the EXACT code change needed
4. Explain WHY the fix works

Rules:
- Be concise — max 3 sentences
- Focus on the single most likely cause
- If you can't determine the cause, say so explicitly
- Never suggest speculative rewrites

Output format:
[CAUSE]: <1-2 sentence root cause>
[FIX]: <specific change needed>
[CODE]: \`\`\`<language>
<exact code to change>
\`\`\``;

// ─────────────────────────────────────────────────────────────────────────────
// Auto-heal function
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeError(
  ctx: HealContext,
  error: string,
  context: string,
): Promise<string> {
  try {
    const result = await generateText({
      model: ctx.model,
      system: HEALER_SYSTEM,
      messages: [
        {
          role: 'user',
          content: `Error:\n\`\`\`\n${error.slice(0, 2000)}\n\`\`\`\n\nContext:\n${context.slice(0, 2000)}`,
        },
      ],
      maxTokens: 500,
      abortSignal: ctx.signal,
      experimental_telemetry: { isEnabled: false },
    });

    return (result.text ?? '').trim() || '[No fix suggested — error not recognized]';
  } catch {
    return '[Error analysis failed — try again or report the issue]';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSelfHealTool(ctx: () => HealContext) {
  return tool({
    description:
      'Analyze an error and get a targeted fix suggestion. Use this when a tool call fails, ' +
      'a build error occurs, or you encounter any unexpected problem. ' +
      'Pass the exact error message and relevant context (file content, command output, etc.). ' +
      'The tool returns a root cause analysis and the minimal fix needed.',
    inputSchema: z.object({
      error: z
        .string()
        .min(5)
        .describe(
          'The exact error message or stack trace. Include the full error for best results.',
        ),
      context: z
        .string()
        .optional()
        .default('')
        .describe(
          'Relevant context: the code that failed, command that was run, or file content. ' +
          'Include enough for the debugger to understand what was happening.',
        ),
    }),
    execute: async ({ error, context }) => {
      const ctx = getContext();
      return await analyzeError(ctx, error, context || '(no additional context)');
    },
  });
}
