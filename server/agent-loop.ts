/**
 * GABy Agent Loop -- uses Vercel AI SDK streamText with native tool calling.
 *
 * Architecture (same as AiderDesk):
 *   streamText({ model, tools, maxSteps }) handles the full agentic loop:
 *     1. AI generates text and/or tool calls (native JSON, NOT XML in text)
 *     2. SDK auto-executes tool.execute() for each call
 *     3. Results fed back automatically for next step
 *     4. Repeats up to maxSteps times
 *
 * No more XML parsing, no more hallucinated tool calls.
 */

import { streamText, type CoreMessage, type LanguageModel } from 'ai';
import { getModelsForMode, isCachingEnabled, getEditFormat } from './agent';
import { createPowerTools } from './power-tools';
import { userClientManager } from './user-client-manager';
import { isBridgeConnected } from './bridge-manager';
import { invalidateRepoMap } from './repo-map';
import { gitAutoCommit, createCheckpoint } from './git-manager';
import { trimHistory } from './context-manager';
import { runLint } from './lint-runner';
import { pickRandom } from './personality';
import {
  applyDiffFormat, applyWholeFormat,
  DIFF_FORMAT_INSTRUCTIONS, WHOLE_FORMAT_INSTRUCTIONS,
  ARCHITECT_PLAN_INSTRUCTIONS,
} from './edit-format-parser';
import type { AgentMessage } from './agent';

export { AgentMessage };

/**
 * For Anthropic, inject cache_control breakpoints so the static system prompt
 * and the conversation history before the current turn are cached.
 *
 * Strategy:
 *   1. System prompt → passed as a `role:'system'` message with cacheControl,
 *      so Anthropic caches it (saves the most tokens — repo map lives here).
 *   2. Last assistant message in history → also marked with cacheControl,
 *      so on turn 2+ the full prior conversation is cached too.
 *
 * When this is used, `system` is NOT passed separately to streamText
 * (Anthropic throws if you supply both a system param and a system message).
 */
function buildAnthropicCachedMessages(
  messages: CoreMessage[],
  systemPrompt: string,
): { messages: CoreMessage[]; useSystemParam: false } {
  const CACHE = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

  // System prompt as a cacheable system message
  const systemMsg: CoreMessage = {
    role: 'system',
    content: systemPrompt,
    providerOptions: CACHE,
  };

  // Find last assistant message index and mark its last content part
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { lastAssistantIdx = i; break; }
  }

  const tagged = messages.map((msg, i) => {
    if (i !== lastAssistantIdx) return msg;
    const rawContent = msg.content;
    // Convert string content to array so we can attach providerOptions to last part
    const parts: Array<{ type: 'text'; text: string; providerOptions?: Record<string, unknown> }> =
      typeof rawContent === 'string'
        ? [{ type: 'text', text: rawContent }]
        : (rawContent as Array<{ type: string; text?: string }>)
            .filter(p => p.type === 'text')
            .map(p => ({ type: 'text' as const, text: p.text ?? '' }));
    if (parts.length > 0) {
      parts[parts.length - 1] = { ...parts[parts.length - 1], providerOptions: CACHE };
    }
    return { ...msg, content: parts };
  });

  return { messages: [systemMsg, ...tagged], useSystemParam: false };
}

const MAX_STEPS = 8;
const MAX_LINT_RETRIES = 3; // max extra AI passes to fix lint errors

export interface AgentLoopRequest {
  userId: number;
  mode: string;
  systemPrompt: string;
  projectId?: number;
  projectPath?: string;
  history: AgentMessage[];
  userMessage: string;
  sessionId: string;
  talkMode?: boolean;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
}

export interface AgentLoopResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  iterations: number;
  resolvedMode: string;
}

/**
 * Classify a user message into the most appropriate billing mode for AUTO routing.
 * Uses keyword heuristics — no extra API call needed.
 */
function classifyAutoMode(message: string): 'free' | 'fast' | 'pro' {
  const t = message.toLowerCase();
  // Pro signals: explicit deep reasoning / architecture / analysis requests
  if (
    t.length > 150 &&
    /\b(architect|design pattern|tradeoff|compare|analyze|security|performance|scalab|deep dive|explain why|complex|algorithm|optimize|review|audit)\b/.test(t)
  ) return 'pro';
  // Free signals: very short casual messages with no coding keywords
  if (
    t.length < 80 &&
    !/\b(fix|error|bug|implement|create|refactor|add|write|function|class|api|test|deploy|code|file|build|run|install|import|export|async|await|type|interface)\b/.test(t)
  ) return 'free';
  // Default: fast — handles most coding tasks well
  return 'fast';
}

export async function runAgentLoop(req: AgentLoopRequest): Promise<AgentLoopResult> {
  const { userId, mode, systemPrompt, projectPath, history, userMessage, sessionId, talkMode, signal, onChunk } = req;

  // Resolve AUTO → real mode via keyword classification
  const resolvedMode = mode === 'auto' ? classifyAutoMode(userMessage) : mode;

  const modelEntries = getModelsForMode(resolvedMode);
  let lastError: Error = new Error('No models available');

  // Track files changed during this turn (for git auto-commit + cache invalidation)
  const changedFiles = new Set<string>();

  // Build CoreMessage history, trimmed to fit context window
  const rawMessages: CoreMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userMessage },
  ];

  // Determine edit format (needs bridgeConnected, must come before fullSystem)
  const bridgeConnected = isBridgeConnected(userId);
  const editFormat = (bridgeConnected && projectPath && !talkMode) ? getEditFormat() : 'tool-call';

  // For text-based formats (diff / whole), drop tool calls and inject format instructions
  const textFormat = editFormat === 'diff' || editFormat === 'whole';

  let formatSystemAddition = '';
  if (textFormat && projectPath) {
    formatSystemAddition = '\n\n' + (editFormat === 'diff' ? DIFF_FORMAT_INSTRUCTIONS : WHOLE_FORMAT_INSTRUCTIONS);
  }
  if (talkMode) {
    formatSystemAddition += '\n\n[TALK MODE] You are in Talk Mode. Do NOT write to, create, or edit any files. Only reason, explain, and discuss. If the user asks you to edit something, explain what you would do but do not call any file tools.';
  }

  // Build system prompt with project context
  // For architect mode, the first pass uses a planning-only prompt
  const architectPlanSystem = editFormat === 'architect'
    ? `${systemPrompt}\n\n${ARCHITECT_PLAN_INSTRUCTIONS}\n\n<WorkingDirectory>${projectPath ?? '(no project)'}</WorkingDirectory>`
    : null;

  const fullSystem = architectPlanSystem ?? (projectPath
    ? `${systemPrompt}${formatSystemAddition}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`
    : systemPrompt + formatSystemAddition);

  // Build tools (only if bridge is connected, project is set, and NOT in talk mode)
  const tools = (bridgeConnected && projectPath && !talkMode)
    ? createPowerTools({
        userId,
        projectPath,
        signal,
        onToolCall: (name, input) => {
          console.log(`[agent-loop] tool call: ${name}`, input);
          userClientManager.pushToUser(userId, 'gaby:tool_call', { tool: name, input });
        },
        onFileChanged: (absPath) => {
          changedFiles.add(absPath);
          // Invalidate repo map cache immediately so the next message sees fresh symbols
          if (projectPath) invalidateRepoMap(userId, projectPath);
        },
      })
    : undefined;

  const effectiveTools = textFormat ? undefined : tools;

  // Notify client that streaming is starting
  userClientManager.pushToUser(userId, 'gaby:stream_start', {});

  // Create a git checkpoint BEFORE any file changes so the user can roll back
  if (bridgeConnected && projectPath && !talkMode) {
    createCheckpoint(userId, projectPath, userMessage).catch(() => {});
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let steps = 0;

  // Try each model in priority order (fallback on error)
  for (const { model, provider } of modelEntries) {
    try {
      // Trim history to fit this provider's context window
      const messages = trimHistory(rawMessages, fullSystem, provider);
      if (messages.length < rawMessages.length) {
        console.log(`[agent-loop] trimmed history ${rawMessages.length} → ${messages.length} msgs for ${provider}`);
      }

      // Inject Anthropic cache breakpoints when caching is enabled
      const cachingEnabled = isCachingEnabled();
      const useAnthropicCache = cachingEnabled && provider === 'Anthropic';
      const { messages: finalMessages, useSystemParam } = useAnthropicCache
        ? buildAnthropicCachedMessages(messages, fullSystem)
        : { messages, useSystemParam: true as const };

      const result = streamText({
        model: model as LanguageModel,
        system: useSystemParam ? fullSystem : undefined,
        messages: finalMessages,
        tools: effectiveTools,
        maxSteps: textFormat ? 1 : MAX_STEPS, // text formats do 1 pass, tool-call does multi-step
        abortSignal: signal,
        onStepFinish: ({ usage }) => {
          steps++;
          totalInput += usage?.inputTokens ?? 0;
          totalOutput += usage?.outputTokens ?? 0;
          if (steps > 1) {
            userClientManager.pushToUser(userId, 'gaby:narration', {
              message: pickRandom('working', 'Working through the steps...'),
            });
          }
        },
        experimental_telemetry: { isEnabled: false },
      });

      let fullText = '';

      // Stream text chunks to frontend
      for await (const delta of result.textStream) {
        fullText += delta;
        if (onChunk) onChunk(delta);
      }

      // Collect final usage
      const usage = await result.usage;
      totalInput += usage.inputTokens;
      totalOutput += usage.outputTokens;

      // Anthropic cache tokens (if available)
      const experimental = (await result.experimental_providerMetadata) as Record<string, unknown> | undefined;
      const anthropicMeta = experimental?.['anthropic'] as Record<string, number> | undefined;
      totalCacheWrite += anthropicMeta?.cacheCreationInputTokens ?? 0;
      totalCacheRead += anthropicMeta?.cacheReadInputTokens ?? 0;

      // DeepSeek automatic cache hit tokens (they cache prefix automatically)
      const deepseekMeta = experimental?.['deepseek'] as Record<string, unknown> | undefined;
      const deepseekUsage = deepseekMeta?.['usage'] as Record<string, number> | undefined;
      totalCacheRead += deepseekUsage?.prompt_cache_hit_tokens ?? 0;

      // ── Architect mode: plan → execute ───────────────────────────────────
      // First pass (above) was the planning pass. Now run a second pass that
      // actually applies edits using diff format (or tool-call if tools available).
      if (editFormat === 'architect' && projectPath && bridgeConnected) {
        userClientManager.pushToUser(userId, 'gaby:narration', {
          message: pickRandom('working', 'Plan ready — now executing...'),
        });

        const execFormatInstructions = tools ? '' : '\n\n' + DIFF_FORMAT_INSTRUCTIONS;
        const execSystem = `${systemPrompt}${execFormatInstructions}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`;

        const rawExecMessages: CoreMessage[] = [
          ...messages,
          { role: 'assistant' as const, content: fullText },
          {
            role: 'user' as const,
            content: 'Great plan. Now execute it — make all the changes described above.',
          },
        ];

        const { messages: execMessages, useSystemParam: execUseSystem } = useAnthropicCache
          ? buildAnthropicCachedMessages(trimHistory(rawExecMessages, execSystem, provider), execSystem)
          : { messages: trimHistory(rawExecMessages, execSystem, provider), useSystemParam: true as const };

        userClientManager.pushToUser(userId, 'gaby:stream_start', {});

        const execResult = streamText({
          model: model as LanguageModel,
          system: execUseSystem ? execSystem : undefined,
          messages: execMessages,
          tools: tools, // use tool-call for execution if available
          maxSteps: MAX_STEPS,
          abortSignal: signal,
          onStepFinish: ({ usage: u }) => {
            steps++;
            totalInput += u?.inputTokens ?? 0;
            totalOutput += u?.outputTokens ?? 0;
            userClientManager.pushToUser(userId, 'gaby:narration', {
              message: pickRandom('working', 'Executing the plan...'),
            });
          },
          experimental_telemetry: { isEnabled: false },
        });

        let execText = '';
        for await (const delta of execResult.textStream) {
          execText += delta;
          if (onChunk) onChunk(delta);
        }
        const execUsage = await execResult.usage;
        totalInput += execUsage.inputTokens;
        totalOutput += execUsage.outputTokens;

        // If no tools, parse diff format from execution output
        if (!tools && execText) {
          const applied = applyDiffFormat(execText, projectPath);
          for (const r of applied) {
            if (r.applied) {
              changedFiles.add(r.file.startsWith('/') ? r.file : `${projectPath}/${r.file}`);
              invalidateRepoMap(userId, projectPath);
            } else {
              console.warn(`[agent-loop] architect diff apply failed: ${r.file} — ${r.error}`);
            }
          }
        }

        fullText = `**Plan:**\n${fullText}\n\n**Execution:**\n${execText}`;
      }

      // ── Apply text-based edit formats ─────────────────────────────────────
      if (textFormat && projectPath && fullText) {
        const applyFn = editFormat === 'diff' ? applyDiffFormat : applyWholeFormat;
        const applied = applyFn(fullText, projectPath);
        for (const r of applied) {
          if (r.applied) {
            changedFiles.add(r.file.startsWith('/') ? r.file : `${projectPath}/${r.file}`);
            invalidateRepoMap(userId, projectPath);
          } else {
            console.warn(`[agent-loop] ${editFormat} apply failed: ${r.file} — ${r.error}`);
          }
        }
      }

      // Auto-commit any changed files to git (non-blocking, non-fatal)
      if (projectPath && changedFiles.size > 0) {
        gitAutoCommit(userId, projectPath, Array.from(changedFiles), userMessage).catch(
          (e) => console.warn('[agent-loop] git auto-commit error:', (e as Error).message),
        );
      }

      // ── Aider-style lint self-correction loop ────────────────────────────
      // After files were changed, run the project linter/compiler.
      // If it reports errors, feed them back to the AI and retry (up to MAX_LINT_RETRIES).
      if (projectPath && changedFiles.size > 0) {
        let lintPass = 0;
        let lintMessages = messages; // keep growing context across lint passes
        let lintFullText = fullText;

        while (lintPass < MAX_LINT_RETRIES) {
          userClientManager.pushToUser(userId, 'gaby:lint_running', {
            attempt: lintPass + 1,
            command: '(detecting...)',
          });

          const lintResult = await runLint(userId, projectPath, Array.from(changedFiles), signal);

          if (!lintResult || lintResult.passed) {
            if (lintResult?.passed) {
              userClientManager.pushToUser(userId, 'gaby:lint_passed', {
                attempt: lintPass + 1,
                command: lintResult.command,
              });
            }
            break; // clean — no errors to fix
          }

          lintPass++;
          console.log(`[agent-loop] lint errors (pass ${lintPass}): ${lintResult.errorCount} errors`);

          userClientManager.pushToUser(userId, 'gaby:lint_errors', {
            attempt: lintPass,
            errorCount: lintResult.errorCount,
            command: lintResult.command,
            output: lintResult.output.slice(0, 2000), // truncate for UI
          });

          // Build correction message
          const lintFix: CoreMessage = {
            role: 'user',
            content:
              `The ${lintResult.command} checker reported ${lintResult.errorCount} error(s):\n\n` +
              '```\n' + lintResult.output.slice(0, 4000) + '\n```\n\n' +
              'Fix ALL errors above. Do not ask for permission — just fix them.',
          };

          // Append the previous AI reply + the lint correction request
          lintMessages = [
            ...lintMessages,
            { role: 'assistant' as const, content: lintFullText },
            lintFix,
          ];

          const rawTrimmedLint = trimHistory(lintMessages, fullSystem, provider);
          const { messages: trimmedLint, useSystemParam: lintUseSystem } = useAnthropicCache
            ? buildAnthropicCachedMessages(rawTrimmedLint, fullSystem)
            : { messages: rawTrimmedLint, useSystemParam: true as const };

          userClientManager.pushToUser(userId, 'gaby:stream_start', {});

          const lintFixResult = streamText({
            model: model as LanguageModel,
            system: lintUseSystem ? fullSystem : undefined,
            messages: trimmedLint,
            tools,
            maxSteps: MAX_STEPS,
            abortSignal: signal,
            onStepFinish: ({ usage }) => {
              steps++;
              totalInput += usage?.inputTokens ?? 0;
              totalOutput += usage?.outputTokens ?? 0;
              userClientManager.pushToUser(userId, 'gaby:narration', {
                message: pickRandom('fixing', 'Fixing the errors...'),
              });
            },
            experimental_telemetry: { isEnabled: false },
          });

          let lintFixText = '';
          for await (const delta of lintFixResult.textStream) {
            lintFixText += delta;
            if (onChunk) onChunk(delta);
          }

          const lintUsage = await lintFixResult.usage;
          totalInput += lintUsage.inputTokens;
          totalOutput += lintUsage.outputTokens;

          lintFullText = lintFixText.trim() || lintFullText;

          // Commit the fixes
          if (changedFiles.size > 0) {
            gitAutoCommit(userId, projectPath, Array.from(changedFiles), `lint fix pass ${lintPass}: ${userMessage}`).catch(() => {});
          }
        }

        if (lintPass === MAX_LINT_RETRIES) {
          // Exhausted retries — warn the user but still return
          const finalLint = await runLint(userId, projectPath, Array.from(changedFiles), signal);
          if (finalLint && !finalLint.passed) {
            userClientManager.pushToUser(userId, 'gaby:lint_gave_up', {
              errorCount: finalLint.errorCount,
              command: finalLint.command,
            });
          }
        }
      }
      // ── End lint loop ────────────────────────────────────────────────────

      return {
        content: fullText.trim() || '',
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheWriteTokens: totalCacheWrite,
        cacheReadTokens: totalCacheRead,
        iterations: steps || 1,
        resolvedMode,
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLast = modelEntries.indexOf(modelEntries.find(m => m.model === model)!) === modelEntries.length - 1;
      if (!isLast) {
        console.warn(`[agent-loop] ${provider} failed, trying fallback: ${lastError.message}`);
        userClientManager.pushToUser(userId, 'gaby:narration', {
          message: `Provider ${provider} failed, trying fallback...`,
        });
      }
    }
  }

  throw lastError;
}
