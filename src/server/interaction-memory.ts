/**
 * interaction-memory.ts â€” Phase 3 + Ruflo HNSW vector upgrade.
 *
 * Stores past user-question + AI-answer pairs and retrieves similar
 * ones as context using HNSW vector similarity search.
 *
 * FALLBACK: if no vectors are indexed (e.g., first run), uses keyword
 * overlap scoring as before. This is purely additive and best-effort.
 */

import { getDb } from './db';
import { textToVector, serializeVector, deserializeVector, cosineSimilarity } from './vectors';
import { HNSWIndex } from './hnsw-lite';

// â”€â”€ In-memory HNSW index â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rebuilt on module load from stored vectors. Updates in real-time.
const VECTOR_DIMS = 2000;
let hnswIndex: HNSWIndex | null = null;
let indexDirty = false;

function ensureIndex(): HNSWIndex {
  if (!hnswIndex) {
    hnswIndex = new HNSWIndex(VECTOR_DIMS, 16, 200);
    // Load existing vectors from DB
    try {
      const db = getDb();
      const rows = db.prepare('SELECT id, vector_b64 FROM interaction_memory WHERE vector_b64 IS NOT NULL ORDER BY id').all() as {
        id: number;
        vector_b64: string;
      }[];
      for (const row of rows) {
        try {
          const vec = deserializeVector(row.vector_b64, VECTOR_DIMS);
          hnswIndex.insert(row.id, vec);
        } catch { /* skip corrupt vectors */ }
      }
      console.log(`[interaction-memory] Loaded ${rows.length} vectors into HNSW index`);
    } catch {
      // Table may not have vector_b64 column yet
    }
  }
  return hnswIndex;
}

export interface InteractionRecord {
  id?: number;
  userId: number;
  projectId: number | null;
  userMessage: string;
  aiResponse: string;
  mode: string;
  keywordsJson: string;
  vectorB64?: string;
  createdAt?: string;
}

export interface InteractionStats {
  total: number;
  byMode: { mode: string; count: number }[];
  uniqueUsers: number;
  indexedVectors: number;
}

export function initializeInteractionMemoryTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_memory (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      project_id  INTEGER DEFAULT NULL,
      user_message TEXT NOT NULL,
      ai_response  TEXT NOT NULL,
      mode         TEXT DEFAULT 'fast',
      keywords_json TEXT DEFAULT '[]',
      vector_b64   TEXT DEFAULT NULL,
      created_at   TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_im_user_id ON interaction_memory(user_id);
    CREATE INDEX IF NOT EXISTS idx_im_created ON interaction_memory(created_at);
  `);

  // Migration: add vector_b64 column if it doesn't exist
  try { db.exec('ALTER TABLE interaction_memory ADD COLUMN vector_b64 TEXT DEFAULT NULL'); } catch { /* already exists */ }
}

/** Extract simple keywords from text (lowercase words, length >= 4, skip stopwords). */
function extractKeywords(text: string): string[] {
  const stopwords = new Set([
    'that', 'this', 'with', 'from', 'have', 'they', 'will', 'what', 'when',
    'where', 'your', 'more', 'than', 'then', 'also', 'some', 'been', 'were',
    'does', 'into', 'their', 'there', 'about', 'which', 'would', 'could',
    'should', 'other', 'after', 'before', 'these', 'those', 'every', 'just',
    'make', 'made', 'need', 'want', 'like', 'much', 'many', 'only', 'over',
    'such', 'each', 'both', 'very', 'well', 'even', 'back', 'come', 'here',
  ]);
  const words = text.toLowerCase().match(/[a-z]{4,}/g) || [];
  const unique = new Set(words.filter(w => !stopwords.has(w)));
  return Array.from(unique).slice(0, 30);
}

/** Store an interaction. Best-effort â€” never throws. */
export function recordInteraction(record: Omit<InteractionRecord, 'id' | 'createdAt' | 'keywordsJson' | 'vectorB64'>): void {
  try {
    const db = getDb();
    const keywords = extractKeywords(record.userMessage + ' ' + record.aiResponse);

    // Generate vector embedding
    const combinedText = `${record.userMessage} ${record.aiResponse}`;
    const vec = textToVector(combinedText, VECTOR_DIMS);
    const vecB64 = serializeVector(vec);

    const result = db.prepare(`
      INSERT INTO interaction_memory (user_id, project_id, user_message, ai_response, mode, keywords_json, vector_b64)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.userId,
      record.projectId ?? null,
      record.userMessage.slice(0, 2000),
      record.aiResponse.slice(0, 4000),
      record.mode,
      JSON.stringify(keywords),
      vecB64,
    );

    // Add to HNSW index in memory
    const newId = result.lastInsertRowid as number;
    const idx = ensureIndex();
    try {
      idx.insert(newId, vec);
      indexDirty = true;
    } catch {
      // Best-effort
    }
  } catch {
    // best-effort
  }
}

export interface SimilarInteraction {
  id: number;
  userMessage: string;
  aiResponse: string;
  createdAt: string;
  score: number;  // cosine similarity (0..1) or keyword overlap count
}

/**
 * Find past interactions similar to a query.
 *
 * PRIMARY: HNSW vector similarity search (O(log N)).
 * FALLBACK: keyword overlap scoring when vectors not available.
 *
 * Returns top N results ordered by score desc.
 */
export function findSimilarInteractions(
  userId: number,
  query: string,
  opts: { limit?: number; projectId?: number | null; minScore?: number } = {},
): SimilarInteraction[] {
  try {
    const db = getDb();
    const { limit = 3, projectId, minScore = 0.3 } = opts;
    const queryKeywords = new Set(extractKeywords(query));

    // â”€â”€ Vector search â”€â”€
    const idx = ensureIndex();
    if (idx.size > 0) {
      const queryVec = textToVector(query, VECTOR_DIMS);
      const vectorResults = idx.search(queryVec, limit * 3, 100);

      if (vectorResults.length > 0) {
        const ids = vectorResults.map(r => r.id);
        const placeholders = ids.map(() => '?').join(',');

        const rows = db.prepare(`
          SELECT id, user_message, ai_response, created_at
          FROM interaction_memory
          WHERE user_id = ? AND id IN (${placeholders})
          ${projectId !== undefined && projectId !== null ? 'AND project_id = ?' : ''}
        `).all(...(projectId !== undefined && projectId !== null
          ? [userId, ...ids, projectId]
          : [userId, ...ids]
        )) as {
          id: number;
          user_message: string;
          ai_response: string;
          created_at: string;
        }[];

        // Re-sort by HNSW distance
        const idToDist = new Map(vectorResults.map(r => [r.id, 1 - r.distance])); // convert distance to similarity
        return rows
          .map(row => ({
            id: row.id,
            userMessage: row.user_message,
            aiResponse: row.ai_response,
            createdAt: row.created_at,
            score: idToDist.get(row.id) ?? 0,
          }))
          .filter(r => r.score >= minScore)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      }
    }

    // â”€â”€ Fallback: keyword overlap (for non-vector rows) â”€â”€
    if (queryKeywords.size === 0) return [];

    const rows = db.prepare(`
      SELECT id, user_message, ai_response, keywords_json, created_at
      FROM interaction_memory
      WHERE user_id = ? ${projectId !== undefined && projectId !== null ? 'AND project_id = ?' : ''}
        AND vector_b64 IS NULL
      ORDER BY created_at DESC
      LIMIT 200
    `).all(...(projectId !== undefined && projectId !== null ? [userId, projectId] : [userId])) as {
      id: number;
      user_message: string;
      ai_response: string;
      keywords_json: string;
      created_at: string;
    }[];

    const scored: SimilarInteraction[] = rows
      .map(row => {
        let keywords: string[] = [];
        try { keywords = JSON.parse(row.keywords_json); } catch { /* ignore */ }
        const overlap = keywords.filter(k => queryKeywords.has(k)).length;
        return {
          id: row.id,
          userMessage: row.user_message,
          aiResponse: row.ai_response,
          createdAt: row.created_at,
          score: overlap,
        };
      })
      .filter(r => r.score >= (opts.minScore ?? 1))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  } catch {
    return [];
  }
}

/**
 * Rebuild the HNSW index from all stored vectors in the DB.
 * Useful after bulk imports or DB restoration.
 */
export function rebuildVectorIndex(): { indexed: number; failed: number } {
  try {
    hnswIndex = new HNSWIndex(VECTOR_DIMS, 16, 200);
    const db = getDb();
    const rows = db.prepare('SELECT id, vector_b64 FROM interaction_memory WHERE vector_b64 IS NOT NULL ORDER BY id').all() as {
      id: number;
      vector_b64: string;
    }[];
    let failed = 0;
    for (const row of rows) {
      try {
        const vec = deserializeVector(row.vector_b64, VECTOR_DIMS);
        hnswIndex.insert(row.id, vec);
      } catch {
        failed++;
      }
    }
    indexDirty = false;
    console.log(`[interaction-memory] Rebuilt HNSW index: ${rows.length - failed} indexed, ${failed} failed`);
    return { indexed: rows.length - failed, failed };
  } catch {
    return { indexed: 0, failed: 0 };
  }
}

/** Format similar interactions as a context block to inject into system prompt. */
export function formatSimilarInteractionsContext(interactions: SimilarInteraction[]): string {
  if (interactions.length === 0) return '';
  const blocks = interactions.map((r, i) =>
    `[Memory ${i + 1}] User asked: "${r.userMessage.slice(0, 200)}"\nAI answered: "${r.aiResponse.slice(0, 400)}"`
  );
  return `<!-- Past relevant interactions:\n${blocks.join('\n\n')}\n-->`;
}

export function getInteractionMemoryStats(): InteractionStats {
  const db = getDb();
  const total = (db.prepare('SELECT COUNT(*) as c FROM interaction_memory').get() as { c: number }).c;
  const byMode = db.prepare(
    'SELECT mode, COUNT(*) as count FROM interaction_memory GROUP BY mode ORDER BY count DESC'
  ).all() as { mode: string; count: number }[];
  const uniqueUsers = (db.prepare('SELECT COUNT(DISTINCT user_id) as c FROM interaction_memory').get() as { c: number }).c;
  const indexedVectors = (db.prepare('SELECT COUNT(*) as c FROM interaction_memory WHERE vector_b64 IS NOT NULL').get() as { c: number }).c;
  return { total, byMode, uniqueUsers, indexedVectors };
}
