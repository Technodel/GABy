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
import * as fs from 'fs';
import {
  selectStrategies, launchHypothesis, completeHypothesis, failHypothesis,
  runHypothesisStrategies,
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
  buildCrossProjectPrompt,
  shareErrorPattern, shareDesignDecision,
  isCrossProjectLearningEnabled,
} from './cross-project-learning';
import { isFeatureEnabled } from './feature-flags';
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
 * DeepSeek auto-caches without any markers — no special handling needed.
 * This function is Anthropic-only.
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

const MAX_STEPS = 24;
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
  stepsExhausted: boolean;
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
    stepsExhausted: boolean;
  };
}

/**
 * Classify a user message into the most appropriate billing mode for AUTO routing.
 * Uses weighted scoring across multiple signal categories to make intelligent
 * routing decisions without an extra API call.
 *
 * Signals considered:
 *   - Coding intent (fix, build, refactor, etc.)
 *   - Creation intent (make a game, create an app, etc.)
 *   - Reasoning depth needed (analyze, architect, explain, etc.)
 *   - Message length (longer = more complex)
 *   - System introspection (questions about SUNy's own behavior/instructions)
 */
export function classifyAutoMode(message: string): 'free' | 'fast' | 'smart' | 'pro' {
  const t = message.toLowerCase();

  // ── Signal detection patterns ──────────────────────────────────────────────

  // Strong coding task verbs — the user wants ACTION on code
  const codingIntentRx = /\b(fix|error|bug|implement|refactor|add|write|function|class|method|variable|api|test|deploy|code|file|build|run|install|import|export|async|await|type|interface|configur|schema|query|pipeline|workflow|component|module|service|middleware|hook|custom|layout|responsive|state|context|reducer|selector|migrate|restructure|integrate|scaffold|generate|delete|rename|edit|change|update|upgrade|downgrade|lint|compile)\b/ig;

  // Creation/build signals — building something NEW (not just asking a question)
  const creationRx = /\b((make|create|build|write|generate|start|scaffold|develop)\s+(a|an|the|me|this|that|my|new|simple|basic|small|fun|quick))|((new|another)\s+(project|app|application|game|website|tool|utility|script|function|module|component|feature|page|form))|game\b/ig;

  // Deep reasoning signals — the user wants analysis, not just action
  const depthRx = /\b(architect|design pattern|tradeoff|compare|analyze|security|performance|scalab|deep dive|explain why|explain how|complex|algorithm|optimize|review|audit|architecture|decision|strategy|approach|pros and cons|trade.?off|migration|comparison|evaluate|assess)\b/ig;

  // System introspection — user asking about SUNy itself
  const introspectionRx = /\b(instructions|system prompt|trained|training|why do you|why don't you|why are you|why aren't you|follow.*instruction|ignore.*instruction|behavior|personality|who are you|what are you)\b/ig;

  // ── Score calculation ───────────────────────────────────────────────────────

  let codingScore = 0;
  let creationScore = 0;
  let depthScore = 0;
  let introspectionScore = 0;

  // Count coding intent matches (cap at 5 to avoid runaway)
  const cMatches = t.match(codingIntentRx);
  if (cMatches) codingScore = Math.min(cMatches.length, 5);

  // Count creation signals — each is worth 2 to ensure these route to smart+
  const crMatches = t.match(creationRx);
  if (crMatches) creationScore = Math.min(crMatches.length, 3) * 2;

  // Count depth signals
  const dMatches = t.match(depthRx);
  if (dMatches) depthScore = Math.min(dMatches.length, 4);

  // Count introspection signals
  const iMatches = t.match(introspectionRx);
  if (iMatches) introspectionScore = Math.min(iMatches.length, 2);

  // Length contributes to implied complexity
  const lengthScore = t.length > 200 ? 3 : t.length > 100 ? 2 : t.length > 50 ? 1 : 0;

  // ── Classification ──────────────────────────────────────────────────────────

  // PRO: Deep reasoning tasks or system introspection
  if (introspectionScore >= 1) return 'pro';
  if (depthScore >= 2 && lengthScore >= 1) return 'pro';
  if (depthScore >= 1 && codingScore >= 2 && lengthScore >= 2) return 'pro';
  if (depthScore >= 3) return 'pro';

  // SMART: Creation/building tasks, moderate coding complexity
  if (creationScore >= 1) return 'smart';        // "make a game", "create an app"
  if (codingScore >= 3) return 'smart';           // multi-intent coding requests
  if (codingScore >= 1 && depthScore >= 1) return 'smart';  // reasoned coding
  if (codingScore >= 1 && lengthScore >= 2) return 'smart';  // long coding request
  if (depthScore >= 1 && lengthScore >= 2) return 'smart';   // long analysis
  if (depthScore >= 2) return 'smart';            // short but significant depth

  // FREE: Genuinely casual — no coding intent, short, no depth
  if (codingScore === 0 && creationScore === 0 && depthScore === 0 && introspectionScore === 0 && t.length < 40) return 'free';

  // FAST: Default for anything with coding intent, or longer messages
  if (codingScore > 0 || lengthScore > 0) return 'fast';

  // Default fallback
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

  // ── DeepSeek cache exploitation ──────────────────────────────────────
  // DeepSeek auto-caches the common prefix across consecutive turns — no
  // explicit cache_control markers needed (unlike Anthropic). The static
  // portions (behavioral rules, project guide, pinned files) are built into
  // systemPrompt first in index.ts. Dynamic parts (repo map, hyp block,
  // tool mandate) are appended below. This keeps the cacheable prefix as
  // large and stable as possible. Cache hit on Flash: $0.003/M input (98%
  // off the $0.14/M miss rate).
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

  // ── Cross-project learning: inject aggregated patterns into system prompt
  if (projectId && isCrossProjectLearningEnabled(userId)) {
    try {
      const crossProjectBlock = buildCrossProjectPrompt(userId);
      if (crossProjectBlock) {
        const ins = fullSystem.lastIndexOf('\n<WorkingDirectory>');
        fullSystem = ins >= 0
          ? fullSystem.slice(0, ins) + '\n' + crossProjectBlock + fullSystem.slice(ins)
          : fullSystem + '\n' + crossProjectBlock;
        console.log(`[agent-loop] Cross-project knowledge injected (${crossProjectBlock.split('\n').length} lines)`);
      }
    } catch (e) {
      console.warn('[agent-loop] Cross-project learning injection failed:', (e as Error).message);
    }
  }

  // Build tools (only if bridge is connected, project is set, and NOT in talk mode)
  // MCP tools from connected servers are merged automatically
  // ── Model references (set inside model loop, used by lazy-getter tools) ──
  let currentModel: LanguageModel | undefined;
  let currentProvider: string = '';

  // ── Web tools (always available — server-side, no bridge needed) ────────
  const webSearch = createWebSearchTool();
  const urlFetch = createUrlFetchTool(userId);
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
          userClientManager.pushToUser(userId, 'suny:tool_start', { tool: name, input });
          userClientManager.pushToUser(userId, 'suny:tool_call', { tool: name, input });
        },
        onToolResult: (name, input, result, error) => {
          userClientManager.pushToUser(userId, 'suny:tool_result', {
            tool: name,
            input,
            success: !error,
            error: error || undefined,
            summary: typeof result === 'string' ? result.slice(0, 200) : undefined,
          });
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
    const reasons: string[] = [];
    if (!bridgeConnected) reasons.push('bridge offline');
    if (!projectPath) reasons.push('no project path');
    if (talkMode) reasons.push('talk mode');
    console.log(`[agent-loop] Full tools unavailable (${reasons.join(', ') || 'unknown'}); web_search + url_fetch only`);
    return alwaysTools;
  })();

  // Always pass tools to streamText — even in text-format modes (diff/whole).
  // Previously this was set to `undefined` for text formats, which meant the AI
  // had zero tool access — couldn't even use web_search or url_fetch. The format
  // instructions in the system prompt guide the AI toward text-based edits, but
  // tools must still be available for reading files, searching, web access, etc.
  const effectiveTools = tools;

  // ── Hypothesis Engine: Branch-isolated parallel strategy testing ─────────
  // For complex tasks with tools available, spawn 2-3 mini-agents with
  // different strategies on isolated git branches (gated by ff_hypothesis_engine).
  // Each strategy runs independently. The winner's branch is merged, losers discarded.
  // Emits suny:hypothesis_winner event for the frontend.
  if (isFeatureEnabled('ff_hypothesis_engine') && bridgeConnected && projectPath && !talkMode && projectId && userMessage.length > 80 && modelEntries.length > 0 && classifyAutoMode(userMessage) !== 'free') {
    try {
      const primaryModel = modelEntries[0].model as LanguageModel;
      // Resolve Pro model for reasoning-heavy hypothesis strategies
      let proModel: LanguageModel | undefined;
      try {
        const proEntries = getModelsForMode('pro');
        if (proEntries.length > 0) proModel = proEntries[0].model as LanguageModel;
      } catch { /* pro model unavailable — fall through, hypothesis uses primaryModel */ }
      const hypResult = await runHypothesisStrategies({
        userId, projectId: projectId!, projectPath, userMessage, fullSystem,
        rawMessages, primaryModel, proModel, signal,
      });
      if (hypResult.hypBlock && hypResult.bestText.length > 100) {
        const ins = fullSystem.lastIndexOf('\n<WorkingDirectory>');
        fullSystem = ins >= 0 ? fullSystem.slice(0, ins) + '\n' + hypResult.hypBlock + fullSystem.slice(ins) : fullSystem + '\n' + hypResult.hypBlock;
        console.log(`[agent-loop] Hypothesis engine injected: ${hypResult.bestStrategy} (score: ${hypResult.bestScore})`);
        userClientManager.pushToUser(userId, 'suny:hypothesis_winner', {
          strategy: hypResult.bestStrategy,
          score: hypResult.bestScore,
          summary: hypResult.bestText.slice(0, 300),
        });
      }
    } catch (e) { console.warn('[agent-loop] Hypothesis engine failed:', (e as Error).message); }
  }

  // ── Tool-calling enforcement ──────────────────────────────────
  // Some models (especially DeepSeek) do not reliably generate tool
  // calls from instructions buried in a long system prompt. This
  // ultra-explicit directive at the very END of the system prompt
  // (immediately before the user message) is where models pay most
  // attention and is hardest to overlook.
  if (!textFormat && !talkMode && bridgeConnected && projectPath) {
    const toolNames = Object.keys(effectiveTools || {});
    if (toolNames.length > 0) {
      fullSystem += `
<tool_mandate>
You MUST use at least one tool before giving your final answer.
Tools available: ${toolNames.join(', ')}.

Do NOT answer from your training data or prior knowledge alone.
READ the files first. SEARCH the web. RUN commands. USE YOUR TOOLS.

Every task that involves looking up information, reading files, checking code,
or verifying assumptions MUST start with a tool call — not a guess.

If your tools are not working, say:
"I'm having trouble accessing my tools — let me try a different approach."
</tool_mandate>`;
    }
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

      // ── DIAGNOSTIC: Log model call details ──────────────────────────────
      const toolCount = effectiveTools ? Object.keys(effectiveTools).length : 0;
      const providerModelId = provider + '/' + ((model as any)?.modelId || 'unknown');
      console.log(`[agent-loop] MODEL CALL: provider=${provider}, modelId=${providerModelId}, tools=${toolCount}, messages=${finalMessages.length}, systemLen=${(useSystemParam ? fullSystem?.length : '(in-msg cache)') ?? 0}`);
      // ── End diagnostic ──────────────────────────────────────────────────

      const result = streamText({
        model: model as LanguageModel,
        system: useSystemParam ? fullSystem : undefined,
        messages: finalMessages,
        tools: effectiveTools,
        maxSteps: MAX_STEPS, // always allow multi-step — tools need result cycles even in text-format modes
        abortSignal: signal,
        onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
          steps++;
          totalInput += usage?.inputTokens ?? 0;
          totalOutput += usage?.outputTokens ?? 0;
          console.log(`[agent-loop] onStepFinish: step=${steps}, inputTokens=${usage?.inputTokens ?? 0}, outputTokens=${usage?.outputTokens ?? 0}`);
          userClientManager.pushToUser(userId, 'suny:step_complete', {
            step: steps,
            toolCallCount: toolCalls?.length ?? 0,
            toolResultCount: toolResults?.length ?? 0,
            textLength: text?.length ?? 0,
          });
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
      let textDeltas = 0;

      // Stream text chunks to frontend — with filtering for model-generated
      // tool-description technical output (e.g. "Writing web request", "Writing request stream...")
      // These are produced by some AI models as verbal chatter before tool calls.
      // Use sentence-boundary flushing at 30 chars for low latency on short responses.
      const SENTENCE_BOUNDARY = /[.!?\n]\s*$/;
      let toolDescBuffer = '';
      let suppressingTechnical = false;
      const TECHNICAL_PATTERNS = [
        /^writing\s+web\s+request/i,
        /^writing\s+request\s+stream/i,
        /^number\s+of\s+bytes\s+written/i,
      ];
      for await (const delta of result.textStream) {
        textDeltas++;
        // Skip pure whitespace-only deltas (model often emits blank tool-call framing)
        if (/^\s*$/.test(delta)) continue;

        toolDescBuffer += delta;

        // When currently suppressing technical output, keep discarding
        // deltas until we hit a clear end of sentence (continuation text like
        // "(Number of bytes written: 17284409)" often arrives as separate
        // deltas that don't match the leading-anchored TECHNICAL_PATTERNS).
        if (suppressingTechnical) {
          // Check if this feels like more technical chatter (continuation text)
          const trimmed = toolDescBuffer.trim();
          const isContinuation = /^[(\-–—]/.test(trimmed) || /bytes\s+written/i.test(trimmed) || /request\s+stream/i.test(trimmed);
          if (isContinuation) {
            // Still inside the technical output — keep suppressing
            toolDescBuffer = '';
            continue;
          }
          // We've moved past technical output — clear the flag and let
          // the text flow normally through the buffer/flush logic below
          suppressingTechnical = false;
        }

        // Check if accumulated buffer matches a known technical tool-description pattern
        const match = TECHNICAL_PATTERNS.find(p => p.test(toolDescBuffer.trim()));
        if (match) {
          suppressingTechnical = true;
          // Suppress this technical output — push friendlier narration
          if (/bytes\s+written/i.test(toolDescBuffer) && userId) {
            const bytesMatch = toolDescBuffer.match(/Number of bytes written:\s*(\d+)/i);
            if (bytesMatch) {
              userClientManager.pushNarration(userId, narrateMessage('', 'url_fetch_progress', { bytes: parseInt(bytesMatch[1], 10) }));
            }
          }
          // Check for "Writing request stream..." to push progress narration
          if (/writing\s+request\s+stream/i.test(toolDescBuffer) && userId) {
            userClientManager.pushNarration(userId, narrateMessage('', 'url_fetch_progress', { bytes: 0 }));
          }
          toolDescBuffer = '';
          continue;
        }

        // Flush on sentence boundaries or at 30-character minimum for low latency
        if (toolDescBuffer.length >= 30 || SENTENCE_BOUNDARY.test(toolDescBuffer)) {
          fullText += toolDescBuffer;
          if (onChunk) onChunk(toolDescBuffer);
          toolDescBuffer = '';
        }
      }
      // Flush any remaining buffer content
      if (toolDescBuffer.length > 0) {
        fullText += toolDescBuffer;
        if (onChunk) onChunk(toolDescBuffer);
      }

      // ── Step exhaustion check ──────────────────────────────────────────────
      const stepsExhausted = steps >= MAX_STEPS;
      if (stepsExhausted) {
        const warning = `\n\n[⚠️ Step limit reached (${MAX_STEPS} steps). The task may be incomplete. Consider splitting it into smaller subtasks or asking me to continue.]\n\n`;
        fullText += warning;
        console.warn(`[agent-loop] STEP EXHAUSTION: hit ${MAX_STEPS} step limit — appended warning to output`);
      }

      // ── DIAGNOSTIC: Log model response summary ──────────────────────────
      console.log(`[agent-loop] MODEL RESPONSE: textDeltas=${textDeltas}, fullText.length=${fullText.length}, steps=${steps}, totalInput=${totalInput}, totalOutput=${totalOutput}, toolCallNames=${Array.from(toolCallNames).join(',') || 'none'}, stepsExhausted=${stepsExhausted}`);
      if (fullText.length > 0) {
        console.log(`[agent-loop] MODEL RESPONSE PREVIEW: ${fullText.slice(0, 500).replace(/\n/g, '\\n')}`);
      } else {
        console.warn(`[agent-loop] MODEL RESPONSE EMPTY — no text produced, no tool calls after ${steps} steps`);
      }
      // ── End diagnostic ──────────────────────────────────────────────────

      // ── Auto-retry on empty/no-tool output ────────────────────────────────
      // If the model produced absolutely nothing (no text, no tool calls) and
      // this is a coding task, re-invoke with a stronger tool mandate rather
      // than silently returning empty output. Retry up to 2 times.
      const isEmptyOutput = fullText.length === 0 && toolCallNames.size === 0;
      const isCodingTask = bridgeConnected && projectPath && !talkMode;
      if (isEmptyOutput && isCodingTask) {
        console.warn('[agent-loop] AUTO-RETRY: empty output with no tools — re-invoking with stronger mandate');
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Model produced empty output — retrying...' });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Model produced empty output — retrying...', 'thinking'),
        });

        let retryAttempt = 0;
        const MAX_RETRY_ATTEMPTS = 2;
        while (retryAttempt < MAX_RETRY_ATTEMPTS && fullText.length === 0 && toolCallNames.size === 0) {
          retryAttempt++;
          const retryMsg: CoreMessage = {
            role: 'user',
            content:
              'I asked you to work on a coding task but you produced no output and made no tool calls.\n\n' +
              'You MUST make at least one tool call (read files, search the web, run commands).\n' +
              'Do NOT just explain what you would do — actually DO it.\n\n' +
              'Original request: ' + userMessage,
          };

          const retryHistory = [...messages, { role: 'assistant', content: '' }, retryMsg];
          const trimRetry = trimHistory(retryHistory, fullSystem, provider);

          try {
            const retryResult = await generateText({
              model: model as LanguageModel,
              system: fullSystem,
              messages: trimRetry,
              tools: effectiveTools,
              maxSteps: 4,
              maxTokens: 2000,
              abortSignal: signal,
            });

            const retryText = retryResult.text?.trim() || '';
            // Check if retry produced meaningful output or tool calls
            // (generateText doesn't give us toolCallNames directly, but text.length is a proxy)
            if (retryText.length > 50 || retryResult.steps > 1) {
              fullText = retryText;
              // Estimate tool calls from steps
              if (retryResult.steps > 1) {
                for (let t = 0; t < retryResult.steps - 1; t++) toolCallNames.add('retry_tool_call');
              }
              console.log(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} succeeded: ${retryText.length} chars, ${retryResult.steps} steps`);
            } else {
              console.warn(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} also produced insufficient output`);
            }
          } catch (retryErr) {
            console.warn(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} failed:`, (retryErr as Error).message);
          }
        }

        if (fullText.length === 0 && toolCallNames.size === 0) {
          // All retries exhausted — produce a fallback message
          fullText = 'I encountered an issue generating a response. Let me try a different approach.\n\n' +
                     'Could you please rephrase your request or let me know what specific task you need help with?';
          console.warn('[agent-loop] AUTO-RETRY exhausted — using fallback message');
        }
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
          onStepFinish: ({ usage: u, text, toolCalls, toolResults }) => {
            steps++;
            totalInput += u?.inputTokens ?? 0;
            totalOutput += u?.outputTokens ?? 0;
            userClientManager.pushToUser(userId, 'suny:step_complete', {
              step: steps,
              toolCallCount: toolCalls?.length ?? 0,
              toolResultCount: toolResults?.length ?? 0,
              textLength: typeof text === 'string' ? text.length : 0,
              phase: 'execution',
            });
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
            onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
              steps++;
              totalInput += usage?.inputTokens ?? 0;
              totalOutput += usage?.outputTokens ?? 0;
              userClientManager.pushToUser(userId, 'suny:step_complete', {
                step: steps,
                toolCallCount: toolCalls?.length ?? 0,
                toolResultCount: toolResults?.length ?? 0,
                textLength: typeof text === 'string' ? text.length : 0,
                phase: 'lint-fixing',
              });
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

      // ── Post-change file verification ─────────────────────────────────────
      // After files have been written and linted, verify that all files in
      // changedFiles actually exist on disk. This catches cases where the AI
      // claimed to write a file but the write was silently skipped or failed.
      if (projectPath && changedFiles.size > 0) {
        const verifiedFiles = new Set<string>();
        let missingCount = 0;
        for (const filePath of changedFiles) {
          const absPath = filePath.startsWith('/') ? filePath : `${projectPath}/${filePath}`;
          try {
            if (fs.existsSync(absPath)) {
              verifiedFiles.add(filePath);
            } else {
              missingCount++;
              console.warn(`[agent-loop] FILE VERIFICATION FAILED: ${filePath} — file does not exist despite being reported as changed`);
            }
          } catch {
            missingCount++;
            console.warn(`[agent-loop] FILE VERIFICATION ERROR: could not stat ${filePath}`);
          }
        }
        if (missingCount > 0) {
          const originalCount = changedFiles.size;
          changedFiles.clear();
          verifiedFiles.forEach(f => changedFiles.add(f));
          console.warn(`[agent-loop] FILE VERIFICATION: removed ${missingCount}/${originalCount} phantom file(s) from changedFiles`);
        }
      }

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
              onStepFinish: ({ usage: u, text, toolCalls, toolResults }) => {
                steps++;
                totalInput += u?.inputTokens ?? 0;
                totalOutput += u?.outputTokens ?? 0;
                userClientManager.pushToUser(userId, 'suny:step_complete', {
                  step: steps,
                  toolCallCount: toolCalls?.length ?? 0,
                  toolResultCount: toolResults?.length ?? 0,
                  textLength: typeof text === 'string' ? text.length : 0,
                  phase: 'test-fixing',
                });
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

      // ── Cross-project learning: share patterns from this task ────────────
      if (projectId && isCrossProjectLearningEnabled(userId)) {
        try {
          // Share lint-fix patterns
          if (lintErrorsFound > 0 && lintPassed) {
            shareErrorPattern({
              userId, projectId: projectId!,
              projectName: projectPath?.split(/[/\\]/).pop() || 'project',
              errorPattern: `lint:${lintErrorsFound} errors fixed across ${Array.from(changedFiles).length} files`,
              errorMessage: `${lintErrorsFound} lint errors found, fixed after ${lintRuns} attempts`,
              attemptedFix: 'Auto-fix applied via lint self-correction loop',
              fixSucceeded: lintPassed,
              recurrenceCount: lintRuns,
            });
          }
          // Share test-fix patterns
          if (testFailuresFound > 0 && testPassed) {
            shareErrorPattern({
              userId, projectId: projectId!,
              projectName: projectPath?.split(/[/\\]/).pop() || 'project',
              errorPattern: `test:${testFailuresFound} failures fixed across ${Array.from(changedFiles).length} files`,
              errorMessage: `${testFailuresFound} test failures found, fixed after ${testRuns} attempts`,
              attemptedFix: 'Auto-fix applied via test self-correction loop',
              fixSucceeded: testPassed,
              recurrenceCount: testRuns,
            });
          }
        } catch (e) {
          console.warn('[agent-loop] Cross-project learning sharing failed:', (e as Error).message);
        }
      }

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
        stepsExhausted,
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
          stepsExhausted,
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const isLast = modelEntries.indexOf(modelEntries.find(m => m.model === model)!) === modelEntries.length - 1;
      if (!isLast) {
        console.warn(`[agent-loop] ${provider} failed, trying fallback: ${lastError.message}`);
        console.warn(`[agent-loop] Fallback stack: ${(lastError as Error).stack?.split('\n').slice(0, 4).join('\n')}`);
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'fallback', label: `Provider ${provider} failed, trying fallback...` });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Provider failed, trying fallback...', 'error'),
        });
      } else {
        console.error(`[agent-loop] ALL PROVIDERS EXHAUSTED — last error: ${lastError.message}`);
      }
    }
  }

  throw lastError;
}
