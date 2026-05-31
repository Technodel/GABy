/**
 * model-distribution-engine.ts
 *
 * Intelligent multi-model routing with cost optimization.
 *
 * Strategy:
 *   - Minimize Claude usage (most expensive)
 *   - Rely on DeepSeek Flash/Pro (best cost/capability ratio)
 *   - Use Groq for speed (free tier, fast)
 *   - Use Gemini for specific strengths (good at analysis)
 *   - Each mode has a priority-ordered fallback chain
 *
 * Cost Reference (per 1M tokens):
 *   Groq:              ~Free (rate-limited)
 *   DeepSeek Flash:    $0.14
 *   DeepSeek Pro:      $0.60
 *   Gemini 2.0:        $0.075
 *   Claude Sonnet:     $3.00
 *   Claude Opus:       $15.00
 *   OpenRouter avg:    ~$1.50 (varies by model)
 */

import type { LanguageModel } from 'ai';

// ── Types ───────────────────────────────────────────────────────────────────

export type UserMode = 'free' | 'fast' | 'smart' | 'pro';
export type TaskComplexity = 'trivial' | 'simple' | 'medium' | 'hard' | 'very_hard';
export type TaskType =
  | 'chat'                    // casual conversation
  | 'code_completion'         // autocomplete / suggestions
  | 'code_review'             // review existing code
  | 'bug_fix'                 // fix a known bug
  | 'small_refactor'          // rename, extract, inline
  | 'feature_add'             // add new functionality
  | 'large_refactor'          // refactor module / architecture
  | 'architecture'            // design / tradeoffs
  | 'performance'             // optimization
  | 'debugging'               // tracing unknown issues
  | 'test_generation'         // write tests
  | 'analysis'                // understand code / codebase
  | 'web_research'            // web search, synthesis
  | 'explanation'             // explain something
  | 'migration'               // migrate code to new tech
  | 'security_audit'          // find security issues
  | 'custom';

export interface ModelRoute {
  primary: string;            // first-choice model
  fallbacks: string[];        // ordered fallback chain
  reasoning: string;          // why this routing
}

export interface TaskClassification {
  type: TaskType;
  complexity: TaskComplexity;
  estimatedTokens: number;
  requiresReasoning: boolean; // long-form thinking needed?
  requiresCreativity: boolean;
  requiresAccuracy: boolean;
  isTimeDelayTolerant: boolean;
}

// ── Model Registry ──────────────────────────────────────────────────────────
//
// Maps model nicknames to provider-specific calls.
// Extend this with your actual API initializers.

export const MODEL_REGISTRY = {
  'groq/llama': {
    name: 'groq:llama-3.1-70b-versatile',
    provider: 'groq',
    costPer1M: 0,           // free tier
    speed: 'very_fast',
    reasoning: 'moderate',
    coding: 'good',
    accuracy: 'good',
    latency: '100-200ms',
  },
  'deepseek/flash': {
    name: 'deepseek:deepseek-chat',
    provider: 'deepseek',
    costPer1M: 0.14,        // cheapest paid option
    speed: 'fast',
    reasoning: 'good',
    coding: 'excellent',
    accuracy: 'very_good',
    latency: '500-800ms',
  },
  'deepseek/pro': {
    name: 'deepseek:deepseek-reasoner',
    provider: 'deepseek',
    costPer1M: 0.60,
    speed: 'moderate',
    reasoning: 'excellent',  // built for reasoning
    coding: 'excellent',
    accuracy: 'excellent',
    latency: '2-4s',
  },
  'gemini/2.0': {
    name: 'google:gemini-2.0-flash-exp',
    provider: 'google',
    costPer1M: 0.075,
    speed: 'very_fast',
    reasoning: 'good',
    coding: 'very_good',
    accuracy: 'very_good',
    latency: '800ms-1.2s',
    strength: 'analysis',    // particularly good at understanding
  },
  'claude/sonnet': {
    name: 'anthropic:claude-3-5-sonnet-20241022',
    provider: 'anthropic',
    costPer1M: 3.0,         // expensive, use sparingly
    speed: 'moderate',
    reasoning: 'excellent',
    coding: 'excellent',
    accuracy: 'excellent',
    latency: '1-2s',
  },
  'openrouter/mixtral': {
    name: 'openrouter:mistralai/mixtral-8x22b-instruct',
    provider: 'openrouter',
    costPer1M: 0.65,
    speed: 'fast',
    reasoning: 'good',
    coding: 'good',
    accuracy: 'good',
    latency: '600-900ms',
  },
} as const;

type ModelKey = keyof typeof MODEL_REGISTRY;

// ── Task Classification ──────────────────────────────────────────────────────

function classifyTaskComplexity(
  taskType: TaskType,
  userMessage: string,
  codebaseSize?: number
): TaskComplexity {
  const msgLen = userMessage.length;
  const hasMultipleFiles = /(?:file|module|class|function).*(?:file|module|class|function)/i.test(userMessage);
  const isArchitectural = /(?:architecture|design|refactor.*entire|migrate|rewrite|restructure)/i.test(userMessage);
  const isSimpleCommand = /^(?:fix|add|write|create|make|implement)\s+\w+/i.test(userMessage);

  // Default complexity by task type
  const baseComplexity: Record<TaskType, TaskComplexity> = {
    chat: 'trivial',
    code_completion: 'simple',
    code_review: 'medium',
    bug_fix: 'medium',
    small_refactor: 'simple',
    feature_add: 'medium',
    large_refactor: 'hard',
    architecture: 'very_hard',
    performance: 'hard',
    debugging: 'hard',
    test_generation: 'medium',
    analysis: 'medium',
    web_research: 'simple',
    explanation: 'simple',
    migration: 'hard',
    security_audit: 'very_hard',
    custom: 'medium',
  };

  let complexity = baseComplexity[taskType];

  // Bump up if architectural or multi-file
  if (isArchitectural) complexity = 'very_hard';
  else if (hasMultipleFiles && complexity !== 'very_hard') {
    if (complexity === 'simple') complexity = 'medium';
    else if (complexity === 'medium') complexity = 'hard';
  }

  // Bump down if simple command
  if (isSimpleCommand && complexity === 'medium') complexity = 'simple';

  // Bump up if large codebase
  if (codebaseSize && codebaseSize > 100 && complexity !== 'very_hard') {
    if (complexity === 'simple') complexity = 'medium';
    else if (complexity === 'medium') complexity = 'hard';
  }

  return complexity;
}

export function classifyTask(
  userMessage: string,
  options?: {
    taskType?: TaskType;
    codebaseSize?: number;
  }
): TaskClassification {
  const msgLower = userMessage.toLowerCase();
  const msgLen = userMessage.length;

  // Infer task type if not provided
  let taskType: TaskType = options?.taskType || 'chat';

  if (!options?.taskType) {
    if (/^(?:hi|hello|hey|thanks|ok|yes|no|cool|nice)/i.test(msgLower)) {
      taskType = 'chat';
    } else if (/\b(?:what|why|how|explain|describe|tell me|show me)\b/i.test(msgLower) && msgLen < 200) {
      taskType = 'explanation';
    } else if (/\b(?:review|check|audit|security|vulnerability)\b/i.test(msgLower)) {
      taskType = 'security_audit';
    } else if (/\b(?:migrate|convert|transform|upgrade|downgrade)\b/i.test(msgLower)) {
      taskType = 'migration';
    } else if (/\b(?:slow|performance|speed|optimize|latency)\b/i.test(msgLower)) {
      taskType = 'performance';
    } else if (/\b(?:debug|trace|issue|problem|error|crash)\b/i.test(msgLower)) {
      taskType = 'debugging';
    } else if (/\b(?:refactor|rename|move|reorgan|clean\s?up|restructure)\b/i.test(msgLower)) {
      taskType = msgLen > 150 ? 'large_refactor' : 'small_refactor';
    } else if (/\b(?:fix|patch|correct|bug)\b/i.test(msgLower)) {
      taskType = 'bug_fix';
    } else if (/\b(?:add|implement|create|build|feature|new)\b/i.test(msgLower)) {
      taskType = 'feature_add';
    } else if (/\b(?:test|unit test|test case|test file)\b/i.test(msgLower)) {
      taskType = 'test_generation';
    } else if (/\b(?:search|research|find|look up|investigate)\b/i.test(msgLower)) {
      taskType = 'web_research';
    } else if (/\b(?:read|understand|analyze|review|check)\b/i.test(msgLower) && msgLen < 150) {
      taskType = 'analysis';
    } else {
      taskType = 'feature_add'; // default for coding
    }
  }

  const complexity = classifyTaskComplexity(taskType, userMessage, options?.codebaseSize);

  // Estimate tokens needed (rough heuristic)
  let estimatedTokens = Math.ceil(msgLen / 3.5) + 500; // message + response overhead
  if (complexity === 'very_hard') estimatedTokens += 5000;
  else if (complexity === 'hard') estimatedTokens += 3000;
  else if (complexity === 'medium') estimatedTokens += 1500;

  return {
    type: taskType,
    complexity,
    estimatedTokens,
    requiresReasoning: ['architecture', 'debugging', 'performance', 'security_audit', 'large_refactor'].includes(taskType),
    requiresCreativity: ['feature_add', 'architecture', 'migration'].includes(taskType),
    requiresAccuracy: ['security_audit', 'bug_fix', 'test_generation', 'code_review'].includes(taskType),
    isTimeDelayTolerant: !['chat', 'code_completion'].includes(taskType),
  };
}

// ── Model Selection by Mode ──────────────────────────────────────────────────

function selectModelsForFastMode(classification: TaskClassification): ModelRoute {
  const { complexity, type } = classification;

  // FAST mode: speed is priority, cost is secondary
  if (complexity === 'trivial' || complexity === 'simple') {
    return {
      primary: 'groq/llama',
      fallbacks: ['deepseek/flash', 'gemini/2.0'],
      reasoning: 'trivial task: Groq fastest, no accuracy loss',
    };
  }

  if (complexity === 'medium') {
    // DeepSeek Flash is sweet spot for cost + speed + accuracy
    return {
      primary: 'deepseek/flash',
      fallbacks: ['groq/llama', 'gemini/2.0', 'openrouter/mixtral'],
      reasoning: 'medium task: DeepSeek Flash balances speed/accuracy, Groq fallback for speed',
    };
  }

  // Hard+ tasks in FAST mode still try to avoid expensive models
  return {
    primary: 'deepseek/flash',
    fallbacks: ['deepseek/pro', 'gemini/2.0', 'openrouter/mixtral'],
    reasoning: 'hard task in FAST: DeepSeek Flash first, Pro if needed, avoid Claude',
  };
}

function selectModelsForSmartMode(classification: TaskClassification): ModelRoute {
  const { complexity, type, requiresReasoning } = classification;

  if (complexity === 'trivial' || complexity === 'simple') {
    // Don't waste capability on simple tasks
    return {
      primary: 'deepseek/flash',
      fallbacks: ['groq/llama', 'gemini/2.0'],
      reasoning: 'simple task in SMART: DeepSeek Flash is overkill-proof, cheap',
    };
  }

  if (complexity === 'medium') {
    // Medium tasks: DeepSeek Flash handles most, Gemini for analysis-heavy
    if (type === 'analysis' || type === 'code_review') {
      return {
        primary: 'gemini/2.0',
        fallbacks: ['deepseek/flash', 'deepseek/pro'],
        reasoning: 'medium analysis task: Gemini excels at understanding, DeepSeek backup',
      };
    }

    return {
      primary: 'deepseek/flash',
      fallbacks: ['gemini/2.0', 'deepseek/pro'],
      reasoning: 'medium task: DeepSeek Flash first, Gemini for clarity, Pro if needed',
    };
  }

  if (complexity === 'hard') {
    // Hard tasks: DeepSeek Pro + Gemini, Claude only if Pro fails
    if (requiresReasoning) {
      return {
        primary: 'deepseek/pro',
        fallbacks: ['gemini/2.0', 'claude/sonnet'],
        reasoning: 'hard reasoning task: DeepSeek Pro reasoning engine, Claude as last resort',
      };
    }

    return {
      primary: 'deepseek/flash',
      fallbacks: ['deepseek/pro', 'gemini/2.0'],
      reasoning: 'hard non-reasoning: DeepSeek Flash often sufficient, Pro if needed',
    };
  }

  // Very hard: DeepSeek Pro + Gemini + Claude
  return {
    primary: 'deepseek/pro',
    fallbacks: ['deepseek/flash', 'gemini/2.0', 'claude/sonnet'],
    reasoning: 'very hard task: DeepSeek Pro reasoning first, Claude only if absolutely needed',
  };
}

function selectModelsForProMode(classification: TaskClassification): ModelRoute {
  const { complexity, type, requiresAccuracy, requiresReasoning } = classification;

  // Even in PRO, don't waste Claude on trivial tasks
  if (complexity === 'trivial' || complexity === 'simple') {
    return {
      primary: 'deepseek/flash',
      fallbacks: ['groq/llama', 'gemini/2.0'],
      reasoning: 'PRO mode simple task: accuracy is guaranteed, no point overspending',
    };
  }

  if (complexity === 'medium') {
    // For accuracy-critical medium tasks, use DeepSeek Pro
    if (requiresAccuracy) {
      return {
        primary: 'deepseek/pro',
        fallbacks: ['deepseek/flash', 'gemini/2.0'],
        reasoning: 'PRO accuracy-critical medium: DeepSeek Pro has reasoning, cheaper than Claude',
      };
    }

    return {
      primary: 'deepseek/flash',
      fallbacks: ['deepseek/pro', 'gemini/2.0'],
      reasoning: 'PRO medium non-critical: DeepSeek Flash often sufficient',
    };
  }

  if (complexity === 'hard') {
    // Hard: always use DeepSeek Pro first, Gemini, Claude only if reasoning needed
    if (requiresReasoning) {
      return {
        primary: 'deepseek/pro',
        fallbacks: ['claude/sonnet', 'deepseek/flash', 'gemini/2.0'],
        reasoning: 'PRO hard reasoning: DeepSeek Pro, Claude if Pro insufficient',
      };
    }

    return {
      primary: 'deepseek/pro',
      fallbacks: ['gemini/2.0', 'claude/sonnet'],
      reasoning: 'PRO hard non-reasoning: DeepSeek Pro, Gemini, Claude as last resort',
    };
  }

  // Very hard: use Claude, but try DeepSeek Pro first
  return {
    primary: 'claude/sonnet',
    fallbacks: ['deepseek/pro', 'gemini/2.0'],
    reasoning: 'PRO very hard: Claude for best accuracy, DeepSeek Pro for cost mitigation',
  };
}

export function selectRoute(
  userMode: UserMode,
  classification: TaskClassification
): ModelRoute {
  // Map userMode to standard modes
  const normalizedMode = userMode === 'free' ? 'fast' : userMode;

  if (normalizedMode === 'fast') {
    return selectModelsForFastMode(classification);
  } else if (normalizedMode === 'smart') {
    return selectModelsForSmartMode(classification);
  } else {
    return selectModelsForProMode(classification);
  }
}

// ── Actual Model Executor ────────────────────────────────────────────────────
//
// In real code, this initializes the actual LLM client.

export async function getModelInstance(
  modelKey: ModelKey,
  config: {
    apiKey?: string;
    baseUrl?: string;
  }
): Promise<LanguageModel | null> {
  const model = MODEL_REGISTRY[modelKey];

  // This is a stub — in your actual code, initialize the provider
  // Examples:
  //   if (model.provider === 'groq') return initGroq(model.name, config.apiKey);
  //   if (model.provider === 'anthropic') return initClaude(model.name, config.apiKey);

  console.log(`[model-distribution] Initializing ${modelKey}: ${model.name}`);
  return null; // replace with actual initialization
}

// ── Main Routing Function ────────────────────────────────────────────────────

export async function routeAndExecuteTask(params: {
  userMessage: string;
  userMode: UserMode;
  taskType?: TaskType;
  codebaseSize?: number;
  apiKeys: Record<string, string>;
  onProgress?: (msg: string) => void;
}): Promise<{
  response: string;
  usedModel: string;
  tokensUsed: number;
  cost: number;
  classification: TaskClassification;
  route: ModelRoute;
  fallbackAttempts: number;
}> {
  const { userMessage, userMode, onProgress } = params;

  // Step 1: Classify the task
  const classification = classifyTask(userMessage, {
    taskType: params.taskType,
    codebaseSize: params.codebaseSize,
  });

  onProgress?.(`[routing] Task: ${classification.type} | Complexity: ${classification.complexity}`);

  // Step 2: Select the route
  const route = selectRoute(userMode, classification);

  onProgress?.(`[routing] Primary model: ${route.primary} | Fallbacks: ${route.fallbacks.join(' → ')}`);
  onProgress?.(`[routing] Reasoning: ${route.reasoning}`);

  // Step 3: Try models in order
  let response = '';
  let usedModel = '';
  let tokensUsed = 0;
  let fallbackAttempts = 0;

  const modelsToTry = [route.primary, ...route.fallbacks] as ModelKey[];

  for (const modelKey of modelsToTry) {
    try {
      onProgress?.(`[execution] Trying ${modelKey}...`);

      const model = await getModelInstance(modelKey, {
        apiKey: params.apiKeys[modelKey] || params.apiKeys[modelKey.split('/')[0]],
      });

      if (!model) {
        onProgress?.(`[execution] ${modelKey} not available, trying fallback...`);
        if (modelKey !== route.primary) fallbackAttempts++;
        continue;
      }

      // TODO: Execute with your preferred AI SDK
      // For example:
      // const result = await streamText({
      //   model,
      //   messages: [{ role: 'user', content: userMessage }],
      // });

      // response = result.text;
      // tokensUsed = result.usage.totalTokens;
      usedModel = modelKey;

      onProgress?.(`[execution] ✓ Success with ${modelKey}`);
      break;
    } catch (err) {
      onProgress?.(`[execution] ${modelKey} failed: ${(err as Error).message}`);
      if (modelKey !== route.primary) fallbackAttempts++;
      continue;
    }
  }

  if (!usedModel) {
    throw new Error('All models failed to execute');
  }

  const costPerM = MODEL_REGISTRY[usedModel as ModelKey].costPer1M;
  const cost = (tokensUsed / 1_000_000) * costPerM;

  return {
    response,
    usedModel,
    tokensUsed,
    cost,
    classification,
    route,
    fallbackAttempts,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

export function logRouteDecision(result: {
  classification: TaskClassification;
  route: ModelRoute;
  usedModel: string;
  fallbackAttempts: number;
  cost: number;
}): void {
  console.log(`
[model-distribution-engine] ── Route Decision ──
  Task Type:        ${result.classification.type}
  Complexity:       ${result.classification.complexity}
  Reasoning:        ${result.route.reasoning}
  Primary Model:    ${result.route.primary}
  Fallback Chain:   ${result.route.fallbacks.join(' → ')}
  Used Model:       ${result.usedModel}
  Fallback Attempts: ${result.fallbackAttempts}
  Cost:             $${result.cost.toFixed(4)}
  ────────────────────────────────────────────
  `);
}
