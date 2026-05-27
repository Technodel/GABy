/**
 * SUNy Learning Signal Prioritizer — scores memories by value and prunes low-value ones.
 *
 * Every memory/failure/blueprint entry gets a "learning value score" based on:
 *   1. Frequency — how often has this pattern been seen?
 *   2. Recency — when was it last accessed/used?
 *   3. Outcome — did the fix succeed? Was the design decision followed?
 *   4. Cross-reference count — how many other entries reference or relate to this one?
 *   5. FTS5 boost — full-text relevance to current query context
 *   6. Vector similarity — semantic closeness to current query
 *   7. Entity match — entity overlap with current context
 *
 * P1 Upgrade: Multi-signal fusion with FTS5, vectors, and entity awareness.
 *
 * Periodic pruning removes low-value entries so high-signal memories dominate.
 *
 * Feature flag: ff_learning_prioritizer
 */

import { getAdapter } from './db';
import { textToVector, cosineSimilarity, applyTemporalRank } from './vectors';
import { findEntities, normalizeEntityName } from './entity-store';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryScore {
  source: 'failure_memory' | 'blueprint_entries' | 'user_memories';
  id: number;
  score: number;
  reason: string;
  createdAt: string;
  signals: {
    legacy: number;    // frequency + recency + outcome
    ftsBoost: number;  // 0..1
    vectorSim: number; // 0..1
    entityMatch: number; // 0..1
  };
}

export interface PruningResult {
  removedFailures: number;
  removedBlueprints: number;
  removedMemories: number;
  totalRemoved: number;
  details: string[];
}

// ── Signal weights ───────────────────────────────────────────────────────────

const SIGNAL_WEIGHTS = {
  LEGACY: 0.40,       // 40% — original frequency/recency/outcome
  FTS: 0.25,          // 25% — FTS5 full-text relevance
  VECTOR: 0.20,       // 20% — vector similarity
  ENTITY: 0.15,       // 15% — entity match
};

const FTS_BOOST_MAX = 0.8;  // max FTS contribution per entry

// ── Scoring constants ────────────────────────────────────────────────────────

const SCORE_WEIGHTS = {
  FREQUENCY_BASE: 10,
  RECENCY_DAYS_CAP: 90,
  RECENCY_MAX_POINTS: 30,
  SUCCESS_BONUS: 20,
  FAILURE_PENALTY: -15,
  CROSS_REF_BONUS: 5,
  MIN_RETENTION_SCORE: 15,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── FTS5 relevance scoring ───────────────────────────────────────────────────

/**
 * Compute an FTS5 relevance boost for a given entry.
 * Returns 0..1 where higher = more relevant to the query context.
 */
async function computeFtsBoost(
  table: string,
  ftsTable: string,
  rowId: number,
  query: string,
): Promise<number> {
  if (!query || query.length < 3) return 0;

  try {
    const db = await getAdapter();
    const ftsQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
    if (!ftsQuery) return 0;

    const result = await db.get<{ rank: number }>(
      `SELECT rank FROM ${ftsTable} WHERE rowid = ? AND ${ftsTable} MATCH ?`,
      [rowId, ftsQuery],
    );

    if (!result) return 0;

    // Normalize rank: 0 = perfect match, negative = good match in FTS5
    // FTS5 rank is typically negative for good matches, 0 for no match
    const normalized = Math.max(0, Math.min(1, -result.rank / 10));
    return normalized * FTS_BOOST_MAX;
  } catch {
    return 0;
  }
}

// ── Entity match scoring ────────────────────────────────────────────────────

/**
 * Compute entity match bonus between a text content and query entities.
 */
async function computeEntityMatch(
  userId: number,
  content: string,
  queryEntities: string[],
): Promise<number> {
  if (queryEntities.length === 0) return 0;

  let matches = 0;
  const contentLower = content.toLowerCase();

  for (const ent of queryEntities) {
    if (contentLower.includes(ent.toLowerCase())) {
      matches++;
    }
  }

  return queryEntities.length > 0 ? matches / queryEntities.length : 0;
}

// ── Legacy scoring (original) ────────────────────────────────────────────────

function scoreFailureMemoryLegacy(row: {
  id: number;
  recurrence_count: number;
  fix_succeeded: number;
  created_at: string;
  error_message: string;
}): number {
  const frequencyScore = (row.recurrence_count || 1) * SCORE_WEIGHTS.FREQUENCY_BASE;
  const recency = recencyScore(row.created_at);
  const outcomeScore = row.fix_succeeded ? SCORE_WEIGHTS.SUCCESS_BONUS : SCORE_WEIGHTS.FAILURE_PENALTY;
  return Math.max(0, frequencyScore + recency + outcomeScore);
}

function scoreBlueprintLegacy(row: {
  id: number;
  category: string;
  created_at: string;
  summary: string;
}): number {
  const recency = recencyScore(row.created_at);
  const categoryBonus = ['goal_completed', 'architecture_change', 'design_decision'].includes(row.category)
    ? 15 : 5;
  return Math.max(0, recency + categoryBonus);
}

function scoreUserMemoryLegacy(row: {
  id: number;
  content: string;
  created_at: string;
}): number {
  const recency = recencyScore(row.created_at);
  const tagBonus = /^\[(preference|decision|project_context)\]/.test(row.content) ? 15 : 5;
  return Math.max(0, recency + tagBonus);
}

// ── Multi-signal scoring ─────────────────────────────────────────────────────

/**
 * Compute fused score for a single entry across all signals.
 */
async function computeFusedScore(
  userId: number,
  legacyScore: number,
  source: 'failure_memory' | 'blueprint_entries' | 'user_memories',
  rowId: number,
  content: string,
  createdAt: string,
  queryContext: string,
  queryVec: Float64Array,
  queryEntities: string[],
): Promise<MemoryScore['signals']> {
  // Legacy score (already computed)
  const legacy = legacyScore;

  // FTS5 boost
  let ftsBoost = 0;
  const ftsTable = source === 'failure_memory' ? 'failure_memory_fts'
    : source === 'blueprint_entries' ? 'blueprint_entries_fts'
    : 'user_memories_fts';
  try {
    ftsBoost = await computeFtsBoost(source, ftsTable, rowId, queryContext);
  } catch {
    ftsBoost = 0;
  }

  // Vector similarity
  let vectorSim = 0;
  try {
    // For entries without stored vectors, we compute on-the-fly from content
    const entryVec = textToVector(content, 2000);
    vectorSim = cosineSimilarity(queryVec, entryVec);
  } catch {
    vectorSim = 0;
  }

  // Entity match
  const entityMatch = await computeEntityMatch(userId, content, queryEntities);

  return { legacy, ftsBoost, vectorSim, entityMatch };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Get scored memories for a user, sorted by value (highest first).
 * Supports optional query context for multi-signal retrieval.
 */
export async function getPrioritizedMemories(
  userId: number,
  limit: number = 50,
  queryContext?: string,
): Promise<MemoryScore[]> {
  const db = await getAdapter();
  const scores: MemoryScore[] = [];

  // Pre-compute query vector and entities if context provided
  const queryVec = queryContext ? textToVector(queryContext, 2000) : new Float64Array(2000);
  const queryEntities = queryContext
    ? (await findEntities({ userId, query: queryContext, limit: 10 })).map(e => e.entityName)
    : [];

  // ── Score failure memories ────────────────────────────────────────────────
  const failures = await db.all<{
    id: number; recurrence_count: number; fix_succeeded: number;
    created_at: string; error_message: string;
  }>(
    `SELECT id, recurrence_count, fix_succeeded, created_at, error_message
     FROM failure_memory WHERE user_id = ?`,
    [userId],
  );
  for (const row of failures) {
    const legacyScore = scoreFailureMemoryLegacy(row);
    const signals = await computeFusedScore(
      userId, legacyScore, 'failure_memory', row.id, row.error_message, row.created_at,
      queryContext ?? '', queryVec, queryEntities,
    );
    const fused = SIGNAL_WEIGHTS.LEGACY * (signals.legacy / 100) +
      SIGNAL_WEIGHTS.FTS * signals.ftsBoost +
      SIGNAL_WEIGHTS.VECTOR * signals.vectorSim +
      SIGNAL_WEIGHTS.ENTITY * signals.entityMatch;
    const score = Math.round(legacyScore * (0.5 + fused * 0.5));

    scores.push({
      source: 'failure_memory',
      id: row.id,
      score: Math.max(0, score),
      reason: `legacy=${signals.legacy} fts=${signals.ftsBoost.toFixed(2)} vec=${signals.vectorSim.toFixed(2)} ent=${signals.entityMatch.toFixed(2)}`,
      createdAt: row.created_at,
      signals,
    });
  }

  // ── Score blueprint entries ──────────────────────────────────────────────
  const blueprints = await db.all<{
    id: number; category: string; created_at: string; summary: string; details: string | null;
  }>(
    `SELECT id, category, created_at, summary, details
     FROM blueprint_entries WHERE user_id = ?`,
    [userId],
  );
  for (const row of blueprints) {
    const legacyScore = scoreBlueprintLegacy(row);
    const content = `${row.summary} ${row.details ?? ''}`;
    const signals = await computeFusedScore(
      userId, legacyScore, 'blueprint_entries', row.id, content, row.created_at,
      queryContext ?? '', queryVec, queryEntities,
    );
    const fused = SIGNAL_WEIGHTS.LEGACY * (signals.legacy / 100) +
      SIGNAL_WEIGHTS.FTS * signals.ftsBoost +
      SIGNAL_WEIGHTS.VECTOR * signals.vectorSim +
      SIGNAL_WEIGHTS.ENTITY * signals.entityMatch;
    const score = Math.round(legacyScore * (0.5 + fused * 0.5));

    scores.push({
      source: 'blueprint_entries',
      id: row.id,
      score: Math.max(0, score),
      reason: `category=${row.category} fts=${signals.ftsBoost.toFixed(2)} vec=${signals.vectorSim.toFixed(2)} ent=${signals.entityMatch.toFixed(2)}`,
      createdAt: row.created_at,
      signals,
    });
  }

  // ── Score user memories ──────────────────────────────────────────────────
  const memories = await db.all<{
    id: number; content: string; created_at: string;
  }>(
    'SELECT id, content, created_at FROM user_memories WHERE user_id = ?',
    [userId],
  );
  for (const row of memories) {
    const legacyScore = scoreUserMemoryLegacy(row);
    const signals = await computeFusedScore(
      userId, legacyScore, 'user_memories', row.id, row.content, row.created_at,
      queryContext ?? '', queryVec, queryEntities,
    );
    const fused = SIGNAL_WEIGHTS.LEGACY * (signals.legacy / 100) +
      SIGNAL_WEIGHTS.FTS * signals.ftsBoost +
      SIGNAL_WEIGHTS.VECTOR * signals.vectorSim +
      SIGNAL_WEIGHTS.ENTITY * signals.entityMatch;
    const score = Math.round(legacyScore * (0.5 + fused * 0.5));

    scores.push({
      source: 'user_memories',
      id: row.id,
      score: Math.max(0, score),
      reason: `tag=${row.content.slice(0, 20)}... fts=${signals.ftsBoost.toFixed(2)} vec=${signals.vectorSim.toFixed(2)} ent=${signals.entityMatch.toFixed(2)}`,
      createdAt: row.created_at,
      signals,
    });
  }

  // Sort by score descending
  scores.sort((a, b) => b.score - a.score);

  return scores.slice(0, limit);
}

/**
 * Prune low-value memories for a user.
 */
export async function pruneLowValueMemories(
  userId: number,
  thresholdScore: number = SCORE_WEIGHTS.MIN_RETENTION_SCORE,
): Promise<PruningResult> {
  const db = await getAdapter();
  const details: string[] = [];
  let removedFailures = 0;
  let removedBlueprints = 0;
  let removedMemories = 0;

  // Score and prune failure memories
  const failures = await db.all<{
    id: number; recurrence_count: number; fix_succeeded: number; created_at: string; error_message: string;
  }>(
    'SELECT id, recurrence_count, fix_succeeded, created_at, error_message FROM failure_memory WHERE user_id = ?',
    [userId],
  );
  for (const row of failures) {
    const legacy = scoreFailureMemoryLegacy(row);
    if (legacy < thresholdScore) {
      await db.run('DELETE FROM failure_memory WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedFailures++;
      details.push(`Removed failure_memory #${row.id} (score=${legacy})`);
    }
  }

  // Score and prune blueprint entries
  const blueprints = await db.all<{
    id: number; category: string; created_at: string; summary: string;
  }>(
    'SELECT id, category, created_at, summary FROM blueprint_entries WHERE user_id = ?',
    [userId],
  );
  for (const row of blueprints) {
    const legacy = scoreBlueprintLegacy(row);
    if (legacy < thresholdScore) {
      await db.run('DELETE FROM blueprint_entries WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedBlueprints++;
      details.push(`Removed blueprint_entries #${row.id} (score=${legacy})`);
    }
  }

  // Score and prune user memories
  const memories = await db.all<{
    id: number; content: string; created_at: string;
  }>(
    'SELECT id, content, created_at FROM user_memories WHERE user_id = ?',
    [userId],
  );
  for (const row of memories) {
    const legacy = scoreUserMemoryLegacy(row);
    if (legacy < thresholdScore) {
      await db.run('DELETE FROM user_memories WHERE id = ? AND user_id = ?', [row.id, userId]);
      removedMemories++;
      details.push(`Removed user_memories #${row.id} (score=${legacy})`);
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
    const label = s.source === 'failure_memory' ? '⚠️ Failure Pattern'
      : s.source === 'blueprint_entries' ? '📐 Design Decision'
      : '💡 User Memory';

    const signalSummary = `v=${(s.signals.vectorSim * 100).toFixed(0)}% f=${(s.signals.ftsBoost * 100).toFixed(0)}% e=${(s.signals.entityMatch * 100).toFixed(0)}%`;
    result += `  • ${label} (score=${s.score}, ${s.createdAt.slice(0, 10)}): ${s.reason} [${signalSummary}]\n`;
  }

  return result;
}
