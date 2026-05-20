/**
 * SUNy Per-User Request Queue — concurrency cap for agent loops.
 *
 * Prevents SQLite contention and runaway token spend by limiting concurrent
 * runAgentLoop invocations per user. Max 2 concurrent; overflow returns 429.
 *
 * Pure in-memory — no DB, no persistence. Resets on server restart.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

interface QueueEntry<T = unknown> {
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

interface UserQueueState {
  /** Number of currently executing agent turns */
  active: number;
  /** Pending callbacks waiting for their turn */
  queue: QueueEntry[];
}

const MAX_CONCURRENT_PER_USER = 2;
const MAX_QUEUE_DEPTH = 5;

const userStates = new Map<number, UserQueueState>();

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wrap an agent loop call with per-user concurrency limiting.
 *
 * - If fewer than MAX_CONCURRENT_PER_USER are running, executes immediately.
 * - If at capacity, enqueues the call. Resolves when a slot opens.
 * - If queue exceeds MAX_QUEUE_DEPTH, throws a 429 error.
 *
 * @param userId  The user making the request
 * @param fn      Async function to execute (typically runAgentLoop)
 * @returns       The return value of fn
 */
export async function withUserQueue<T>(
  userId: number,
  fn: () => Promise<T>,
): Promise<T> {
  let state = userStates.get(userId);
  if (!state) {
    state = { active: 0, queue: [] };
    userStates.set(userId, state);
  }

  // If under the limit, run immediately
  if (state.active < MAX_CONCURRENT_PER_USER) {
    return runWithTracking(state, fn);
  }

  // At capacity — check queue depth
  if (state.queue.length >= MAX_QUEUE_DEPTH) {
    throw Object.assign(new Error('Too many pending requests'), {
      statusCode: 429,
      detail: `User ${userId} has ${state.active} active + ${state.queue.length} queued turns. Max queue depth: ${MAX_QUEUE_DEPTH}.`,
    });
  }

  // Enqueue
  return new Promise<T>((resolve, reject) => {
    state!.queue.push({ fn, resolve: resolve as (v: unknown) => void, reject, enqueuedAt: Date.now() });
  });
}

/**
 * Get current queue stats for a user (for diagnostics/debugging).
 */
export function getUserQueueStats(userId: number): {
  active: number;
  queued: number;
  position: number | null;
} | null {
  const state = userStates.get(userId);
  if (!state) return null;
  return {
    active: state.active,
    queued: state.queue.length,
    position: state.active >= MAX_CONCURRENT_PER_USER ? state.queue.length : 0,
  };
}

/**
 * Get overall queue stats (for the /metrics endpoint).
 */
export function getGlobalQueueStats(): {
  totalActive: number;
  totalQueued: number;
  totalUsers: number;
} {
  let totalActive = 0;
  let totalQueued = 0;
  let totalUsers = 0;
  for (const state of userStates.values()) {
    totalActive += state.active;
    totalQueued += state.queue.length;
    totalUsers++;
  }
  return { totalActive, totalQueued, totalUsers };
}

// ── Internal ──────────────────────────────────────────────────────────────────

async function runWithTracking<T>(state: UserQueueState, fn: () => Promise<T>): Promise<T> {
  state.active++;
  try {
    return await fn();
  } finally {
    state.active--;
    // Dequeue next waiting request and execute its specific fn
    if (state.queue.length > 0) {
      const next = state.queue.shift()!;
      // Execute in next microtask to avoid stack issues
      Promise.resolve().then(() => {
        runWithTracking(state, next.fn).then(next.resolve, next.reject);
      });
    }
  }
}
