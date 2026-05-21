/**
 * SUNy Goal Tracker — persistent multi-horizon goal stack.
 *
 * Tracks goals across sessions with:
 *   1. Hierarchical goals with success criteria
 *   2. Evidence collection (proof that a goal is done)
 *   3. Session resume — pick up exactly where you left off
 *   4. Progress measurement by criteria, not by chat history
 *
 * Feature flag: ff_goal_tracker
 * DB table: goal_stack
 */

import { getAdapter } from './db';

// ── Types ─────────────────────────────────────────────────────────────────────

export type GoalStatus = 'active' | 'blocked' | 'completed' | 'abandoned';
export type GoalPriority = 'critical' | 'high' | 'normal' | 'low';

export interface Goal {
  id: string;
  userId: number;
  projectId: number;
  description: string;
  successCriteria: string[];
  status: GoalStatus;
  priority: GoalPriority;
  parentGoalId: string | null;
  sortOrder: number;
  attemptCount: number;
  lastAttemptAt: string | null;
  evidence: string[];
  blockedReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface GoalProgress {
  total: number;
  completed: number;
  blocked: number;
  active: number;
  abandoned: number;
  percentComplete: number;
}

// ── DB initialization ─────────────────────────────────────────────────────────

export async function initializeGoalTrackerTable(): Promise<void> {
  const db = await getAdapter();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS goal_stack (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      success_criteria TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      priority TEXT NOT NULL DEFAULT 'normal',
      parent_goal_id TEXT DEFAULT NULL,
      sort_order INTEGER DEFAULT 0,
      attempt_count INTEGER DEFAULT 0,
      last_attempt_at TEXT DEFAULT NULL,
      evidence TEXT NOT NULL DEFAULT '[]',
      blocked_reason TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT DEFAULT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id),
      FOREIGN KEY(parent_goal_id) REFERENCES goal_stack(id)
    );
    CREATE INDEX IF NOT EXISTS idx_goal_stack_user ON goal_stack(user_id);
    CREATE INDEX IF NOT EXISTS idx_goal_stack_project ON goal_stack(project_id);
    CREATE INDEX IF NOT EXISTS idx_goal_stack_status ON goal_stack(status);
    CREATE INDEX IF NOT EXISTS idx_goal_stack_parent ON goal_stack(parent_goal_id);
  `);
}

// ── Core operations ───────────────────────────────────────────────────────────

/**
 * Create a new goal. Returns the goal ID.
 */
export async function createGoal(input: {
  userId: number;
  projectId: number;
  description: string;
  successCriteria?: string[];
  priority?: GoalPriority;
  parentGoalId?: string | null;
  sortOrder?: number;
}): Promise<string> {
  const db = await getAdapter();
  const id = `goal_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const criteria = JSON.stringify(input.successCriteria || []);
  const parentId = input.parentGoalId ?? null;

  await db.run(
    `INSERT INTO goal_stack
      (id, user_id, project_id, description, success_criteria, priority, parent_goal_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.userId, input.projectId, input.description, criteria,
      input.priority || 'normal', parentId, input.sortOrder ?? 0],
  );

  return id;
}

/**
 * Get the current (most recent non-completed) active goal for a user/project.
 * Returns null if no active goal exists.
 */
export async function getCurrentGoal(userId: number, projectId: number): Promise<Goal | null> {
  const db = await getAdapter();
  const row = await db.get(
    `SELECT * FROM goal_stack
    WHERE user_id = ? AND project_id = ? AND status IN ('active', 'blocked')
    ORDER BY sort_order ASC, created_at DESC
    LIMIT 1`,
    [userId, projectId],
  ) as GoalRow | undefined;

  return row ? rowToGoal(row) : null;
}

/**
 * Get all goals for a user/project, ordered hierarchically.
 */
export async function getGoalHierarchy(userId: number, projectId: number): Promise<Goal[]> {
  const db = await getAdapter();
  const rows = await db.all(
    `SELECT * FROM goal_stack
    WHERE user_id = ? AND project_id = ?
    ORDER BY parent_goal_id IS NULL DESC, sort_order ASC, created_at ASC`,
    [userId, projectId],
  ) as GoalRow[];

  return rows.map(rowToGoal);
}

/**
 * Get a single goal by ID.
 */
export async function getGoal(goalId: string): Promise<Goal | null> {
  const db = await getAdapter();
  const row = await db.get('SELECT * FROM goal_stack WHERE id = ?', [goalId]) as GoalRow | undefined;
  return row ? rowToGoal(row) : null;
}

/**
 * Update goal status.
 */
export async function setGoalStatus(goalId: string, status: GoalStatus, blockedReason?: string): Promise<void> {
  const db = await getAdapter();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

  if (status === 'completed') {
    await db.run(
      `UPDATE goal_stack SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
      [status, now, now, goalId],
    );
  } else if (status === 'blocked' && blockedReason) {
    await db.run(
      `UPDATE goal_stack SET status = ?, blocked_reason = ?, updated_at = ? WHERE id = ?`,
      [status, blockedReason, now, goalId],
    );
  } else {
    await db.run(
      `UPDATE goal_stack SET status = ?, updated_at = ? WHERE id = ?`,
      [status, now, goalId],
    );
  }
}

/**
 * Add evidence to a goal (proof that a criterion is met).
 */
export async function addGoalEvidence(goalId: string, evidence: string): Promise<void> {
  const db = await getAdapter();
  const goal = await getGoal(goalId);
  if (!goal) return;

  const current = goal.evidence;
  current.push(`[${new Date().toISOString().slice(0, 19)}] ${evidence}`);
  await db.run(
    'UPDATE goal_stack SET evidence = ?, updated_at = datetime(\'now\') WHERE id = ?',
    [JSON.stringify(current), goalId],
  );
}

/**
 * Increment attempt count (called when agent retries this goal).
 */
export async function incrementGoalAttempt(goalId: string): Promise<void> {
  const db = await getAdapter();
  await db.run(
    `UPDATE goal_stack SET attempt_count = attempt_count + 1, last_attempt_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ?`,
    [goalId],
  );
}

/**
 * Check if all success criteria are met based on evidence.
 * Returns the list of met and unmet criteria.
 */
export async function checkGoalCriteria(goalId: string): Promise<{
  met: string[];
  unmet: string[];
  allMet: boolean;
}> {
  const goal = await getGoal(goalId);
  if (!goal) return { met: [], unmet: [], allMet: false };

  const evidenceText = goal.evidence.join(' ').toLowerCase();
  const met: string[] = [];
  const unmet: string[] = [];

  for (const criterion of goal.successCriteria) {
    // A criterion is "met" if evidence text contains key terms from it
    const keyTerms = criterion.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const isMet = keyTerms.length === 0 || keyTerms.some(term => evidenceText.includes(term));
    if (isMet) met.push(criterion);
    else unmet.push(criterion);
  }

  return { met, unmet, allMet: met.length === goal.successCriteria.length && goal.successCriteria.length > 0 };
}

/**
 * Auto-complete a goal if all criteria are met.
 * Returns true if the goal was auto-completed.
 */
export async function tryAutoCompleteGoal(goalId: string): Promise<boolean> {
  const { allMet } = await checkGoalCriteria(goalId);
  if (allMet) {
    await setGoalStatus(goalId, 'completed');
    return true;
  }
  return false;
}

/**
 * Get progress summary for all goals in a project.
 */
export async function getGoalProgress(userId: number, projectId: number): Promise<GoalProgress> {
  const db = await getAdapter();
  const all = await db.all(
    `SELECT status, COUNT(*) as count FROM goal_stack
    WHERE user_id = ? AND project_id = ?
    GROUP BY status`,
    [userId, projectId],
  ) as Array<{ status: string; count: number }>;

  const counts: Record<string, number> = { active: 0, blocked: 0, completed: 0, abandoned: 0 };
  let total = 0;
  for (const row of all) {
    counts[row.status] = row.count;
    total += row.count;
  }

  return {
    total,
    completed: counts.completed,
    blocked: counts.blocked,
    active: counts.active,
    abandoned: counts.abandoned,
    percentComplete: total > 0 ? Math.round((counts.completed / total) * 100) : 0,
  };
}

/**
 * Format current goals as a context block for the agent prompt.
 * This is injected at session start so the agent knows what to work on.
 */
export async function formatGoalContext(userId: number, projectId: number): Promise<string> {
  const current = await getCurrentGoal(userId, projectId);
  if (!current) return '';

  const progress = await getGoalProgress(userId, projectId);
  const criteria = current.successCriteria.join('\n    • ');
  const evidence = current.evidence.join('\n    • ');

  let ctx = `<current_goal>\n`;
  ctx += `  Description: ${current.description}\n`;
  ctx += `  Status: ${current.status} (attempt ${current.attemptCount})\n`;
  ctx += `  Priority: ${current.priority}\n`;
  ctx += `  Progress: ${progress.percentComplete}% (${progress.completed}/${progress.total} goals)\n`;

  if (criteria) ctx += `  Success criteria:\n    • ${criteria}\n`;
  if (evidence) ctx += `  Evidence collected:\n    • ${evidence}\n`;
  if (current.blockedReason) ctx += `  Blocked by: ${current.blockedReason}\n`;

  ctx += `</current_goal>`;
  return ctx;
}

/**
 * Get active goal count for a user/project.
 */
export async function getActiveGoalCount(userId: number, projectId: number): Promise<number> {
  const db = await getAdapter();
  const row = await db.get(
    `SELECT COUNT(*) as c FROM goal_stack
    WHERE user_id = ? AND project_id = ? AND status = 'active'`,
    [userId, projectId],
  ) as { c: number };
  return row.c;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

interface GoalRow {
  id: string;
  user_id: number;
  project_id: number;
  description: string;
  success_criteria: string;
  status: string;
  priority: string;
  parent_goal_id: string | null;
  sort_order: number;
  attempt_count: number;
  last_attempt_at: string | null;
  evidence: string;
  blocked_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    description: row.description,
    successCriteria: JSON.parse(row.success_criteria || '[]'),
    status: row.status as GoalStatus,
    priority: row.priority as GoalPriority,
    parentGoalId: row.parent_goal_id,
    sortOrder: row.sort_order,
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at,
    evidence: JSON.parse(row.evidence || '[]'),
    blockedReason: row.blocked_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
