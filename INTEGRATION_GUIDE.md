# Model Distribution Engine — Integration Guide

## Overview

The `model-distribution-engine.ts` intelligently routes tasks across your available models based on:
1. **Task classification** (type + complexity)
2. **User mode** (FAST / SMART / PRO)
3. **Fallback chains** (ordered backup models)

This replaces the naive `selectModel()` logic and ensures:
- DeepSeek Flash handles 70% of tasks (cheapest + capable)
- Groq handles speed-critical tasks (free tier)
- DeepSeek Pro handles reasoning-heavy tasks (good balance)
- Claude is used sparingly (expensive, last resort)
- Gemini fills specific gaps (analysis, understanding)

---

## Integration into agent-loop.ts

### Step 1: Import the Engine

```ts
import {
  classifyTask,
  selectRoute,
  routeAndExecuteTask,
  logRouteDecision,
  type UserMode,
  type TaskClassification,
  type ModelRoute,
} from './model-distribution-engine';
```

### Step 2: Replace resolveMode() Logic

**Current code** (around line 230):

```ts
function resolveMode(userMode?: string, userPlan?: string): string {
  if (userMode && ['fast', 'smart', 'pro'].includes(userMode)) return userMode;
  if (userPlan === 'pro') return 'pro';
  if (userPlan === 'smart') return 'smart';
  return 'fast'; // default
}
```

**Replace with:**

```ts
function resolveMode(userMode?: string, userPlan?: string): UserMode {
  if (userMode && ['fast', 'smart', 'pro', 'free'].includes(userMode)) {
    return userMode as UserMode;
  }
  if (userPlan === 'pro') return 'pro';
  if (userPlan === 'smart') return 'smart';
  if (userPlan === 'free' || !userPlan) return 'free'; // free is default
  return 'fast';
}
```

### Step 3: Add Task Classification at Session Start

**In the main agent loop function**, after extracting userMessage, add:

```ts
export async function runAgentLoop(params: {
  projectId?: string;
  userId: number;
  userMessage: string;
  userMode?: string;
  userPlan?: string;
  projectPath?: string;
  // ... other params
}): Promise<void> {
  const resolvedMode = resolveMode(params.userMode, params.userPlan);

  // NEW: Classify the incoming task
  const taskClassification = classifyTask(params.userMessage, {
    // optional: detect from message if not provided
    codebaseSize: projectStats?.fileCount, // if you track this
  });

  // NEW: Select the route
  const route = selectRoute(resolvedMode, taskClassification);

  console.log(`[agent-loop] Classified as ${taskClassification.type}/${taskClassification.complexity}`);
  console.log(`[agent-loop] Route: ${route.primary} (fallbacks: ${route.fallbacks.join(', ')})`);

  // ... rest of agent loop
}
```

### Step 4: Replace Model Selection Logic

**Current code** (around line 660, in agent-loop):

```ts
const resolvedModel = resolveProviderMode(resolvedMode);
const result = await streamText({
  model: getModel(resolvedModel),
  messages,
  system: systemPrompt,
  tools,
  maxSteps: stepLimit,
  // ...
});
```

**Replace with:**

```ts
// Prepare API keys (assumes they're stored in user settings or env)
const apiKeys = {
  'groq': process.env.GROQ_API_KEY || '',
  'deepseek': process.env.DEEPSEEK_API_KEY || '',
  'google': process.env.GOOGLE_API_KEY || '',
  'anthropic': process.env.ANTHROPIC_API_KEY || '',
  'openrouter': process.env.OPENROUTER_API_KEY || '',
};

// Route the task to the best model
let result: any;
let usedModel = '';
let fallbackAttempts = 0;

const modelsToTry = [route.primary, ...route.fallbacks] as const;

for (const modelKey of modelsToTry) {
  try {
    const model = getModelForKey(modelKey, apiKeys); // see helper below
    
    console.log(`[agent-loop] Attempting ${modelKey}...`);
    
    result = await streamText({
      model,
      messages,
      system: systemPrompt,
      tools,
      maxSteps: stepLimit,
      onStepFinish: (step) => {
        // ... existing onStepFinish logic
      },
    });

    usedModel = modelKey;
    console.log(`[agent-loop] ✓ Success with ${modelKey}`);
    break;

  } catch (err) {
    const isLastModel = modelKey === modelsToTry[modelsToTry.length - 1];
    
    if (isLastModel) {
      // All models failed
      throw new Error(`All models failed: ${(err as Error).message}`);
    }
    
    // Try next fallback
    if (modelKey !== route.primary) fallbackAttempts++;
    console.log(`[agent-loop] ${modelKey} failed, trying next: ${(err as Error).message}`);
    continue;
  }
}

// Log the routing decision (optional but useful for analytics)
logRouteDecision({
  classification: taskClassification,
  route,
  usedModel,
  fallbackAttempts,
  cost: 0, // calculate from result.usage if needed
});
```

### Step 5: Add Model Initialization Helper

Add this function to your agent-loop.ts or a separate `model-factory.ts`:

```ts
/**
 * Initialize the correct model provider based on model key.
 */
function getModelForKey(
  modelKey: string,
  apiKeys: Record<string, string>
): LanguageModel {
  const [provider, model] = modelKey.split('/');

  if (provider === 'groq') {
    return groq(model, { apiKey: apiKeys.groq });
  }

  if (provider === 'deepseek') {
    // Assuming you're using a provider that supports DeepSeek
    // e.g., via OpenRouter or direct API
    if (model === 'flash') {
      return openrouter('deepseek/deepseek-chat', { apiKey: apiKeys.openrouter });
    } else if (model === 'pro') {
      return openrouter('deepseek/deepseek-reasoner', { apiKey: apiKeys.openrouter });
    }
  }

  if (provider === 'google') {
    return google(model, { apiKey: apiKeys.google });
  }

  if (provider === 'anthropic') {
    return anthropic(model, { apiKey: apiKeys.anthropic });
  }

  if (provider === 'openrouter') {
    return openrouter(model, { apiKey: apiKeys.openrouter });
  }

  throw new Error(`Unknown model: ${modelKey}`);
}
```

### Step 6: Track Fallback Usage for Analytics

**Optional: Add fallback tracking to your usage_log table:**

```ts
// After the agent loop completes successfully
if (fallbackAttempts > 0) {
  const db = getDb();
  db.prepare(`
    INSERT INTO fallback_log (session_id, user_id, model_primary, model_used, fallback_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, userId, route.primary, usedModel, fallbackAttempts, new Date());

  console.log(`[analytics] Fallback used: ${route.primary} → ${usedModel} (${fallbackAttempts} attempts)`);
}
```

---

## Routing Decision Examples

### Example 1: Simple Chat Question (FAST Mode)
```
Input: "Hi, can you explain what this function does?"
Classification: 
  - Type: explanation
  - Complexity: simple
  - Tokens: ~1,200
Route:
  - Primary: groq/llama (fastest)
  - Fallbacks: deepseek/flash → gemini/2.0
Reasoning: Simple task, Groq is fastest and cheapest
Cost: ~$0.000 (free tier)
```

### Example 2: Medium Bug Fix (SMART Mode)
```
Input: "There's a TypeError in the auth module, line 45. Fix it."
Classification:
  - Type: bug_fix
  - Complexity: medium
  - Tokens: ~3,500
Route:
  - Primary: deepseek/flash
  - Fallbacks: gemini/2.0 → deepseek/pro
Reasoning: Bug fix requires accuracy, DeepSeek Flash is ideal (cheap + accurate)
Cost: ~$0.49
```

### Example 3: Large Refactor (PRO Mode)
```
Input: "Refactor the entire authentication system to use OAuth2 with refresh tokens."
Classification:
  - Type: large_refactor
  - Complexity: hard
  - Tokens: ~8,000
  - Requires reasoning: true
Route:
  - Primary: deepseek/pro
  - Fallbacks: gemini/2.0 → claude/sonnet
Reasoning: Hard task needs reasoning, DeepSeek Pro cheaper than Claude, reasoning engine built-in
Cost: ~$4.80 (saves ~$9 vs Claude)
```

### Example 4: Security Audit (PRO Mode)
```
Input: "Audit this code for security vulnerabilities."
Classification:
  - Type: security_audit
  - Complexity: very_hard
  - Tokens: ~5,000
  - Requires accuracy: true
Route:
  - Primary: claude/sonnet
  - Fallbacks: deepseek/pro → gemini/2.0
Reasoning: Security requires best accuracy, Claude is worth the cost
Cost: ~$15.00
```

---

## Cost Comparison

### Scenario: 20-turn refactoring session (~50K total tokens)

**Without routing engine (everything on Claude):**
```
Claude 3.5 Sonnet: 50K tokens × $3.00/1M = $0.15 per session
Cost: $150/month (assuming 1000 sessions)
```

**With routing engine (intelligent distribution):**
```
Turn 1-4 (simple):      5K tokens → Groq ($0.00)
Turn 5-10 (medium):    20K tokens → DeepSeek Flash ($0.0028)
Turn 11-18 (hard):     20K tokens → DeepSeek Pro ($0.012)
Turn 19-20 (very hard): 5K tokens → Claude ($0.015)
Total: 50K tokens = $0.0298 per session
Cost: $30/month (assuming 1000 sessions)
```

**Savings: 80% reduction in model costs** 🎯

---

## Configuration Checklist

- [ ] Set environment variables for all API keys:
  - `GROQ_API_KEY`
  - `DEEPSEEK_API_KEY`
  - `GOOGLE_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `OPENROUTER_API_KEY`

- [ ] Add task type detection to chat input (optional but improves routing)

- [ ] Add codebase file count tracking (improves complexity classification)

- [ ] Wire up fallback logging to `fallback_log` table (for analytics)

- [ ] Test routing with sample prompts from each task type

- [ ] Monitor actual model distribution vs expected in first week

---

## Tuning the Router

If you notice patterns like "always falling back to Claude" or "never using Groq", you can tune:

1. **Model strengths** — Adjust the `reasoning`, `accuracy` fields in `MODEL_REGISTRY`
2. **Task complexity thresholds** — Modify `classifyTaskComplexity()` logic
3. **Fallback chains** — Reorder fallbacks in the `selectModels*` functions
4. **Task type detection** — Improve regex patterns in `classifyTask()`

Start with the defaults and adjust after 1-2 weeks of real usage data.
