/**
 * SUNy User Memory Tool — persistent fact storage via SQLite.
 *
 * P0 Upgrade: ADD-only + multi-signal retrieval.
 *
 * The AI can save and recall user-specific facts (preferences, project context,
 * decisions) across sessions using the existing user_memories table.
 *
 * Key improvements:
 *   - ADD-only: no delete/update tools — facts are immutable
 *   - Vector embeddings on every save for similarity search
 *   - FTS5 full-text search for keyword-aware retrieval
 *   - Multi-signal retrieval fuses vector + FTS5 + keyword + temporal
 *   - Entity extraction and linking on save
 *
 * Two tools:
 *   save_memory   – save a fact (immutable)
 *   recall_memories – retrieve facts with multi-signal ranking
 */

import { tool } from 'ai';
import { z } from 'zod';
import { getAdapter } from './db';
import { textToVector, serializeVector, deserializeVector, cosineSimilarity, applyTemporalRank } from './vectors';
import { extractEntities, storeEntities, getEntityContext } from './entity-store';

// ── Types ────────────────────────────────────────────────────────────────────

export interface MemoryToolContext {
  userId: number;
  projectPath?: string;
}

interface MemoryRow {
  id: number;
  user_id: number;
  project_id: number | null;
  content: string;
  vector_b64: string | null;
  source_entity: string | null;
  created_at: string;
}

// ── Signal fusion weights ────────────────────────────────────────────────────

const SIGNAL_WEIGHTS = {
  VECTOR: 0.40,     // 40% — semantic similarity
  FTS: 0.35,        // 35% — full-text keyword match
  KEYWORD: 0.15,    // 15% — simple keyword overlap
  ENTITY: 0.10,     // 10% — entity match bonus
};

const FTS_BOOST_THRESHOLD = 0.6; // FTS scores above this get extra boost

// ── Multi-signal scorer ──────────────────────────────────────────────────────

interface SignalScore {
  vectorScore: number;
  ftsScore: number;
  keywordScore: number;
  entityBonus: number;
  temporalScore: number;
  fused: number;
}

/**
 * Compute fused score from all signals for a single memory entry.
 */
function computeFusedScore(
  row: MemoryRow,
  queryVec: Float64Array,
  queryTokens: Set<string>,
  queryEntities: string[],
  ftsRank: number,   // 0..1 from FTS5 rank, 0 if not matched
): SignalScore {
  // 1. Vector similarity
  let vectorScore = 0;
  if (row.vector_b64) {
    try {
      const vec = deserializeVector(row.vector_b64, 2000);
      vectorScore = cosineSimilarity(queryVec, vec);
    } catch { /* skip corrupt vector */ }
  }

  // 2. FTS5 score — already provided as rank (0 = perfect match)
  const ftsScore = ftsRank > 0 ? 1 - ftsRank : 0;

  // 3. Keyword overlap
  const contentWords = row.content.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  const contentSet = new Set(contentWords);
  let overlap = 0;
  for (const tok of queryTokens) {
    if (contentSet.has(tok)) overlap++;
  }
  const keywordScore = queryTokens.size > 0 ? overlap / queryTokens.size : 0;

  // 4. Entity bonus
  let entityBonus = 0;
  const contentLower = row.content.toLowerCase();
  for (const ent of queryEntities) {
    if (contentLower.includes(ent.toLowerCase())) {
      entityBonus = Math.max(entityBonus, 0.15);
    }
  }

  // 5. Temporal ranking
  const temporalScore = applyTemporalRank(1.0, row.created_at, 0.05);

  // Fuse
  let fused =
    SIGNAL_WEIGHTS.VECTOR * vectorScore +
    SIGNAL_WEIGHTS.FTS * ftsScore +
    SIGNAL_WEIGHTS.KEYWORD * keywordScore +
    SIGNAL_WEIGHTS.ENTITY * entityBonus;

  // Boost if FTS was a strong match
  if (ftsScore > FTS_BOOST_THRESHOLD) {
    fused = Math.min(1.0, fused * 1.3);
  }

  // Apply temporal decay as a final multiplier
  fused *= temporalScore;

  return { vectorScore, ftsScore, keywordScore, entityBonus, temporalScore, fused };
}

// ── Tool factory ─────────────────────────────────────────────────────────────

export async function createMemoryTools(ctx: MemoryToolContext) {
  const { userId, projectPath } = ctx;

  // Determine project_id if we have a project path
  let projectId: number | null = null;
  if (projectPath) {
    const db = await getAdapter();
    const row = await db.get<{ id: number }>(
      'SELECT id FROM projects WHERE user_id = ? AND local_path = ?',
      [userId, projectPath],
    );
    if (row) projectId = row.id;
  }

  const saveMemoryTool = tool({
    description:
      'Save a fact or piece of information to long-term memory. Use this when the user tells you something they want you to remember (preferences, important context, decisions, personal details). The fact will persist across conversations. This is ADD-ONLY — memories cannot be edited or deleted once saved.',
    inputSchema: z.object({
      fact: z
        .string()
        .min(1)
        .max(2000)
        .describe(
          'The fact or information to remember. Should be a clear, self-contained statement (e.g., "User prefers tabs over spaces").',
        ),
      category: z
        .string()
        .max(100)
        .optional()
        .default('general')
        .describe(
          'Optional category: "general", "preference", "decision", "project_context", "personal".',
        ),
    }),
    execute: async ({ fact, category }) => {
      const tagged = category !== 'general' ? `[${category}] ${fact}` : fact;

      const db = await getAdapter();

      // Generate vector embedding
      const vec = textToVector(tagged, 2000);
      const vecB64 = serializeVector(vec);

      // Extract and store entities
      const entities = extractEntities(tagged);
      const entityNames = entities.map(e => e.name);
      const sourceEntityTag = entityNames.length > 0 ? entityNames.slice(0, 5).join(', ') : null;

      const result = await db.run(
        'INSERT INTO user_memories (user_id, project_id, content, vector_b64, source_entity) VALUES (?, ?, ?, ?, ?)',
        [userId, projectId, tagged, vecB64, sourceEntityTag],
      );

      const newId = result.lastInsertRowid as number;

      // Store entities separately
      if (entities.length > 0) {
        storeEntities(userId, 'user_memories', newId, entities);
      }

      // Sync FTS index
      try {
        await db.run(
          'INSERT INTO user_memories_fts (rowid, content, category) VALUES (?, ?, ?)',
          [newId, tagged, category],
        );
      } catch {
        // FTS may not be available — best-effort
      }

      return `✅ Saved: "${fact}"`;
    },
  });

  const recallMemoriesTool = tool({
    description:
      'Recall saved facts from memory. Returns the most relevant stored facts for this user/project using multi-signal retrieval (semantic similarity + keyword search + entity matching). Results are ranked by relevance.',
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(500)
        .describe(
          'A search query describing what you want to recall. Be specific — the system uses semantic search to find the most relevant memories.',
        ),
      category: z
        .string()
        .max(100)
        .optional()
        .describe(
          'Optional category filter: "general", "preference", "decision", "project_context", "personal". Returns all if omitted.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe('Maximum number of memories to return.'),
    }),
    execute: async ({ query, category, limit }) => {
      const db = await getAdapter();

      // Build query vector
      const queryVec = textToVector(query, 2000);

      // Extract query tokens for keyword scoring
      const queryTokens = new Set(
        query.toLowerCase().split(/\W+/).filter(w => w.length > 2)
      );

      // Extract entities from query for entity bonus
      const queryEntities = extractEntities(query).map(e => e.name);

      // ── Multi-signal retrieval ────────────────────────────────────────────

      // Get all candidate memories
      let candidates: MemoryRow[];
      if (projectId) {
        candidates = await db.all<MemoryRow>(
          'SELECT id, user_id, project_id, content, vector_b64, source_entity, created_at FROM user_memories WHERE user_id = ? AND (project_id = ? OR project_id IS NULL)',
          [userId, projectId],
        );
      } else {
        candidates = await db.all<MemoryRow>(
          'SELECT id, user_id, project_id, content, vector_b64, source_entity, created_at FROM user_memories WHERE user_id = ?',
          [userId],
        );
      }

      if (candidates.length === 0) {
        return 'No saved memories found.' + (category ? ` (filtered by category: ${category})` : '');
      }

      // Filter by category if specified
      if (category) {
        candidates = candidates.filter(r => r.content.startsWith(`[${category}]`));
        if (candidates.length === 0) {
          return `No saved memories found for category: ${category}`;
        }
      }

      // ── Try FTS5 search first for early boost ────────────────────────────
      const ftsScores = new Map<number, number>();
      try {
        const ftsQuery = query.replace(/[^a-zA-Z0-9 ]/g, '').trim();
        if (ftsQuery.length > 0) {
          const ftsResults = await db.all<{ rowid: number; rank: number }>(
            `SELECT rowid, rank FROM user_memories_fts WHERE user_memories_fts MATCH ? ORDER BY rank LIMIT ?`,
            [ftsQuery, limit! * 2],
          );
          for (const r of ftsResults) {
            // Normalize rank to 0..1 (0 = perfect match)
            const normalized = Math.max(0, Math.min(1, 1 - r.rank / 100));
            ftsScores.set(r.rowid, normalized);
          }
        }
      } catch {
        // FTS may not be available
      }

      // ── Score all candidates ──────────────────────────────────────────────
      const scored = candidates.map(row => {
        const ftsRank = ftsScores.get(row.id) ?? 0;
        const signals = computeFusedScore(row, queryVec, queryTokens, queryEntities, ftsRank);
        return { row, signals };
      });

      // Sort by fused score descending
      scored.sort((a, b) => b.signals.fused - a.signals.fused);

      // Take top results
      const top = scored.slice(0, limit!);

      if (top.length === 0) {
        return 'No matching memories found.';
      }

      const lines = top.map(({ row, signals }, i) => {
        const content = row.content.replace(/^\[.*?\]\s*/, '');
        const pct = Math.round(signals.fused * 100);
        return `${i + 1}. ${content} (relevance: ${pct}%)`;
      });

      return `📋 Relevant memories (${top.length} of ${candidates.length} total):\n${lines.join('\n')}`;
    },
  });

  return {
    save_memory: saveMemoryTool,
    recall_memories: recallMemoriesTool,
  };
}
