/**
 * Integration tests for SUNy Code Conscience — full end-to-end flow
 *
 * Spins up the Express server on a test port with an isolated SQLite database
 * and tests the blueprint memory and change guardian modules in context.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// ── Test DB ───────────────────────────────────────────────────────────────────
const TEST_DB_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'suny-int-'));
const TEST_DB_PATH = path.join(TEST_DB_DIR, 'test-suny.db');

// Set env BEFORE importing modules that read it
process.env.SUNY_DB_PATH = TEST_DB_PATH;
process.env.SUNY_PORT = '0'; // random port
process.env.NODE_ENV = 'test';

import { getDb } from './db';

// ── Blueprint memory ──────────────────────────────────────────────────────────
import {
  getBlueprintContext,
  getBlueprintEntries,
  getBlueprintSummary,
  storeBlueprintEntry,
} from './blueprint-memory';

// ── Change Guardian ──────────────────────────────────────────────────────────
import {
  captureSnapshot,
  clearSnapshot,
  detectDrift,
} from './change-guardian';

let testDir: string;
let db: ReturnType<typeof getDb>;

beforeAll(() => {
  // Initialize the DB (uses SUNY_DB_PATH env var)
  db = getDb();

  // Seed test users to satisfy FK constraints on blueprint_entries
  db.exec(`
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (42, 'test_user_42', 'hash', 100);
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (43, 'test_user_43', 'hash', 100);
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (44, 'test_user_44', 'hash', 100);
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (50, 'test_user_50', 'hash', 100);
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (100, 'test_user_100', 'hash', 100);
    INSERT OR IGNORE INTO users (id, username, password_hash, balance) VALUES (200, 'test_user_200', 'hash', 100);
  `);

  // Create a temp project directory with some TS files
  testDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'suny-proj-'));
  fs.writeFileSync(path.join(testDir, 'math.ts'), `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`, 'utf-8');

  fs.writeFileSync(path.join(testDir, 'types.ts'), `
export interface Config {
  host: string;
  port: number;
}

export type Status = 'active' | 'inactive';
`, 'utf-8');
});

afterAll(() => {
  // Cleanup
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
  } catch { /* ignore */ }
});

// ═══════════════════════════════════════════════════════════════════════════════
// BLUEPRINT MEMORY INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Blueprint Memory — integration (real DB)', () => {
  beforeEach(() => {
    // Clear all blueprint entries between tests to prevent data pollution
    try { db.exec('DELETE FROM blueprint_entries'); } catch { /* table may not exist yet */ }
  });

  it('stores and retrieves entries across multiple turns', () => {
    const userId = 42;
    const projectId = 100;
    const sessionId = 'int_sess_1';

    // Simulate 3 turns
    storeBlueprintEntry({
      userId, projectId, sessionId, turnIndex: 1,
      summary: 'Added user authentication with JWT tokens',
      details: 'Created auth middleware, login route, token verification helper',
      intent: 'Add JWT auth to the API',
      affectedFiles: ['src/auth.ts', 'src/middleware.ts', 'src/routes/login.ts'],
    });

    storeBlueprintEntry({
      userId, projectId, sessionId, turnIndex: 2,
      summary: 'Fixed the 401 error when token expires',
      details: 'Added token refresh logic and expiry check',
      intent: 'Fix expired token handling',
      affectedFiles: ['src/auth.ts'],
    });

    storeBlueprintEntry({
      userId, projectId, sessionId, turnIndex: 3,
      summary: 'Refactored auth middleware to use async/await',
      intent: 'Modernize auth code',
      affectedFiles: ['src/middleware.ts'],
    });

    // Retrieve all entries
    const entries = getBlueprintEntries({ userId, projectId });
    expect(entries).toHaveLength(3);

    // Verify they come back in reverse chronological order (most recent first)
    expect(entries[0].turn_index).toBe(3);
    expect(entries[2].turn_index).toBe(1);

    // Verify categories
    const categories = entries.map(e => e.category);
    expect(categories).toContain('bug_fix');
    expect(categories).toContain('feature_add');
    expect(categories).toContain('refactor');
  });

  it('generates context string that can be injected into system prompt', () => {
    const userId = 43;
    const projectId = 101;

    storeBlueprintEntry({
      userId, projectId, sessionId: 's1', turnIndex: 1,
      summary: 'Set up PostgreSQL connection pool',
      intent: 'Configure database',
      affectedFiles: ['src/db.ts'],
    });

    const ctx = getBlueprintContext({ userId, projectId, maxEntries: 5 });

    // Context must be a valid injection block
    expect(ctx).toContain('=== SUNy CODE CONSCIENCE — DESIGN MEMORY ===');
    expect(ctx).toContain('=== END DESIGN MEMORY ===');
    expect(ctx).toContain('Set up PostgreSQL');
    expect(ctx).toContain('Design Decision');

    // Must start/end cleanly so it can be appended to systemLines
    expect(ctx.startsWith('\n\n')).toBe(true);
  });

  it('summary aggregates categories correctly', () => {
    const userId = 44;
    const projectId = 102;

    storeBlueprintEntry({ userId, projectId, sessionId: 's1', turnIndex: 1, summary: 'Fix login bug', intent: 'fix', affectedFiles: ['login.ts'] });
    storeBlueprintEntry({ userId, projectId, sessionId: 's1', turnIndex: 2, summary: 'Add dashboard feature', intent: 'add', affectedFiles: ['dashboard.ts'] });
    storeBlueprintEntry({ userId, projectId, sessionId: 's1', turnIndex: 3, summary: 'Fix logout bug', intent: 'fix', affectedFiles: ['logout.ts'] });
    storeBlueprintEntry({ userId, projectId, sessionId: 's1', turnIndex: 4, summary: 'Another fix', intent: 'fix', affectedFiles: ['auth.ts'] });

    const summary = getBlueprintSummary({ userId, projectId });
    expect(summary).toContain('4 entries');
    expect(summary).toContain('bug fix: 3');
    expect(summary).toContain('feature add: 1');
  });

  it('does not leak entries across users', () => {
    storeBlueprintEntry({ userId: 100, projectId: 1, sessionId: 's1', turnIndex: 1, summary: 'User 100 design' });
    storeBlueprintEntry({ userId: 200, projectId: 1, sessionId: 's1', turnIndex: 1, summary: 'User 200 design' });

    const user100Entries = getBlueprintEntries({ userId: 100, projectId: 1 });
    const user200Entries = getBlueprintEntries({ userId: 200, projectId: 1 });

    expect(user100Entries).toHaveLength(1);
    expect(user200Entries).toHaveLength(1);
    expect(user100Entries[0].intent).not.toBe(user200Entries[0].intent);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHANGE GUARDIAN INTEGRATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Change Guardian — integration (real TS files)', () => {
  const userId = 50;
  const projectId = 200;

  it('captures snapshot and detects no drift on unchanged files', () => {
    clearSnapshot();

    const mathPath = path.join(testDir, 'math.ts');
    const typesPath = path.join(testDir, 'types.ts');

    captureSnapshot('int_nochange', [mathPath, typesPath]);

    // Files haven't changed
    const report = detectDrift('int_nochange', [mathPath, typesPath], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(false);
  });

  it('detects drift when export signature changes', () => {
    clearSnapshot();

    const mathPath = path.join(testDir, 'math.ts');

    // Snapshot with add(a: number, b: number): number
    // We need the current content to be the "before"
    // So let's write a known state, snapshot, then change it
    fs.writeFileSync(mathPath, `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}
`, 'utf-8');

    captureSnapshot('int_drift', [mathPath]);

    // Now change the signature — add changes to accept strings too
    fs.writeFileSync(mathPath, `
export function add(a: string | number, b: string | number): number {
  return Number(a) + Number(b);
}

export function multiply(a: number, b: number): number {
  return a * b;
}

export function divide(a: number, b: number): number {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}
`, 'utf-8');

    const report = detectDrift('int_drift', [mathPath], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    // Should detect signature change on add and new export divide
    const allChanges = report!.files.flatMap(f => f.changes);
    const sigChanges = allChanges.filter(c => c.severity === 'signature_change');
    const addedExports = allChanges.filter(c => c.severity === 'added_export');

    expect(sigChanges.length).toBeGreaterThanOrEqual(1);
    expect(sigChanges[0].name).toBe('add');

    expect(addedExports.length).toBeGreaterThanOrEqual(1);
    expect(addedExports[0].name).toBe('divide');
  });

  it('detects removed exports', () => {
    clearSnapshot();

    const typesPath = path.join(testDir, 'types.ts');

    fs.writeFileSync(typesPath, `
export interface Config {
  host: string;
  port: number;
}

export type Status = 'active' | 'inactive';
`, 'utf-8');

    captureSnapshot('int_remove', [typesPath]);

    // Remove the Status type
    fs.writeFileSync(typesPath, `
export interface Config {
  host: string;
  port: number;
}
`, 'utf-8');

    const report = detectDrift('int_remove', [typesPath], '');
    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    const removedExports = report!.files.flatMap(f =>
      f.changes.filter(c => c.severity === 'removed_export')
    );
    expect(removedExports.length).toBeGreaterThanOrEqual(1);
    expect(removedExports[0].name).toBe('Status');
  });

  it('correctly classifies intentional vs unintentional drift', () => {
    clearSnapshot();

    const mathPath = path.join(testDir, 'math.ts');

    fs.writeFileSync(mathPath, `
export function add(a: number, b: number): number {
  return a + b;
}
`, 'utf-8');

    captureSnapshot('int_intent', [mathPath]);

    fs.writeFileSync(mathPath, `
export function add(a: number, b: number): number {
  return a + b;
}

export function subtract(a: number, b: number): number {
  return a - b;
}
`, 'utf-8');

    // User said: "Add a subtract function"
    const report = detectDrift('int_intent', [mathPath], 'Add a subtract function to the math library');

    expect(report).not.toBeNull();
    expect(report!.hasDrift).toBe(true);

    const intentional = report!.files.flatMap(f =>
      f.changes.filter(c => c.isIntentional)
    );
    const unintentional = report!.files.flatMap(f =>
      f.changes.filter(c => !c.isIntentional)
    );

    // subtract was mentioned → intentional
    const subtractChange = intentional.find(c => c.name === 'subtract');
    expect(subtractChange).toBeDefined();

    // No unintentional changes here — only subtract was added
    expect(unintentional.length).toBe(0);
  });
});
