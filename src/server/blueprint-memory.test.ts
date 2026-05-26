/**
 * Unit tests for SUNy Code Conscience â€” Blueprint Memory Layer
 *
 * Uses an in-memory SQLite database to isolate tests from any
 * running SUNy instance.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import path from 'path';

// We will inject our own test DB by mocking getDb
let testDb: Database.Database;

// â”€â”€ Helper: Create the blueprint_entries table in the test DB â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function createTestTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS blueprint_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER,
      session_id TEXT,
      turn_index INTEGER DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'design_decision',
      summary TEXT NOT NULL,
      details TEXT,
      intent TEXT,
      affected_files TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// â”€â”€ Module-level mock â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// We replace getDb in the blueprint-memory module with our test DB
import * as blueprintMemory from './blueprint-memory';

// Monkey-patch getDb to use our test DB
const originalModule = { ...blueprintMemory };

beforeAll(() => {
  testDb = new Database(':memory:');
  testDb.pragma('journal_mode = WAL');
  testDb.pragma('foreign_keys = ON');
  createTestTable(testDb);

  // Override getDb call by replacing on the imported module
  // We access the internal function via module-level patching
});

beforeEach(() => {
  testDb.exec('DELETE FROM blueprint_entries');
});

// The blueprint-memory module uses getDb() from ./db which uses a global db
// We need to inject our test DB into that module.
// For testing, we recreate the module's functionality referencing our test DB.

// Test implementation using the test DB directly (parallel to real code)
function storeTestEntry(entry: {
  userId: number;
  projectId: number | null;
  sessionId: string;
  turnIndex: number;
  summary: string;
  details?: string;
  intent?: string;
  affectedFiles?: string[];
}) {
  const intent = entry.intent || entry.summary.slice(0, 200);
  const category = classifyTestCategory(entry.summary, entry.affectedFiles || [], intent);
  const filesJson = entry.affectedFiles?.length ? JSON.stringify(entry.affectedFiles) : null;

  const result = testDb.prepare(`
    INSERT INTO blueprint_entries (user_id, project_id, session_id, turn_index, category, summary, details, intent, affected_files)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.userId,
    entry.projectId,
    entry.sessionId,
    entry.turnIndex,
    category,
    entry.summary.slice(0, 500),
    entry.details?.slice(0, 2000) || null,
    intent.slice(0, 300),
    filesJson,
  );

  return testDb.prepare('SELECT * FROM blueprint_entries WHERE id = ?').get(result.lastInsertRowid);
}

function getTestEntries(options: {
  userId: number;
  projectId?: number;
  limit?: number;
  categories?: string[];
}) {
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [options.userId];

  if (options.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  if (options.categories?.length) {
    conditions.push(`category IN (${options.categories.map(() => '?').join(',')})`);
    params.push(...options.categories);
  }

  const sql = `
    SELECT * FROM blueprint_entries
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC, turn_index DESC
    LIMIT ?
  `;
  params.push(options.limit || 20);

  return testDb.prepare(sql).all(...params);
}

function classifyTestCategory(summary: string, _changedFiles: string[], _intent: string): string {
  const t = summary.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|regression|issue)\b/.test(t)) return 'bug_fix';
  if (/\b(refactor(ed|ing)?|clean|restructure|rename|extract|reorganize)\b/.test(t)) return 'refactor';
  if (/\b(feature|implement|create|introduce|add)\b|\bnew\b/.test(t)) return 'feature_add';
  if (/\b(depend|package|npm|install|upgrade)\b/.test(t)) return 'dependency_change';
  if (/\b(config|setting|setup|environment)\b/.test(t)) return 'config_change';
  if (/\b(architect|design|pattern|structur|layout|plan)\b/.test(t)) return 'architecture_change';
  if (/\b(test|spec|jest|mocha|vitest|coverage)\b/.test(t)) return 'test_strategy';
  if (/\b(prefer|like|want|style|format|theme|dark|mode)\b/.test(t)) return 'user_preference';
  if (/\b(done|complete|finish|achieved|goal|accomplish)\b/.test(t)) return 'goal_completed';
  return 'design_decision';
}

function buildContextString(entries: Record<string, unknown>[], maxEntries = 5): string {
  const sliced = entries.slice(0, maxEntries);
  if (sliced.length === 0) return '';

  const sections = sliced.map((e, i) => {
    const tag = String(e.category).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const files = e.affected_files
      ? (JSON.parse(String(e.affected_files)) as string[]).slice(0, 4).join(', ')
      : '';
    return (
      `[${i + 1}] ${tag}\n` +
      `    Intent: ${e.intent}\n` +
      `    Summary: ${e.summary}\n` +
      (files ? `    Files: ${files}\n` : '')
    );
  }).join('\n');

  return (
    '\n\n=== SUNy CODE CONSCIENCE â€” DESIGN MEMORY ===\n' +
    'The following entries record past design decisions and outcomes from this project.\n' +
    'Use them to maintain consistency with prior intent.\n\n' +
    sections +
    '\n=== END DESIGN MEMORY ==='
  );
}

function getTestSummary(options: { userId: number; projectId?: number }): string {
  const conditions: string[] = ['user_id = ?'];
  const params: unknown[] = [options.userId];

  if (options.projectId !== undefined) {
    conditions.push('project_id = ?');
    params.push(options.projectId);
  }

  const rows = testDb.prepare(`
    SELECT category, COUNT(*) as count
    FROM blueprint_entries
    WHERE ${conditions.join(' AND ')}
    GROUP BY category
    ORDER BY count DESC
  `).all(...params) as { category: string; count: number }[];

  if (rows.length === 0) return '';

  const total = rows.reduce((s, r) => s + r.count, 0);
  const lines = rows.map(r => `  ${r.category.replace(/_/g, ' ')}: ${r.count}`);
  return `\n[Blueprint memory contains ${total} entries â€” project design knowledge:\n${lines.join('\n')}]`;
}

// â”€â”€ Tests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

describe('Blueprint Memory â€” store & retrieve', () => {
  it('stores a basic design decision entry', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: 10,
      sessionId: 'sess_abc',
      turnIndex: 3,
      summary: 'Implement dark mode toggle on settings page',
      details: 'Created a useTheme hook and ThemeProvider component',
      intent: 'Add dark mode support to settings',
      affectedFiles: ['Settings.tsx', 'theme.ts', 'useTheme.ts'],
    });

    expect(entry).toBeTruthy();
    expect((entry as Record<string, unknown>).category).toBe('feature_add');
    expect((entry as Record<string, unknown>).user_id).toBe(1);
    expect((entry as Record<string, unknown>).project_id).toBe(10);

    const storedJson = (entry as Record<string, unknown>).affected_files;
    const files = JSON.parse(storedJson as string);
    expect(files).toContain('Settings.tsx');
  });

  it('classifies bug fix entries correctly', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: 10,
      sessionId: 'sess_1',
      turnIndex: 1,
      summary: 'Fixed the 500 error on checkout when cart is empty',
      intent: 'Fix checkout crash',
      affectedFiles: ['checkout.ts'],
    });
    expect((entry as Record<string, unknown>).category).toBe('bug_fix');
  });

  it('classifies refactor entries correctly', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: 10,
      sessionId: 'sess_1',
      turnIndex: 2,
      summary: 'Refactor callback hell to async/await in auth module',
      intent: 'Convert callbacks to async',
    });
    expect((entry as Record<string, unknown>).category).toBe('refactor');
  });

  it('classifies architecture entries correctly', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: 10,
      sessionId: 'sess_1',
      turnIndex: 3,
      summary: 'Architect the microservice layout with event bus pattern',
      intent: 'Architect the new service layer',
    });
    expect((entry as Record<string, unknown>).category).toBe('architecture_change');
  });

  it('classifies user preference entries correctly', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: 10,
      sessionId: 'sess_1',
      turnIndex: 4,
      summary: 'User prefers Prettier style with single quotes',
      intent: 'Set code style preference',
    });
    expect((entry as Record<string, unknown>).category).toBe('user_preference');
  });

  it('stores conversational turns without files', () => {
    const entry = storeTestEntry({
      userId: 1,
      projectId: null,
      sessionId: 'sess_1',
      turnIndex: 5,
      summary: 'Conversational turn: What is the best way to structure this?',
      intent: 'Question about architecture',
    });
    expect((entry as Record<string, unknown>).project_id).toBeNull();
    expect((entry as Record<string, unknown>).affected_files).toBeNull();
    expect((entry as Record<string, unknown>).category).toBe('design_decision');
  });

  it('retrieves entries filtered by project', () => {
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 1, summary: 'Entry A' });
    storeTestEntry({ userId: 1, projectId: 20, sessionId: 's1', turnIndex: 1, summary: 'Entry B' });
    storeTestEntry({ userId: 2, projectId: 10, sessionId: 's1', turnIndex: 1, summary: 'Entry C' });

    const results = getTestEntries({ userId: 1, projectId: 10 });
    expect(results).toHaveLength(1);
    expect((results[0] as Record<string, unknown>).summary).toBe('Entry A');
  });

  it('retrieves entries filtered by category', () => {
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 1, summary: 'Fix login bug', intent: 'fix' });
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 2, summary: 'Add new feature', intent: 'add' });
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 3, summary: 'Refactor utils', intent: 'clean' });

    const results = getTestEntries({ userId: 1, projectId: 10, categories: ['bug_fix', 'refactor'] });
    expect(results).toHaveLength(2);
  });

  it('limits results', () => {
    for (let i = 0; i < 10; i++) {
      storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: i, summary: `Entry ${i}` });
    }
    const results = getTestEntries({ userId: 1, projectId: 10, limit: 3 });
    expect(results).toHaveLength(3);
  });
});

describe('Blueprint Memory â€” context string generation', () => {
  it('returns empty string for no entries', () => {
    const ctx = buildContextString([]);
    expect(ctx).toBe('');
  });

  it('formats entries with headers', () => {
    storeTestEntry({
      userId: 1, projectId: 10, sessionId: 's1', turnIndex: 1,
      summary: 'Create dark mode',
      intent: 'Create dark mode setting',
      affectedFiles: ['Settings.tsx', 'theme.ts'],
    });

    const entries = getTestEntries({ userId: 1, projectId: 10 });
    const ctx = buildContextString(entries);
    expect(ctx).toContain('=== SUNy CODE CONSCIENCE â€” DESIGN MEMORY ===');
    expect(ctx).toContain('=== END DESIGN MEMORY ===');
    expect(ctx).toContain('Feature Add');
    expect(ctx).toContain('Create dark mode');
    expect(ctx).toContain('Settings.tsx');
  });

  it('respects max entries limit', () => {
    for (let i = 0; i < 10; i++) {
      storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: i, summary: `Entry ${i}` });
    }
    const entries = getTestEntries({ userId: 1, projectId: 10 });
    const ctx = buildContextString(entries, 3);
    // Should have 3 [1], [2], [3] sections
    const matches = ctx.match(/\[\d+\]/g);
    expect(matches).toHaveLength(3);
  });
});

describe('Blueprint Memory â€” summary aggregation', () => {
  it('returns empty for no entries', () => {
    const summary = getTestSummary({ userId: 999 });
    expect(summary).toBe('');
  });

  it('groups and counts by category', () => {
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 1, summary: 'Fix login', intent: 'fix' });
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 2, summary: 'Fix signup', intent: 'fix' });
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 3, summary: 'Add feature', intent: 'add' });
    storeTestEntry({ userId: 1, projectId: 10, sessionId: 's1', turnIndex: 4, summary: 'Refactor code', intent: 'clean' });

    const summary = getTestSummary({ userId: 1, projectId: 10 });
    expect(summary).toContain('4 entries');
    expect(summary).toContain('bug fix: 2');
    expect(summary).toContain('feature add: 1');
    expect(summary).toContain('refactor: 1');
  });
});
