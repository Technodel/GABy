/**
 * SUNy Context Summarizer â€” condenses older conversation history to save tokens.
 *
 * Two mechanisms:
 *   1. Tool (`summarize_history`) â€” AI explicitly requests summarization of
 *      older turns when it identifies the conversation is getting long.
 *   2. Auto-summarize â€” Before trimHistory() drops old messages, the agent
 *      loop can optionally compress them into a single condensed entry.
 *
 * The AI-powered summarization uses generateText() on the same provider/model
 * that's currently running, so it's consistent with the active conversation.
 */

import { generateText, type LanguageModel } from 'ai';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SummarizeOptions {
  /** The conversation text to condense */
  text: string;
  /** Target compression ratio (0.1 = 10% of original, 0.5 = 50%). Default 0.25. */
  targetRatio?: number;
  /** Maximum summary length in tokens. Overrides targetRatio if set. */
  maxTokens?: number;
}

export interface SummarizerContext {
  model: LanguageModel;
  provider: string;
  /** Abort signal to cancel in-flight summarization */
  signal?: AbortSignal;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Summarization prompt
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Turn this into SUMMARY.md once we get it right */
const SUMMARIZE_SYSTEM = `You are a conversation condenser. Your job is to compress the provided conversation history into a dense summary that preserves:

1. **User's actual requirements and goals** â€” what they're trying to build/fix
2. **Key decisions** â€” architecture choices, design tradeoffs, technology selections
3. **Files changed** â€” which files were modified, added, or deleted
4. **Errors encountered and fixes applied** â€” bugs found and how they were resolved
5. **Open issues** â€” anything left incomplete or deferred
6. **Current state** â€” what was the last thing that happened before this summary

Output format: A single paragraph or concise bullet list (3-8 lines maximum).
Do NOT include greetings, meta-commentary, or conversational filler.
Focus on WHAT was accomplished and WHAT remains.
Only include information that will be NEEDED in future turns.`;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Core summarization
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function summarizeConversation(
  ctx: SummarizerContext,
  options: SummarizeOptions,
): Promise<string> {
  const { text, targetRatio = 0.25, maxTokens } = options;

  // Estimate source length
  const sourceTokens = Math.ceil(text.length / 3.5);
  const budget = maxTokens ?? Math.max(150, Math.ceil(sourceTokens * targetRatio));

  const result = await generateText({
    model: ctx.model,
    system: SUMMARIZE_SYSTEM,
    messages: [
      {
        role: 'user',
        content: `Summarize this conversation (target ${budget} tokens max):\n\n${text.slice(0, 12000)}`,
      },
    ],
    maxTokens: budget + 50,
    abortSignal: ctx.signal,
    experimental_telemetry: { isEnabled: false },
  });

  return (result.text ?? '').trim() || '[Summary unavailable]';
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Auto-summarize check â€” called before trimHistory in agent-loop.ts
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface AutoSummarizeInput {
  rawMessages: Array<{ role: string; content: string }>;
  /** The system prompt (not counted in the "old" section) */
  systemPrompt: string;
  /** Provider context limit */
  contextLimit: number;
}

export interface AutoSummarizeResult {
  /** Whether summarization was performed */
  summarized: boolean;
  /** Updated messages (with old section condensed if summarized) */
  messages: Array<{ role: string; content: string }>;
  /** Summary text if summarization was performed */
  summary?: string;
}

/**
 * Check if the conversation is long enough to benefit from summarization.
 * If so, condense the oldest messages into a single summary entry.
 *
 * Trigger: history > 15 messages AND estimated tokens > 60% of context limit.
 */
export async function autoSummarizeIfNeeded(
  ctx: SummarizerContext,
  input: AutoSummarizeInput,
): Promise<AutoSummarizeResult> {
  const { rawMessages, contextLimit } = input;

  if (rawMessages.length < 15) {
    return { summarized: false, messages: rawMessages };
  }

  // Estimate total tokens
  const totalChars = rawMessages.reduce((sum, m) => sum + m.content.length, 0);
  const estimatedTokens = Math.ceil(totalChars / 3.5);

  // Only summarize if we're above 60% of context
  if (estimatedTokens < contextLimit * 0.6) {
    return { summarized: false, messages: rawMessages };
  }

  // Keep the last 6 messages (most recent), summarize everything older
  const splitIdx = Math.max(0, rawMessages.length - 6);
  const oldMessages = rawMessages.slice(0, splitIdx);
  const recentMessages = rawMessages.slice(splitIdx);

  // Don't summarize if the old section is too short
  if (oldMessages.length < 3) {
    return { summarized: false, messages: rawMessages };
  }

  const oldText = oldMessages
    .map((m) => `[${m.role}]: ${m.content.slice(0, 500)}`)
    .join('\n\n');

  try {
    const summary = await summarizeConversation(ctx, {
      text: oldText,
      targetRatio: 0.2,
      maxTokens: 400,
    });

    const summaryMessage = {
      role: 'user' as const,
      content: `[Summarized ${oldMessages.length} earlier messages]:\n${summary}`,
    };

    return {
      summarized: true,
      messages: [summaryMessage, ...recentMessages],
      summary,
    };
  } catch {
    // If summarization fails, proceed without it
    return { summarized: false, messages: rawMessages };
  }
}
