/**
 * SUNy Context Manager â€” ported from Aider's history.py logic.
 *
 * Prevents context-window overflows by trimming the oldest conversation
 * messages when the estimated token count approaches the model's limit.
 *
 * Strategy (same as Aider):
 *   - Keep the most RECENT messages (they matter most)
 *   - Drop the OLDEST messages first
 *   - Never split a message mid-way â€” only drop whole messages
 *   - If even the last message is too large, truncate its content
 *   - Prepend a "[N messages omitted]" note when messages are dropped
 *   - Always reserve 25% of context for the model's response
 */

import type { CoreMessage } from 'ai';
import { compressToolResultsInContent } from './tool-result-compressor';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Context limits per provider (conservative estimates)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PROVIDER_CONTEXT: Record<string, number> = {
  Anthropic: 200_000,
  OpenAI: 128_000,
  Groq: 131_072,
  DeepSeek: 64_000,
  OpenRouter: 128_000,

  default: 128_000,
};

export function getContextLimit(provider: string): number {
  return PROVIDER_CONTEXT[provider] ?? PROVIDER_CONTEXT.default;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Token estimation â€” ~3.5 chars per token is a good conservative estimate
// for mixed English/code content.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function messageTokens(msg: CoreMessage): number {
  const content =
    typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content);
  return estimateTokens(content) + 4; // +4 for role/overhead per message
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Main export
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function compressOlderAssistantTurn(msg: CoreMessage): CoreMessage {
  if (typeof msg.content === 'string') {
    return { ...msg, content: '[Assistant text omitted for ephemeral memory]' };
  }
  if (!Array.isArray(msg.content)) return msg;

  const newContent = msg.content.map(part => {
    if (part.type === 'tool-call') {
      return { type: 'text', text: `[Tool call '${part.toolName}' executed]` };
    }
    if (part.type === 'text') {
      return { type: 'text', text: '[Assistant text omitted for ephemeral memory]' };
    }
    return part;
  });

  return { ...msg, content: newContent as any };
}

/**
 * Trim the message history so the full context (system + history + new message)
 * fits inside 75% of the model's context limit, leaving 25% for the response.
 *
 * @param messages     Full history INCLUDING the new user message (last element).
 * @param systemPrompt The system prompt text (counted against the budget).
 * @param provider     Provider name (used to look up context limit).
 */
export function trimHistory(
  messages: CoreMessage[],
  systemPrompt: string,
  provider: string,
): CoreMessage[] {
  if (!messages.length) return messages;

  const limit = getContextLimit(provider);
  const targetBudget = Math.floor(limit * 0.75); // keep 25% for response

  // System prompt is passed separately to streamText (not in messages array),
  // so it does not consume the conversation budget. Skip deducting it.
  let remaining = targetBudget;

  // Walk backwards: keep the most recent messages first.
  // Compress tool results before token-counting to reduce provider API costs.
  const kept: CoreMessage[] = [];
  let userTurns = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const rawMsg = messages[i];
    if (rawMsg.role === 'user') userTurns++;

    let msg: CoreMessage = Array.isArray(rawMsg.content)
      ? { ...rawMsg, content: compressToolResultsInContent(rawMsg.content) as CoreMessage['content'] }
      : rawMsg;

    // EPHEMERAL MEMORY: If older than 2 user turns, compress assistant reasoning to save huge amounts of tokens
    if (userTurns > 2 && msg.role === 'assistant') {
      msg = compressOlderAssistantTurn(msg);
    }

    const t = messageTokens(msg);
    if (remaining - t >= 0) {
      kept.unshift(msg);
      remaining -= t;
    } else if (kept.length === 0) {
      // Must keep at least the last message — truncate its content
      const raw = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const maxChars = Math.max(100, Math.floor(remaining * 3.5));
      const truncated = raw.slice(0, maxChars) + '\n[...truncated to fit context window...]';
      kept.unshift({ ...msg, content: truncated });
      break;
    } else {
      // Can't fit this message — stop here (all older messages dropped)
      break;
    }
  }

  // Prepend a summary note if we dropped messages
  const dropped = messages.length - kept.length;
  if (dropped > 0) {
    const note: CoreMessage = {
      role: 'user',
      content: `[${dropped} earlier message${dropped !== 1 ? 's' : ''} omitted — context window limit]`,
    };
    return [note, ...kept];
  }

  return kept;
}
