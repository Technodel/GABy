/**
 * SUNy Checkpoint Manager — Rich checkpoint management with metadata,
 * tagging, snapshots, and rollback timeline.
 *
 * Extends git-manager.ts with a DB-backed checkpoint registry that stores
 * metadata alongside git commits for rich UI timelines.
 */

import { getAdapter } from './db';
import {
  gitAutoCommit,
  createCheckpoint as gitCreateCheckpoint,
  listCheckpoints as gitListCheckpoints,
  rollbackToCheckpoint,
  type CheckpointEntry,
} from './git-manager';

// ── Types ───────────────────────────────────────────────────────────────────

export interface CheckpointRecord {
  id: number;
  user_id: number;
  project_id: number | null;
  session_id: string | null;
  sha: string;
  label: string;
  tags: string;          // comma-separated
  files_changed: number;
  turn_index: number;
  metadata_json: string; // JSON blob for extensible data
  created_at: string;
}

export interface CheckpointCreateRequest {
  userId: number;
  projectPath: string;
  projectId?: number | null;
  sessionId?: string | null;
  label: string;
  tags?: string[];
  turnIndex?: number;
  metadata?: Record<string, unknown>;
}

// ── Database ────────────────────────────────────────────────────────────────

async function ensureTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      session_id TEXT,
      sha TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '',
      files_changed INTEGER DEFAULT 0,
      turn_index INTEGER DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_checkpoints_user_project
      ON checkpoints(user_id, project_id);
    CREATE INDEX IF NOT EXISTS idx_checkpoints_sha
      ON checkpoints(sha);
  `);
}

// ── Core operations ─────────────────────────────────────────────────────────

/**
 * Create a git checkpoint + DB record in one operation.
 * Called at the start of each agent turn.
 */
export async function createCheckpointRecord(
  req: CheckpointCreateRequest,
): Promise<CheckpointRecord | null> {
  const { userId, projectPath, projectId, sessionId, label, tags, turnIndex, metadata } = req;

  try {
    // Git checkpoint (non-blocking, best-effort)
    await gitCreateCheckpoint(userId, projectPath, label).catch(() => {});

    // Get the latest git SHA
    let sha = '';
    try {
      const { sendToBridge } = require('./bridge-manager');
      sha = (await sendToBridge(userId, 'exec:shell', {
        command: 'git rev-parse HEAD',
        cwd: projectPath,
        requiresConfirmation: false,
      }, 5_000) as string).trim();
    } catch {
      sha = 'unknown';
    }

    // Store in DB
    await ensureTable();
    const db = await getAdapter();
    const result = await db.run(`
      INSERT INTO checkpoints (user_id, project_id, session_id, sha, label, tags, turn_index, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
      userId,
      projectId ?? null,
      sessionId ?? null,
      sha,
      label.slice(0, 200),
      (tags || []).join(','),
      turnIndex ?? 0,
      JSON.stringify(metadata || {}),
    );

    return await getCheckpointById(result.lastInsertRowid as number);
  } catch (err) {
    console.warn('[checkpoint-manager] createCheckpointRecord failed:', (err as Error).message);
    return null;
  }
}

/**
 * Auto-checkpoint at the start of an agent turn.
 * Called from agent-loop.ts after determining the changed files from the previous turn.
 */
export async function autoCheckpoint(
  userId: number,
  projectPath: string,
  projectId: number | null,
  sessionId: string | null,
  turnIndex: number,
  userMessage: string,
  changedFiles: string[],
): Promise<CheckpointRecord | null> {
  // Auto-commit the last turn's changes first
  await gitAutoCommit(userId, projectPath, changedFiles, userMessage).catch(() => {});

  // Create a new checkpoint for the upcoming turn
  return createCheckpointRecord({
    userId,
    projectPath,
    projectId,
    sessionId,
    label: `Turn ${turnIndex}: ${userMessage.slice(0, 80)}`,
    tags: ['auto', 'turn-checkpoint'],
    turnIndex,
    metadata: { changedFiles: changedFiles.length, userMessage: userMessage.slice(0, 200) },
  });
}

// ── Query operations ────────────────────────────────────────────────────────

export async function getCheckpointById(id: number): Promise<CheckpointRecord | null> {
  await ensureTable();
  const db = await getAdapter();
  return await db.get<CheckpointRecord>('SELECT * FROM checkpoints WHERE id = ?', [id]) ?? null;
}

export async function getCheckpointsByUser(
  userId: number,
  projectId?: number,
  limit = 50,
): Promise<CheckpointRecord[]> {
  await ensureTable();
  const db = await getAdapter();
  if (projectId) {
    return await db.all<CheckpointRecord>(
      'SELECT * FROM checkpoints WHERE user_id = ? AND project_id = ? ORDER BY id DESC LIMIT ?',
      [userId, projectId, limit],
    );
  }
  return await db.all<CheckpointRecord>(
    'SELECT * FROM checkpoints WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    [userId, limit],
  );
}

export async function getCheckpointsBySession(
  sessionId: string,
  limit = 50,
): Promise<CheckpointRecord[]> {
  await ensureTable();
  const db = await getAdapter();
  return await db.all<CheckpointRecord>(
    'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY id ASC LIMIT ?',
    [sessionId, limit],
  );
}

export async function getCheckpointTimeline(
  userId: number,
  projectId?: number,
  limit = 20,
): Promise<Array<CheckpointRecord & { gitSha?: string; filesChanged?: number }>> {
  const records = await getCheckpointsByUser(userId, projectId ?? undefined, limit);
  return records.map(r => ({
    ...r,
    gitSha: r.sha,
    filesChanged: r.files_changed,
  }));
}

// ── Tag management ──────────────────────────────────────────────────────────

export async function tagCheckpoint(checkpointId: number, tags: string[]): Promise<void> {
  await ensureTable();
  const db = await getAdapter();
  const record = await getCheckpointById(checkpointId);
  if (!record) return;

  const existingTags = record.tags ? record.tags.split(',').filter(Boolean) : [];
  const merged = [...new Set([...existingTags, ...tags])];
  await db.run('UPDATE checkpoints SET tags = ? WHERE id = ?', [merged.join(','), checkpointId]);
}

export async function getCheckpointsByTag(
  userId: number,
  tag: string,
  limit = 50,
): Promise<CheckpointRecord[]> {
  await ensureTable();
  const db = await getAdapter();
  return await db.all<CheckpointRecord>(
    'SELECT * FROM checkpoints WHERE user_id = ? AND tags LIKE ? ORDER BY id DESC LIMIT ?',
    [userId, `%${tag}%`, limit],
  );
}

// ── Rollback (with DB record) ───────────────────────────────────────────────

export async function rollbackWithRecord(
  userId: number,
  projectPath: string,
  checkpointId: number,
): Promise<{ success: boolean; sha: string; message: string }> {
  const record = await getCheckpointById(checkpointId);
  if (!record || record.user_id !== userId) {
    return { success: false, sha: '', message: 'Checkpoint not found or access denied.' };
  }

  try {
    await rollbackToCheckpoint(userId, projectPath, record.sha);
    return {
      success: true,
      sha: record.sha,
      message: `Rolled back to checkpoint "${record.label}" (${record.sha.slice(0, 7)})`,
    };
  } catch (err) {
    return {
      success: false,
      sha: record.sha,
      message: `Rollback failed: ${(err as Error).message}`,
    };
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

export async function deleteOldCheckpoints(
  userId: number,
  keepCount: number,
): Promise<number> {
  await ensureTable();
  const db = await getAdapter();
  const result = await db.run(`
    DELETE FROM checkpoints WHERE id IN (
      SELECT id FROM checkpoints WHERE user_id = ?
      ORDER BY id DESC LIMIT -1 OFFSET ?
    )
  `, [userId, keepCount]);
  return result.changes;
}
