/**
 * SUNy Personality Module
 *
 * Loads suny_status_messages.txt (project root) once at startup and serves
 * random messages by category. Also drives the "Did you know?" timer that
 * fires every 60 seconds during long-running tasks.
 *
 * File format:
 *   # comment lines and blank lines are ignored
 *   [section_name]
 *   message line 1
 *   message line 2
 *   ...
 */

import fs from 'fs';
import path from 'path';
import { userClientManager } from './user-client-manager';

type MessageBank = Record<string, string[]>;

let bank: MessageBank | null = null;

function loadBank(): MessageBank {
  if (bank) return bank;

  // Resolve to project root regardless of whether we're running from
  // src/server (ts-node-dev) or dist/server (compiled).
  const candidates = [
    path.join(process.cwd(), 'suny_status_messages.txt'),
    path.join(__dirname, '../../suny_status_messages.txt'),
    path.join(__dirname, '../../../suny_status_messages.txt'),
  ];

  let raw = '';
  for (const p of candidates) {
    try { raw = fs.readFileSync(p, 'utf8'); break; } catch { /* try next */ }
  }

  if (!raw) {
    console.warn('[personality] suny_status_messages.txt not found â€” using fallbacks');
    bank = {};
    return bank;
  }

  const result: MessageBank = {};
  let current = '';

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1];
      if (!result[current]) result[current] = [];
      continue;
    }

    if (current) result[current].push(line);
  }

  bank = result;

  const total = Object.values(result).reduce((s, a) => s + a.length, 0);
  console.log(`[personality] loaded ${total} messages across ${Object.keys(result).length} categories`);

  return bank;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public API
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Pick a random message from the given category.
 * Returns `fallback` if the category is empty or the file couldn't be loaded.
 */
export function pickRandom(category: string, fallback = ''): string {
  try {
    const b = loadBank();
    const arr = b[category];
    if (!arr || arr.length === 0) return fallback;
    return arr[Math.floor(Math.random() * arr.length)];
  } catch {
    return fallback;
  }
}

/**
 * Start a "Did you know?" timer that pushes a random fact to the user every
 * 60 seconds while a long task is running.
 *
 * Returns a cleanup function â€” call it when the task finishes so the interval
 * is cleared and no fact leaks after the response is done.
 *
 *   const stopFacts = startDidYouKnowTimer(userId, signal);
 *   try {
 *     await runAgentLoop(...);
 *   } finally {
 *     stopFacts();
 *   }
 */
export function startDidYouKnowTimer(userId: number, signal?: AbortSignal): () => void {
  const interval = setInterval(() => {
    if (signal?.aborted) {
      clearInterval(interval);
      return;
    }
    const fact = pickRandom('did_you_know');
    if (fact) {
      userClientManager.pushToUser(userId, 'suny:narration', {
        message: `ðŸ’¡ Did you know? ${fact}`,
      });
    }
  }, 60_000);

  const stop = () => clearInterval(interval);

  // Also stop if the abort signal fires before the first tick
  signal?.addEventListener('abort', stop, { once: true });

  return stop;
}

// Pre-load on module import so the first request is instant
try { loadBank(); } catch { /* non-fatal */ }
