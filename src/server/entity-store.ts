/**
 * entity-store.ts — Entity extraction, storage, and linking for memory systems.
 *
 * Extracts named entities (people, technologies, patterns, domains) from text,
 * stores them with relationships, and provides entity-aware retrieval that
 * boosts memory scores when queried entities match stored entities.
 *
 * Part of the mem0-inspired memory upgrade (P2).
 */

import { getDb } from './db';
import { textToVector, serializeVector, deserializeVector, cosineSimilarity, applyTemporalRank } from './vectors';

// ── Types ────────────────────────────────────────────────────────────────────

export interface EntityRecord {
  id: number;
  userId: number;
  entityType: EntityType;
  entityName: string;
  normalizedName: string;
  contextText: string;
  sourceTable: string;
  sourceRowId: number;
  embeddingB64: string | null;
  created_at: string;
}

export type EntityType =
  | 'technology'     // React, TypeScript, SQLite, etc.
  | 'framework'      // Express, Next.js, Spring, etc.
  | 'language'       // JavaScript, Python, Go, etc.
  | 'pattern'        // Observer, Singleton, MVVM, etc.
  | 'domain'         // auth, payment, search, etc.
  | 'file_path'      // src/server/index.ts, etc.
  | 'function_name'  // handleLogin, processPayment, etc.
  | 'concept'        // caching, streaming, pagination, etc.
  | 'person'         // team member or user name
  | 'project'        // project name or reference
  | 'generic';

export interface EntityLink {
  entityId: number;
  linkedTable: string;
  linkedRowId: number;
  relationship: string;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
  context: string;
}

// ── Entity extraction patterns ───────────────────────────────────────────────

const ENTITY_PATTERNS: Array<{ type: EntityType; regex: RegExp }> = [
  // File paths
  { type: 'file_path', regex: /(?:`|['"]?)((?:src|app|lib|components|pages|server)\/[\/\w.-]+\.\w+)(?:`|['"]?)/gi },
  // Function/method names: camelCase function calls
  { type: 'function_name', regex: /(?:function\s+(\w+)|(\w+)\s*\([^)]*\)\s*\{)/g },
  // Technologies: PascalCase or capitalized tech names
  { type: 'technology', regex: /\b(React|Vue|Angular|Svelte|Node\.?js|Deno|Bun|Express|Fastify|Koa|Next\.?js|Nuxt|Prisma|Drizzle|TypeORM|Sequelize|Mongoose|Tailwind|Bootstrap|MaterialUI|Chakra|Redis|Postgres(?:QL)?|MySQL|SQLite|MongoDB|Docker|Kubernetes|AWS|GCP|Azure|Firebase|Supabase|Vercel|Netlify|Heroku|GraphQL|REST|gRPC|WebSocket|tRPC|Zod|Valibot|Joi|Yup|Jest|Vitest|Mocha|Cypress|Playwright|Puppeteer|ESLint|Prettier|Webpack|Vite|Rollup|ESBuild|Turbo|Nx|Lerna|Yarn|pnpm|npm)\b/g },
  // Frameworks
  { type: 'framework', regex: /\b(Express|Fastify|Koa|Hono|Next|Nuxt|Nest|Spring|Django|Flask|Rails|Laravel|Symfony|ASP\.NET|Blazor|Phoenix|Gin|Echo|Fiber|Axum|Actix|Tauri|Electron)\b/g },
  // Languages
  { type: 'language', regex: /\b(JavaScript|TypeScript|Python|Rust|Go|Golang|Java|Kotlin|Swift|C#|C\+\+|C\s?Sharp|Ruby|PHP|Elixir|Erlang|Scala|Haskell|Clojure|Dart|R|Julia|Perl|Lua|Zig|OCaml|F#)\b/g },
  // Design patterns
  { type: 'pattern', regex: /\b(Singleton|Factory|Observer|Decorator|Strategy|Adapter|Facade|Proxy|Command|Iterator|Mediator|Memento|State|Template|Visitor|Module|MVC|MVVM|MVP|Repository|Service|DI|IoC|Dependency\s+Injection|Inversion\s+of\s+Control|Container|Provider|Hook|HOC|Render\s+Prop|Compound\s+Component)\b/g },
  // Domain concepts (lowercase domain words)
  { type: 'domain', regex: /\b(auth(?:entication|orization)?|payment|checkout|subscription|billing|search|indexing|caching|logging|monitoring|analytics|dashboard|notification|email|sms|push|webhook|streaming|upload|download|sync|migration|seed|deploy|pipeline|workflow|orchestrat|scheduler|queue|pub\s*sub|event|web\s*socket|middleware|guard|resolver|adapter|facade|proxy|factory|controller|service|repository|store|slice|hook|context|provider|layout|shell|portal)\b/gi },
];

const STOPWORDS = new Set([
  'that', 'this', 'with', 'from', 'have', 'they', 'will', 'what', 'when',
  'where', 'your', 'more', 'than', 'then', 'also', 'some', 'been', 'were',
  'does', 'into', 'their', 'there', 'about', 'which', 'would', 'could',
  'should', 'other', 'after', 'before', 'these', 'those', 'every', 'just',
  'make', 'made', 'need', 'want', 'like', 'much', 'many', 'only', 'over',
  'such', 'each', 'both', 'very', 'well', 'even', 'back', 'come', 'here',
  'use', 'used', 'using', 'get', 'gets', 'got', 'set', 'sets', 'setting',
  'run', 'runs', 'running', 'let', 'lets', 'put', 'puts', 'putting',
]);

// ── Extract entities from text ───────────────────────────────────────────────

/**
 * Extract named entities from a text string.
 * Returns deduplicated entities with their types and surrounding context.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  const entities = new Map<string, ExtractedEntity>();

  for (const { type, regex } of ENTITY_PATTERNS) {
    regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const name = (match[1] || match[2] || match[0]).trim();
      if (!name || name.length < 2) continue;
      if (STOPWORDS.has(name.toLowerCase())) continue;

      // Get surrounding context (up to 40 chars before and after)
      const idx = match.index;
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + name.length + 40);
      const context = text.slice(start, end).replace(/\n/g, ' ').trim();

      const key = `${type}:${name.toLowerCase()}`;
      if (!entities.has(key)) {
        entities.set(key, { name, type, context: context.slice(0, 120) });
      }
    }
  }

  return Array.from(entities.values());
}

/**
 * Normalize an entity name for consistent matching.
 */
export function normalizeEntityName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

// ── Database operations ──────────────────────────────────────────────────────

/**
 * Initialize the entities table and supporting indexes.
 */
export function initializeEntityStore(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      entity_type TEXT NOT NULL,
      entity_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      context_text TEXT DEFAULT '',
      source_table TEXT NOT NULL,
      source_row_id INTEGER NOT NULL,
      embedding_b64 TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_mem_entities_user ON memory_entities(user_id);
    CREATE INDEX IF NOT EXISTS idx_mem_entities_type ON memory_entities(entity_type);
    CREATE INDEX IF NOT EXISTS idx_mem_entities_normalized ON memory_entities(normalized_name);
    CREATE INDEX IF NOT EXISTS idx_mem_entities_source ON memory_entities(source_table, source_row_id);
  `);

  // Add FTS5 for entity text search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_entities_fts USING fts5(
        entity_name,
        context_text,
        content='memory_entities',
        content_rowid='id',
        tokenize='porter unicode61'
      );
    `);
  } catch {
    // May already exist
  }
}

/**
 * Store extracted entities from a text source, linked to their source record.
 */
export function storeEntities(
  userId: number,
  sourceTable: string,
  sourceRowId: number,
  entities: ExtractedEntity[],
): void {
  const db = getDb();

  for (const entity of entities) {
    const normalized = normalizeEntityName(entity.name);

    // Check if this entity already exists for this source
    const existing = db.prepare(
      'SELECT id FROM memory_entities WHERE user_id = ? AND normalized_name = ? AND source_table = ? AND source_row_id = ?'
    ).get(userId, normalized, sourceTable, sourceRowId) as { id: number } | undefined;

    if (existing) continue; // deduplicate

    // Generate a lightweight embedding for this entity
    const vec = textToVector(`${entity.name} ${entity.context}`, 2000);
    const vecB64 = serializeVector(vec);

    db.prepare(`
      INSERT INTO memory_entities (user_id, entity_type, entity_name, normalized_name, context_text, source_table, source_row_id, embedding_b64)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(userId, entity.type, entity.name.slice(0, 200), normalized, entity.context, sourceTable, sourceRowId, vecB64);

    // Update FTS index
    try {
      // FTS is linked via content_sync — just ensure the row is indexed
      // We use direct insert into FTS table for explicit sync
      const entityId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
      db.prepare(`
        INSERT INTO memory_entities_fts (rowid, entity_name, context_text)
        VALUES (?, ?, ?)
      `).run(entityId.id, entity.name, entity.context);
    } catch {
      // FTS may not be available or row already indexed
    }
  }
}

/**
 * Find entities matching a query by name or type.
 * Returns scored results: exact name match > type match > fuzzy match.
 */
export function findEntities(options: {
  userId: number;
  query?: string;
  entityType?: EntityType;
  limit?: number;
}): EntityRecord[] {
  const db = getDb();
  const { userId, query, entityType, limit = 20 } = options;
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [userId];

  if (entityType) {
    conditions.push('entity_type = ?');
    params.push(entityType);
  }

  if (query) {
    // Try FTS5 search first
    try {
      const normalized = normalizeEntityName(query);
      const ftsRows = db.prepare(`
        SELECT me.id, me.user_id, me.entity_type, me.entity_name, me.normalized_name,
               me.context_text, me.source_table, me.source_row_id, me.embedding_b64, me.created_at
        FROM memory_entities_fts fts
        JOIN memory_entities me ON fts.rowid = me.id
        WHERE memory_entities_fts MATCH ?
          AND me.user_id = ?
          ${entityType ? 'AND me.entity_type = ?' : ''}
        ORDER BY rank
        LIMIT ?
      `).all(
        query.replace(/[^a-zA-Z0-9 ]/g, ''),
        userId,
        ...(entityType ? [entityType] : []),
        limit,
      ) as EntityRecord[];

      if (ftsRows.length > 0) return ftsRows;
    } catch {
      // FTS5 not available, fall through to basic search
    }

    // Fallback: LIKE search on entity_name
    conditions.push('(normalized_name LIKE ? OR entity_name LIKE ?)');
    const likeQuery = `%${normalizeEntityName(query)}%`;
    params.push(likeQuery, likeQuery);
  }

  const sql = `
    SELECT * FROM memory_entities
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  params.push(limit);

  return db.prepare(sql).all(...params) as EntityRecord[];
}

/**
 * Find entities with vector similarity to a query text.
 * Returns entities sorted by cosine similarity (temporally ranked).
 */
export function findSimilarEntities(
  userId: number,
  queryText: string,
  limit: number = 10,
): Array<EntityRecord & { similarity: number }> {
  const db = getDb();
  const queryVec = textToVector(queryText, 2000);

  const rows = db.prepare(`
    SELECT id, entity_name, entity_type, context_text, source_table, source_row_id, embedding_b64, created_at
    FROM memory_entities
    WHERE user_id = ? AND embedding_b64 IS NOT NULL
    ORDER BY created_at DESC
    LIMIT 200
  `).all(userId) as Array<{
    id: number;
    entity_name: string;
    entity_type: string;
    context_text: string;
    source_table: string;
    source_row_id: number;
    embedding_b64: string;
    created_at: string;
  }>;

  const scored = rows
    .map(row => {
      try {
        const vec = deserializeVector(row.embedding_b64, 2000);
        const rawSim = cosineSimilarity(queryVec, vec);
        const timeRanked = applyTemporalRank(rawSim, row.created_at, 0.05);
        return {
          id: row.id,
          userId,
          entityType: row.entity_type as EntityType,
          entityName: row.entity_name,
          normalizedName: normalizeEntityName(row.entity_name),
          contextText: row.context_text,
          sourceTable: row.source_table,
          sourceRowId: row.source_row_id,
          embeddingB64: row.embedding_b64,
          created_at: row.created_at,
          similarity: timeRanked,
        };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null && r.similarity > 0.15)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return scored;
}

/**
 * Get all entities linked to a specific source record.
 */
export function getEntitiesForSource(
  sourceTable: string,
  sourceRowId: number,
): EntityRecord[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM memory_entities
    WHERE source_table = ? AND source_row_id = ?
    ORDER BY entity_type, entity_name
  `).all(sourceTable, sourceRowId) as EntityRecord[];
}

/**
 * Get entity-based context string for prompt injection.
 * Returns a concise list of entities relevant to the current query.
 */
export function getEntityContext(
  userId: number,
  queryText: string,
  maxEntities: number = 8,
): string {
  if (!queryText) return '';

  // Get similar entities via vector search
  const similar = findSimilarEntities(userId, queryText, maxEntities);

  if (similar.length === 0) {
    // Fallback: exact match entities
    const exact = findEntities({ userId, query: queryText, limit: maxEntities });
    if (exact.length === 0) return '';

    const lines = exact.map(e =>
      `  • ${e.entityName} (${e.entityType})`
    );
    return `<relevant_entities>\n${lines.join('\n')}\n</relevant_entities>`;
  }

  const lines = similar.map(e =>
    `  • ${e.entityName} (${e.entityType}, similarity: ${(e.similarity * 100).toFixed(0)}%)`
  );

  return `<relevant_entities>\n${lines.join('\n')}\n</relevant_entities>`;
}

/**
 * Extract and store entities from a batch of text, linking them to the source record.
 * Convenience wrapper for use by memory modules.
 */
export function extractAndStoreEntities(
  userId: number,
  sourceTable: string,
  sourceRowId: number,
  text: string,
): number {
  const entities = extractEntities(text);
  if (entities.length === 0) return 0;
  storeEntities(userId, sourceTable, sourceRowId, entities);
  return entities.length;
}
