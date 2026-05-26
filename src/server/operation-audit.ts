/**
 * SUNy Operation Audit â€” centralized operation logging.
 *
 * Records every tool call, error, and state transition into the operation_log
 * table for session replay, debugging, and admin oversight.
 *
 * Respects the ff_operation_audit feature flag â€” can be disabled at runtime.
 */

import { getDb } from './db';
import { isOperationAuditEnabled } from './feature-flags';

export interface OperationEntry {
  id?: number;
  userId: number;
  projectId?: number | null;
  sessionId?: string | null;
  operation: string;
  toolName?: string | null;
  status: 'success' | 'error' | 'started';
  detail?: string;
  durationMs?: number;
  timestamp?: string;
}

/**
 * Log an operation to the audit trail.
 * Silently no-ops if the feature flag is off.
 */
export function logOperation(entry: OperationEntry): void {
  if (!isOperationAuditEnabled()) return;

  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO operation_log (user_id, project_id, session_id, operation, tool_name, status, detail, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.userId,
      entry.projectId ?? null,
      entry.sessionId ?? null,
      entry.operation,
      entry.toolName ?? null,
      entry.status,
      entry.detail ?? '',
      entry.durationMs ?? 0,
    );
  } catch {
    // Audit logging is best-effort â€” never crash the main flow
  }
}

/**
 * Get the operation log for a session (for replay).
 */
export function getSessionLog(
  sessionId: string,
  limit: number = 200,
): OperationEntry[] {
  const db = getDb();
  return db.prepare(
    `SELECT id, user_id as userId, project_id as projectId, session_id as sessionId,
            operation, tool_name as toolName, status, detail, duration_ms as durationMs,
            timestamp
     FROM operation_log
     WHERE session_id = ?
     ORDER BY id ASC
     LIMIT ?`,
  ).all(sessionId, limit) as OperationEntry[];
}

/**
 * Get all sessions with operations (for admin/replay picker).
 */
export function getRecentSessions(
  userId?: number,
  limit: number = 20,
): Array<{ sessionId: string; operationCount: number; firstOp: string; lastOp: string }> {
  const db = getDb();
  let rows;
  if (userId) {
    rows = db.prepare(
      `SELECT session_id, COUNT(*) as c, MIN(timestamp) as firstOp, MAX(timestamp) as lastOp
       FROM operation_log
       WHERE user_id = ? AND session_id IS NOT NULL AND session_id != ''
       GROUP BY session_id
       ORDER BY MAX(timestamp) DESC
       LIMIT ?`,
    ).all(userId, limit);
  } else {
    rows = db.prepare(
      `SELECT session_id, COUNT(*) as c, MIN(timestamp) as firstOp, MAX(timestamp) as lastOp
       FROM operation_log
       WHERE session_id IS NOT NULL AND session_id != ''
       GROUP BY session_id
       ORDER BY MAX(timestamp) DESC
       LIMIT ?`,
    ).all(limit);
  }
  return (rows as Array<{ session_id: string; c: number; firstOp: string; lastOp: string }>).map(r => ({
    sessionId: r.session_id,
    operationCount: r.c,
    firstOp: r.firstOp,
    lastOp: r.lastOp,
  }));
}

/**
 * Log an agent loop tool call.
 * Convenience wrapper for the agent-loop integration point.
 */
export function logToolCall(
  userId: number,
  projectId: number | undefined,
  sessionId: string,
  toolName: string,
  status: 'success' | 'error' | 'started',
  detail?: string,
  durationMs?: number,
): void {
  logOperation({
    userId,
    projectId: projectId ?? null,
    sessionId,
    operation: 'tool_call',
    toolName,
    status,
    detail: detail ?? '',
    durationMs: durationMs ?? 0,
  });
}

/**
 * Log an agent loop stage transition.
 */
export function logStageTransition(
  userId: number,
  projectId: number | undefined,
  sessionId: string,
  stageName: string,
  status: 'started' | 'completed' | 'error',
  detail?: string,
): void {
  logOperation({
    userId,
    projectId: projectId ?? null,
    sessionId,
    operation: 'stage_transition',
    toolName: stageName,
    status,
    detail: detail ?? '',
  });
}
