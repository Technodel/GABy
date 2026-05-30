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

import { streamText, generateText, stepCountIs, tool, type CoreMessage, type LanguageModel } from 'ai';
import { z } from 'zod';
import { getModelsForMode, getVisionCapableModels, isCachingEnabled, getEditFormat, classifyTaskType, reorderModelsForProTask } from './agent';
import { createPowerTools } from './power-tools';
import { createWebSearchTool } from './web-search';
import { createUrlFetchTool } from './url-fetch';
import { createMemoryTools } from './user-memory';
import { createSymbolReaderTool } from './symbol-reader';
import { createSubtaskDelegatorTool } from './subtask-delegator';
import { createSwarmDelegatorTool } from './swarm-delegator';
import { createPromptRegistryTool } from './prompt-registry';
import { createFileDiscoveryTool } from './file-discovery';
import { createSelfHealTool } from './error-corrector';
import { mcpManager } from './mcp-manager';
import { userClientManager } from './user-client-manager';
import { invalidateRepoMap, buildRepoMap } from './repo-map';
import { searchCodeIndex, findImporters } from './code-index';
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
import { getAdapter } from './db';
import { createUserModelTool, formatUserModelForPrompt } from './user-model';
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
import { storeBlueprintEntry } from './blueprint-memory';
import { extractAndStoreEntities } from './entity-store';
import type { AgentMessage } from './agent';

export { AgentMessage };

/**
 * For Anthropic, inject cache_control breakpoints so the static system prompt
 * and the conversation history before the current turn are cached.
 *
 * Strategy:
 *   1. System prompt Ã¢â€ â€™ passed as a `role:'system'` message with cacheControl,
 *      so Anthropic caches it (saves the most tokens — repo map lives here).
 *   2. Last assistant message in history Ã¢â€ â€™ also marked with cacheControl,
 *      so on turn 2+ the full prior conversation is cached too.
 *
 * DeepSeek auto-caches without any markers — no special handling needed.
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

// Per-user LoopDetector instances — each user gets their own to avoid cross-user contamination
const loopDetectors = new Map<number, LoopDetector>();

/** Remove a user's loop detector on WS disconnect to prevent memory leaks. */
export function clearLoopDetector(userId: number): void {
  loopDetectors.delete(userId);
}

function getLoopDetector(userId: number): LoopDetector {
  let detector = loopDetectors.get(userId);
  if (!detector) {
    detector = new LoopDetector();
    loopDetectors.set(userId, detector);
  }
  return detector;
}

const MAX_STEPS = 24; // legacy fallback / used by tests
const MAX_LINT_RETRIES = 3;  // max extra AI passes to fix lint errors
const MAX_TEST_RETRIES = 5;  // max extra AI passes to fix test failures ("consider it done")

/**
 * Suggest a higher tier when the current model appears too weak to complete
 * the task (step exhaustion, repeated empty output, etc.). Returns null if
 * the user is already on the top tier.
 */
function suggestUpgrade(currentMode: string): { next: string; label: string } | null {
  switch (currentMode) {
    case 'free': return { next: 'fast', label: 'Fast' };
    case 'fast': return { next: 'smart', label: 'Smart' };
    case 'smart': return { next: 'pro', label: 'Pro' };
    case 'auto': return { next: 'pro', label: 'Pro' };
    default: return null; // 'pro' or unknown — no upgrade
  }
}

function buildUpgradeHint(currentMode: string, reason: string): string {
  const sug = suggestUpgrade(currentMode);
  if (!sug) return '';
  return (
    `\n\nÃ°Å¸â€™Â¡ **${reason}** This task may be too complex for **${currentMode}** mode. ` +
    `Switch to **${sug.label}** mode in the mode selector for a stronger model that can handle multi-step reasoning, longer plans, and tougher edits.`
  );
}

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
  autoExecuteOverride?: boolean | null;
  signal?: AbortSignal;
  onChunk?: (chunk: string) => void;
  /** Budget gate — called at 80% (warn) and 90% (gate) of budgetCapCredits */
  budgetCapCredits?: number;
  onBudgetWarning?: (spent: number, cap: number, pct: number) => void;
  onBudgetGate?: (spent: number, cap: number) => Promise<'continue' | 'budget_mode' | 'extend' | 'stop'>;
  onBudgetExtend?: () => Promise<number>;
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
  apiKeyId?: number;
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
/**
 * Return the maximum number of tool-use steps allowed for a given mode.
 * Task complexity (derived from classifyAutoMode) further adjusts the limit
 * so that simple fast requests don't over-iterate while pro tasks get headroom.
 */
export function getStepLimit(resolvedMode: string, userMessage: string): number {
  if (resolvedMode === 'free') return 4;
  const complexity = classifyAutoMode(userMessage);
  if (resolvedMode === 'fast') return complexity === 'smart' || complexity === 'pro' ? 14 : 10;
  if (resolvedMode === 'smart') return 18;
  if (resolvedMode === 'pro') return 24;
  return 12; // auto / unknown
}

export function classifyAutoMode(
  message: string,
  hasImage?: boolean,
  history?: Array<{ role: string; content: string | unknown }>,
): 'free' | 'fast' | 'smart' | 'pro' {
  if (hasImage) {
    const base = classifyAutoMode(message, false, history);
    return base === 'free' ? 'fast' : base;
  }
  const t = message.toLowerCase();

  // Pro signals: system introspection
  if (/\b(what are your instructions|your system prompt|your rules|how are you configured|what model are you|reveal your prompt)\b/.test(t)) return 'pro';

  // Pro signals: long + deep reasoning requests
  if (
    t.length > 150 &&
    /\b(architect|design pattern|tradeoff|compare|analyze|security|performance|scalab|deep dive|explain why|complex|algorithm|optimize|review|audit)\b/.test(t)
  ) return 'pro';

  // Smart signals: creation/build intent (regardless of length)
  if (/\b(make a|create a|build a|create an|make an|build an|write a|generate a|scaffold a|design a|add a new|implement a new|new function|new endpoint|new route|new component|new module|new feature)\b/.test(t)) return 'smart';

  // Smart signals: depth/analysis/architecture keywords (length-independent)
  if (/\b(analyze|architect|optimize|migrate|restructure|integrate|configur|deploy|schema|query|pipeline|workflow|module|service|middleware|hook|layout|responsive|accessibility|state|reducer|selector|thunk|saga|observable|subscription|security|performance)\b/.test(t)) return 'smart';

  // Smart signals: domain keywords when message has enough context (>40 chars)
  if (t.length > 40 && /\b(component|refactor)\b/.test(t) && /\b(error|handle|proper|complex|multi|with|and|including)\b/.test(t)) return 'smart';

  // History-escalation signal: if the last assistant turn contained errors/failures,
  // escalate one level above what the message text alone would suggest.
  if (history && history.length > 0) {
    const lastAssistant = [...history].reverse().find(h => h.role === 'assistant');
    const lastContent = typeof lastAssistant?.content === 'string' ? lastAssistant.content : '';
    if (lastContent && /error|failed|issue|problem|doesn't work|couldn't|couldn't complete/i.test(lastContent)) {
      // Base without history to avoid recursion, then escalate one tier
      const base = classifyAutoMode(message);
      const tier: Record<string, 'fast' | 'smart' | 'pro'> = { free: 'fast', fast: 'smart', smart: 'pro', pro: 'pro' };
      return tier[base] ?? 'smart';
    }
  }

  // Free signals: very short casual messages with no coding keywords
  if (
    t.length < 80 &&
    !/\b(fix|error|bug|implement|create|refactor|add|write|function|class|api|test|deploy|code|file|build|run|install|import|export|async|await|type|interface)\b/.test(t)
  ) return 'free';

  // Default: fast — handles most coding tasks well
  return 'fast';
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Function-tag fallback parser Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
// Some models (especially via OpenRouter) emit tool calls as raw XML:
//   <function.name=glob>{"pattern":"README.md","cwd":"D:\\Projects\\SEO"}</function>
// The Vercel AI SDK v5 doesn't parse these, so we intercept them post-hoc.

const FUNCTION_TAG_REGEX = /<function\.name=(\w+)>([\s\S]*?)<\/function\s*>/gi;

function hasFunctionTagCalls(content: string): boolean {
  return /<function\.name=\w+>/i.test(content);
}

function parseAndStripFunctionTags(content: string): {
  cleanContent: string;
  calls: Array<{ name: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  let match: RegExpExecArray | null;
  FUNCTION_TAG_REGEX.lastIndex = 0;

  while ((match = FUNCTION_TAG_REGEX.exec(content)) !== null) {
    const toolName = match[1];
    const bodyStr = (match[2] || '').trim();
    let params: Record<string, unknown> = {};
    if (bodyStr) {
      try { params = JSON.parse(bodyStr); } catch { params = { _raw: bodyStr }; }
    }
    if (toolName) calls.push({ name: toolName, params });
  }

  const cleanContent = content
    .replace(FUNCTION_TAG_REGEX, '')
    .replace(/<function\.name=\w+>/gi, '')
    .trim();

  return { cleanContent, calls };
}

export async function runAgentLoop(req: AgentLoopRequest): Promise<AgentLoopResult> {
  const { userId, mode, systemPrompt, projectId, projectPath, history, userMessage, imageData, sessionId, talkMode, signal, onChunk } = req;
  const startedAt = Date.now();

  // Resolve AUTO Ã¢â€ â€™ real mode via keyword classification
  let resolvedMode = mode === 'auto' ? classifyAutoMode(userMessage, !!imageData, history) : mode;

  // ── Hybrid Routing for OPUS 4.7 ──
  // If the user selected 'opus' but the task is basic (free/fast), route it to 'fast' to save cost.
  if (resolvedMode === 'opus') {
    const taskComplexity = classifyAutoMode(userMessage, !!imageData, history);
    if (taskComplexity === 'free' || taskComplexity === 'fast') {
      console.log(`[agent-loop] Hybrid routing (OPUS): task complexity is ${taskComplexity}, downgrading to 'fast' mode.`);
      resolvedMode = 'fast';
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Anti-hallucination guard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Free-mode models are too weak to reliably drive the bridge tool calls.
  // When a project is selected, the user almost always expects the agent to
  // actually read files. If Auto routed a short message to 'free' but a
  // project context is active, bump to 'fast' so a tool-capable model runs.
  // This prevents the "I see the issue — earlier scans worked but now the
  // tools lost access" hallucination class on questions like
  // "what does this app do" inside a real project.
  if (mode === 'auto' && resolvedMode === 'free' && projectPath && !talkMode) {
    console.log(`[agent-loop] Auto-bump: free Ã¢â€ â€™ fast (project context active, projectPath=${projectPath})`);
    resolvedMode = 'fast';
  }

  // When imageData is present, prefer vision-capable models across all modes
  const isVisionRequest = !!imageData;
  let modelEntries = isVisionRequest
    ? await (async () => {
        const vision = await getVisionCapableModels();
        if (vision.length > 0) {
          console.log(`[agent-loop] Using vision-capable models: ${vision.map(v => v.provider).join(', ')}`);
          return vision;
        }
        console.warn('[agent-loop] imageData present but no vision-capable model found');
        // Return empty list to trigger the no-vision-model error below
        return [];
      })()
    : await getModelsForMode(resolvedMode);

  // Ã¢â€â‚¬Ã¢â€â‚¬ Pro mode: task-based model routing Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // DeepSeek excels at coding/implementation; Anthropic at analysis/review.
  // Reorder the fallback chain so the best model for the task gets first shot.
  if (resolvedMode === 'pro' && modelEntries.length >= 2) {
    const taskType = classifyTaskType(userMessage);
    const prevOrder = modelEntries.map(e => e.provider).join(' Ã¢â€ â€™ ');
    modelEntries = reorderModelsForProTask(modelEntries, taskType);
    const newOrder = modelEntries.map(e => e.provider).join(' Ã¢â€ â€™ ');
    if (prevOrder !== newOrder) {
      console.log(`[agent-loop] Pro task-routing: "${taskType}" Ã¢â€ â€™ ${newOrder}`);
    }
  }

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
  let userContent: CoreMessage['content'] = userMessage;
  if (imageData) {
    // Determine mime type from data URL and extract pure base64
    const match = imageData.match(/^data:(image\/\w+);base64,/);
    const mime = match?.[1] || 'image/png';
    const b64 = imageData.replace(/^data:image\/\w+;base64,/, '');

    userContent = [
      { type: 'text', text: userMessage },
      { type: 'image', image: b64, mimeType: mime },
    ];
  }
  const rawMessages: CoreMessage[] = [
    ...history.map(h => ({ role: h.role as 'user' | 'assistant', content: h.content })),
    { role: 'user' as const, content: userContent },
  ];

  // Determine edit format (needs true, must come before fullSystem)
    const editFormat = (projectPath && !talkMode) ? await getEditFormat() : 'tool-call';

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

  // Ã¢â€â‚¬Ã¢â€â‚¬ DeepSeek cache exploitation Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // DeepSeek auto-caches the common prefix across consecutive turns — no
  // explicit cache_control markers needed (unlike Anthropic). The static
  // portions (behavioral rules, project guide, pinned files) are built into
  // systemPrompt first in index.ts. Dynamic parts (repo map, hyp block,
  // tool mandate) are appended below. This keeps the cacheable prefix as
  // large and stable as possible. Cache hit on Flash: $0.003/M input (98%
  // off the $0.14/M miss rate).
  let fullSystem = architectPlanSystem ?? (projectPath
    ? `${systemPrompt}${formatSystemAddition}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`
    : systemPrompt + formatSystemAddition);

  // --- Antigravity Planning Mode ---
  if (!req.talkMode && (resolvedMode === 'smart' || resolvedMode === 'pro') && req.autoExecuteOverride !== true) {
    fullSystem += `\n\n<planning_mode>
CRITICAL INSTRUCTION: You are in Planning Mode because this is a complex task.
Before you make ANY code changes using file_write or file_edit, you MUST:
1. Research the codebase using grep_search, list_dir, and file_read.
2. Present your detailed implementation plan as a normal chat message (using markdown) so the user can easily read it.
3. THEN, immediately use the request_checkpoint tool with a short 1-sentence summary in the details field to formally ask for approval.
4. Wait for the user to approve the checkpoint. If approved, you may proceed with the edits.
</planning_mode>`;
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Runtime skill classification: inject relevant skill instructions Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
        ...activeSkills.map(s => `  Ã¢â‚¬Â¢ ${s.name}: ${s.description}`),
        '</active_skills>',
      ].join('\n');
      // Inject into fullSystem — append before the WorkingDirectory block or at the end
      const insertionPoint = fullSystem.lastIndexOf('\n<WorkingDirectory>');
      if (insertionPoint >= 0) {
        // Insert skill block right before the working directory tag
        fullSystem = fullSystem.slice(0, insertionPoint) + '\n' + skillBlock + fullSystem.slice(insertionPoint);
      } else {
        fullSystem = fullSystem + '\n' + skillBlock;
      }
      console.log(`[agent-loop] Skill classification: ${classification.phase} Ã¢â€ â€™ ${classification.skillName} (${(classification.confidence * 100).toFixed(0)}%)`);
    }
  }

  // Ã¢â€â‚¬Ã¢â€â‚¬ Cross-project learning: inject aggregated patterns into system prompt
  if (projectId && await isCrossProjectLearningEnabled(userId)) {
    try {
      const crossProjectBlock = await buildCrossProjectPrompt(userId);
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

  // ── Structured user model: inject what we know about this user
  try {
    const userModelBlock = formatUserModelForPrompt(userId);
    if (userModelBlock) {
      const ins = fullSystem.lastIndexOf('\n<WorkingDirectory>');
      fullSystem = ins >= 0
        ? fullSystem.slice(0, ins) + '\n' + userModelBlock + fullSystem.slice(ins)
        : fullSystem + '\n' + userModelBlock;
    }
  } catch (e) {
    console.warn('[agent-loop] User model injection failed:', (e as Error).message);
  }

  // Build tools (only if bridge is connected, project is set, and NOT in talk mode)
  // MCP tools from connected servers are merged automatically
  // Ã¢â€â‚¬Ã¢â€â‚¬ Model references (set inside model loop, used by lazy-getter tools) Ã¢â€â‚¬Ã¢â€â‚¬
  let currentModel: LanguageModel | undefined;
  let currentProvider: string = '';

  // Ã¢â€â‚¬Ã¢â€â‚¬ Web tools (always available — server-side, no bridge needed) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  const webSearch = createWebSearchTool();
  const urlFetch = createUrlFetchTool(userId);
  const alwaysTools: Record<string, any> = { web_search: webSearch, url_fetch: urlFetch };

  const mcpToolsAvailable = mcpManager.availableToolCount > 0;
  const tools = await (async () => {
    if (projectPath && !talkMode) {
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
      // Ã¢â€â‚¬Ã¢â€â‚¬ Additional SUNy tools (memory, symbol, prompt, discovery, delegation, healing) Ã¢â€â‚¬Ã¢â€â‚¬
      const memoryTools = await createMemoryTools({ userId, projectPath });
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
      const swarmDelegatorTool = createSwarmDelegatorTool({
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Codebase navigation tools Ã¢â€â‚¬Ã¢â€â‚¬
      const codeSearchTool = tool({
        description: 'Search the entire codebase for functions, classes, components, exports by name or keyword. Returns file paths and line numbers so you can go directly to the right file without scanning blindly. Use this BEFORE reading files to locate exactly where symbols live.',
        inputSchema: z.object({
          query: z.string().describe('Symbol name, concept, or keyword to search for (e.g. "Header component", "auth middleware", "login form")'),
          type: z.string().optional().describe('Filter by symbol type: function, class, interface, type, variable, enum, component'),
          limit: z.number().optional().default(10).describe('Max results to return'),
        }),
        execute: async (input: { query: string; type?: string; limit?: number }) => {
          const results = searchCodeIndex(input.query, { type: input.type, limit: input.limit ?? 10 });
          if (results.length === 0) return `No symbols found matching "${input.query}". Try a different keyword or use grep to search for the term in file contents.`;
          return results.map(r =>
            `${r.filePath}:${r.symbol?.lineStart} — ${r.symbol?.symbolName} (${r.symbol?.symbolType}, ${r.symbol?.exportType} export)`
          ).join('\n');
        },
      });

      const whoImportsTool = tool({
        description: 'Find all files that import a specific symbol or module. Use this to understand the blast radius of a change before editing.',
        inputSchema: z.object({
          symbol: z.string().describe('The symbol or module name to find importers of (e.g. "Header", "./auth", "express")'),
        }),
        execute: async (input: { symbol: string }) => {
          const results = findImporters(input.symbol);
          if (results.length === 0) return `No files found importing "${input.symbol}".`;
          return results.map(r =>
            `${r.filePath} Ã¢â€ Â imports ${r.importedSymbols.join(', ')} from ${r.source}`
          ).join('\n');
        },
      });

      const repoMapTool = tool({
        description: 'Get a compact map of the project showing which symbols and components live in which files. Call this once at the start of a task to orient yourself — then target specific files instead of scanning the whole project.',
        inputSchema: z.object({
          query: z.string().optional().describe('Optional keyword to filter the map to relevant files (e.g. "header", "auth", "api")'),
        }),
        execute: async (input: { query?: string }) => {
          const repoMap = await buildRepoMap(userId, projectPath!, input.query || userMessage, 2500);
          return repoMap || 'Repo map unavailable — bridge may be offline. Use code_search and find_files instead.';
        },
      });

      const checkpointTool = tool({
        description: 'Pause execution and ask the user to confirm before proceeding. Use this BEFORE making irreversible or risky changes (e.g. deleting files, dropping database tables, replacing large sections of code, merging branches). Describe what you are about to do and why. If the user approves, proceed. If they abort, stop and report what was skipped.',
        inputSchema: z.object({
          label: z.string().describe('Short headline: what are you about to do? (e.g. "Delete 3 files and rewrite auth module")'),
          details: z.string().describe('One paragraph explaining: what will change, what will be irreversible, and what the safe alternative is if they say no.'),
        }),
        execute: async (input: { label: string; details: string }) => {
          const approved = await userClientManager.waitForCheckpoint(userId, input.label, input.details);
          return approved
            ? 'APPROVED — proceed with the planned changes.'
            : 'ABORTED — the user chose not to proceed. Stop this task and report what was skipped.';
        },
      });

      const worktreeTool = tool({
        description: 'Create an isolated git worktree for the current task so changes are safe to make without touching the main branch. Use this before making large-scale or risky edits. After the task is done, merge it back with merge_worktree.',
        inputSchema: z.object({
          branch_name: z.string().describe('Name for the new branch/worktree (e.g. "suny/fix-auth-flow")'),
        }),
        execute: async (input: { branch_name: string }) => {
          
          const out = typeof result === 'object' && result !== null && 'stdout' in result ? String((result as {stdout: string}).stdout) : String(result);
          if (out.includes('already exists') || out.includes('Preparing worktree')) {
            return `Worktree created at ${worktreePath} on branch ${input.branch_name}. All changes will be isolated here.`;
          }
          return out || `Worktree created at ${worktreePath}.`;
        },
      });

      const mergeWorktreeTool = tool({
        description: 'Merge a completed worktree branch back into the main branch and clean up. Call this after all changes in the worktree are verified and ready.',
        inputSchema: z.object({
          branch_name: z.string().describe('The branch name that was created by create_worktree'),
          delete_after_merge: z.boolean().default(true).describe('Whether to delete the worktree and branch after merging'),
        }),
        execute: async (input: { branch_name: string; delete_after_merge: boolean }) => {
          
          out += typeof merge === 'object' && merge !== null && 'stdout' in merge ? String((merge as {stdout:string}).stdout) : String(merge);
          if (input.delete_after_merge) {
            const cleanup = await sendToBridge(userId, { type: 'shell', command: `git worktree remove "${worktreePath}" --force 2>&1 && git branch -d "${input.branch_name}" 2>&1`, cwd: projectPath });
            out += '\n' + (typeof cleanup === 'object' && cleanup !== null && 'stdout' in cleanup ? String((cleanup as {stdout:string}).stdout) : String(cleanup));
          }
          return out.trim() || 'Worktree merged and cleaned up successfully.';
        },
      });

      const extraTools = {
        ...memoryTools,     // save_memory, recall_memories, delete_memory
        read_symbols: symbolReaderTool,
        get_prompt_template: promptRegistryTool,
        find_files: fileDiscoveryTool,
        delegate_subtask: subtaskDelegatorTool,
        delegate_swarm: swarmDelegatorTool,
        self_heal: selfHealTool,
        code_search: codeSearchTool,
        who_imports: whoImportsTool,
        get_repo_map: repoMapTool,
        request_checkpoint: checkpointTool,
        create_worktree: worktreeTool,
        merge_worktree: mergeWorktreeTool,
        update_user_model: createUserModelTool(userId),
      };

      const activeSkillNames = getActiveSkills(userMessage).map(s => s.name.toLowerCase());
      const msgLower = userMessage.toLowerCase();

      // Core Tools (Always injected when bridge is connected)
      let merged: Record<string, any> = { 
        ...alwaysTools,
        file_read: powerTools.file_read,
        file_edit: powerTools.file_edit,
        file_write: powerTools.file_write,
        list_dir: powerTools.list_dir,
        grep_search: powerTools.grep_search,
        path_exists: powerTools.path_exists,
        request_checkpoint: extraTools.request_checkpoint,
        read_symbols: extraTools.read_symbols,
        find_files: extraTools.find_files,
        code_search: extraTools.code_search,
        save_memory: extraTools.save_memory,
        recall_memories: extraTools.recall_memories,
      };

      // Dynamic Category: Server & Processes
      if (activeSkillNames.includes('backend') || activeSkillNames.includes('debugging') || msgLower.includes('server') || msgLower.includes('start') || msgLower.includes('run')) {
        if (powerTools.start_server) merged.start_server = powerTools.start_server;
        if (powerTools.stop_server) merged.stop_server = powerTools.stop_server;
        if (powerTools.read_server_logs) merged.read_server_logs = powerTools.read_server_logs;
        if (powerTools.list_servers) merged.list_servers = powerTools.list_servers;
        if (powerTools.run_background_command) merged.run_background_command = powerTools.run_background_command;
      }

      // Dynamic Category: Git & Worktrees
      if (activeSkillNames.includes('version_control') || activeSkillNames.includes('refactor') || msgLower.includes('git') || msgLower.includes('branch') || msgLower.includes('worktree')) {
        if (extraTools.create_worktree) merged.create_worktree = extraTools.create_worktree;
        if (extraTools.merge_worktree) merged.merge_worktree = extraTools.merge_worktree;
      }

      // Dynamic Category: Delegation & Agents
      if (activeSkillNames.includes('architecture') || activeSkillNames.includes('testing') || msgLower.includes('subagent') || msgLower.includes('delegate')) {
        if (powerTools.invoke_subagent) merged.invoke_subagent = powerTools.invoke_subagent;
        if (extraTools.delegate_subtask) merged.delegate_subtask = extraTools.delegate_subtask;
        if (extraTools.delegate_swarm) merged.delegate_swarm = extraTools.delegate_swarm;
      }

      // Dynamic Category: Bash Fallback
      if (activeSkillNames.includes('devops') || activeSkillNames.includes('debugging') || msgLower.includes('bash') || msgLower.includes('terminal')) {
        if (powerTools.bash) merged.bash = powerTools.bash;
      }

      if (mcpToolsAvailable) {
        const mcpTools = mcpManager.getTools();
        merged = { ...merged, ...mcpTools };
        if (Object.keys(mcpTools).length > 0) {
          console.log(`[agent-loop] Merged ${Object.keys(mcpTools).length} MCP tool(s) into toolset`);
        }
      }
      
      console.log(`[agent-loop] JIT Context Engine: Masked tools from ${Object.keys({...alwaysTools, ...powerTools, ...extraTools}).length} down to ${Object.keys(merged).length} active tools.`);
      return merged;
    }
    // Bridge offline, no project, or talk mode — still provide web tools
    const reasons: string[] = [];
    if (false) reasons.push('bridge offline');
    if (!projectPath) reasons.push('no project path');
    if (talkMode) reasons.push('talk mode');
    console.log(`[agent-loop] Full tools unavailable (${reasons.join(', ') || 'unknown'}); web_search + url_fetch only`);
    return alwaysTools;
  })();

  // Always pass tools to streamText — even in text-format modes (diff/whole).
  // Previously this was set to `undefined` for text formats, which meant the AI
  // had zero tool access — couldn't even use web_search or url_fetch. The format
  // instructions in the system prompt guide the AI toward text-based edits, but
  // tools must still be available for reading files, searching, web access, etc.
  const effectiveTools = tools;

  // Ã¢â€â‚¬Ã¢â€â‚¬ Hypothesis Engine: Branch-isolated parallel strategy testing Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // For complex tasks with tools available, spawn 2-3 mini-agents with
  // different strategies on isolated git branches (gated by ff_hypothesis_engine).
  // Each strategy runs independently. The winner's branch is merged, losers discarded.
  // Emits suny:hypothesis_winner event for the frontend.
  if (isFeatureEnabled('ff_hypothesis_engine') && projectPath && !talkMode && projectId && userMessage.length > 80 && modelEntries.length > 0 && classifyAutoMode(userMessage) !== 'free') {
    try {
      const primaryModel = modelEntries[0].model as LanguageModel;
      // Resolve Pro model for reasoning-heavy hypothesis strategies
      let proModel: LanguageModel | undefined;
      try {
        const proEntries = await getModelsForMode('pro');
        if (proEntries.length > 0) proModel = proEntries[0].model as LanguageModel;
      } catch { /* pro model unavailable — fall through, hypothesis uses primaryModel */ }
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

  // Ã¢â€â‚¬Ã¢â€â‚¬ Tool-calling enforcement Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
  // Some models (especially DeepSeek) do not reliably generate tool
  // calls from instructions buried in a long system prompt. This
  // ultra-explicit directive at the very END of the system prompt
  // (immediately before the user message) is where models pay most
  // attention and is hardest to overlook.
  if (!textFormat && !talkMode && projectPath) {
    const toolNames = Object.keys(effectiveTools || {});
    if (toolNames.length > 0) {
      fullSystem += `
<tool_mandate>
You MUST use at least one tool before giving your final answer.
Tools available: ${toolNames.join(', ')}.

Do NOT answer from your training data or prior knowledge alone.
READ the files first. SEARCH the web. RUN commands. USE YOUR TOOLS.

Every task that involves looking up information, reading files, checking code,
or verifying assumptions MUST start with a tool call — not a guess.

IMPORTANT: After you make a tool call and receive the result, you MUST
always produce a text response summarizing what you found or did.
Never send tool calls alone — always include a text reply for the user.

If your tools are not working, say:
"I'm having trouble accessing my tools — let me try a different approach."
</tool_mandate>`;
    }
  }

  // Notify client that streaming is starting
  // Emit stage event for pipeline phase tracking
  userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Planning & executing...' });
  userClientManager.pushToUser(userId, 'suny:stream_start', {});

  // Create a git checkpoint BEFORE any file changes so the user can roll back
  if (projectPath && !talkMode) {
    createCheckpoint(userId, projectPath, userMessage).catch(() => {});
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheWrite = 0;
  let totalCacheRead = 0;
  let steps = 0;

  // ── Budget gate state ────────────────────────────────────────────────────
  const { budgetCapCredits, onBudgetWarning, onBudgetGate, onBudgetExtend } = req;
  let estimatedSpend = 0;         // running credit estimate based on token totals
  let budgetCap = budgetCapCredits ?? null;
  let budget80Fired = false;
  let budget90Fired = false;
  let budgetMode = false;         // when true, inject lean-finish instruction
  // Fetch pricing rates once for cost estimation
  let inputRate = 0;
  let outputRate = 0;
  if (budgetCap) {
    try {
      const { getDb } = await import('./db');
      const dbInst = getDb();
      const pm = dbInst.prepare('SELECT input_token_base_cost, output_token_base_cost FROM pricing_modes WHERE mode = ?').get(resolvedMode) as { input_token_base_cost: number; output_token_base_cost: number } | undefined;
      if (pm) { inputRate = pm.input_token_base_cost; outputRate = pm.output_token_base_cost; }
    } catch { /* best-effort */ }
  }

  // If image data is present but no vision-capable models were found, throw
  if (isVisionRequest && modelEntries.length === 0) {
    throw new Error('NO_VISION_MODEL_AVAILABLE');
  }

  // Try each model in priority order (fallback on error)
  for (const { model, provider, apiKeyId } of modelEntries) {
    // Update model references for lazy-getter tools (subtask delegator, self-heal)
    currentModel = model as LanguageModel;
    currentProvider = provider;

    try {
      // Auto-summarize long sessions before trimming (preserves goal/decision context)
      let rawMessagesForProvider = rawMessages;
      if (rawMessages.length > 12) {
        try {
          const { autoSummarizeIfNeeded } = await import('./context-summarizer');
          const { getContextLimit: ctxLimit } = await import('./context-manager');
          const sumResult = await autoSummarizeIfNeeded(
            { model: model as LanguageModel, provider, signal },
            { rawMessages: rawMessages as Array<{ role: string; content: string }>, systemPrompt: fullSystem ?? '', contextLimit: ctxLimit(provider) },
          );
          if (sumResult.summarized) {
            rawMessagesForProvider = sumResult.messages as typeof rawMessages;
            console.log(`[agent-loop] Auto-summarized ${rawMessages.length} messages → ${rawMessagesForProvider.length}`);
          }
        } catch { /* best-effort — fall through to plain trim */ }
      }

      // Trim history to fit this provider's context window
      const messages = trimHistory(rawMessagesForProvider, fullSystem, provider);
      if (messages.length < rawMessagesForProvider.length) {
        console.log(`[agent-loop] trimmed history ${rawMessages.length} Ã¢â€ â€™ ${messages.length} msgs for ${provider}`);
      }

      // Inject Anthropic cache breakpoints when caching is enabled
      const cachingEnabled = await isCachingEnabled();
      const useAnthropicCache = cachingEnabled && provider === 'Anthropic';
      const { messages: finalMessages, useSystemParam } = useAnthropicCache
        ? buildAnthropicCachedMessages(messages, fullSystem)
        : { messages, useSystemParam: true as const };

      // Ã¢â€â‚¬Ã¢â€â‚¬ DIAGNOSTIC: Log model call details Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      const toolCount = effectiveTools ? Object.keys(effectiveTools).length : 0;
      const providerModelId = provider + '/' + ((model as any)?.modelId || 'unknown');
      console.log(`[agent-loop] MODEL CALL: provider=${provider}, modelId=${providerModelId}, tools=${toolCount}, messages=${finalMessages.length}, systemLen=${(useSystemParam ? fullSystem?.length : '(in-msg cache)') ?? 0}`);
      // Ã¢â€â‚¬Ã¢â€â‚¬ End diagnostic Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

      // Ã¢â€â‚¬Ã¢â€â‚¬ Force-first-tool-call guard Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      // Some models (notably DeepSeek-chat under a large system prompt) emit
      // a few tokens of narration ("Let me check the README...") and stop
      // without ever calling a tool. When the user is clearly asking SUNy to
      // look at the project, force step 0 to make a tool call. Subsequent
      // steps return to 'auto' so the model can synthesize the final answer.
      const projectTurn = !!projectPath && !talkMode && toolCount > 0;
      // DeepSeek under our 60KB+ system prompt has been observed narrating
      // "Let me check..." / "Got it running!" without ever calling a tool.
      // In a project context the right answer is almost always grounded in a
      // tool call, so force step 0 to make one — UNLESS the message is pure
      // chitchat (greetings, short acks, thanks). After step 0 we return to
      // 'auto' so the model can synthesize the final answer.
      const trimmedMsg = userMessage.trim();
      const isPureChitchat = /^(hi|hello|hey|yo|sup|thanks?|thx|ty|ok|okay|cool|nice|great|good|fine|yes|no|nope|yep|yeah|bye|cya|lol|haha)[\s!.?]*$/i.test(trimmedMsg)
        || (trimmedMsg.length <= 3);
      const forceToolStep0 = projectTurn && !isPureChitchat;

      const result = streamText({
        model: model as LanguageModel,
        system: useSystemParam ? fullSystem : undefined,
        messages: finalMessages,
        tools: effectiveTools,
        // AI SDK v5 defaults stopWhen to stepCountIs(1), which kills agentic
        // multi-step flows (e.g. read Ã¢â€ â€™ edit, or write A Ã¢â€ â€™ write B). When the
        // model has tools available we need to let it iterate, otherwise it
        // stops after the first tool call without ever producing the final
        // text answer or follow-up tool calls.
        stopWhen: toolCount > 0 ? stepCountIs(getStepLimit(resolvedMode, userMessage)) : undefined,
        abortSignal: signal,
        onStepFinish: ({ usage, text, toolCalls, toolResults }) => {
          steps++;
          totalInput += usage?.inputTokens ?? 0;
          totalOutput += usage?.outputTokens ?? 0;
          // Update running cost estimate
          if (budgetCap && (inputRate > 0 || outputRate > 0)) {
            estimatedSpend = totalInput * inputRate + totalOutput * outputRate;
          }
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
        prepareStep: async ({ stepNumber }) => {
          // Budget gate checks between steps
          if (budgetCap && budgetCap > 0 && estimatedSpend > 0) {
            const pct = estimatedSpend / budgetCap;
            // 80% warning (fire once, non-blocking)
            if (pct >= 0.8 && !budget80Fired) {
              budget80Fired = true;
              if (onBudgetWarning) onBudgetWarning(estimatedSpend, budgetCap, pct);
            }
            // 90% gate (fire once, blocking — wait for user decision)
            if (pct >= 0.9 && !budget90Fired && onBudgetGate) {
              budget90Fired = true;
              const decision = await onBudgetGate(estimatedSpend, budgetCap);
              if (decision === 'stop') {
                // Abort the loop
                if (signal && !signal.aborted) {
                  (signal as any)._budgetStop = true;
                }
                throw new Error('BUDGET_STOP');
              } else if (decision === 'extend' && onBudgetExtend) {
                const newCap = await onBudgetExtend();
                if (newCap > budgetCap) {
                  budgetCap = newCap;
                  budget80Fired = false;
                  budget90Fired = false;
                }
              } else if (decision === 'budget_mode') {
                budgetMode = true;
              }
              // 'continue' falls through
            }
          }
          // Budget Mode: inject lean-finish system injection for remaining steps
          if (budgetMode) {
            const leanInstruction = '[BUDGET MODE: You are running on minimal remaining budget. Do NOT do any further reading, exploring, or verification steps. Wrap up what you have already done into the best possible final answer right now. Skip all optional steps. Deliver results immediately.]';
            return {
              system: (useSystemParam ? (fullSystem ?? '') : '') + '\n\n' + leanInstruction,
            };
          }
          // Force first tool call logic (preserve existing)
          if (stepNumber === 0 && forceToolStep0) return { toolChoice: 'required' as const };
          return undefined;
        },
        experimental_telemetry: { isEnabled: false },
      });

      let fullText = '';
      let textDeltas = 0;

      // Stream text chunks to frontend — with filtering for model-generated
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
        // Removed pure whitespace skip because it collapsed words and lists natively emitted as whitespace-only chunks.

        toolDescBuffer += delta;

        // When currently suppressing technical output, keep discarding
        // deltas until we hit a clear end of sentence (continuation text like
        // "(Number of bytes written: 17284409)" often arrives as separate
        // deltas that don't match the leading-anchored TECHNICAL_PATTERNS).
        if (suppressingTechnical) {
          // Check if this feels like more technical chatter (continuation text)
          const trimmed = toolDescBuffer.trim();
          const isContinuation = /^[(\-—œ—]/.test(trimmed) || /bytes\s+written/i.test(trimmed) || /request\s+stream/i.test(trimmed);
          if (isContinuation) {
            // Still inside the technical output — keep suppressing
            toolDescBuffer = '';
            continue;
          }
          // We've moved past technical output — clear the flag and let
          // the text flow normally through the buffer/flush logic below
          suppressingTechnical = false;
        }

        // Check if accumulated buffer matches a known technical tool-description pattern
        const match = TECHNICAL_PATTERNS.find(p => p.test(toolDescBuffer.trim()));
        if (match) {
          suppressingTechnical = true;
          // Suppress this technical output — push friendlier narration
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
        // BUT never in the middle of a UTF-16 surrogate pair (emoji, etc.),
        // which would produce garbled output (U+FFFD) on the frontend.
        const endsWithPartialSurrogate = toolDescBuffer.length > 0 && (() => {
          const last = toolDescBuffer.charCodeAt(toolDescBuffer.length - 1);
          return last >= 0xD800 && last <= 0xDBFF;
        })();
        if ((toolDescBuffer.length >= 30 || SENTENCE_BOUNDARY.test(toolDescBuffer)) && !endsWithPartialSurrogate) {
          fullText += toolDescBuffer;
          if (onChunk) onChunk(toolDescBuffer);
          toolDescBuffer = '';
        }
      }
      // Flush any remaining buffer content — strip trailing orphan surrogate to avoid garbled output
      if (toolDescBuffer.length > 0) {
        let finalFlush = toolDescBuffer;
        const lastCode = finalFlush.charCodeAt(finalFlush.length - 1);
        if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
          finalFlush = finalFlush.slice(0, -1);
        }
        fullText += finalFlush;
        if (onChunk && finalFlush.length > 0) onChunk(finalFlush);
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ DIAGNOSTIC: Log model response summary Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      console.log(`[agent-loop] MODEL RESPONSE: textDeltas=${textDeltas}, fullText.length=${fullText.length}, steps=${steps}, totalInput=${totalInput}, totalOutput=${totalOutput}, toolCallNames=${Array.from(toolCallNames).join(',') || 'none'}`);
      if (fullText.length > 0) {
        console.log(`[agent-loop] MODEL RESPONSE PREVIEW: ${fullText.slice(0, 500).replace(/\n/g, '\\n')}`);
      } else {
        console.warn(`[agent-loop] MODEL RESPONSE EMPTY — no text produced, no tool calls after ${steps} steps`);
      }
      // Ã¢â€â‚¬Ã¢â€â‚¬ End diagnostic Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

      // Ã¢â€â‚¬Ã¢â€â‚¬ Auto-retry on empty/no-tool output Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      // If the model produced absolutely nothing (no text, no tool calls) and
      // this is a coding task, re-invoke with a stronger tool mandate rather
      // than silently returning empty output. Retry up to 2 times.
      const isEmptyOutput = fullText.length === 0 && toolCallNames.size === 0;
      const isCodingTask = projectPath && !talkMode;
      if (isEmptyOutput && isCodingTask) {
        console.warn('[agent-loop] AUTO-RETRY: empty output with no tools — re-invoking with stronger mandate');
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Model produced empty output — retrying...' });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Model produced empty output — retrying...', 'thinking'),
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
              'Do NOT just explain what you would do — actually DO it.\n\n' +
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
              stopWhen: stepCountIs(6),
              maxTokens: 8000,
              abortSignal: signal,
            });

            const retryText = retryResult.text?.trim() || '';
            // Check if retry produced meaningful output or tool calls
            // (generateText doesn't give us toolCallNames directly, but text.length is a proxy)
            const retryStepCount = Array.isArray(retryResult.steps) ? retryResult.steps.length : 0;
            if (retryText.length > 50 || retryStepCount > 1) {
              fullText = retryText;
              // Estimate tool calls from steps
              if (retryStepCount > 1) {
                for (let t = 0; t < retryStepCount - 1; t++) toolCallNames.add('retry_tool_call');
              }
              console.log(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} succeeded: ${retryText.length} chars, ${retryStepCount} steps`);
            } else {
              console.warn(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} also produced insufficient output`);
            }
          } catch (retryErr) {
            console.warn(`[agent-loop] AUTO-RETRY attempt ${retryAttempt} failed:`, (retryErr as Error).message);
          }
        }

        if (fullText.length === 0 && toolCallNames.size === 0) {
          // All retries exhausted — produce a fallback message + tier hint
          const upgradeHint = buildUpgradeHint(mode === 'auto' ? 'auto' : resolvedMode, 'The model could not produce a response after multiple attempts.');
          fullText = 'I encountered an issue generating a response. Let me try a different approach.\n\n' +
                     'Could you please rephrase your request or let me know what specific task you need help with?' +
                     upgradeHint;
          console.warn(`[agent-loop] AUTO-RETRY exhausted — using fallback message (mode=${resolvedMode})`);
          const sug = suggestUpgrade(resolvedMode);
          if (sug) {
            userClientManager.pushToUser(userId, 'suny:suggest_tier_upgrade', {
              currentMode: mode === 'auto' ? 'auto' : resolvedMode,
              routedMode: resolvedMode,
              suggestedMode: sug.next,
              reason: 'retries_exhausted',
            });
          }
        }
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Deferred-placeholder recovery Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      // Some models reply with short stalling text like
      //   "Let me search for the latest World Cup schedule."
      //   "Let me look that up for you!"
      //   "I'll check on that..."
      // without actually invoking any tool. The UI then sits forever because
      // the turn "finished" but no answer was produced. If we have a
      // web_search tool available, force a follow-up step with
      // toolChoice:'required' so the model actually performs the lookup.
      const looksLikePlaceholder =
        fullText.length > 0 &&
        fullText.length < 220 &&
        toolCallNames.size === 0 &&
        /\b(let me|i(?:'| )?ll|i will|i'm going to|going to|hold on|one moment|just a (?:sec|moment))\b.*\b(search|look|check|find|fetch|get|look up|look that up|pull up|grab|see)\b/i.test(fullText);
      const hasWebSearch = !!effectiveTools && typeof (effectiveTools as Record<string, any>).web_search?.execute === 'function';
      if (looksLikePlaceholder && hasWebSearch) {
        console.warn('[agent-loop] DEFERRED-PLACEHOLDER: short stalling output with no tool calls — forcing tool step');
        // Tell the UI to clear the stalling placeholder so the user sees
        // active progress instead of a frozen "Let me look that up for you!".
        // The frontend treats suny:stream_start as a reset of streamingContent.
        userClientManager.pushToUser(userId, 'suny:stream_start', {});
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Looking that up...' });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Looking that up...', 'thinking'),
        });

        const followUpMsg: CoreMessage = {
          role: 'user',
          content:
            'You said you would look that up but did not call any tool. ' +
            'Now actually perform the lookup using the web_search tool, then answer the original question:\n\n' +
            userMessage,
        };
        const fuHistory = [...messages, { role: 'assistant' as const, content: fullText }, followUpMsg];
        const trimFu = trimHistory(fuHistory, fullSystem, provider);

        try {
          // Stage A: force ONE tool call only on step 0, then let
          // subsequent steps synthesize the final answer with toolChoice='auto'.
          const fuResult = await generateText({
            model: model as LanguageModel,
            system: fullSystem,
            messages: trimFu,
            tools: effectiveTools,
            stopWhen: stepCountIs(6),
            prepareStep: ({ stepNumber }) =>
              stepNumber === 0 ? { toolChoice: 'required' as const } : { toolChoice: 'auto' as const },
            maxTokens: 4000,
            abortSignal: signal,
          });

          let fuText = fuResult.text?.trim() || '';
          const fuStepCount = Array.isArray(fuResult.steps) ? fuResult.steps.length : 0;
          totalInput += fuResult.usage?.inputTokens ?? 0;
          totalOutput += fuResult.usage?.outputTokens ?? 0;
          if (fuStepCount > 0) {
            for (let t = 0; t < fuStepCount; t++) toolCallNames.add('web_search');
          }

          // Stage B: if step A still produced no text (model stayed stuck in
          // tool-call mode), do a final synthesis call with NO tools, feeding
          // back the tool results as plain text.
          if (fuText.length === 0 && Array.isArray(fuResult.steps) && fuResult.steps.length > 0) {
            const toolResultsBlock = fuResult.steps
              .flatMap((s: any) => (Array.isArray(s.toolResults) ? s.toolResults : []))
              .map((tr: any) => {
                const name = tr?.toolName || 'tool';
                const out = typeof tr?.result === 'string' ? tr.result : JSON.stringify(tr?.result ?? '');
                return `<tool_result name="${name}">\n${String(out).slice(0, 6000)}\n</tool_result>`;
              })
              .join('\n');
            try {
              const synthResult = await generateText({
                model: model as LanguageModel,
                system: fullSystem,
                messages: [
                  ...messages,
                  { role: 'assistant' as const, content: fullText },
                  {
                    role: 'user' as const,
                    content:
                      `Here are the search results you just retrieved:\n\n${toolResultsBlock}\n\n` +
                      `Now write the final answer to the user's original question (no tool calls, just the answer):\n\n` +
                      userMessage,
                  },
                ],
                maxTokens: 2000,
                abortSignal: signal,
              });
              fuText = synthResult.text?.trim() || '';
              totalInput += synthResult.usage?.inputTokens ?? 0;
              totalOutput += synthResult.usage?.outputTokens ?? 0;
              console.log(`[agent-loop] DEFERRED-PLACEHOLDER synthesis: ${fuText.length} chars`);
            } catch (synthErr) {
              console.warn('[agent-loop] DEFERRED-PLACEHOLDER synthesis failed:', (synthErr as Error).message);
            }
          }

          if (fuText.length > 0) {
            // Replace the stalling placeholder with the real answer
            fullText = fuText;
          } else {
            // Both stages produced nothing — give the user a clear message
            fullText = 'I tried to look that up but could not get a clear answer right now. Please try again in a moment.';
          }
          // Stream the recovered answer progressively so the UI doesn't jump
          // from "Looking that up..." straight to the final blob. Use word
          // boundaries to keep latency low without breaking unicode.
          if (onChunk && fullText.length > 0) {
            const parts = fullText.match(/\S+\s*|\s+/g) || [fullText];
            for (const part of parts) {
              try { onChunk(part); } catch { /* best-effort */ }
            }
          }
          console.log(`[agent-loop] DEFERRED-PLACEHOLDER recovery: ${fuText.length} chars, ${fuStepCount} steps`);
        } catch (fuErr) {
          console.warn('[agent-loop] DEFERRED-PLACEHOLDER recovery failed:', (fuErr as Error).message);
          // Append a graceful fallback so the user never sees a dangling "let me look..."
          fullText = fullText.trim() + '\n\nI could not reach the search service just now. Please try again in a moment.';
        }
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Function-tag fallback: intercept <function.name=X> XML tool calls Ã¢â€â‚¬Ã¢â€â‚¬
      // Some models (especially via OpenRouter) emit tool calls as raw XML text
      // instead of native JSON tool calls. The Vercel AI SDK v5 doesn't parse
      // these, so we intercept them here, execute the tools, and feed results
      // back for a follow-up response.
      if (hasFunctionTagCalls(fullText) && effectiveTools) {
        console.log('[agent-loop] FUNCTION-TAG FALLBACK: detected <function.name=X> calls in output');
        const parsed = parseAndStripFunctionTags(fullText);
        fullText = parsed.cleanContent;

        if (parsed.calls.length > 0) {
          const results: Array<{ call: { name: string; params: Record<string, unknown> }; result: string }> = [];

          for (const tc of parsed.calls) {
            const toolFn = (effectiveTools as Record<string, any>)[tc.name];
            if (!toolFn || typeof toolFn.execute !== 'function') {
              console.warn(`[agent-loop] FUNCTION-TAG: unknown tool '${tc.name}' — skipping`);
              results.push({ call: tc, result: `Tool '${tc.name}' is not available. Try using a different tool to accomplish your goal.` });
              continue;
            }
            try {
              toolCallNames.add(tc.name);
              console.log(`[agent-loop] FUNCTION-TAG: executing ${tc.name}(${JSON.stringify(tc.params).slice(0, 200)})`);
              userClientManager.pushToUser(userId, 'suny:tool_start', { tool: tc.name, input: tc.params });
              const execResult = await toolFn.execute(tc.params, { toolCallId: `fn_${tc.name}_${Date.now()}`, abortSignal: signal });
              const resultStr = typeof execResult === 'string' ? execResult : JSON.stringify(execResult);
              console.log(`[agent-loop] FUNCTION-TAG: ${tc.name} result: ${resultStr.slice(0, 300)}`);
              userClientManager.pushToUser(userId, 'suny:tool_result', { tool: tc.name, input: tc.params, success: true, summary: resultStr.slice(0, 200) });
              results.push({ call: tc, result: resultStr });
            } catch (err) {
              const errMsg = (err as Error).message;
              console.warn(`[agent-loop] FUNCTION-TAG: ${tc.name} failed: ${errMsg}`);
              userClientManager.pushToUser(userId, 'suny:tool_result', { tool: tc.name, input: tc.params, success: false, error: errMsg });
              results.push({ call: tc, result: `Tool '${tc.name}' encountered an internal error and could not complete. Try a different approach or tool.` });
            }
          }

          // Feed tool results back to the model for a final response
          if (results.length > 0) {
            const resultBlock = results.map(r =>
              `<tool_result name="${r.call.name}">\n${r.result.slice(0, 8000)}\n</tool_result>`
            ).join('\n');

            const followUpMsg: CoreMessage = {
              role: 'user',
              content:
                `Here are the results of your tool calls:\n\n${resultBlock}\n\n` +
                `Now provide your final answer to the original request: "${userMessage.slice(0, 500)}"`,
            };

            const fuHistory = [...messages, { role: 'assistant' as const, content: fullText || '(tool calls made)' }, followUpMsg];
            const trimFu = trimHistory(fuHistory, fullSystem, provider);

            try {
              userClientManager.pushToUser(userId, 'suny:stage', { stage: 'processing', label: 'Processing tool results...' });
              const fuResult = await generateText({
                model: model as LanguageModel,
                system: fullSystem,
                messages: trimFu,
                tools: effectiveTools,
                stopWhen: stepCountIs(6),
                maxTokens: 4000,
                abortSignal: signal,
              });

              const fuText = fuResult.text?.trim() || '';
              if (fuText.length > 0) {
                fullText = fuText;
                totalInput += fuResult.usage?.inputTokens ?? 0;
                totalOutput += fuResult.usage?.outputTokens ?? 0;
                console.log(`[agent-loop] FUNCTION-TAG: follow-up produced ${fuText.length} chars`);
              } else {
                // Model didn't respond — stitch results together as a best-effort answer
                fullText = results.map(r =>
                  `**${r.call.name}**: ${r.result.slice(0, 1000)}`
                ).join('\n\n');
                // If all results are errors, provide a graceful fallback
                if (results.every(r => r.result.startsWith(`Tool '`))) {
                  fullText = "I ran into some internal issues processing your request. Could you try rephrasing or provide more specific guidance?";
                }
              }
            } catch (fuErr) {
              console.warn('[agent-loop] FUNCTION-TAG: follow-up call failed:', (fuErr as Error).message);
              // Best-effort: show tool results directly
              fullText = results.map(r =>
                `**${r.call.name}**: ${r.result.slice(0, 1000)}`
              ).join('\n\n');
              // If all results are errors, provide a graceful fallback
              if (results.every(r => r.result.startsWith(`Tool '`))) {
                fullText = "I ran into some internal issues processing your request. Could you try rephrasing or provide more specific guidance?";
              }
            }
          }
        }
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Loop detection: if AI was stuck in a loop, inject self-correction Ã¢â€â‚¬Ã¢â€â‚¬
      if (getLoopDetector(userId).isLoopReported) {
        const loopMsg = '\n\n[SYSTEM: You were stuck in a repetitive loop. Step back, stop repeating yourself, and try a completely different approach. If you were reading the same files, stop — you already have the information you need.]\n\n';
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Increment per-user cached-tokens counter Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      const stepCacheTokens = (anthropicMeta?.cacheCreationInputTokens ?? 0) +
                               (anthropicMeta?.cacheReadInputTokens ?? 0) +
                               (deepseekUsage?.prompt_cache_hit_tokens ?? 0);
      if (stepCacheTokens > 0) {
        try {
          const db = await (await import('./db')).getAdapter();
          await db.run(
            `INSERT INTO user_cache_counters (user_id, cached_tokens, updated_at)
             VALUES (?, ?, datetime('now'))
             ON CONFLICT(user_id) DO UPDATE SET
               cached_tokens = cached_tokens + ?,
               updated_at = datetime('now')`,
            [userId, stepCacheTokens, stepCacheTokens],
          );
        } catch { /* non-critical — don't fail agent loop for counter update */ }
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Phase 2.1: Real-time self-scoring after main response Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Confidence Scorer: self-assessment after main response Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
          await recordConfidence({
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

          // Ã¢â€â‚¬Ã¢â€â‚¬ Low-Confidence Self-Revision (PRO mode) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
                  `Review your own response above — not the question, but what you wrote.\n` +
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
                // No tools — this is a pure text refinement pass
                stopWhen: stepCountIs(1),
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Architect mode: plan Ã¢â€ â€™ execute Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      // First pass (above) was the planning pass. Now run a second pass that
      // actually applies edits using diff format (or tool-call if tools available).
      if (editFormat === 'architect' && projectPath && true) {
        userClientManager.pushToUser(userId, 'suny:stage', { stage: 'executing', label: 'Plan ready — now executing...' });
        userClientManager.pushToUser(userId, 'suny:narration', {
          message: narrateMessage('Plan ready — now executing...', 'plan'),
        });

        const execFormatInstructions = tools ? '' : '\n\n' + DIFF_FORMAT_INSTRUCTIONS;
        const execSystem = `${systemPrompt}${execFormatInstructions}\n\n<WorkingDirectory>${projectPath}</WorkingDirectory>\nAll relative file paths are resolved against this directory.`;

        const rawExecMessages: CoreMessage[] = [
          ...messages,
          { role: 'assistant' as const, content: fullText },
          {
            role: 'user' as const,
            content: 'Great plan. Now execute it — make all the changes described above.',
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
          // Allow multi-step execution (read Ã¢â€ â€™ edit Ã¢â€ â€™ write across files).
          stopWhen: tools ? stepCountIs(8) : undefined,
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
              console.warn(`[agent-loop] architect diff apply failed: ${r.file} — ${r.error}`);
            }
          }
        }

        fullText = `**Plan:**\n${fullText}\n\n**Execution:**\n${execText}`;
      }

      // ── Apply text-based edit formats ──
      if (textFormat && projectPath && fullText) {
        const applyFn = editFormat === 'diff' ? applyDiffFormat : applyWholeFormat;
        const applied = applyFn(fullText, projectPath);
        for (const r of applied) {
          if (r.applied) {
            changedFiles.add(r.file.startsWith('/') ? r.file : `${projectPath}/${r.file}`);
            invalidateRepoMap(userId, projectPath);
          } else {
            console.warn(`[agent-loop] ${editFormat} apply failed: ${r.file} —  ${r.error}`);
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Aider-style lint self-correction loop Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
            break; // clean — no errors to fix
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
              'Fix ALL errors above. Do not ask for permission — just fix them.',
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
            // Allow multi-step fixes (read Ã¢â€ â€™ edit across files).
            stopWhen: tools ? stepCountIs(8) : undefined,
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
          // Exhausted retries — warn the user but still return
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
      // Ã¢â€â‚¬Ã¢â€â‚¬ End lint loop Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

      // Ã¢â€â‚¬Ã¢â€â‚¬ Post-change file verification Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      // After files have been written and linted, verify that all files in
      // changedFiles actually exist on disk. This catches cases where the AI
      // claimed to write a file but the write was silently skipped or failed.
      //
      // NOTE: When the user runs through the bridge, project files live on
      // their machine — NOT the server. Server-side fs.existsSync would always
      // return false and falsely flag every change as phantom. In that case we
      // skip verification entirely (the bridge already errors on write failure).
      const bridgeActive = isBridgeConnected(userId);
      if (projectPath && changedFiles.size > 0 && !bridgeActive) {
        const verifiedFiles = new Set<string>();
        let missingCount = 0;
        for (const filePath of changedFiles) {
          const absPath = filePath.startsWith('/') ? filePath : `${projectPath}/${filePath}`;
          try {
            if (fs.existsSync(absPath)) {
              verifiedFiles.add(filePath);
            } else {
              missingCount++;
              console.warn(`[agent-loop] FILE VERIFICATION FAILED: ${filePath} — file does not exist despite being reported as changed`);
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Phase 2.3: Extract mistake rules from lint failures Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      if (lintErrorsFound > 0 && projectPath) {
        try {
          await extractMistakeRule(await getAdapter(), userId, projectId ?? null, 'lint', {
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ Test self-correction loop Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
              // Allow multi-step fixes (read Ã¢â€ â€™ edit across files).
              stopWhen: tools ? stepCountIs(8) : undefined,
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

            // Re-run — scope-narrowed to only failing tests on pass 2+ for speed
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
            const remaining = testResult.failedTests.slice(0, 5).map(t => `Ã¢â‚¬Â¢ ${t.name}`).join('\n');
            fullText = (testFullText || fullText) +
              `\n\nÃ¢Å¡Â Ã¯Â¸Â ${testResult.failCount} test(s) still failing after ${testPass} attempt(s):\n${remaining || testResult.output.slice(0, 400)}`;
          }
        } else if (testResult?.passed) {
          testPassed = true;
          userClientManager.pushToUser(userId, 'suny:test_passed', { attempt: 0 });
        }
      }
      // Ã¢â€â‚¬Ã¢â€â‚¬ End test loop Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

      // Ã¢â€â‚¬Ã¢â€â‚¬ Phase 2.3: Extract mistake rules from test failures Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      if (testFailuresFound > 0 && projectPath) {
        try {
          await extractMistakeRule(await getAdapter(), userId, projectId ?? null, 'test', {
            errorCount: testFailuresFound,
            retriesUsed: testRuns,
            gaveUp: testGaveUp,
            context: userMessage.slice(0, 300),
          });
        } catch (e) {
          console.warn('[agent-loop] mistake extraction (test) failed:', (e as Error).message);
        }
      }

      // Ã¢â€â‚¬Ã¢â€â‚¬ Silent self-reflection pass Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
                'If it has factual errors, incomplete code, or misses the request — reply with the fully corrected response ONLY. No preamble, no explanations.\n\n' +
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
          // Reflection is best-effort — never block the main response
        }
      }
      // Emit stage complete
      userClientManager.pushToUser(userId, 'suny:stage', { stage: 'complete', label: 'Done!' });

      // Ã¢â€â‚¬Ã¢â€â‚¬ Cross-project learning: share patterns from this task Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
      if (projectId && await isCrossProjectLearningEnabled(userId)) {
        try {
          // Share lint-fix patterns
          if (lintErrorsFound > 0 && lintPassed) {
            await shareErrorPattern({
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
            await shareErrorPattern({
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

      // Ã¢â€â‚¬Ã¢â€â‚¬ End self-reflection Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬

      // ── P3: Agent-action memory capture ─────────────────────────────────
      // Store a blueprint entry recording what the agent did this turn
      if (projectId && fullText && !talkMode) {
        try {
          const toolList = Array.from(toolCallNames);
          const changedList = Array.from(changedFiles);
          const summary = toolList.length > 0
            ? `Used tools: ${toolList.slice(0, 5).join(', ')}${changedList.length > 0 ? ` — modified ${changedList.length} file(s)` : ''}`
            : `Responded to: ${userMessage.slice(0, 100)}`;
          const entry = await storeBlueprintEntry({
            userId,
            projectId,
            sessionId,
            turnIndex: steps || 1,
            summary: summary.slice(0, 500),
            details: `Tools used: ${toolList.join(', ')}\nFiles changed: ${changedList.join(', ')}\nLint: ${lintPassed ? 'passed' : lintGaveUp ? 'gave up' : 'skipped'}\nTests: ${testPassed ? 'passed' : testGaveUp ? 'gave up' : 'skipped'}`.slice(0, 2000),
            intent: userMessage.slice(0, 300),
            affectedFiles: changedList,
          });

          // Extract and store entities from the interaction
          const interactionText = `${userMessage} ${fullText.slice(0, 2000)}`;
          const entityCount = extractAndStoreEntities(userId, 'blueprint_entries', entry.id, interactionText);
          if (entityCount > 0) {
            console.log(`[agent-loop] Captured ${entityCount} entities from agent action`);
          }
        } catch (e) {
          console.warn('[agent-loop] Agent-action memory capture failed:', (e as Error).message);
        }
      }

      const stepsExhausted = false;

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
        apiKeyId,
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
        console.error(`[agent-loop] ALL PROVIDERS EXHAUSTED — last error: ${lastError.message}`);
        
        if (isVisionRequest && lastError.message === 'No models available') {
          userClientManager.pushToUser(userId, 'suny:suggest_tier_upgrade', {
            currentMode: mode === 'auto' ? 'auto' : resolvedMode,
            routedMode: resolvedMode,
            suggestedMode: 'pro',
            reason: 'no_vision_models',
          });
          throw new Error('No vision models available');
        }

        const sug = suggestUpgrade(resolvedMode);
        if (sug) {
          userClientManager.pushToUser(userId, 'suny:suggest_tier_upgrade', {
            currentMode: mode === 'auto' ? 'auto' : resolvedMode,
            routedMode: resolvedMode,
            suggestedMode: sug.next,
            reason: 'all_providers_failed',
          });
        }
      }
    }
  }

  throw lastError;
}
