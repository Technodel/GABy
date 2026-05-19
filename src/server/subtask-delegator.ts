/**
 * SUNy Subtask Delegator — spawns focused sub-agents for multi-file refactors.
 *
 * When the main agent identifies a complex multi-file task (e.g., "refactor the
 * auth system"), it can delegate sub-tasks to independent sub-agents that each
 * get their own model context, tools, and scope — then merge results back.
 *
 * Architecture:
 *   1. Main agent calls `delegate_subtask({ task, files, goal, success_criteria })`
 *   2. Sub-agent runs with `generateText()` + limited tools (read/write/bash/glob/grep)
 *   3. Returns structured result: changed files, summary, errors
 *   4. Main agent merges the results into its own context
 *
 * Each sub-agent is stateless and self-contained — no shared memory, no side effects
 * beyond the files it modifies (which are real files on the user's machine).
 */

import { generateText, tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import { createPowerTools, type PowerToolContext } from './power-tools';
import type { AgentMessage } from './agent';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SubtaskInput {
  /** Description of the sub-task — what to accomplish */
  task: string;
  /** Files to focus on (relative or absolute paths) */
  files: string[];
  /** Overall goal for context */
  goal: string;
  /** Success criteria — how to know the task is done */
  success_criteria: string;
  /** Max sub-agent steps (default: 5) */
  max_steps?: number;
}

export interface SubtaskResult {
  /** Whether the task was completed */
  success: boolean;
  /** Summary of what was accomplished */
  summary: string;
  /** Files that were changed (absolute paths) */
  changed_files: string[];
  /** Any errors encountered */
  errors: string[];
  /** Detailed output from each sub-agent step */
  details: string;
  /** Token usage */
  input_tokens: number;
  output_tokens: number;
}

export interface SubtaskContext {
  userId: number;
  projectPath: string;
  model: LanguageModel;
  provider: string;
  signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-agent system prompt
// ─────────────────────────────────────────────────────────────────────────────

const SUBAGENT_SYSTEM = `You are a focused sub-agent. Your job is to complete ONE specific task precisely.

## Rules
1. ONLY modify the files listed in your task — do not touch unrelated files.
2. Read files before editing them — never assume their content.
3. Make surgical, minimal changes. Do not refactor beyond what's requested.
4. After each change, verify the result by reading the file back.
5. If you hit an error, try once to fix it, then report it.
6. Do NOT run tests, linters, or dev servers — those are handled by the main agent.
7. When done, summarize exactly what you changed and why.

## Available tools
You have file read/write/edit, shell commands (bash), directory listing, glob, and grep.
Use file_read first to understand existing code, then file_edit for targeted changes.`;

// ─────────────────────────────────────────────────────────────────────────────
// Delegation
// ─────────────────────────────────────────────────────────────────────────────

export async function runSubtask(
  ctx: SubtaskContext,
  input: SubtaskInput,
): Promise<SubtaskResult> {
  const { userId, projectPath, model, provider, signal } = ctx;
  const { task, files, goal, success_criteria, max_steps = 5 } = input;

  if (!files.length) {
    return {
      success: false,
      summary: 'No files specified for sub-task.',
      changed_files: [],
      errors: ['No file paths provided.'],
      details: '',
      input_tokens: 0,
      output_tokens: 0,
    };
  }

  // Track files changed by sub-agent
  const subChangedFiles = new Set<string>();
  const errors: string[] = [];

  // Create limited tools for sub-agent (bridge tools only — no web/search/memory)
  const subTools = createPowerTools({
    userId,
    projectPath,
    signal,
    onToolCall: (name, inputData) => {
      console.log(`[subtask] tool call: ${name}`, inputData);
    },
    onFileChanged: (absPath) => {
      subChangedFiles.add(absPath);
    },
  });

  // Build the sub-agent prompt
  const fileList = files.join('\n');
  const messages = [
    {
      role: 'user' as const,
      content: `## Task\n${task}\n\n## Files to modify\n${fileList}\n\n## Overall goal\n${goal}\n\n## Success criteria\n${success_criteria}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.\n\nRead the files first, then make the changes. When done, provide a summary.`,
    },
  ];

  try {
    const result = await generateText({
      model,
      system: SUBAGENT_SYSTEM,
      messages,
      tools: subTools,
      maxSteps: max_steps,
      abortSignal: signal,
      experimental_telemetry: { isEnabled: false },
    });

    const resultText = result.text?.trim() ?? '';

    // Build a structured output
    const changed = Array.from(subChangedFiles);
    const summary = resultText.slice(0, 2000);

    return {
      success: errors.length === 0 && changed.length > 0,
      summary,
      changed_files: changed,
      errors,
      details: resultText,
      input_tokens: result.usage?.inputTokens ?? 0,
      output_tokens: result.usage?.outputTokens ?? 0,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    errors.push(errorMsg);

    return {
      success: false,
      summary: errorMsg.slice(0, 500),
      changed_files: Array.from(subChangedFiles),
      errors,
      details: errorMsg,
      input_tokens: 0,
      output_tokens: 0,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool factory — returns the `delegate_subtask` tool for registration
// in the main agent loop.
// ─────────────────────────────────────────────────────────────────────────────

export interface DelegatorContext {
  /** Already established subtask context (userId, projectPath, model, provider) */
  getContext: () => SubtaskContext;
  /** Get the current session's system prompt (for context continuity) */
  getSystemPrompt: () => string;
  /** Get the conversation history (for context) */
  getHistory: () => AgentMessage[];
}

export function createSubtaskDelegatorTool(ctx: DelegatorContext) {
  return tool({
    description:
      'Delegate a focused sub-task to a sub-agent. Use this for multi-file refactors, ' +
      'implementing isolated features, or any task that benefits from its own dedicated ' +
      'context without cluttering the main conversation. ' +
      'The sub-agent will read files, make changes, and report back what it did. ' +
      'PASS the EXACT task description, file list, and success criteria — precision matters.',
    inputSchema: z.object({
      task: z
        .string()
        .min(10)
        .describe(
          'Precise description of what the sub-agent should do. Example: "Add input validation to the login form — check email format, min password length 8, and show inline error messages."',
        ),
      files: z
        .array(z.string())
        .min(1)
        .max(20)
        .describe(
          'List of files the sub-agent should work on (relative to WorkingDirectory or absolute). Example: ["src/auth/login.tsx", "src/auth/validation.ts"]. Max 20 files.',
        ),
      goal: z
        .string()
        .min(10)
        .describe(
          'The broader goal this sub-task contributes to. Example: "Implement secure user authentication for the web app."',
        ),
      success_criteria: z
        .string()
        .min(10)
        .describe(
          'How to know the task is done. Example: "Login form validates email and password, shows errors inline, and submits only when valid."',
        ),
      max_steps: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe('Maximum steps for the sub-agent (1–10, default: 5).'),
    }),
    execute: async (input) => {
      const subtaskCtx = ctx.getContext();
      const systemPrompt = ctx.getSystemPrompt();

      console.log(
        `[subtask] delegating: "${input.task.slice(0, 80)}..." (${input.files.length} files, ${input.max_steps} steps)`,
      );

      const result = await runSubtask(subtaskCtx, input);

      // Format result for main agent
      const header = result.success
        ? `✅ Subtask complete (${result.changed_files.length} file(s) changed)`
        : `⚠️ Subtask had issues`;

      const changedList = result.changed_files.length
        ? `\nFiles changed:\n${result.changed_files.map((f) => `  • ${f}`).join('\n')}`
        : '';

      const errorList = result.errors.length
        ? `\nErrors:\n${result.errors.map((e) => `  • ${e}`).join('\n')}`
        : '';

      return `${header}${changedList}${errorList}\n\n${result.summary}\n\n— Tokens: ${result.input_tokens} in / ${result.output_tokens} out —`;
    },
  });
}
