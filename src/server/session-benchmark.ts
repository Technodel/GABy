/**
 * SUNy Session Benchmark Tracker â€” per-session performance metrics.
 *
 * Records execution metrics for every task turn so SUNy can:
 *   1. Track improvement over time (week-over-week, month-over-month)
 *   2. Compare success rates across projects, modes, models
 *   3. Surface trends to the AI and the user
 *
 * Feature flag: ff_session_benchmark
 */

import { getDb } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface SessionBenchmark {
  id: number;
  userId: number;
  projectId: number | null;
  sessionId: string;
  taskMode: string;
  turnIndex: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  steps: number;
  toolCalls: number;
  lintRuns: number;
  lintErrorsFound: number;
  lintPassed: number;
  testRuns: number;
  testFailuresFound: number;
  testPassed: number;
  filesChanged: number;
  stagesCompleted: number;
  errorCount: number;
  success: number;
  created_at: string;
}

export interface BenchmarkSummary {
  totalSessions: number;
  totalTasks: number;
  successRate: number;
  avgDurationMs: number;
  avgTokens: number;
  avgSteps: number;
  avgFilesChanged: number;
  avgErrorCount: number;
  lintSuccessRate: number;
  testSuccessRate: number;
  weekOverWeek: {
    successRateDelta: number | null;
    durationDelta: number | null;
    tokenDelta: number | null;
  };
}

export interface BenchmarkTrend {
  date: string;
  totalTasks: number;
  successRate: number;
  avgDurationMs: number;
  avgTokens: number;
  avgSteps: number;
}

// â”€â”€ DB initialization â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function initializeSessionBenchmarkTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_benchmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      session_id TEXT NOT NULL,
      task_mode TEXT DEFAULT '',
      turn_index INTEGER DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      steps INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      lint_runs INTEGER DEFAULT 0,
      lint_errors_found INTEGER DEFAULT 0,
      lint_passed INTEGER DEFAULT 0,
      test_runs INTEGER DEFAULT 0,
      test_failures_found INTEGER DEFAULT 0,
      test_passed INTEGER DEFAULT 0,
      files_changed INTEGER DEFAULT 0,
      stages_completed INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      success INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_benchmarks_user ON session_benchmarks(user_id);
    CREATE INDEX IF NOT EXISTS idx_benchmarks_project ON session_benchmarks(project_id);
    CREATE INDEX IF NOT EXISTS idx_benchmarks_created ON session_benchmarks(created_at);
    CREATE INDEX IF NOT EXISTS idx_benchmarks_success ON session_benchmarks(success);
  `);
}

// â”€â”€ Record a benchmark entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function recordBenchmark(entry: {
  userId: number;
  projectId: number | null;
  sessionId: string;
  taskMode: string;
  turnIndex: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number;
  cacheReadTokens?: number;
  steps: number;
  toolCalls: number;
  lintRuns: number;
  lintErrorsFound: number;
  lintPassed: boolean;
  testRuns: number;
  testFailuresFound: number;
  testPassed: boolean;
  filesChanged: number;
  stagesCompleted: number;
  errorCount: number;
  success: boolean;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO session_benchmarks (
      user_id, project_id, session_id, task_mode, turn_index,
      duration_ms, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
      steps, tool_calls, lint_runs, lint_errors_found, lint_passed,
      test_runs, test_failures_found, test_passed, files_changed, stages_completed,
      error_count, success
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId,
    entry.projectId,
    entry.sessionId,
    entry.taskMode,
    entry.turnIndex,
    entry.durationMs,
    entry.inputTokens,
    entry.outputTokens,
    entry.cacheWriteTokens ?? 0,
    entry.cacheReadTokens ?? 0,
    entry.steps,
    entry.toolCalls,
    entry.lintRuns,
    entry.lintErrorsFound,
    entry.lintPassed ? 1 : 0,
    entry.testRuns,
    entry.testFailuresFound,
    entry.testPassed ? 1 : 0,
    entry.filesChanged,
    entry.stagesCompleted,
    entry.errorCount,
    entry.success ? 1 : 0,
  );
}

// â”€â”€ Query methods â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get a summary of benchmark performance for a user.
 * Compares current week vs previous week for trend detection.
 */
export function getBenchmarkSummary(userId: number): BenchmarkSummary {
  const db = getDb();

  const allRows = db.prepare(
    'SELECT * FROM session_benchmarks WHERE user_id = ? ORDER BY created_at',
  ).all(userId) as SessionBenchmark[];

  if (allRows.length === 0) {
    return {
      totalSessions: 0,
      totalTasks: 0,
      successRate: 0,
      avgDurationMs: 0,
      avgTokens: 0,
      avgSteps: 0,
      avgFilesChanged: 0,
      avgErrorCount: 0,
      lintSuccessRate: 0,
      testSuccessRate: 0,
      weekOverWeek: { successRateDelta: null, durationDelta: null, tokenDelta: null },
    };
  }

  const totalTasks = allRows.length;
  const successful = allRows.filter(r => r.success);
  const successRate = totalTasks > 0 ? (successful.length / totalTasks) * 100 : 0;
  const avgDurationMs = allRows.reduce((s, r) => s + r.duration_ms, 0) / totalTasks;
  const avgTokens = allRows.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0) / totalTasks;
  const avgSteps = allRows.reduce((s, r) => s + r.steps, 0) / totalTasks;
  const avgFilesChanged = allRows.reduce((s, r) => s + r.files_changed, 0) / totalTasks;
  const avgErrorCount = allRows.reduce((s, r) => s + r.error_count, 0) / totalTasks;
  const lintTasks = allRows.filter(r => r.lint_runs > 0);
  const lintSuccessRate = lintTasks.length > 0
    ? (lintTasks.filter(r => r.lint_passed).length / lintTasks.length) * 100 : 0;
  const testTasks = allRows.filter(r => r.test_runs > 0);
  const testSuccessRate = testTasks.length > 0
    ? (testTasks.filter(r => r.test_passed).length / testTasks.length) * 100 : 0;

  // Week-over-week comparison
  const now = new Date();
  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const thisWeek = allRows.filter(r => new Date(r.created_at) >= oneWeekAgo);
  const lastWeek = allRows.filter(r => {
    const d = new Date(r.created_at);
    return d >= twoWeeksAgo && d < oneWeekAgo;
  });

  let weekOverWeek = { successRateDelta: null as number | null, durationDelta: null as number | null, tokenDelta: null as number | null };

  if (thisWeek.length > 0 && lastWeek.length > 0) {
    const thisSuccess = thisWeek.filter(r => r.success).length / thisWeek.length;
    const lastSuccess = lastWeek.filter(r => r.success).length / lastWeek.length;
    weekOverWeek.successRateDelta = (thisSuccess - lastSuccess) * 100;

    const thisDuration = thisWeek.reduce((s, r) => s + r.duration_ms, 0) / thisWeek.length;
    const lastDuration = lastWeek.reduce((s, r) => s + r.duration_ms, 0) / lastWeek.length;
    weekOverWeek.durationDelta = lastDuration > 0
      ? ((thisDuration - lastDuration) / lastDuration) * 100 : null;

    const thisTokens = thisWeek.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0) / thisWeek.length;
    const lastTokens = lastWeek.reduce((s, r) => s + r.input_tokens + r.output_tokens, 0) / lastWeek.length;
    weekOverWeek.tokenDelta = lastTokens > 0
      ? ((thisTokens - lastTokens) / lastTokens) * 100 : null;
  }

  // Determine unique sessions (by session_id)
  const uniqueSessions = new Set(allRows.map(r => r.session_id)).size;

  return {
    totalSessions: uniqueSessions,
    totalTasks,
    successRate: Math.round(successRate * 100) / 100,
    avgDurationMs: Math.round(avgDurationMs),
    avgTokens: Math.round(avgTokens),
    avgSteps: Math.round(avgSteps * 100) / 100,
    avgFilesChanged: Math.round(avgFilesChanged * 100) / 100,
    avgErrorCount: Math.round(avgErrorCount * 100) / 100,
    lintSuccessRate: Math.round(lintSuccessRate * 100) / 100,
    testSuccessRate: Math.round(testSuccessRate * 100) / 100,
    weekOverWeek,
  };
}

/**
 * Get daily trend data for the last N days.
 */
export function getBenchmarkTrend(userId: number, days: number = 30): BenchmarkTrend[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const rows = db.prepare(
    `SELECT date(created_at) as day,
            COUNT(*) as total_tasks,
            ROUND(AVG(success) * 100, 2) as success_rate,
            ROUND(AVG(duration_ms)) as avg_duration_ms,
            ROUND(AVG(input_tokens + output_tokens)) as avg_tokens,
            ROUND(AVG(steps), 2) as avg_steps
     FROM session_benchmarks
     WHERE user_id = ? AND created_at >= ?
     GROUP BY date(created_at)
     ORDER BY day ASC`
  ).all(userId, cutoff) as Array<{
    day: string; total_tasks: number; success_rate: number;
    avg_duration_ms: number; avg_tokens: number; avg_steps: number;
  }>;

  return rows.map(r => ({
    date: r.day,
    totalTasks: r.total_tasks,
    successRate: r.success_rate,
    avgDurationMs: r.avg_duration_ms,
    avgTokens: r.avg_tokens,
    avgSteps: r.avg_steps,
  }));
}

/**
 * Get the latest N benchmarks for a project.
 */
export function getProjectBenchmarks(projectId: number, limit: number = 20): SessionBenchmark[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM session_benchmarks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(projectId, limit) as SessionBenchmark[];
}

/**
 * Format benchmark summary as a readable string for AI injection.
 */
export function formatBenchmarkSummary(summary: BenchmarkSummary): string {
  if (summary.totalTasks === 0) return 'No benchmark data yet.';

  let result = `[BENCHMARK SUMMARY â€” ${summary.totalTasks} tasks across ${summary.totalSessions} sessions]\n`;
  result += `  Success rate: ${summary.successRate}%\n`;
  result += `  Avg duration: ${summary.avgDurationMs}ms\n`;
  result += `  Avg tokens: ${summary.avgTokens}\n`;
  result += `  Avg steps: ${summary.avgSteps}\n`;
  result += `  Avg files changed: ${summary.avgFilesChanged}\n`;
  result += `  Avg errors: ${summary.avgErrorCount}\n`;
  result += `  Lint pass rate: ${summary.lintSuccessRate}%\n`;
  result += `  Test pass rate: ${summary.testSuccessRate}%\n`;

  if (summary.weekOverWeek.successRateDelta !== null) {
    result += `\n[WEEK OVER WEEK]\n`;
    const sr = summary.weekOverWeek.successRateDelta;
    result += `  Success rate: ${sr >= 0 ? '+' : ''}${sr.toFixed(1)}%\n`;
    const dur = summary.weekOverWeek.durationDelta;
    if (dur !== null) {
      result += `  Duration: ${dur >= 0 ? '+' : ''}${dur.toFixed(1)}% ${dur < 0 ? '(faster!)' : '(slower)'}\n`;
    }
    const tok = summary.weekOverWeek.tokenDelta;
    if (tok !== null) {
      result += `  Tokens: ${tok >= 0 ? '+' : ''}${tok.toFixed(1)}% ${tok < 0 ? '(more efficient!)' : '(more expensive)'}\n`;
    }
  }

  return result;
}
