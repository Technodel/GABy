/**
 * Unit tests for code-chunks.ts — semantic chunk search, prompt formatting, stats
 *
 * Uses an in-memory SQLite database to isolate tests.
 * Mocks getAdapter() with a SqliteAdapter wrapping an in-memory DB.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import { SqliteAdapter } from './db-sqlite';
import type { DbAdapter } from './db-types';

// ── Mutable holder for the test adapter reference ──────────────────────────────
const mockAdapterHolder: { adapter: DbAdapter | null } = { adapter: null };

vi.mock('./db', () => ({
  getAdapter: () => {
    if (!mockAdapterHolder.adapter) {
      throw new Error('Test adapter not initialized');
    }
    return mockAdapterHolder.adapter;
  },
}));

import { searchChunks, formatChunksForPrompt, getChunkStats, clearChunkIndex } from './code-chunks';
import { textToVector, serializeVector } from './vectors';

const VECTOR_DIMS = 2000;

async function createTables(adapter: DbAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      symbol_name TEXT NOT NULL DEFAULT '',
      symbol_type TEXT NOT NULL DEFAULT 'block',
      start_line INTEGER NOT NULL DEFAULT 0,
      end_line INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      vector_b64 TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, file_path, symbol_name, symbol_type)
    );
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

async function seedChunks(adapter: DbAdapter, projectId: number, count: number): Promise<void> {
  const samples = [
    { file: 'src/server/index.ts', sym: 'main', type: 'function', content: 'function main() { const app = express(); app.listen(3500); }' },
    { file: 'src/server/db.ts', sym: 'getDb', type: 'function', content: 'function getDb() { if (!db) { db = new Database(path); db.pragma("journal_mode=WAL"); } return db; }' },
    { file: 'src/server/auth.ts', sym: 'requireAuth', type: 'function', content: 'function requireAuth(req, res, next) { const token = req.cookies.suny_token; if (!token) return res.status(401); }' },
    { file: 'src/client/App.tsx', sym: 'App', type: 'component', content: 'function App() { return <div>Hello World</div>; }' },
    { file: 'src/client/chat.tsx', sym: 'Chat', type: 'component', content: 'function Chat() { const [messages, setMessages] = useState([]); return <div>chat</div>; }' },
  ];

  for (let i = 0; i < count && i < samples.length; i++) {
    const s = samples[i];
    const vec = serializeVector(textToVector(s.content, VECTOR_DIMS));
    const hash = 'test_hash_' + i;
    await adapter.run(
      `INSERT OR IGNORE INTO code_chunks (project_id, file_path, symbol_name, symbol_type, start_line, end_line, content, content_hash, vector_b64)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, s.file, s.sym, s.type, 1, 20, s.content, hash, vec],
    );
  }
}

describe('getChunkStats', () => {
  let adapter: DbAdapter;

  beforeAll(async () => {
    const db = new Database(':memory:');
    adapter = new SqliteAdapter(':memory:', db);
    mockAdapterHolder.adapter = adapter;
    await createTables(adapter);
  });

  it('returns zero stats when table is empty', async () => {
    const stats = await getChunkStats(1);
    expect(stats.total).toBe(0);
    expect(stats.files).toBe(0);
    expect(stats.indexed_at).toBeNull();
  });

  it('returns correct counts after seeding chunks', async () => {
    await seedChunks(adapter, 999, 3);
    const stats = await getChunkStats(999);
    expect(stats.total).toBe(3);
    expect(stats.files).toBeGreaterThanOrEqual(1);
    expect(stats.indexed_at).toBeTruthy();
  });
});

describe('searchChunks', () => {
  beforeAll(async () => {
    const db = new Database(':memory:');
    const adapter = new SqliteAdapter(':memory:', db);
    mockAdapterHolder.adapter = adapter;
    await createTables(adapter);
    await seedChunks(adapter, 42, 5);
  });

  it('returns empty array for project with no chunks', async () => {
    const results = await searchChunks('test', 9999, 3);
    expect(results).toEqual([]);
  });

  it('returns relevant results for project with chunks', async () => {
    const results = await searchChunks('database connection', 42, 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThanOrEqual(3);
    // The first result should be semantically relevant
    expect(results[0].score).toBeGreaterThan(0.05);
  });

  it('includes expected fields in results', async () => {
    const results = await searchChunks('express server', 42, 2);
    if (results.length > 0) {
      expect(results[0]).toHaveProperty('filePath');
      expect(results[0]).toHaveProperty('symbolName');
      expect(results[0]).toHaveProperty('symbolType');
      expect(results[0]).toHaveProperty('startLine');
      expect(results[0]).toHaveProperty('endLine');
      expect(results[0]).toHaveProperty('content');
      expect(results[0]).toHaveProperty('score');
    }
  });

  it('respects topK parameter', async () => {
    const results = await searchChunks('test', 42, 1);
    expect(results.length).toBeLessThanOrEqual(1);
  });
});

describe('clearChunkIndex', () => {
  let adapter: DbAdapter;

  beforeAll(async () => {
    const db = new Database(':memory:');
    adapter = new SqliteAdapter(':memory:', db);
    mockAdapterHolder.adapter = adapter;
    await createTables(adapter);
    await seedChunks(adapter, 7, 3);
  });

  it('removes all chunks for the project', async () => {
    expect((await getChunkStats(7)).total).toBe(3);
    await clearChunkIndex(7);
    expect((await getChunkStats(7)).total).toBe(0);
  });

  it('does not affect other projects', async () => {
    await seedChunks(adapter, 7, 2);
    await seedChunks(adapter, 8, 1);
    expect((await getChunkStats(7)).total).toBe(2);
    expect((await getChunkStats(8)).total).toBe(1);
    await clearChunkIndex(7);
    expect((await getChunkStats(7)).total).toBe(0);
    expect((await getChunkStats(8)).total).toBe(1);
  });
});

describe('formatChunksForPrompt', () => {
  it('returns empty string for empty chunks', () => {
    expect(formatChunksForPrompt([], '/project')).toBe('');
  });

  it('formats a single chunk correctly', () => {
    const chunks = [{
      filePath: '/project/src/index.ts',
      symbolName: 'main',
      symbolType: 'function',
      startLine: 1,
      endLine: 10,
      content: 'function main() {}',
      score: 0.9,
    }];
    const result = formatChunksForPrompt(chunks, '/project');
    expect(result).toContain('SEMANTICALLY RELEVANT CODE');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('function `main` (L1–10)');
    expect(result).toContain('function main() {}');
    expect(result).toContain('END VECTOR CONTEXT');
  });

  it('groups chunks by file', () => {
    const chunks = [
      { filePath: '/project/a.ts', symbolName: 'foo', symbolType: 'function', startLine: 1, endLine: 5, content: 'function foo() {}', score: 0.8 },
      { filePath: '/project/a.ts', symbolName: 'bar', symbolType: 'function', startLine: 10, endLine: 15, content: 'function bar() {}', score: 0.7 },
      { filePath: '/project/b.ts', symbolName: 'baz', symbolType: 'class', startLine: 1, endLine: 20, content: 'class Baz {}', score: 0.6 },
    ];
    const result = formatChunksForPrompt(chunks, '/project');
    // File sections appear once
    expect(result.split('--- a.ts ---').length).toBe(2);
    expect(result.split('--- b.ts ---').length).toBe(2);
    // Both symbols in a.ts are present
    expect(result).toContain('function `foo`');
    expect(result).toContain('function `bar`');
  });

  it('handles block-type symbols', () => {
    const chunks = [{
      filePath: '/project/app.py',
      symbolName: 'block_L1',
      symbolType: 'block',
      startLine: 1,
      endLine: 50,
      content: 'print("hello")',
      score: 0.5,
    }];
    const result = formatChunksForPrompt(chunks, '/project');
    expect(result).toContain('lines 1–50');
    expect(result).not.toContain('block `block_L1`');
  });

  it('strips the project path prefix from file paths', () => {
    const chunks = [{
      filePath: '/Users/test/projects/myapp/src/lib/helper.ts',
      symbolName: 'helper',
      symbolType: 'function',
      startLine: 1,
      endLine: 10,
      content: 'export function helper() {}',
      score: 0.9,
    }];
    const result = formatChunksForPrompt(chunks, '/Users/test/projects/myapp');
    expect(result).toContain('src/lib/helper.ts');
    expect(result).not.toContain('/Users/test/projects/myapp');
  });
});
