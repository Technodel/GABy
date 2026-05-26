/**
 * SUNy Learning Signal Prioritizer â€” scores memories by value and prunes low-value ones.
 *
 * Every memory/failure/blueprint entry gets a "learning value score" based on:
 *   1. Frequency â€” how often has this pattern been seen?
 *   2. Recency â€” when was it last accessed/used?
 *   3. Outcome â€” did the fix succeed? Was the design decision followed?
 *   4. Cross-reference count â€” how many other entries reference or relate to this one?
 *
 * Periodic pruning removes low-value entries so high-signal memories dominate.
 *
 * Feature flag: ff_learning_prioritizer
 */

import { getAdapter } from './db';

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface MemoryScore {
  source: 'failure_memory' | 'blueprint_entries' | 'user_memories';
  id: number;
  score: number;
  reason: string;
  createdAt: string;
}

export interface PruningResult {
  removedFailures: number;
  removedBlueprints: number;
  removedMemories: number;
  totalRemoved: number;
  details: string[];
}

// â”€â”€ Scoring constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SCORE_WEIGHTS = {
  FREQUENCY_BASE: 10,         // per recurrence count
  RECENCY_DAYS_CAP: 90,       // entries older than this lose all recency points
  RECENCY_MAX_POINTS: 30,     // max recency contribution
  SUCCESS_BONUS: 20,          // if fix succeeded or blueprint was followed
  FAILURE_PENALTY: -15,       // if fix failed or blueprint was contradicted
  CROSS_REF_BONUS: 5,         // per cross-reference
  MIN_RETENTION_SCORE: 15,    // entries below this score are pruning candidates
};

// â”€â”€ Score calculation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function daysSince(dateStr: string): number {
  const then = new Date(dateStr).getTime();
  const now = Date.now();
  return (now - then) / (1000 * 60 * 60 * 24);
}

function recencyScore(dateStr: string): number {
  const days = daysSince(dateStr);
  if (days > SCORE_WEIGHTS.RECENCY_DAYS_CAP) return 0;
  return Math.round(SCORE_WEIGHTS.RECENCY_MAX_POINTS * (1 - days / SCORE_WEIGHTS.RECENCY_DAYS_CAP));
}

/**
 * Score a failure memory entry.
 */
function scoreFailureMemory(row: {
  id: number;
  recurrence_count: number;
  fix_succeeded: number;
  created_at: string;
}): MemoryScore {
  const frequencyScore = (row.recurrence_count || 1) * SCORE_WEIGHTS.FREQUENCY_BASE;
  const recency = recencyScore(row.created_at);
  const outcomeScore = row.fix_succeeded ? SCORE_WEIGHTS.SUCCESS_BONUS : SCORE_WEIGHTS.FAILURE_PENALTY;
  const total = frequencyScore + recency + outcomeScore;

  return {
    source: 'failure_memory',
    id: row.id,
    score: Math.max(0, total),
    reason: `recurrence=${row.recurrence_count} recency=${recency} outcome=${outcomeScore > 0 ? 'success' : 'fail'}`,
    createdAt: row.created_at,
  };
}

/**
 * Score a blueprint entry.
 */
function scoreBlueprintEntry(row: {
  id: number;
  category: string;
  created_at: string;
}): MemoryScore {
  const recency = recencyScore(row.created_at);
  // Blueprints with goal_completed or architecture_change categories get a bonus
  const categoryBonus = ['goal_completed', 'architecture_change', 'design_decision'].includes(row.category)
    ? 15 : 5;
  const total = recency + categoryBonus;

  return {
    source: 'blueprint_entries',
    id: row.id,
    score: Math.max(0, total),
    reason: `category=${row.category} recency=${recency}`,
    createdAt: row.created_at,
  };
}

/**
 * Score a user memory entry.
 */
function scoreUserMemory(row: {
  id: number;
  content: string;
  created_at: string;
}): MemoryScore {
  const recency = recencyScore(row.created_at);
  // User memories tagged with [preference] or [decision] are more valuable
  const tagBonus = /^\[(preference|decision|project_context)\]/.test(row.content) ? 15 : 5;
  const total = recency + tagBonus;

  return {
    source: 'user_memories',
    id: row.id,
    score: Math.max(0, total),
    reason: `tag=${row.content.slice(0, 20)}... recency=${recency}`,
    createdAt: row.created_at,
  };
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get scored memories for a user, sorted by value (highest first).
 */
export async function getPrioritizedMemories(userId: number, limit: number = 50): Promise<MemoryScore[]> {
  const db = await getAdapter();
  const scores: MemoryScore[] = [];

  // Score failure memories
  const failures = await db.all<{ id: number; recurrence_count: number; fix_succeeded: number; created_at: string }>(
    'SELECT id, recurrence_count, fix_succeeded, created_at FROM failure_memory WHERE user_id = ?',
    [userId],
  );
  for (const row of failures) {
    scores.push(scoreFailureMemory(row));
  }

  // Score blueprint entries
  const blueprints = await db.all<{ id: number; category: string; created_at: string }>(
    'SELECT id, category, created_at FROM blueprint_entries WHERE user_id = ?',
    [userId],
  );
  for (const row of blueprints) {
    scores.push(scoreBlueprintEntry(row));
  }

  // Score user memories
  const memories = await db.all<{ id: number; content: string; created_at: string }>(
    'SELECT id, content, created_at FROM user_memories WHERE user_id = ?',
    [userId],
  );
  for (const row of memories) {
    scores.push(scoreUserMemory(row));
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, limit);
}

/**
 * Prune low-value memories for a user.
 * Returns count of removed entries and details.
 */
export async function pruneLowValueMemories(userId: number, thresholdScore: number = SCORE_WEIGHTS.MIN_RETENTION_SCORE): Promise<PruningResult> {
  const db = await getAdapter();
  const details: string[] = [];
  let removedFailures = 0;
  let removedBlueprints = 0;
  let removedMemories = 0;

  // Score and prune failure memories
  const failures = await db.all<{ id: number; recurrence_count: number; fix_succeeded: number; created_at: string }>(
    'SELECT id, recurrence_count, fix_succeeded, created_at FROM failure_memory WHERE user_id = ?',
    [userId],
  );
  for (const row of failures) {
    const scored = scoreFailureMemory(row);
    if (scored.score < thresholdScore) {
      await db.run('DELETE FROM failure_memory WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedFailures++;
      details.push(`Removed failure_memory #${row.id} (score=${scored.score}, ${scored.reason})`);
    }
  }

  // Score and prune blueprint entries
  const blueprints = await db.all<{ id: number; category: string; created_at: string }>(
    'SELECT id, category, created_at FROM blueprint_entries WHERE user_id = ?',
    [userId],
  );
  for (const row of blueprints) {
    const scored = scoreBlueprintEntry(row);
    if (scored.score < thresholdScore) {
      await db.run('DELETE FROM blueprint_entries WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedBlueprints++;
      details.push(`Removed blueprint_entries #${row.id} (score=${scored.score}, ${scored.reason})`);
    }
  }

  // Score and prune user memories
  const memories = await db.all<{ id: number; content: string; created_at: string }>(
    'SELECT id, content, created_at FROM user_memories WHERE user_id = ?',
    [userId],
  );
  for (const row of memories) {
    const scored = scoreUserMemory(row);
    if (scored.score < thresholdScore) {
      await db.run('DELETE FROM user_memories WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedMemories++;
      details.push(`Removed user_memories #${row.id} (score=${scored.score}, ${scored.reason})`);
    }
  }

  const totalRemoved = removedFailures + removedBlueprints + removedMemories;

  return { removedFailures, removedBlueprints, removedMemories, totalRemoved, details };
}

/**
 * Format the top memories for AI prompt injection.
 */
export function formatTopMemories(scores: MemoryScore[], maxEntries: number = 10): string {
  if (scores.length === 0) return '';

  const top = scores.slice(0, maxEntries);
  let result = '[HIGH-VALUE LEARNING SIGNALS]\n';

  for (const s of top) {
    const label = s.source === 'failure_memory' ? 'âš ï¸ Failure Pattern'
      : s.source === 'blueprint_entries' ? 'ðŸ“ Design Decision'
      : 'ðŸ’¡ User Memory';
    result += `  â€¢ ${label} (score=${s.score}, ${s.createdAt.slice(0, 10)}): ${s.reason}\n`;
  }

  return result;
}
