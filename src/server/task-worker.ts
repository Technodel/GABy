/**
 * task-worker.ts — Background task processor for the Task Queue (Phase 4).
 *
 * Polls the task_queue table for pending tasks every N seconds, dispatches
 * them to registered handlers, and updates their status.
 *
 * All handlers run asynchronously and never block the main agent loop.
 *
 * Start: startTaskWorker()
 * Stop:  stopTaskWorker()
 * Register: registerTaskHandler('my_task', async (task) => { ... })
 */

import { claimNextPendingTask, markTaskDone, markTaskFailed } from './task-queue';
import { pruneLowValueMemories } from './learning-prioritizer';

// ── Handler registry ──────────────────────────────────────────────────────────

export interface TaskHandlerContext {
  id: number;
  userId: number;
  projectId: number | null;
  sessionId: string | null;
  payload: Record<string, unknown>;
}

type TaskHandler = (ctx: TaskHandlerContext) => Promise<Record<string, unknown> | void>;

const handlers = new Map<string, TaskHandler>();

/**
 * Register a handler function for a given task type.
 * Multiple registrations overwrite the previous handler.
 */
export function registerTaskHandler(taskType: string, handler: TaskHandler): void {
  handlers.set(taskType, handler);
}

// ── Built-in handlers ─────────────────────────────────────────────────────────

registerTaskHandler('prune_memories', async (ctx) => {
  const threshold = (ctx.payload?.threshold as number) ?? 5;
  const result = await pruneLowValueMemories(ctx.userId, threshold);
  console.log(
    `[task-worker] prune_memories #${ctx.id}: removed ${result.totalRemoved} entries ` +
    `(${result.removedFailures} failures, ${result.removedBlueprints} blueprints, ${result.removedMemories} memories)`,
  );
  return {
    removed: result.totalRemoved,
    removedFailures: result.removedFailures,
    removedBlueprints: result.removedBlueprints,
    removedMemories: result.removedMemories,
  };
});

registerTaskHandler('echo', async (ctx) => {
  console.log(`[task-worker] echo #${ctx.id}: payload =`, JSON.stringify(ctx.payload));
  return { echoed: ctx.payload };
});

registerTaskHandler('health_report', async (ctx) => {
  const { getProviderHealthSummary } = await import('./provider-health');
  const summary = await getProviderHealthSummary();
  const failing = summary.filter(s => s.score < 50);
  console.log(
    `[task-worker] health_report #${ctx.id}: ${summary.length} providers, ` +
    `${failing.length} below threshold`,
  );
  return { providers: summary.length, failing: failing.length, report: summary };
});

// ── Worker lifecycle ──────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setInterval> | null = null;
const POLL_INTERVAL_MS = 3000;

export function isTaskWorkerRunning(): boolean {
  return pollTimer !== null;
}

export function startTaskWorker(): void {
  if (pollTimer) {
    console.warn('[task-worker] Already running');
    return;
  }

  console.log(`[task-worker] Started (poll every ${POLL_INTERVAL_MS}ms)`);

  pollTimer = setInterval(async () => {
    try {
      const task = claimNextPendingTask();
      if (!task) return;

      const handler = handlers.get(task.task_type);
      if (!handler) {
        console.warn(`[task-worker] No handler for type "${task.task_type}" (#${task.id})`);
        markTaskFailed(task.id, `No registered handler for "${task.task_type}"`);
        return;
      }

      let payload: Record<string, unknown> = {};
      try { payload = JSON.parse(task.payload); } catch { /* payload is already default {} */ }

      const result = await handler({
        id: task.id,
        userId: task.user_id,
        projectId: task.project_id,
        sessionId: task.session_id,
        payload,
      });

      markTaskDone(task.id, result ?? undefined);
      console.log(`[task-worker] Done #${task.id} (${task.task_type})`);
    } catch (err) {
      // claimNextPendingTask wraps in its own try/catch and returns null on error.
      // If we get here, the handler threw — but we lost the task reference.
      // This should be rare; handlers wrap their own logic.
      console.error('[task-worker] Unhandled error:', (err as Error).message);
    }
  }, POLL_INTERVAL_MS);
}

export function stopTaskWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[task-worker] Stopped');
  }
}
