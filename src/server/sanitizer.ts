/**
 * Information Firewall â€” sanitizeForUser() and friendlyError()
 *
 * This module is the single enforcement point for Phase 11.
 * ALL data leaving the server toward user-facing clients MUST pass through here.
 * Technical terms, model names, token counts, costs â€” none of it ever reaches users.
 *
 * Strategy:
 *   - BLOCKED_KEYS strips technical metadata keys from object payloads (e.g. model_id,
 *     inputTokens, rawCost). These are internal-only fields that should never reach the client.
 *   - BLOCKED_PATTERNS applies regex replacement to string values in UI chrome payloads
 *     (narration messages, tool call displays, status badges, error messages, etc.) to
 *     prevent model/provider names from appearing in the UI shell.
 *   - Chat content (suny:stream_chunk, suny:stream_end) is NEVER string-sanitized â€” doing so
 *     corrupts the AI's legitimate responses. Use buildChatEvent() for those events.
 *     The AI's system prompt handles preventing technical leaks in natural language.
 */

// Absolute blacklist: keys that must never appear in user-facing payloads
const BLOCKED_KEYS = new Set([
  'model', 'modelName', 'modelId', 'model_name', 'model_id',
  'provider', 'providerName', 'provider_name',
  'inputTokens', 'outputTokens', 'totalTokens', 'contextTokens',
  'input_tokens', 'output_tokens', 'total_tokens', 'context_tokens',
  'tokens', 'token_count', 'tokenCount',
  'rawCost', 'chargedCost', 'costBreakdown', 'costPerToken',
  'raw_cost', 'charged_cost', 'cost_breakdown', 'cost_per_token',
  'apiKey', 'api_key', 'apiKeyId', 'api_key_id',
  'temperature', 'top_p', 'topP', 'max_tokens', 'maxTokens',
  'stop_sequences', 'stopSequences', 'contextWindow', 'context_window',
  'latency', 'requestId', 'request_id',
  'stackTrace', 'stack_trace', 'stack',
  'endpoint', 'baseUrl', 'base_url',
  'markup_formula', 'markupFormula',
  'input_token_base_cost', 'output_token_base_cost',
]);

// Terms that must not appear in string values sent to users (UI chrome only)
const BLOCKED_PATTERNS = [
  /\bclaude\b/gi,
  /\bgpt[-\s]?\d/gi,
  /\bgemini\b/gi,
  /\bhaiku\b/gi,
  /\bsonnet\b/gi,
  /\bopus\b/gi,
  /\bmistral\b/gi,
  /\bllama\b/gi,
  /\bdeepseek\b/gi,
  /\banthropic\b/gi,
  /\bopenai\b/gi,
  /\bgoogle\s+ai\b/gi,
  /\btoken(s)?\b/gi,
  /\bllm\b/gi,
  /\blarge\s+language\s+model\b/gi,
  /\bapi\s+key\b/gi,
  /\bmodel\s+name\b/gi,
  /\bprovider\b/gi,
  /\bembedding\b/gi,
  /\bvector\b/gi,
  /\bcontext\s+window\b/gi,
  /\$[\d.]+\s*\/\s*(1k|1M)\s*token/gi,
];

/**
 * Full sanitization â€” strips blocked keys AND applies regex patterns to string values.
 * Use this for UI chrome payloads (narration, tool calls, status, errors, etc.).
 */
export function sanitizeForUser(data: unknown): unknown {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    return sanitizeString(data);
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeForUser);
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key)) continue;
      result[key] = sanitizeForUser(value);
    }
    return result;
  }

  return data;
}

/**
 * Lightweight sanitization â€” strips blocked keys only, leaves string values untouched.
 * Use this for AI chat content (stream chunks, final responses) where the AI should
 * be free to use natural language including model/provider names.
 */
export function sanitizeForChatContent(data: unknown): unknown {
  if (data === null || data === undefined) return data;

  // Strings pass through unchanged â€” the AI prompt handles language-level sanitization
  if (typeof data === 'string') return data;

  if (Array.isArray(data)) {
    return data.map(sanitizeForChatContent);
  }

  if (typeof data === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key)) continue;
      result[key] = sanitizeForChatContent(value);
    }
    return result;
  }

  return data;
}

function sanitizeString(str: string): string {
  let result = str;
  for (const pattern of BLOCKED_PATTERNS) {
    result = result.replace(pattern, '[SUNy]');
  }
  return result;
}

/**
 * Translates internal technical errors into friendly user-facing messages.
 * Raw error messages, stack traces, and HTTP codes never reach users.
 */
export function friendlyError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes('invalid_api_key') || lowerMsg.includes('401') || lowerMsg.includes('unauthorized')) {
    return "SUNy is having a bit of trouble connecting. We're on it! ðŸ”§";
  }
  if (lowerMsg.includes('rate_limit') || lowerMsg.includes('429') || lowerMsg.includes('too many')) {
    return 'SUNy needs a quick breather â€” try again in a moment ðŸ˜„';
  }
  if (lowerMsg.includes('balance') || lowerMsg.includes('credit') || lowerMsg.includes('insufficient')) {
    return "Looks like you're out of credits! Reach out and we'll top you up ðŸ˜Š";
  }
  if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out')) {
    return "SUNy is taking a bit longer than usual â€” hang tight or try again! â³";
  }
  if (lowerMsg.includes('network') || lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound')) {
    return "Having a little trouble reaching the network. Let's try that again! ðŸŒ";
  }

  return 'Hmm, something unexpected happened. SUNy is already trying again! ðŸ’ª';
}

/**
 * Build a safe WebSocket event payload for user clients.
 * Applies full sanitization (keys + string patterns) â€” use for UI chrome events.
 * Chat content (stream chunks, final responses) should use buildChatEvent() instead.
 */
export function buildUserEvent(event: string, payload: Record<string, unknown>): string {
  const safePayload = sanitizeForUser(payload) as Record<string, unknown>;
  return JSON.stringify({ event, ...safePayload });
}

/**
 * Build a chat content WebSocket event for user clients.
 * Applies key-only sanitization â€” string values (the AI's actual responses) pass through unchanged.
 */
export function buildChatEvent(event: string, payload: Record<string, unknown>): string {
  const safePayload = sanitizeForChatContent(payload) as Record<string, unknown>;
  return JSON.stringify({ event, ...safePayload });
}
