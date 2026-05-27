/**
 * SUNy Failure Memory â€” persistent error pattern storage for smarter retries.
 *
 * When a build, lint, test, or runtime error occurs, the system records:
 *   1. The error pattern (message + type)
 *   2. The context (file + function + relevant code snippet)
 *   3. The attempted fix
 *   4. Whether the fix succeeded or failed
 *
 * On subsequent similar errors, the system recalls past failures and their
 * resolutions, enabling the AI to avoid repeating failed strategies.
 *
 * Feature flag: ff_failure_memory
 */

import { getDb } from './db';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Types
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export type ErrorSource = 'lint' | 'test' | 'build' | 'runtime' | 'shell' | 'typecheck';

export interface FailureRecord {
  id?: number;
  user_id: number;
  project_id: number | null;
  error_source: ErrorSource;
  error_pattern: string;
  error_message: string;
  file_path: string;
  function_name: string;
  context_snippet: string;
  attempted_fix: string;
  fix_succeeded: number;
  recurrence_count: number;
  created_at: string;
  // camelCase aliases for backward compat
  userId?: number;
  projectId?: number | null;
  errorSource?: ErrorSource;
  errorPattern?: string;
  errorMessage?: string;
  filePath?: string;
  functionName?: string;
  contextSnippet?: string;
  attemptedFix?: string;
  fixSucceeded?: boolean;
  recurrenceCount?: number;
  createdAt?: string;
}

export interface FailureMatch {
  record: FailureRecord;
  similarity: number;
  previousFixWorked: boolean;
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Database setup
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export function initializeFailureMemoryTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS failure_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      error_source TEXT NOT NULL,
      error_pattern TEXT NOT NULL,
      error_message TEXT NOT NULL,
      file_path TEXT DEFAULT '',
      function_name TEXT DEFAULT '',
      context_snippet TEXT DEFAULT '',
      attempted_fix TEXT DEFAULT '',
      fix_succeeded INTEGER DEFAULT 0,
      recurrence_count INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_failure_memory_user ON failure_memory(user_id);
    CREATE INDEX IF NOT EXISTS idx_failure_memory_pattern ON failure_memory(error_pattern);
    CREATE INDEX IF NOT EXISTS idx_failure_memory_source ON failure_memory(error_source);
  `);
}

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Core operations
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Generate a normalized error pattern from an error message.
 * Strips line numbers, timestamps, and variable values to create a reusable key.
 */
export function normalizeErrorPattern(errorMessage: string): string {
  return errorMessage
    .slice(0, 300)
    .replace(/\b\d+\b/g, 'N')                          // Replace numbers with N
    .replace(/['"][^'"]*['"]/g, '"..."')                 // Replace quoted strings
    .replace(/`[^`]*`/g, '`...`')                        // Replace template literals
    .replace(/(:\d+:\d+)/g, ':N:N')                      // Replace line:col
    .replace(/\(.*?\)/g, '(...)')                        // Replace parenthesized content
    .replace(/\s+/g, ' ')                                // Collapse whitespace
    .trim()
    .slice(0, 200);
}

/**
 * Extract a function name from context (file path + error message).
 */
export function extractFunctionName(filePath: string, errorMessage: string): string {
  // Try to find function name in error message (e.g., "at myFunction", "in render")
  const atMatch = errorMessage.match(/\b(?:at|in)\s+(\w+)/);
  if (atMatch) return atMatch[1];

  // Try to infer from file path
  const fileName = filePath.split(/[/\\]/).pop()?.replace(/\.\w+$/, '') || '';
  return fileName;
}

/**
 * Record a new failure in memory.
 */
export function recordFailure(input: {
  userId: number;
  projectId: number | null;
  errorSource: ErrorSource;
  errorMessage: string;
  filePath?: string;
  contextSnippet?: string;
  attemptedFix?: string;
  fixSucceeded?: boolean;
}): void {
  const db = getDb();
  const pattern = normalizeErrorPattern(input.errorMessage);
  const functionName = extractFunctionName(input.filePath || '', input.errorMessage);

  // Check if we already have a similar failure
  const existing = db.prepare(
    `SELECT id, recurrence_count, attempted_fix, fix_succeeded
     FROM failure_memory
     WHERE user_id = ? AND error_pattern = ? AND error_source = ?
     ORDER BY created_at DESC LIMIT 1`
  ).get(input.userId, pattern, input.errorSource) as { id: number; recurrence_count: number; attempted_fix: string; fix_succeeded: number } | undefined;

  if (existing) {
    // Update recurrence count and optionally record new fix attempt
    if (input.attemptedFix) {
      db.prepare(
        `UPDATE failure_memory
         SET recurrence_count = recurrence_count + 1,
             attempted_fix = ?,
             fix_succeeded = ?,
             error_message = ?,
             file_path = ?,
             context_snippet = ?,
             function_name = ?,
             created_at = datetime('now')
         WHERE id = ?`
      ).run(
        input.attemptedFix,
        input.fixSucceeded ? 1 : 0,
        input.errorMessage.slice(0, 1000),
        input.filePath || '',
        input.contextSnippet?.slice(0, 500) || '',
        functionName,
        existing.id,
      );
    } else {
      db.prepare(
        'UPDATE failure_memory SET recurrence_count = recurrence_count + 1, created_at = datetime(\'now\') WHERE id = ?'
      ).run(existing.id);
    }
  } else {
    db.prepare(
      `INSERT INTO failure_memory
       (user_id, project_id, error_source, error_pattern, error_message, file_path,
        function_name, context_snippet, attempted_fix, fix_succeeded)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.userId,
      input.projectId,
      input.errorSource,
      pattern,
      input.errorMessage.slice(0, 1000),
      input.filePath || '',
      functionName,
      input.contextSnippet?.slice(0, 500) || '',
      input.attemptedFix?.slice(0, 1000) || '',
      input.fixSucceeded ? 1 : 0,
    );
  }
}

/**
 * Find past failures that match the given error.
 * Returns failures ranked by similarity, with the most relevant first.
 */
export function findMatchingFailures(
  userId: number,
  errorMessage: string,
  options?: { errorSource?: ErrorSource; filePath?: string; limit?: number },
): FailureMatch[] {
  const db = getDb();
  const limit = options?.limit ?? 5;
  const pattern = normalizeErrorPattern(errorMessage);
  const conditions: string[] = ['user_id = ?'];
  const params: (string | number)[] = [userId];

  // Match by error pattern (exact match = high similarity)
  conditions.push('error_pattern = ?');
  params.push(pattern);

  if (options?.errorSource) {
    conditions.push('error_source = ?');
    params.push(options.errorSource);
  }

  // Also search for partially matching patterns (broader recall)
  const where = conditions.join(' AND ');

  const exactRows = db.prepare(
    `SELECT id, user_id, project_id, error_source, error_pattern, error_message,
            file_path, function_name, context_snippet, attempted_fix, fix_succeeded,
            recurrence_count, created_at
     FROM failure_memory
     WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ?`
  ).all(limit, ...params) as FailureRecord[];

  let results: FailureMatch[] = exactRows.map(r => ({
    record: r,
    similarity: r.error_pattern === pattern ? 1.0 : 0.8,
    previousFixWorked: r.fix_succeeded === 1,
  }));

  // If exact matches are few, also search broader pattern (fuzzy match)
  if (results.length < 3) {
    const fuzzyPattern = pattern.split(' ').slice(0, 5).join(' ');
    const fuzzyRows = db.prepare(
      `SELECT id, user_id, project_id, error_source, error_pattern, error_message,
              file_path, function_name, context_snippet, attempted_fix, fix_succeeded,
              recurrence_count, created_at
       FROM failure_memory
       WHERE user_id = ? AND error_pattern LIKE ?${options?.errorSource ? ' AND error_source = ?' : ''}
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(
      userId,
      `%${fuzzyPattern.slice(0, 100)}%`,
      ...(options?.errorSource ? [options.errorSource] : []),
      limit - results.length,
    ) as FailureRecord[];

    for (const row of fuzzyRows) {
      if (results.some(r => r.record.id === row.id)) continue;
      results.push({
        record: row,
        similarity: 0.5,
        previousFixWorked: row.fix_succeeded === 1,
      });
    }
  }

  // Sort by similarity descending
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, limit);
}

/**
 * Format matching failures as a prompt-friendly context block.
 */
export function formatFailureContext(matches: FailureMatch[]): string {
  if (!matches.length) return '';

  const blocks = matches.map((m, i) => {
    const r = m.record;
    const outcome = m.previousFixWorked ? 'âœ… Fixed successfully' : 'âŒ Fix did not resolve';
    return [
      `[${i + 1}] Previous occurrence (${r.created_at?.slice(0, 10) || 'unknown'}) â€” recurred ${r.recurrence_count}x`,
      `  Error: ${r.error_message?.slice(0, 200)}`,
      r.file_path ? `  File: ${r.file_path}` : '',
      r.function_name ? `  Function: ${r.function_name}` : '',
      r.context_snippet ? `  Context: ${r.context_snippet?.slice(0, 200)}` : '',
      r.attempted_fix ? `  Previous fix: ${r.attempted_fix?.slice(0, 300)}` : '',
      `  Outcome: ${outcome}`,
    ].filter(Boolean).join('\n');
  });

  return `<failure_memory>\n${blocks.join('\n\n')}\n</failure_memory>`;
}

/**
 * Prune stale or low-value failure records.
 * Rules (mirrors Hermes curator logic, simplified for SQLite):
 *   1. Delete failures older than 30 days that never recurred (recurrence_count = 1) and fix_succeeded = 0
 *   2. Delete failures older than 90 days regardless of recurrence (patterns that old are stale)
 *   3. Cap each user at 200 records, keeping the highest recurrence_count ones
 */
export function pruneFailureMemory(): void {
  const db = getDb();

  // Rule 1: single-occurrence failures older than 30 days that were never fixed
  db.prepare(`
    DELETE FROM failure_memory
    WHERE recurrence_count = 1
      AND fix_succeeded = 0
      AND created_at < datetime('now', '-30 days')
  `).run();

  // Rule 2: any record older than 90 days
  db.prepare(`
    DELETE FROM failure_memory
    WHERE created_at < datetime('now', '-90 days')
  `).run();

  // Rule 3: per-user cap at 200 — keep the 200 with highest recurrence
  const users = db.prepare(
    `SELECT DISTINCT user_id FROM failure_memory GROUP BY user_id HAVING COUNT(*) > 200`
  ).all() as Array<{ user_id: number }>;

  for (const { user_id } of users) {
    db.prepare(`
      DELETE FROM failure_memory
      WHERE user_id = ?
        AND id NOT IN (
          SELECT id FROM failure_memory
          WHERE user_id = ?
          ORDER BY recurrence_count DESC, created_at DESC
          LIMIT 200
        )
    `).run(user_id, user_id);
  }

  console.log('[failure-memory] pruning complete');
}

/**
 * Get failure memory statistics for a user/project.
 */
export function getFailureStats(userId: number, projectId?: number | null): {
  totalFailures: number;
  uniquePatterns: number;
  topSources: Array<{ source: string; count: number }>;
} {
  const db = getDb();

  const totalRow = db.prepare(
    'SELECT COUNT(*) as c FROM failure_memory WHERE user_id = ?'
  ).get(userId) as { c: number };

  const patternsRow = db.prepare(
    'SELECT COUNT(DISTINCT error_pattern) as c FROM failure_memory WHERE user_id = ?'
  ).get(userId) as { c: number };

  const sources = db.prepare(
    'SELECT error_source, SUM(recurrence_count) as count FROM failure_memory WHERE user_id = ? GROUP BY error_source ORDER BY count DESC'
  ).all(userId) as Array<{ error_source: string; count: number }>;

  return {
    totalFailures: totalRow.c,
    uniquePatterns: patternsRow.c,
    topSources: sources.map(s => ({ source: s.error_source, count: s.count })),
  };
}
