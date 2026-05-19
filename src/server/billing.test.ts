/**
 * Unit tests for SUNy Billing — deductUsage, hasSufficientBalance, transferToWallet
 *
 * Uses an in-memory SQLite database to isolate tests.
 * Mocks the getDb() call from ./db using vi.mock.
 */
import 'dotenv/config';
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

// ── Mutable holder for the test DB reference ───────────────────────────────────
// vi.mock factory is hoisted so we use a plain object as a mutable reference.
const mockDbHolder: { db: Database.Database | null } = { db: null };

vi.mock('./db', () => ({
  getDb: () => {
    if (!mockDbHolder.db) {
      throw new Error('Test DB not initialized — call initTestDb() in beforeAll');
    }
    return mockDbHolder.db;
  },
}));

import * as billing from './billing';

function createTestTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing_modes (
      mode TEXT PRIMARY KEY,
      markup_formula TEXT NOT NULL DEFAULT 'cost',
      input_token_base_cost REAL NOT NULL DEFAULT 0.0001,
      output_token_base_cost REAL NOT NULL DEFAULT 0.0002,
      global_max_tokens INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      balance REAL NOT NULL DEFAULT 0,
      wallet_balance REAL NOT NULL DEFAULT 0,
      wallet_auto_spend INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      project_id INTEGER,
      mode TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      raw_cost REAL NOT NULL,
      charged_cost REAL NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function seedTestData(db: Database.Database): void {
  const insertPricing = db.prepare(`
    INSERT INTO pricing_modes (mode, markup_formula, input_token_base_cost, output_token_base_cost, global_max_tokens)
    VALUES (?, ?, ?, ?, ?)
  `);
  insertPricing.run('pro', 'cost * 3', 0.00015, 0.0006, 128000);
  insertPricing.run('smart', 'cost * 2', 0.00015, 0.0006, 128000);
  insertPricing.run('fast', 'cost * 1', 0.00015, 0.0002, 64000);
  insertPricing.run('free', 'cost * 0', 0.00015, 0.0002, 8000);

  db.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?, ?, ?, ?)').run(1, 100, 50, 1);
}

beforeAll(() => {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createTestTables(db);
  seedTestData(db);
  mockDbHolder.db = db;
});

describe('deductUsage', () => {
  beforeEach(() => {
    mockDbHolder.db!.exec('DELETE FROM usage_log');
    mockDbHolder.db!.prepare('UPDATE users SET balance = 100, wallet_balance = 50, wallet_auto_spend = 1 WHERE id = 1').run();
  });

  it('deducts from wallet first, then balance', () => {
    const result = billing.deductUsage(1, 'session-1', null, 'pro', 1000, 200);
    expect(result.rawCost).toBeCloseTo(0.27, 5);
    expect(result.chargedCost).toBeCloseTo(0.81, 5);
    expect(result.newWalletBalance).toBeCloseTo(49.19, 5);
    expect(result.newBalance).toBeCloseTo(100, 5);
  });

  it('overflows to balance when wallet is insufficient', () => {
    mockDbHolder.db!.prepare('UPDATE users SET wallet_balance = ? WHERE id = ?').run(0.50, 1);
    const result = billing.deductUsage(1, 'session-2', null, 'pro', 1000, 200);
    expect(result.chargedCost).toBeCloseTo(0.81, 5);
    expect(result.newWalletBalance).toBeCloseTo(0, 5);
    expect(result.newBalance).toBeCloseTo(99.69, 5);
  });

  it('handles free mode (zero markup)', () => {
    const result = billing.deductUsage(1, 'session-3', null, 'free', 100, 50);
    expect(result.rawCost).toBeCloseTo(0.025, 5);
    expect(result.chargedCost).toBe(0);
    expect(result.newWalletBalance).toBe(50);
    expect(result.newBalance).toBe(100);
  });

  it('handles cache tokens correctly', () => {
    const result = billing.deductUsage(1, 'session-4', null, 'smart', 1000, 200, 100, 500);
    expect(result.rawCost).toBeCloseTo(0.29625, 5);
    expect(result.chargedCost).toBeCloseTo(0.6675, 5);
  });

  it('throws for unknown mode', () => {
    expect(() => billing.deductUsage(1, 'session-5', null, 'unknown_mode', 100, 50)).toThrow('Unknown mode');
  });

  it('prevents negative balance', () => {
    mockDbHolder.db!.prepare('UPDATE users SET balance = ?, wallet_balance = ? WHERE id = ?').run(0, 0.10, 1);
    const result = billing.deductUsage(1, 'session-6', null, 'pro', 10000, 5000);
    expect(result.newWalletBalance).toBe(0);
    expect(result.newBalance).toBe(0);
  });

  it('logs usage to usage_log table', () => {
    billing.deductUsage(1, 'session-log', 42, 'fast', 500, 100);
    const log = mockDbHolder.db!.prepare('SELECT * FROM usage_log WHERE session_id = ?').get('session-log') as any;
    expect(log).toBeTruthy();
    expect(log.user_id).toBe(1);
    expect(log.project_id).toBe(42);
    expect(log.mode).toBe('fast');
    expect(log.input_tokens).toBe(500);
    expect(log.output_tokens).toBe(100);
  });
});

describe('hasSufficientBalance', () => {
  beforeEach(() => {
    mockDbHolder.db!.exec('DELETE FROM users');
  });

  it('returns true when wallet has balance', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(1, 0, 10, 0);
    expect(billing.hasSufficientBalance(1)).toBe(true);
  });

  it('returns false when wallet is empty and auto_spend is off', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(2, 100, 0, 0);
    expect(billing.hasSufficientBalance(2)).toBe(false);
  });

  it('returns true when wallet is empty but auto_spend on and balance > 0', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(3, 100, 0, 1);
    expect(billing.hasSufficientBalance(3)).toBe(true);
  });

  it('returns false when everything is empty', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(4, 0, 0, 0);
    expect(billing.hasSufficientBalance(4)).toBe(false);
  });

  it('returns false for non-existent user', () => {
    expect(billing.hasSufficientBalance(999)).toBe(false);
  });

  it('handles zero wallet with auto_spend off as insufficient', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(5, 50, 0, 0);
    expect(billing.hasSufficientBalance(5)).toBe(false);
  });
});

describe('transferToWallet', () => {
  beforeEach(() => {
    mockDbHolder.db!.exec('DELETE FROM users');
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(1, 100, 0, 1);
  });

  it('transfers credits from balance to wallet', () => {
    const result = billing.transferToWallet(1, 30);
    expect(result.newBalance).toBe(70);
    expect(result.newWalletBalance).toBe(30);
  });

  it('caps transfer at available balance', () => {
    const result = billing.transferToWallet(1, 500);
    expect(result.newBalance).toBe(0);
    expect(result.newWalletBalance).toBe(100);
  });

  it('throws when balance is zero', () => {
    mockDbHolder.db!.prepare('UPDATE users SET balance = ? WHERE id = ?').run(0, 1);
    expect(() => billing.transferToWallet(1, 10)).toThrow('Insufficient credits to transfer');
  });

  it('throws for non-existent user', () => {
    expect(() => billing.transferToWallet(999, 10)).toThrow('User not found');
  });
});

describe('getUserBalance', () => {
  beforeEach(() => {
    mockDbHolder.db!.exec('DELETE FROM users');
  });

  it('returns balance for existing user', () => {
    mockDbHolder.db!.prepare('INSERT INTO users (id, balance, wallet_balance, wallet_auto_spend) VALUES (?,?,?,?)').run(1, 75.50, 0, 0);
    expect(billing.getUserBalance(1)).toBe(75.50);
  });

  it('returns 0 for non-existent user', () => {
    expect(billing.getUserBalance(999)).toBe(0);
  });
});

describe('friendlySessionLimit', () => {
  it('returns "Unlimited" for null/0', () => {
    expect(billing.friendlySessionLimit(null)).toContain('Unlimited');
    expect(billing.friendlySessionLimit(0)).toContain('Unlimited');
  });

  it('returns "Short session" for <= 8000', () => {
    expect(billing.friendlySessionLimit(8000)).toBe('Short session');
    expect(billing.friendlySessionLimit(1000)).toBe('Short session');
  });

  it('returns "Medium session" for 8001-32000', () => {
    expect(billing.friendlySessionLimit(16000)).toBe('Medium session');
    expect(billing.friendlySessionLimit(32000)).toBe('Medium session');
  });

  it('returns "Long session" for 32001-100000', () => {
    expect(billing.friendlySessionLimit(64000)).toBe('Long session');
    expect(billing.friendlySessionLimit(100000)).toBe('Long session');
  });

  it('returns "Extended session" for > 100000', () => {
    expect(billing.friendlySessionLimit(200000)).toBe('Extended session');
  });
});
