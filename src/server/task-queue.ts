/**
 * task-queue.ts â€” Low-level task queue backed by the DB interaction_memory table.
 *
 * Provides atomic claim-and-execute semantics for background workers.
 * This is a lightweight in-process queue â€” not suitable for multi-process
 * workloads without a shared lock store.
 */

import { getDb } from './db';

export interface Task {
  id?: number;
  userId: number;
  taskType: string;
  payload: Record<string, unknown>;
  priority: number;
  status?: 'pending' | 'running' | 'done' | 'failed';
  createdAt?: string;
  claimedAt?: string;
  doneAt?: string;
  error?: string;
}

/**
 * Initialize the task_queue table (called on server startup).
 */
export function initializeTaskQueueTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      task_type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      priority INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      claimed_at TEXT,
      done_at TEXT,
      error TEXT
    )
  `);
}

/**
 * Enqueue a task for background processing.
 */
export function enqueueTask(task: Omit<Task, 'id' | 'status' | 'createdAt'>): number {
  const db = getDb();
  initializeTaskQueueTable();
  const info = db.prepare(`
    INSERT INTO task_queue (user_id, task_type, payload, priority)
    VALUES (?, ?, ?, ?)
  `).run(task.userId, task.taskType, JSON.stringify(task.payload), task.priority);
  return Number(info.lastInsertRowid);
}

/**
 * Atomically claim the highest-priority pending task for a worker.
 */
export function claimNextPendingTask(): Task | null {
  const db = getDb();
  initializeTaskQueueTable();
  const row = db.prepare(`
    SELECT id, user_id as userId, task_type as taskType, payload, priority, status,
           created_at as createdAt, claimed_at as claimedAt, done_at as doneAt, error
    FROM task_queue
    WHERE status = 'pending'
    ORDER BY priority ASC, id ASC
    LIMIT 1
  `).get() as Task | undefined;
  if (!row) return null;
  db.prepare(`UPDATE task_queue SET status = 'running', claimed_at = datetime('now') WHERE id = ?`).run(row.id);
  row.payload = typeof row.payload === 'string' ? JSON.parse(row.payload as string) : row.payload;
  return row;
}

/**
 * Mark a task as done.
 */
export function markTaskDone(id: number): void {
  initializeTaskQueueTable();
  getDb().prepare(`UPDATE task_queue SET status = 'done', done_at = datetime('now') WHERE id = ?`).run(id);
}

/**
 * Mark a task as failed.
 */
export function markTaskFailed(id: number, error: string): void {
  initializeTaskQueueTable();
  getDb().prepare(`UPDATE task_queue SET status = 'failed', done_at = datetime('now'), error = ? WHERE id = ?`).run(error, id);
}
