/**
 * benchmark.ts â€” Benchmark session recording.
 *
 * Records agent benchmark runs (speed, token usage, task completion)
 * for performance analysis and regression detection.
 */

import { getAdapter } from './db';

export interface BenchmarkRun {
  id?: number;
  userId: number;
  sessionId: string;
  taskType: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
  createdAt?: string;
}

/**
 * Record a benchmark run result.
 */
export async function recordBenchmarkRun(run: Omit<BenchmarkRun, 'id' | 'createdAt'>): Promise<void> {
  const db = getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      duration_ms INTEGER NOT NULL,
      success INTEGER NOT NULL DEFAULT 1,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.run(`
    INSERT INTO benchmark_runs (user_id, session_id, task_type, model_id, input_tokens, output_tokens,
       cache_write_tokens, cache_read_tokens, duration_ms, success, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    run.userId, run.sessionId, run.taskType, run.modelId,
    run.inputTokens, run.outputTokens, run.cacheWriteTokens, run.cacheReadTokens,
    run.durationMs, run.success ? 1 : 0, run.errorMessage || null,
  ]);
}
