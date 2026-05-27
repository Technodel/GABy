/**
 * SUNy Agent -- Multi-provider AI caller using Vercel AI SDK.
 *
 * Supported providers (via DB api_keys table):
 *   Anthropic      -> @ai-sdk/anthropic (with prompt caching)
 *   DeepSeek       -> @ai-sdk/deepseek
 *   Groq           -> @ai-sdk/groq
 *   OpenRouter     -> @ai-sdk/openai-compatible
 *   OpenAI         -> @ai-sdk/openai
 *   Gemini (removed - no API key)
 *   Ollama         -> @ai-sdk/openai-compatible (local models via Ollama)
 *
 * Per-mode fallback: keys sorted by priority (1=primary, 2=fallback ...).
 */

// import { createAnthropic } from '@ai-sdk/anthropic';
// import { createOpenAI } from '@ai-sdk/openai';
// import { createGroq } from '@ai-sdk/groq';
// import { createDeepSeek } from '@ai-sdk/deepseek';
// import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
// import type { LanguageModel } from 'ai';
// import { getDb } from './db';

// -- Types -----------------------------------------------------------------------

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface KeyEntry {
  key_value: string;
  provider: string;
  model_id_override: string | null;
  priority: number;
}

// -- DB helpers ------------------------------------------------------------------

export function isCachingEnabled(): boolean {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = 'prompt_caching_enabled'")
    .get() as { value: string } | undefined;
  return row?.value === 'true';
}

export type EditFormat = 'tool-call' | 'diff' | 'whole' | 'architect';

export function getEditFormat(): EditFormat {
  const row = getDb()
    .prepare("SELECT value FROM app_settings WHERE key = 'edit_format'")
    .get() as { value: string } | undefined;
  const val = row?.value ?? 'tool-call';
  return (['tool-call', 'diff', 'whole', 'architect'].includes(val) ? val : 'tool-call') as EditFormat;
}

export function getKeysForMode(mode: string): KeyEntry[] {
  return getDb()
    .prepare('SELECT key_value, provider, model_id_override, priority FROM api_keys WHERE mode = ? AND is_active = 1 ORDER BY priority ASC')
    .all(mode) as KeyEntry[];
}

export function getModelForMode(mode: string): string {
  const row = getDb()
    .prepare('SELECT model_id FROM pricing_modes WHERE mode = ?')
    .get(mode) as { model_id: string } | undefined;
  return row?.model_id || 'deepseek-chat';
}

// -- Provider factory ------------------------------------------------------------

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// Gemini removed - no API key available

/**
 * Build a Vercel AI SDK LanguageModel from a DB key entry + model id.
 */
export function buildLanguageModel(key: KeyEntry, modelId: string): LanguageModel {
  const { provider, key_value } = key;
  switch (provider) {
    case 'Anthropic':
      return createAnthropic({ apiKey: key_value })(modelId);
    case 'DeepSeek':
      return createDeepSeek({ apiKey: key_value })(modelId);
    case 'Groq':
      return createGroq({ apiKey: key_value })(modelId);
    case 'OpenAI':
      return createOpenAI({ apiKey: key_value })(modelId);
    case 'OpenRouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: OPENROUTER_BASE_URL,
        apiKey: key_value,
        headers: { 'HTTP-Referer': 'https://suny.app', 'X-Title': 'SUNy' },
      })(modelId);
    case 'Ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: key_value || 'http://localhost:11434/v1',
        apiKey: 'ollama', // Ollama doesn't require API key auth by default
      })(modelId);
    default:
      return createOpenAI({ apiKey: key_value })(modelId);
  }
}

/**
 * Get all available models for a mode (sorted by priority) for fallback iteration.
 */
export function getModelsForMode(mode: string): Array<{ model: LanguageModel; provider: string }> {
  const keys = getKeysForMode(mode);
  if (keys.length === 0) throw new Error(`No active API key configured for mode "${mode}"`);
  const modeModel = getModelForMode(mode);
  return keys.map((key) => ({
    model: buildLanguageModel(key, key.model_id_override ?? modeModel),
    provider: key.provider,
  }));
}

