/**
 * fallbacks.ts — Shared reply-fallback utilities.
 *
 * Extracted from index.ts to break the circular dependency
 * between index.ts and ws-handler.ts.
 *
 * Usage:
 *   import { ERROR_REPLY_FALLBACKS, EXHAUSTED_REPLY_FALLBACKS,
 *            EMPTY_FINAL_REPLY_FALLBACKS, pickNonRepeatingFallback,
 *            normalizeFinalContent }
 *     from './fallbacks';
 */

export const EMPTY_FINAL_REPLY_FALLBACKS = [
  "Done.",
  "All set \u2014 check your project for the changes.",
  "Finished. Take a look at the results above.",
  "Task complete.",
];

export const ERROR_REPLY_FALLBACKS = [
  'Something unexpected happened on my side. Please try again in a moment. 💪',
  "I hit a temporary issue while finishing that request. Please send it again and I'll retry.",
  "That run failed unexpectedly. Try once more and I'll take another path.",
  'I ran into an internal hiccup just now. Please retry and I will continue.',
];

export const EXHAUSTED_REPLY_FALLBACKS = [
  'All AI models are currently unavailable. Please try again later or contact support. 🤖💤',
  'Looks like every model is taking a nap right now. Try again in a bit or reach out to support!',
  'All providers are tapped out at the moment. Please retry later or ping support for help.',
  'No AI model could complete your request — they\'re all down. Try again soon, or contact support.',
  'The AI backend is having a moment. All models exhausted. Please try again later or contact support.',
  'Every single model returned an error. Something\'s wrong on the backend — try again later or contact support.',
  'We\'ve hit a full provider blackout. All models exhausted. Please retry later or contact support.',
  'All AI models are currently offline. Please try again later or contact support for assistance.',
  'The AI service is completely unavailable right now. All models exhausted. Try again later or contact support.',
  'Well, this is awkward — every model failed. Please try again later or contact support.',
];

const lastFallbackByUser = new Map<number, string>();

export function normalizeFinalContent(userId: number, rawContent: unknown): string {
  const content = String(rawContent || '').trim();
  if (!content) {
    return pickNonRepeatingFallback(userId, EMPTY_FINAL_REPLY_FALLBACKS);
  }

  // Guard against model-generated meta-commentary about missing output.
  // These patterns indicate the model is talking about its own response
  // instead of producing actual content.
  const looksLikeMissingFinalText = /didn't receive a final reply text|please send that again|final text didn't come through|was empty on my side/i.test(content);
  if (looksLikeMissingFinalText) {
    return pickNonRepeatingFallback(userId, EMPTY_FINAL_REPLY_FALLBACKS);
  }

  return content;
}

export function pickNonRepeatingFallback(userId: number, choices: string[]): string {
  if (choices.length === 0) return '';
  if (choices.length === 1) return choices[0];
  const last = lastFallbackByUser.get(userId);
  const pool = choices.filter(choice => choice !== last);
  const selected = pool[Math.floor(Math.random() * pool.length)] || choices[0];
  lastFallbackByUser.set(userId, selected);
  return selected;
}
