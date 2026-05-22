/**
 * SUNy Project Lock — session-level lock per project.
 *
 * Prevents concurrent mutations from multiple tabs/sessions on the same project.
 * Uses the project_locks DB table with expiry to handle crashes gracefully.
 */

import { getAdapter } from './db';

const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes max lock duration

/** Convert JS Date to SQLite datetime string for reliable comparison. */
function toSqliteDatetime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

export interface ProjectLock {
  projectId: number;
  userId: number;
  sessionId: string;
  lockedAt: string;
  expiresAt: string;
}

/**
 * Acquire a lock for a project session.
 * Returns true if lock acquired, false if another session holds it.
 */
export async function acquireLock(projectId: number, userId: number, sessionId: string): Promise<boolean> {
  const db = getAdapter();

  // Clean expired locks first
  await db.run('DELETE FROM project_locks WHERE expires_at < ?', [toSqliteDatetime(new Date())]);

  const existing = await db.get<ProjectLock>(
    'SELECT * FROM project_locks WHERE project_id = ?',
    [projectId],
  );

  if (existing) {
    // Same session — refresh the lock
    if (existing.sessionId === sessionId) {
      const expiresAt = toSqliteDatetime(new Date(Date.now() + LOCK_TIMEOUT_MS));
      await db.run(
        'UPDATE project_locks SET expires_at = ? WHERE project_id = ?',
        [expiresAt, projectId],
      );
      return true;
    }
    // Different session holds it — deny
    return false;
  }

  // No existing lock — create one
  const expiresAt = toSqliteDatetime(new Date(Date.now() + LOCK_TIMEOUT_MS));
  try {
    await db.run(
      `INSERT INTO project_locks (project_id, user_id, session_id, expires_at)
       VALUES (?, ?, ?, ?)`,
      [projectId, userId, sessionId, expiresAt],
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Release a lock for a project session.
 */
export async function releaseLock(projectId: number, sessionId: string): Promise<void> {
  const db = getAdapter();
  await db.run(
    'DELETE FROM project_locks WHERE project_id = ? AND session_id = ?',
    [projectId, sessionId],
  );
}

/**
 * Check if a project is locked by another session.
 */
export async function isLockedByOther(projectId: number, sessionId: string): Promise<boolean> {
  const db = getAdapter();
  const lock = await db.get<ProjectLock>(
    'SELECT * FROM project_locks WHERE project_id = ? AND session_id != ? AND expires_at >= ?',
    [projectId, sessionId, toSqliteDatetime(new Date())],
  );
  return !!lock;
}

/**
 * Get detailed info about who holds the lock on a project.
 * Returns null if no active lock exists.
 */
export async function getLockInfo(projectId: number): Promise<{
  userId: number;
  username: string;
  sessionId: string;
  lockedAt: string;
  expiresAt: string;
} | null> {
  const db = getAdapter();
  // Clean expired first
  await db.run('DELETE FROM project_locks WHERE expires_at < ?', [toSqliteDatetime(new Date())]);
  const row = await db.get<{
    user_id: number;
    session_id: string;
    locked_at: string;
    expires_at: string;
  }>(
    'SELECT user_id, session_id, locked_at, expires_at FROM project_locks WHERE project_id = ?',
    [projectId],
  );
  if (!row) return null;
  const user = await db.get<{ username: string }>(
    'SELECT username FROM users WHERE id = ?',
    [row.user_id],
  );
  return {
    userId: row.user_id,
    username: user?.username ?? `user_${row.user_id}`,
    sessionId: row.session_id,
    lockedAt: row.locked_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Check if lock is active (for UI status).
 */
export async function getLockStatus(projectId: number): Promise<{ locked: boolean; sessionId?: string } | null> {
  const db = getAdapter();
  await db.run('DELETE FROM project_locks WHERE expires_at < ?', [toSqliteDatetime(new Date())]);
  const lock = await db.get<ProjectLock>(
    'SELECT * FROM project_locks WHERE project_id = ?',
    [projectId],
  );
  if (!lock) return { locked: false };
  return { locked: true, sessionId: lock.sessionId };
}
