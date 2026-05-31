import { generateText, type LanguageModel } from 'ai';
import { getAdapter } from './db';
import { buildLanguageModel, getAllActiveKeys, type KeyEntry } from './agent';

export type UserTier = 'free' | 'fast' | 'smart' | 'pro' | 'opus';

export interface RouteEntry {
  providerName: string; // 'Groq' | 'DeepSeek' | 'Google' | 'Anthropic' | 'OpenRouter'
  modelId: string;
  isCombined?: boolean;
  chatOnly?: boolean;
}

// Hierarchies matching the user's requirements
export const TIER_HIERARCHIES: Record<UserTier, RouteEntry[]> = {
  free: [
    { providerName: 'Groq', modelId: 'llama-3.3-70b-versatile' },
    { providerName: 'DeepSeek', modelId: 'deepseek-chat' },
    { providerName: 'Google', modelId: 'gemini-2.5-flash' },
    { providerName: 'OpenRouter', modelId: 'meta-llama/llama-3.3-70b-instruct' },
    { providerName: 'Anthropic', modelId: 'claude-3-5-sonnet-20241022', chatOnly: true }
  ],
  fast: [
    { providerName: 'DeepSeek', modelId: 'deepseek-chat' },
    { providerName: 'Google', modelId: 'gemini-2.5-flash' },
    { providerName: 'Anthropic', modelId: 'claude-3-5-sonnet-20241022' },
    { providerName: 'Groq', modelId: 'llama-3.3-70b-versatile' }
  ],
  smart: [
    { providerName: 'DeepSeek', modelId: 'deepseek-reasoner' },
    { providerName: 'Google', modelId: 'gemini-2.5-pro' },
    { providerName: 'Anthropic', modelId: 'claude-3-5-sonnet-20241022' },
    { providerName: 'Groq', modelId: 'llama-3.3-70b-versatile' }
  ],
  pro: [
    { providerName: 'DeepSeek', modelId: 'deepseek-reasoner', isCombined: true }, // Virtual combined model trigger
    { providerName: 'Google', modelId: 'gemini-2.5-pro' },
    { providerName: 'Groq', modelId: 'llama-3.3-70b-versatile' } // Deadend fallback
  ],
  opus: [
    { providerName: 'Anthropic', modelId: 'claude-3-opus-20240229' }
  ]
};

export interface ResolvedModel {
  model: LanguageModel;
  provider: string; // SDK Provider name
  apiKeyId?: number;
  modelId: string;
  isCombined?: boolean;
  chatOnly?: boolean;
}

/**
 * Resolves active database keys into an ordered fallback chain for the user's tier.
 */
export async function resolveModelsForTier(
  tier: string
): Promise<ResolvedModel[]> {
  const normalizedTier = (tier.toLowerCase() === 'starter' ? 'free' : tier.toLowerCase()) as UserTier;
  const hierarchy = TIER_HIERARCHIES[normalizedTier] || TIER_HIERARCHIES['free'];
  
  const activeKeys = await getAllActiveKeys();
  const resolved: ResolvedModel[] = [];

  for (const route of hierarchy) {
    // Find active key matching the provider
    const key = activeKeys.find(
      (k) => k.provider.toLowerCase() === route.providerName.toLowerCase()
    );

    if (key) {
      try {
        const modelId = key.model_id_override || route.modelId;
        const model = buildLanguageModel(key, modelId);
        resolved.push({
          model,
          provider: key.provider,
          apiKeyId: key.id,
          modelId,
          isCombined: route.isCombined,
          chatOnly: route.chatOnly
        });
      } catch (err) {
        console.error(`[model-distribution] Failed to build model for ${route.providerName}:`, err);
      }
    }
  }

  return resolved;
}

/**
 * Disable a failing API key in the DB, write an audit log, and send a webhook notification to the ADMIN.
 */
export async function handleKeyFailure(params: {
  apiKeyId?: number;
  provider: string;
  tier: string;
  errorMessage: string;
}): Promise<void> {
  const { apiKeyId, provider, tier, errorMessage } = params;
  try {
    const db = await getAdapter();

    // Log the error to the database
    await db.run(
      'INSERT INTO key_status_logs (provider, error_message, resolved) VALUES (?, ?, 0)',
      [provider, `Failure on tier "${tier}": ${errorMessage}`]
    );

    // Deactivate the key if an ID is present (keeps user experience stable by filtering it out next time)
    if (apiKeyId) {
      await db.run('UPDATE api_keys SET is_active = 0 WHERE id = ?', [apiKeyId]);
      console.warn(`[model-distribution] Deactivated API key ID ${apiKeyId} (${provider}) due to error: ${errorMessage}`);
    }

    // Pull Admin Webhook from settings
    const setting = await db.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'admin_notification_webhook'"
    );
    
    if (setting && setting.value) {
      const payload = {
        text: `⚠️ **SUNy API Key Deactivation Alert** ⚠️\n\n**Provider:** \`${provider}\`\n**User Tier:** \`${tier.toUpperCase()}\`\n**Status:** Key Auto-Disabled (is_active = 0)\n**Error message:** \`${errorMessage}\`\n\n*The system has automatically disabled this key and routed active user traffic to fallback models.*`
      };

      await fetch(setting.value, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      console.log(`[model-distribution] Posted webhook alert to admin for ${provider}`);
    }
  } catch (err) {
    console.error('[model-distribution] Error while handling key failure logs/alerts:', err);
  }
}

/**
 * Periodically verifies all active keys by sending minimal ping requests.
 * Auto-deactivates keys that fail and reports to the ADMIN.
 */
export function startApiKeyHealthChecker(intervalMs = 12 * 60 * 60 * 1000): void {
  console.log('[model-distribution-engine] Starting API Key health checker background job...');
  
  const checkAllKeys = async () => {
    console.log('[model-distribution-engine] Running scheduled API Key health checks...');
    try {
      const activeKeys = await getAllActiveKeys();
      for (const key of activeKeys) {
        try {
          // Resolve a default testing model ID for the provider
          let testModelId = key.model_id_override;
          if (!testModelId) {
            if (key.provider === 'Groq') testModelId = 'llama-3.3-70b-versatile';
            else if (key.provider === 'DeepSeek') testModelId = 'deepseek-chat';
            else if (key.provider === 'Google') testModelId = 'gemini-2.5-flash';
            else if (key.provider === 'Anthropic') testModelId = 'claude-3-5-sonnet-20241022';
            else if (key.provider === 'OpenRouter') testModelId = 'meta-llama/llama-3.3-70b-instruct';
            else testModelId = 'gpt-4o-mini';
          }

          const model = buildLanguageModel(key, testModelId);
          // Run a tiny test query
          await generateText({
            model,
            prompt: 'ping',
            maxTokens: 1
          });
          console.log(`[model-distribution-engine] Key ID ${key.id} (${key.provider}) is healthy.`);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[model-distribution-engine] Health check failed for key ID ${key.id} (${key.provider}):`, errMsg);
          
          await handleKeyFailure({
            apiKeyId: key.id,
            provider: key.provider,
            tier: key.mode || 'unknown',
            errorMessage: `Scheduled health check failed: ${errMsg}`
          });
        }
      }
    } catch (err) {
      console.error('[model-distribution-engine] Error during health check loop:', err);
    }
  };

  // Run once shortly after startup (10s delay)
  setTimeout(() => {
    checkAllKeys().catch(console.error);
  }, 10000);

  // Scheduled check
  setInterval(() => {
    checkAllKeys().catch(console.error);
  }, intervalMs);
}
