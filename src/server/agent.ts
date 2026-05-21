/**
 * SUNy Agent -- Multi-provider AI caller using Vercel AI SDK.
 *
 * Supported providers (via DB api_keys table):
 *   Anthropic      -> @ai-sdk/anthropic (with prompt caching)
 *   DeepSeek       -> @ai-sdk/deepseek
 *   Groq           -> @ai-sdk/groq
 *   OpenRouter     -> @ai-sdk/openai-compatible
 *   OpenAI         -> @ai-sdk/openai
 *   Gemini         -> @ai-sdk/openai-compatible (OpenAI-compat endpoint)
 *   Ollama         -> @ai-sdk/openai-compatible (local models via Ollama)
 *   HuggingFace    -> @ai-sdk/openai-compatible (free Inference API, no paid server needed)
 *
 * Per-mode fallback: keys sorted by priority (1=primary, 2=fallback ...).
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGroq } from '@ai-sdk/groq';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import { getAdapter } from './db';

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

export async function isCachingEnabled(): Promise<boolean> {
  const db = await getAdapter();
  const row = await db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'prompt_caching_enabled'");
  return row?.value === 'true';
}

export type EditFormat = 'tool-call' | 'diff' | 'whole' | 'architect';

export async function getEditFormat(): Promise<EditFormat> {
  const db = await getAdapter();
  const row = await db.get<{ value: string }>("SELECT value FROM app_settings WHERE key = 'edit_format'");
  const val = row?.value ?? 'tool-call';
  return (['tool-call', 'diff', 'whole', 'architect'].includes(val) ? val : 'tool-call') as EditFormat;
}

export async function getKeysForMode(mode: string): Promise<KeyEntry[]> {
  const db = await getAdapter();
  return db.all<KeyEntry[]>('SELECT key_value, provider, model_id_override, priority FROM api_keys WHERE mode = ? AND is_active = 1 ORDER BY priority ASC', [mode]);

export async function getModelForMode(mode: string): Promise<string> {
  const db = await getAdapter();
  const row = await db.get<{ model_id: string }>('SELECT model_id FROM pricing_modes WHERE mode = ?', [mode]);
  return row?.model_id || 'deepseek-chat';
}

// -- Provider factory ------------------------------------------------------------

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * Known vision-capable model IDs per provider, in preference order (cheapest/fastest first).
 * Used when imageData is present in a request — we search ALL active keys across all modes.
 */
const VISION_MODEL_MAP: Record<string, string[]> = {
  Groq: ['llama-3.2-11b-vision-preview', 'llama-3.2-90b-vision-preview'],
  'OpenRouter': [
    'meta-llama/llama-3.2-11b-vision-instruct:free',
    'google/gemini-2.0-flash-lite-preview-02-05:free',
    'google/gemini-2.0-flash-exp:free',
  ],
  OpenAI: ['gpt-4o-mini', 'gpt-4o'],
  Anthropic: ['claude-3-haiku-20240307', 'claude-3-5-sonnet-20241022'],
  Gemini: ['gemini-2.0-flash-lite', 'gemini-2.0-flash'],
  HuggingFace: ['meta-llama/Llama-3.2-11B-Vision-Instruct'],
};

/**
 * Search ALL active API keys across all modes for vision-capable models.
 * Returns entries sorted by priority (primary keys first) so the agent loop
 * can use fallback iteration.
 */
export async function getVisionCapableModels(): Promise<Array<{ model: LanguageModel; provider: string }>> {
  const db = await getAdapter();
  const allKeys = await db.all<Array<{ key_value: string; provider: string; model_id_override: string | null; priority: number }>>(
    'SELECT key_value, provider, model_id_override, priority FROM api_keys WHERE is_active = 1 ORDER BY priority ASC'
  );

  const results: Array<{ model: LanguageModel; provider: string }> = [];
  const seen = new Set<string>();

  for (const key of allKeys) {
    const visionModels = VISION_MODEL_MAP[key.provider];
    if (!visionModels) continue;
    const dedupKey = `${key.provider}:${key.key_value.slice(0, 12)}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    for (const modelId of visionModels) {
      try {
        const model = buildLanguageModel(key, modelId);
        results.push({ model, provider: key.provider });
        break; // one vision model per key is enough
      } catch {
        continue; // try next model id for this key
      }
    }
  }

  return results;
}

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
    case 'Gemini':
      return createOpenAICompatible({
        name: 'gemini',
        baseURL: GEMINI_BASE_URL,
        apiKey: key_value,
      })(modelId);
    case 'Ollama':
      return createOpenAICompatible({
        name: 'ollama',
        baseURL: key_value || 'http://localhost:11434/v1',
        apiKey: 'ollama', // Ollama doesn't require API key auth by default
      })(modelId);
    case 'OpenAI-compatible':
      return createOpenAICompatible({
        name: 'custom',
        baseURL: key_value || 'http://localhost:8000/v1',
        apiKey: 'not-needed', // local/self-hosted endpoint, auth optional
      })(modelId);
    case 'HuggingFace':
      return createOpenAICompatible({
        name: 'huggingface',
        baseURL: 'https://api-inference.huggingface.co/v1/',
        apiKey: key_value, // HF access token from huggingface.co/settings/tokens
      })(modelId);
    default:
      return createOpenAI({ apiKey: key_value })(modelId);
  }
}

/**
 * Get all available models for a mode (sorted by priority) for fallback iteration.
 */
export async function getModelsForMode(mode: string): Promise<Array<{ model: LanguageModel; provider: string }>> {
  const keys = await getKeysForMode(mode);
  if (keys.length === 0) throw new Error(`No active API key configured for mode "${mode}"`);
  const modeModel = await getModelForMode(mode);
  return keys.map((key) => ({
    model: buildLanguageModel(key, key.model_id_override ?? modeModel),
    provider: key.provider,
  }));
}
