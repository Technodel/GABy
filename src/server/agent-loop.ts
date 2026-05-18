/**
 * SUNy Agent Loop -- uses Vercel AI SDK streamText with native tool calling.
 *
 * Architecture:
 *   streamText({ model, tools, maxSteps }) handles the full agentic loop:
 *     1. AI generates text and/or tool calls (native JSON, NOT XML in text)
 *     2. SDK auto-executes tool.execute() for each call
 *     3. Results fed back automatically for next step
 *     4. Repeats up to maxSteps times
 *
 * No more XML parsing, no more hallucinated tool calls.
 */

import { streamText, generateText, type CoreMessage, type LanguageModel } from 'ai';
import { getModelsForMode, getVisionCapableModels, isCachingEnabled, getEditFormat } from './agent';
import { createPowerTools } from './power-tools';
import { createWebSearchTool } from './web-search';
import { createUrlFetchTool } from './url-fetch';
import { createMemoryTools } from './user-memory';
import { createSymbolReaderTool } from './symbol-reader';
import { createSubtaskDelegatorTool } from './subtask-delegator';
import { createPromptRegistryTool } from './prompt-registry';
import { createFileDiscoveryTool } from './file-discovery';
import { createSelfHealTool } from './error-corrector';
import { mcpManager } from './mcp-manager';
import { userClientManager } from './user-client-manager';
import { isBridgeConnected } from './bridge-manager';
import { invalidateRepoMap } from './repo-map';
import { gitAutoCommit, createCheckpoint } from './git-manager';
import { trimHistory } from './context-manager';
import { classifyTask, getActiveSkills } from './skill-loader';
import { runLint } from './lint-runner';
import { runTests, runFailingTests, buildTestFixPrompt } from './test-runner';
import { pickRandom } from './personality';
import { narrateMessage } from './narrator';
import { LoopDetector } from './loop-detector';
import {
  selectStrategies, launchHypothesis, completeHypothesis,
} from './hypothesis-engine';
import {
  scoreAgentTurn, type TrainingScorerInput,
} from './training-scorer';
import {
  recordConfidence, buildConfidenceAssessmentPrompt,
} from './confidence-scorer';
import {
  extractMistakeRule,
} from './behavioral-rules';
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

// Per-user LoopDetector instances — each user gets their own to avoid cross-user contamination
const loopDetectors = new Map<number, LoopDetector>();
function getLoopDetector(userId: number): LoopDetector {
  let detector = loopDetectors.get(userId);
  if (!detector) {
    detector = new LoopDetector();
    loopDetectors.set(userId, detector);
  }
  return detector;
}

const MAX_STEPS = 8;
const MAX_LINT_RETRIES = 3;  // max extra AI passes to fix lint errors
const MAX_TEST_RETRIES = 5;  // max extra AI passes to fix test failures ("consider it done")

export interface AgentLoopRequest {
  userId: number;
  mode: string;
  systemPrompt: string;
  projectId?: number;
  projectPath?: string;
  history: AgentMessage[];
  userMessage: string;
  imageData?: string;        // base64-encoded image for vision/multimodal analysis
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
  changedFiles: string[];
  proofSummary: {
    durationMs: number;
    toolCalls: string[];
    toolCallCount: number;
    lintRuns: number;
    lintErrorsFound: number;
    lintPassed: boolean;
    lintGaveUp: boolean;
    testRuns: number;
    testFailuresFound: number;
    testPassed: boolean;
    testGaveUp: boolean;
    filesChanged: number;
    steps: number;
  };
}

/**
 * Classify a user message into the most appropriate billing mode for AUTO routing.
 * Uses keyword heuristics — no extra API call needed.
 */
function classifyAutoMode(message: string): 'free' | 'fast' | 'smart' | 'pro' {
  const t = message.toLowerCase();
  // Pro signals: explicit deep reasoning / architecture / analysis requests
  if (
    t.length > 150 &&
    /\b(architect|design pattern|tradeoff|compare|analyze|security|performance|scalab|deep dive|explain why|complex|algorithm|optimize|review|audit)\b/.test(t)
  ) return 'pro';
  // Smart signals: moderate-length tasks with domain-specific or moderate-complexity keywords
  if (
    t.length > 80 &&
    /\b(refactor|migrate|restructure|integrate|configur|deploy|optimize|schema|query|pipeline|workflow|component|module|service|middleware|hook|custom|layout|responsive|accessibility|state|context|reducer|selector|thunk|saga|observable|subscription)\b/.test(t)
  ) return 'smart';
  // Free signals: very short casual messages with no coding keywords
  if (
    t.length < 80 &&
    !/\b(fix|error|bug|implement|create|refactor|add|write|function|class|api|test|deploy|code|file|build|run|install|import|export|async|await|type|interface)\b/.test(t)
  ) return 'free';
  // Default: fast — handles most coding tasks well
  return 'fast';
}

export async function runAgentLoop(req: AgentLoopRequest): Promise<AgentLoopResult> {
  const { userId, mode, systemPrompt, projectId, projectPath, history, userMessage, imageData, sessionId, talkMode, signal, onChunk } = req;
  const startedAt = Date.now();

  // Resolve AUTO → real mode via keyword classification
  const resolvedMode = mode === 'auto' ? classifyAutoMode(userMessage) : mode;

  // When imageData is present, prefer vision-capable models across all modes
  const isVisionRequest = !!imageData;
  const modelEntries = isVisionRequest
    ? (() => {
        const vision = getVisionCapableModels();
        if (vision.length > 0) {
          console.log(`[agent-loop] Using vision-capable models: ${vision.map(v => v.provider).join(', ')}`);
          return vision;
        }
        console.warn('[agent-loop] imageData present but no vision-capable model found');
        // Return empty list to trigger the no-vision-model error below
        return [];
      })()
    : getModelsForMode(resolvedMode);
  let lastError: Error = new Error('No models available');

  // Track files changed during this turn (for git auto-commit + cache invalidation)
  const changedFiles = new Set<string>();
  const toolCallNames = new Set<string>();
  let lintRuns = 0;
  let lintErrorsFound = 0;
  let lintPassed = false;
  let lintGaveUp = false;
  let lintRetryCount = 0;  // declared here for scope access by mistake extraction below
  let testRuns = 0;
  let testFailuresFound = 0;
  let testPassed = false;
  let testGaveUp = false;

  // Build CoreMessage history, trimmed to fit context window
  // If imageData is provided, use multimodal content format (text + image parts)
  const userContent: CoreMessage['content'] = imageData
    ? [{ type: 'text', text: userMessage }, { type: 'image', image: imageData }]
    : userMessage;
  const rawMessages: CoreMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userContent },
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

  let fullSystem = architectPlanSystem ?? (projectPath
    ? `${systemPrompt}${formatSystemAddition}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`
    : systemPrompt + formatSystemAddition);

  // ── Runtime skill classification: inject relevant skill instructions ─────
  // Identify which engineering skill applies to this specific task and inject
  // its process guidance into the system prompt.
  if (userMessage) {
    const classification = classifyTask(userMessage);
    const activeSkills = getActiveSkills(userMessage);
    if (classification.confidence >= 0.3 && activeSkills.length > 0) {
      const skillBlock = [
        '',
        '<active_skills>',
        `Detected phase: ${classification.phase} | Skill: ${classification.skillName ?? 'none'} (confidence: ${(classification.confidence * 100).toFixed(0)}%)`,
        'The following skills are active for this task. Follow their processes:',
        ...activeSkills.map(s => `  • ${s.name}: ${s.description}`),
        '</active_skills>',
      ].join('\n');
      // Inject into fullSystem — append before the WorkingDirectory block or at the end
      const insertionPoint = fullSystem.lastIndexOf('\n<WorkingDirectory>');
      if (insertionPoint >= 0) {
        // Insert skill block right before the working directory tag
        fullSystem = fullSystem.slice(0, insertionPoint) + '\n' + skillBlock + fullSystem.slice(insertionPoint);
      } else {
        fullSystem = fullSystem + '\n' + skillBlock;
      }
      console.log(`[agent-loop] Skill classification: ${classification.phase} → ${classification.skillName} (${(classification.confidence * 100).toFixed(0)}%)`);
    }
  }

  // Build tools (only if bridge is connected, project is set, and NOT in talk mode)
  // MCP tools from connected servers are merged automatically
  // ── Model references (set inside model loop, used by lazy-getter tools) ──
  let currentModel: LanguageModel | undefined;
  let currentProvider: string = '';

  // ── Web tools (always available — server-side, no bridge needed) ────────
  const webSearch = createWebSearchTool();
  const urlFetch = createUrlFetchTool();
  const alwaysTools: Record<string, any> = { web_search: webSearch, url_fetch: urlFetch };

  const mcpToolsAvailable = mcpManager.availableToolCount > 0;
  const tools = (() => {
    if (bridgeConnected && projectPath && !talkMode) {
      const powerTools = createPowerTools({
        userId,
        projectPath,
        signal,
        onToolCall: (name, input) => {
          toolCallNames.add(name);
          const loopReport = getLoopDetector(userId).recordToolCall(name, typeof input === 'string' ? { raw: input } : input);
          if (loopReport?.detected) {
            console.warn(`[agent-loop] LOOP DETECTED: ${loopReport.message}`);
            userClientManager.pushToUser(userId, 'suny:narration', {
              message: narrateMessage(loopReport.message, 'error'),
            });
          }
          console.log(`[agent-loop] tool call: ${name}`, input);
          userClientManager.pushToUser(userId, 'suny:tool_call', { tool: name, input });
        },
        onFileChanged: (absPath) => {
          changedFiles.add(absPath);
          if (projectPath) invalidateRepoMap(userId, projectPath);
        },
        onFileDeleted: (absPath) => {
          changedFiles.delete(absPath);
          if (projectPath) invalidateRepoMap(userId, projectPath);
        },
      });
      // ── Additional SUNy tools (memory, symbol, prompt, discovery, delegation, healing) ──
      const memoryTools = createMemoryTools({ userId, projectPath });
      const symbolReaderTool = createSymbolReaderTool({ userId, projectPath });
      const promptRegistryTool = createPromptRegistryTool({ userId });
      const fileDiscoveryTool = createFileDiscoveryTool({ userId, projectPath });
      const subtaskDelegatorTool = createSubtaskDelegatorTool({
        getContext: () => ({
          userId,
          projectPath,
          model: currentModel as LanguageModel,
          provider: currentProvider,
          signal,
        }),
        getSystemPrompt: () => fullSystem,
        getHistory: () => history,
      });
      const selfHealTool = createSelfHealTool(() => ({
        model: currentModel as LanguageModel,
        signal,
      }));

      const extraTools = {
        ...memoryTools,     // save_memory, recall_memories, delete_memory
        read_symbols: symbolReaderTool,
        get_prompt_template: promptRegistryTool,
        find_files: fileDiscoveryTool,
        delegate_subtask: subtaskDelegatorTool,
        self_heal: selfHealTool,
      };

      let merged = { ...alwaysTools, ...powerTools, ...extraTools };
      if (mcpToolsAvailable) {
        const mcpTools = mcpManager.getTools();
        merged = { ...merged, ...mcpTools };
        if (Object.keys(mcpTools).length > 0) {
          console.log(`[agent-loop] Merged ${Object.keys(mcpTools).length} MCP tool(s) into toolset`);
        }
      }
      return merged;
    }
    // Bridge offline, no project, or talk mode — still provide web tools
    console.log('[agent-loop] Bridge/project tools unavailable; web_search + url_fetch only');
    return alwaysTools;
  })();

  const effectiveTools = textFormat ? undefined : tools;

  // ── Hypothesis Engine: Parallel strategy testing ────────────────────────
  // For complex tasks with tools available, spawn 2-3 mini-agent runs
  // with different strategies and pick the best result to guide the main loop.
  if (bridgeConnected && projectPath && !talkMode && projectId && userMessage.length > 80 && modelEntries.length > 0 && classifyAutoMode(userMessage) !== 'free' && classifyAutoMode(userMessage) !== 'fast') {
    try {
      const strategies = selectStrategies(userMessage);
      if (strategies.length >= 2) {
        const primaryModel = modelEntries[0].model as LanguageModel;
        const strategyPrompts: Record<string, string> = {
          direct_edit: '\n\n<strategy>Use targeted edits to existing files. Make minimal, precise changes.</strategy>',
          refactor_first: '\n\n<strategy>First refactor/clean up the relevant code, then implement the change.</strategy>',
          test_first: '\n\n<strategy>Write tests first, then implement the feature to make them pass.</strategy>',
          from_scratch: '\n\n<strategy>Create new files with a fresh implementation.</strategy>',
          minimal_patch: '\n\n<strategy>Find the absolute smallest change that solves the problem.</strategy>',
        };
        const hypResults = await Promise.allSettled(strategies.map(async (strategy) => {
          const hypId = launchHypothesis({ userId, projectId: projectId!, problem: userMessage.slice(0, 200), strategy });
          const hypSys = `${fullSystem}${strategyPrompts[strategy] || ''}`;
          const hypMsgs = [...rawMessages.slice(-4)];
          const result = await generateText({ model: primaryModel, system: hypSys, messages: hypMsgs, maxTokens: 800, abortSignal: signal });
          const text = result.text?.trim() || '';
          // Quality-based scoring: +40 test pass mention, +30 code block, +20 concise, -20 error keywords
          let score = 0;
          if (text.length > 50) {
            if (/tests?\s+(passed|passing|green|succeed)/i.test(text)) score += 40;
            if (/```[\w]*\n/.test(text)) score += 30;
            if (text.length < 500) score += 20;
            if (/(error|failed|fail|couldn't|cannot|unable)/i.test(text)) score -= 20;
            score = Math.max(0, Math.min(100, score));
          }
          completeHypothesis({ hypothesisId: hypId, resultSummary: text.slice(0, 500), changedFiles: [], score });
          return { strategy, text, score };
        }));
        let bestScore = -1, bestText = '', bestStrategy = '';
        for (const r of hypResults) {
          if (r.status === 'fulfilled' && r.value.score > bestScore) { bestScore = r.value.score; bestText = r.value.text; bestStrategy = r.value.strategy; }
        }
        if (bestText && bestText.length > 100) {
          const hypBlock = ['', '<hypothesis_testing>', `Best strategy: ${bestStrategy}`, `Result: ${bestText.slice(0, 1500)}`, '</hypothesis_testing>'].join('\n');
          const ins = fullSystem.lastIndexOf('\n<WorkingDirectory>');
          fullSystem = ins >= 0 ? fullSystem.slice(0, ins) + '\n' + hypBlock + fullSystem.slice(ins) : fullSystem + '\n' + hypBlock;
          console.log(`[agent-loop] Hypothesis engine injected: ${bestStrategy} (score: ${bestScore})`);
        }
      }
    } catch (e) { console.warn('[agent-loop] Hypothesis engine failed:', (e as Error).message); }
  }

  // Notify client that streaming is starting
  // Emit stage event for pipeline phase tracking
  userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Planning & executing...' });
  userClientManager.pushToUser(userId, 'suny:stream_start', {});

  // Create a git checkpoint BEFORE any file changes so the user can roll back
  if (bridgeConnected && projectPath && !talkMode) {
    createCheckpoint(userId, projectPath, userMessage).catch(() => {});
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let steps = 0;

  // If image data is present but no vision-capable models were found, throw
  if (isVisionRequest && modelEntries.length === 0) {
    throw new Error('NO_VISION_MODEL_AVAILABLE');
  }

  // Try each model in priority order (fallback on error)
  for (const { model, provider } of modelEntries) {
    // Update model references for lazy-getter tools (subtask delegator, self-heal)
    currentModel = model as LanguageModel;
    currentProvider = provider;

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
            userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Working through the steps...' });
            userClientManager.pushToUser(userId, 'suny:narration', {
              message: narrateMessage('Working through the steps...', 'thinking'),
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

      // ── Loop detection: if AI was stuck in a loop, inject self-correction ──
      if (getLoopDetector(userId).isLoopReported) {
        const loopMsg = '\n\n[SYSTEM: You were stuck in a repetitive loop. Step back, stop repeating yourself, and try a completely different approach. If you were reading the same files, stop — you already have the information you need.]\n\n';
        fullText = loopMsg + fullText;
        getLoopDetector(userId).rearm();
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

      // ── Phase 2.1: Real-time self-scoring after main response ─────────────
      // Score SUNy's intermediate response immediately, not just at end of turn.
      // This catches drift while the conversation is still fresh.
      if (fullText && userMessage && projectPath) {
        const scoreInput: TrainingScorerInput = {
          userRequest: userMessage,
          aiResponse: fullText,
          changedFiles: Array.from(changedFiles),
          lintPassed: false,
          testPassed: false,
          lintErrorsFound: 0,
          testFailuresFound: 0,
          durationMs: Date.now() - startedAt,
          toolCallCount: toolCallNames.size,
          steps,
        };
        scoreAgentTurn(userId, projectId ?? null, sessionId, resolvedMode, steps, scoreInput)
          .catch(e => console.warn('[agent-loop] main scoring failed:', (e as Error).message));
      }

      // ── Confidence Scorer: self-assessment after main response ──────────
      // Model self-reports confidence (0-1) and uncertainties; low confidence
      // is logged for escalation tracking.
      if (fullText && projectId && !talkMode) {
        try {
          const assessmentPrompt = buildConfidenceAssessmentPrompt();
          const assessResult = await generateText({
            model: model as LanguageModel,
            system: 'You are assessing your own work. Be honest and concise.',
            messages: [
              { role: 'user', content: `Task: ${userMessage.slice(0, 300)}\n\nYour response:\n${fullText.slice(0, 2000)}\n\n${assessmentPrompt}` },
            ],
            maxTokens: 200,
            abortSignal: signal,
          });
          const assessText = assessResult.text?.trim() || '';
          // Parse confidence: look for a number between 0.0 and 1.0
          const confMatch = assessText.match(/\b(0(?:\.\d+)?|1\.0)\b/);
          const confidence = confMatch ? Math.max(0, Math.min(1, parseFloat(confMatch[0]))) : 0.9;
          // Extract uncertainties (lines with specific concerns)
          const uncertainties: string[] = assessText
            .split('\n')
            .filter(l => /unsure|not certain|might not|maybe|could be|concern|risk|edge case/i.test(l))
            .map(l => l.trim())
            .slice(0, 5);
          recordConfidence({
            turnIndex: steps || 1,
            userId,
            projectId: projectId!,
            sessionId,
            confidence,
            uncertainties,
            currentMode: resolvedMode,
          });
          totalInput += assessResult.usage?.inputTokens ?? 0;
          totalOutput += assessResult.usage?.outputTokens ?? 0;
          console.log(`[confidence] Self-assessed: ${(confidence * 100).toFixed(0)}% (${uncertainties.length} uncertainties)`);

          // ── Low-Confidence Self-Revision (PRO mode) ────────────────────
          // When the model self-reports low confidence, give it one shot to
          // revise before proceeding to lint/test/architect.  This addresses
          // the "first draft vs second draft" accuracy gap at minimal cost:
          // roughly +15-25% tokens for ~20% of PRO requests.
          if (
            confidence < 0.8 &&
            uncertainties.length > 1 &&
            resolvedMode === 'pro' &&
            projectPath &&
            fullText.length > 100
          ) {
            try {
              userClientManager.pushNarration(userId, 'Reviewing for accuracy...');

              const revisionMsg: CoreMessage = {
                role: 'user',
                content:
                  `You flagged uncertainty about: ${uncertainties.join('; ')}.\n\n` +
                  `Review your own response above — not the question, but what you wrote.\n` +
                  `Fix any inaccuracies, fill edge-case gaps, and output ONLY the corrected version.\n` +
                  `Do not re-explain. Do not add fluff. Just the corrected response.`,
              };

              const revIn: CoreMessage[] = [
                ...messages,
                { role: 'assistant' as const, content: fullText },
                revisionMsg,
              ];

              const { messages: revMsgs, useSystemParam: revUse } = useAnthropicCache
                ? buildAnthropicCachedMessages(trimHistory(revIn, fullSystem, provider), fullSystem)
                : { messages: trimHistory(revIn, fullSystem, provider), useSystemParam: true as const };

              userClientManager.pushToUser(userId, 'suny:stream_start', {});

              const revResult = streamText({
                model: model as LanguageModel,
                system: revUse ? fullSystem : undefined,
                messages: revMsgs,
                // No tools — this is a pure text refinement pass
                maxSteps: 1,
                abortSignal: signal,
                onStepFinish: ({ usage }) => {
                  steps++;
                  totalInput += usage?.inputTokens ?? 0;
                  totalOutput += usage?.outputTokens ?? 0;
                },
                experimental_telemetry: { isEnabled: false },
              });

              let revText = '';
              for await (const delta of revResult.textStream) {
                revText += delta;
                if (onChunk) onChunk(delta);
              }

              const revUsage = await revResult.usage;
              totalInput += revUsage.inputTokens;
              totalOutput += revUsage.outputTokens;

              if (revText.trim()) {
                fullText = revText;
                console.log(`[agent-loop] Self-revision applied (confidence was ${(confidence * 100).toFixed(0)}%, ${uncertainties.length} concerns)`);
              }
            } catch (revErr) {
              console.warn('[agent-loop] Self-revision failed:', (revErr as Error).message);
            }
          }
        } catch (cErr) {
          console.warn('[confidence] Assessment failed:', (cErr as Error).message);
        }
      }

      // ── Architect mode: plan → execute ───────────────────────────────────
      // First pass (above) was the planning pass. Now run a second pass that
      // actually applies edits using diff format (or tool-call if tools available).
      if (editFormat === 'architect' && projectPath && bridgeConnected) {
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'executing', label: 'Plan ready — now executing...' });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Plan ready — now executing...', 'plan'),
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

        userClientManager.pushToUser(userId, 'suny:stream_start', {});

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
            userClientManager.pushToUser(userId, 'suny:stage', { stage: 'executing', label: 'Executing the plan...' });
            userClientManager.pushToUser(userId, 'suny:narration', {
              message: narrateMessage('Executing the plan...', 'plan'),
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

      // Emit stage transition to linting
      if (projectPath && changedFiles.size > 0) {
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'linting', label: 'Checking code quality...' });
      }

      // ── Aider-style lint self-correction loop ────────────────────────────
      // After files were changed, run the project linter/compiler.
      // If it reports errors, feed them back to the AI and retry (up to MAX_LINT_RETRIES).
      if (projectPath && changedFiles.size > 0) {
        let lintPass = 0;
        let lintMessages = messages; // keep growing context across lint passes
        let lintFullText = fullText;

        while (lintPass < MAX_LINT_RETRIES) {
          lintRuns++;
          userClientManager.pushToUser(userId, 'suny:lint_running', {
            attempt: lintPass + 1,
            command: '(detecting...)',
          });

          const lintResult = await runLint(userId, projectPath, Array.from(changedFiles), signal);

          if (!lintResult || lintResult.passed) {
            if (lintResult?.passed) {
              lintPassed = true;
              userClientManager.pushToUser(userId, 'suny:lint_passed', {
                attempt: lintPass + 1,
                command: lintResult.command,
              });
            }
            break; // clean — no errors to fix
          }

          lintPass++;
          lintErrorsFound += lintResult.errorCount;
          console.log(`[agent-loop] lint errors (pass ${lintPass}): ${lintResult.errorCount} errors`);

          userClientManager.pushToUser(userId, 'suny:lint_errors', {
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

          userClientManager.pushToUser(userId, 'suny:stream_start', {});

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
              userClientManager.pushToUser(userId, 'suny:stage', { stage: 'lint-fixing', label: 'Fixing lint errors...' });
              userClientManager.pushToUser(userId, 'suny:narration', {
                message: narrateMessage('Fixing the errors...', 'test_fixing'),
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
            lintGaveUp = true;
            userClientManager.pushToUser(userId, 'suny:lint_gave_up', {
              errorCount: finalLint.errorCount,
              command: finalLint.command,
            });
          }
        }
        lintRetryCount = lintPass;
      }
      // ── End lint loop ────────────────────────────────────────────────────

      // ── Phase 2.3: Extract mistake rules from lint failures ───────────────
      if (lintErrorsFound > 0 && projectPath) {
        try {
          await extractMistakeRule(userId, projectId ?? null, 'lint', {
            errorCount: lintErrorsFound,
            retriesUsed: lintRetryCount,
            gaveUp: lintGaveUp,
            context: userMessage.slice(0, 300),
          });
        } catch (e) {
          console.warn('[agent-loop] mistake extraction (lint) failed:', (e as Error).message);
        }
      }

      // Emit stage transition to testing
      if (projectPath && changedFiles.size > 0 && !talkMode) {
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'testing', label: 'Running tests...' });
      }

      // ── Test self-correction loop ─────────────────────────────────────────
      // After lint is green (or skipped), run the test suite and loop until
      // all tests pass or MAX_TEST_RETRIES is exhausted.
      // Each retry escalates the prompt depth so the AI goes deeper on each pass.
      if (projectPath && changedFiles.size > 0 && !talkMode) {
        userClientManager.pushToUser(userId, 'suny:test_running', {
          attempt: 0,
          message: 'Running tests...',
        });
        testRuns++;

        let testResult = await runTests(userId, projectPath, signal);

        if (testResult && !testResult.passed) {
          let testPass = 0;
          let testMessages = messages;
          let testFullText = fullText;

          while (testPass < MAX_TEST_RETRIES && testResult && !testResult.passed) {
            testPass++;
            testFailuresFound += testResult.failCount;
            console.log(`[agent-loop] test failures (pass ${testPass}): ${testResult.failCount} failing`);

            userClientManager.pushToUser(userId, 'suny:test_errors', {
              attempt: testPass,
              failCount: testResult.failCount,
              framework: testResult.framework,
            });

            const testFix: CoreMessage = {
              role: 'user',
              content: buildTestFixPrompt(testResult, testPass),
            };

            testMessages = [
              ...testMessages,
              { role: 'assistant' as const, content: testFullText },
              testFix,
            ];

            const rawTrimmedTest = trimHistory(testMessages, fullSystem, provider);
            const { messages: trimmedTest, useSystemParam: testUseSystem } = useAnthropicCache
              ? buildAnthropicCachedMessages(rawTrimmedTest, fullSystem)
              : { messages: rawTrimmedTest, useSystemParam: true as const };

            userClientManager.pushToUser(userId, 'suny:stream_start', {});

            const testFixResult = streamText({
              model: model as LanguageModel,
              system: testUseSystem ? fullSystem : undefined,
              messages: trimmedTest,
              tools,
              maxSteps: MAX_STEPS,
              abortSignal: signal,
              onStepFinish: ({ usage: u }) => {
                steps++;
                totalInput += u?.inputTokens ?? 0;
                totalOutput += u?.outputTokens ?? 0;
                userClientManager.pushToUser(userId, 'suny:stage', { stage: 'test-fixing', label: `Fixing tests (attempt ${testPass})...` });
                userClientManager.pushToUser(userId, 'suny:narration', {
                  message: narrateMessage('Fixing tests...', 'test_fixing', { attempt: testPass }),
                });
              },
              experimental_telemetry: { isEnabled: false },
            });

            let testFixText = '';
            for await (const delta of testFixResult.textStream) {
              testFixText += delta;
              if (onChunk) onChunk(delta);
            }
            const testFixUsage = await testFixResult.usage;
            totalInput += testFixUsage.inputTokens;
            totalOutput += testFixUsage.outputTokens;

            testFullText = testFixText.trim() || testFullText;

            // Commit the test fixes
            if (changedFiles.size > 0) {
              gitAutoCommit(
                userId, projectPath, Array.from(changedFiles),
                `test fix pass ${testPass}: ${userMessage}`,
              ).catch(() => {});
            }

            // Re-run — scope-narrowed to only failing tests on pass 2+ for speed
            userClientManager.pushToUser(userId, 'suny:test_running', {
              attempt: testPass,
              message: `Re-running tests (attempt ${testPass + 1})...`,
            });
            testRuns++;
            testResult = testPass === 1
              ? await runTests(userId, projectPath, signal)
              : await runFailingTests(userId, projectPath, testResult);
          }

          if (testResult?.passed) {
            testPassed = true;
            userClientManager.pushToUser(userId, 'suny:test_passed', {
              attempt: testPass,
            });
          } else if (testResult && !testResult.passed) {
            testGaveUp = true;
            userClientManager.pushToUser(userId, 'suny:test_gave_up', {
              failCount: testResult.failCount,
              framework: testResult.framework,
            });
            // Surface the remaining failures in the chat
            const remaining = testResult.failedTests.slice(0, 5).map(t => `• ${t.name}`).join('\n');
            fullText = (testFullText || fullText) +
              `\n\n⚠️ ${testResult.failCount} test(s) still failing after ${testPass} attempt(s):\n${remaining || testResult.output.slice(0, 400)}`;
          }
        } else if (testResult?.passed) {
          testPassed = true;
          userClientManager.pushToUser(userId, 'suny:test_passed', { attempt: 0 });
        }
      }
      // ── End test loop ─────────────────────────────────────────────────────

      // ── Phase 2.3: Extract mistake rules from test failures ───────────────
      if (testFailuresFound > 0 && projectPath) {
        try {
          await extractMistakeRule(userId, projectId ?? null, 'test', {
            errorCount: testFailuresFound,
            retriesUsed: testRuns,
            gaveUp: testGaveUp,
            context: userMessage.slice(0, 300),
          });
        } catch (e) {
          console.warn('[agent-loop] mistake extraction (test) failed:', (e as Error).message);
        }
      }

      // ── Silent self-reflection pass ───────────────────────────────────────
      // For substantial conversational responses (no file edits made), run a
      // hidden review on the same model to catch errors before sending.
      // Skipped when: files were changed (lint loop already handles quality),
      // text-based edit formats (diff/whole output), or architect multi-pass.
      if (
        !textFormat &&
        editFormat !== 'architect' &&
        changedFiles.size === 0 &&
        fullText.length > 600
      ) {
        try {
          const reflectResult = await generateText({
            model: model as LanguageModel,
            system: 'You are a meticulous senior engineer performing a silent final accuracy review.',
            messages: [{
              role: 'user',
              content:
                'Review this AI response to the user\'s request.\n' +
                'If it is accurate and complete, reply with exactly: LGTM\n' +
                'If it has factual errors, incomplete code, or misses the request — reply with the fully corrected response ONLY. No preamble, no explanations.\n\n' +
                'User request:\n' + userMessage.slice(0, 1200) + '\n\n' +
                'Draft response:\n' + fullText.slice(0, 5000),
            }],
            maxTokens: 3000,
            abortSignal: signal,
          });
          const refined = reflectResult.text?.trim() ?? '';
          // Only replace if the model actually found something wrong (not a LGTM)
          if (refined && !refined.startsWith('LGTM') && refined.length > 100) {
            fullText = refined;
          }
          totalInput += reflectResult.usage?.inputTokens ?? 0;
          totalOutput += reflectResult.usage?.outputTokens ?? 0;
        } catch {
          // Reflection is best-effort — never block the main response
        }
      }
      // Emit stage complete
      userClientManager.pushToUser(userId, 'suny:stage', { stage: 'complete', label: 'Done!' });

      // ── End self-reflection ───────────────────────────────────────────────

      return {
        content: fullText.trim() || '',
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheWriteTokens: totalCacheWrite,
        cacheReadTokens: totalCacheRead,
        iterations: steps || 1,
        resolvedMode,
        changedFiles: Array.from(changedFiles),
        proofSummary: {
          durationMs: Date.now() - startedAt,
          toolCalls: Array.from(toolCallNames),
          toolCallCount: toolCallNames.size,
          lintRuns,
          lintErrorsFound,
          lintPassed,
          lintGaveUp,
          testRuns,
          testFailuresFound,
          testPassed,
          testGaveUp,
          filesChanged: changedFiles.size,
          steps: steps || 1,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLast = modelEntries.indexOf(modelEntries.find(m => m.model === model)!) === modelEntries.length - 1;
      if (!isLast) {
        console.warn(`[agent-loop] ${provider} failed, trying fallback: ${lastError.message}`);
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'fallback', label: `Provider ${provider} failed, trying fallback...` });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Provider failed, trying fallback...', 'error'),
        });
      }
    }
  }

  throw lastError;
}
