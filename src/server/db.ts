/**
 * db.ts â€” Database factory for SUNy.
 *
 * Provides TWO access patterns:
 *   1. `getDb()` â‡’ Database.Database (sync better-sqlite3 API) â€” legacy, for gradual migration
 *   2. `getAdapter()` â‡’ DbAdapter (async API) â€” new code should use this
 *   3. `closeDb()` â‡’ cleanup
 *
 * Both share the same underlying connection. The adapter wraps the sync DB in Promises.
 *
 * Backend selection (future):
 *   Set process.env.DB_BACKEND to 'sqlite' (default) or 'postgres'.
 *   Set process.env.SUNY_DB_PATH for SQLite file path.
 *   Set process.env.DATABASE_URL for Postgres connection string.
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SqliteAdapter } from './db-sqlite';
import { runMigrations } from './db-migrations';
import { seedBehavioralRules } from './behavioral-rules';
import type { DbAdapter, DbBackendType } from './db-types';

// â”€â”€ Configuration â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const BACKEND: DbBackendType = (process.env.DB_BACKEND as DbBackendType) || 'sqlite';
const DB_PATH = process.env.SUNY_DB_PATH || './data/suny.db';

// â”€â”€ Lazy singleton â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let db: Database.Database | null = null;
let adapter: DbAdapter | null = null;

// â”€â”€ Legacy sync API (returns raw better-sqlite3 Database instance) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get the database instance (sync better-sqlite3 API).
 * Legacy API â€” kept for backward compatibility during the migration.
 *
 * Usage (existing code):
 *   import { getDb } from './db';
 *   const db = getDb();
 *   const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
 *   db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(100, userId);
 */
export function getDb(): Database.Database {
  if (db) return db;

  switch (BACKEND) {
    case 'sqlite': {
      const resolvedPath = path.resolve(DB_PATH);
      const dataDir = path.dirname(resolvedPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      db = new Database(resolvedPath);
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('cache_size = -64000');
      db.pragma('busy_timeout = 5000');
      db.pragma('foreign_keys = ON');

      // Create adapter from same connection for async API
      adapter = new SqliteAdapter(resolvedPath, db);

      // Migrations are run via initializeDb() at startup — NOT here,
      // so the server never accepts requests before the schema is ready.

      console.log(`[db] Initialized SQLite backend at ${resolvedPath}`);
      return db;
    }
    case 'postgres':
      throw new Error(
        'Postgres backend selected via DB_BACKEND=postgres but PostgresAdapter is not yet implemented.',
      );
    default:
      throw new Error(`Unknown DB_BACKEND: '${BACKEND}'. Use 'sqlite' or 'postgres'.`);
  }
}

// â”€â”€ New async API (DbAdapter interface) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Get the database adapter (async API, backend-agnostic).
 * New code should use this instead of getDb().
 *
 * Usage (new code):
 *   import { getAdapter } from './db';
 *   const db = getAdapter();
 *   const users = await db.all('SELECT * FROM users');
 *   await db.run('UPDATE users SET balance = ? WHERE id = ?', [100, userId]);
 *
 * getAdapter() must be called AFTER getDb() to share the same connection.
 * For new code paths that don't need the sync API, call getDb() first to initialize.
 */
export function getAdapter(): DbAdapter {
  if (adapter) return adapter;
  // Initialize the DB (which creates the adapter) then return it
  getDb();
  return adapter!;
}

// â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Close the database connection gracefully.
 */
export async function closeDb(): Promise<void> {
  if (adapter) {
    await adapter.close();
    adapter = null;
    db = null;
  }
}

export async function resetDb(): Promise<void> {
  await closeDb();
}


// ── Startup initialization ──────────────────────────────────────────────────

/**
 * Initialize the database and run all migrations + seed data.
 * Must be awaited before server.listen() to guarantee schema is ready.
 */
export async function initializeDb(): Promise<void> {
  const db = getDb();
  if (!db) throw new Error('[db] Failed to initialize database');
  const adp = getAdapter();
  await runMigrations(adp);
  await seedBehavioralRules(adp, 1).catch((err: Error) =>
    console.warn('[db] seedBehavioralRules skipped:', err.message),
  );
  console.log('[db] Migrations and seed complete');
}