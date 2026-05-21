/**
 * DbAdapter — abstract database interface for SUNy's persistence layer.
 *
 * Designed to support multiple backends (SQLite, Postgres, etc.)
 * without changing consumer code. All methods are async.
 *
 * Current backends:
 *   - SqliteAdapter  (better-sqlite3, synchronous wrapped in Promise)
 *   - PostgresAdapter (pg, fully async) — coming in Phase 3
 */

// ── Result types ─────────────────────────────────────────────────────────────

export interface DbRow {
  [column: string]: unknown;
}

export interface DbRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// ── Adapter interface ────────────────────────────────────────────────────────

export interface DbAdapter {
  /** Fetch a single row. Returns undefined when no row matches. */
  get<T extends DbRow>(sql: string, params?: unknown[]): Promise<T | undefined>;

  /** Fetch all matching rows. Returns empty array when none found. */
  all<T extends DbRow>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute an INSERT / UPDATE / DELETE. Returns change count + last rowid. */
  run(sql: string, params?: unknown[]): Promise<DbRunResult>;

  /** Execute raw SQL (DDL, multiple statements). */
  exec(sql: string): Promise<void>;

  /**
   * Run a function inside a database transaction.
   * The function receives the adapter so nested queries use the same transaction.
   */
  transaction<T>(fn: (trx: DbAdapter) => Promise<T>): Promise<T>;

  // ── Migration helpers ──────────────────────────────────────────────────

  getSchemaVersion(): Promise<number>;
  setSchemaVersion(version: number): Promise<void>;
  columnExists(table: string, column: string): Promise<boolean>;

  // ── Lifecycle ──────────────────────────────────────────────────────────

  close(): Promise<void>;
}

// ── Backend type ─────────────────────────────────────────────────────────────

export type DbBackendType = 'sqlite' | 'postgres';

// ── Factory options ──────────────────────────────────────────────────────────

export interface DbFactoryOptions {
  backend?: DbBackendType;
  path?: string;       // SQLite: file path
  url?: string;        // Postgres: connection string
}
