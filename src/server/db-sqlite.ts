/**
 * SqliteAdapter â€” wraps better-sqlite3 behind the DbAdapter interface.
 *
 * better-sqlite3 is synchronous, so every method returns a resolved Promise.
 * This lets consumers write uniform async code regardless of backend.
 */

import Database from 'better-sqlite3';
import type { DbAdapter, DbRow, DbRunResult } from './db-types';

// â”€â”€ Savepoint depth counter (supports nested transaction() calls) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let savepointDepth = 0;

export class SqliteAdapter implements DbAdapter {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string, existingDb?: Database.Database) {
    this.dbPath = dbPath;
    this.db = existingDb ?? new Database(dbPath);
    if (!existingDb) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('cache_size = -64000');   // 64 MB
      this.db.pragma('busy_timeout = 5000');
      this.db.pragma('foreign_keys = ON');
    }
  }

  /** Return the underlying better-sqlite3 instance (for migration internals). */
  getRaw(): Database.Database {
    return this.db;
  }

  // â”€â”€ Core query methods â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async get<T extends DbRow>(sql: string, params?: unknown[]): Promise<T | undefined> {
    return (params && params.length > 0
      ? this.db.prepare(sql).get(...params)
      : this.db.prepare(sql).get()) as T | undefined;
  }

  async all<T extends DbRow>(sql: string, params?: unknown[]): Promise<T[]> {
    return (params && params.length > 0
      ? this.db.prepare(sql).all(...params)
      : this.db.prepare(sql).all()) as T[];
  }

  async run(sql: string, params?: unknown[]): Promise<DbRunResult> {
    const stmt = this.db.prepare(sql);
    const result = params && params.length > 0 ? stmt.run(...params) : stmt.run();
    return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  // â”€â”€ Transaction support (savepoint-based for nesting) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async transaction<T>(fn: (trx: DbAdapter) => Promise<T>): Promise<T> {
    const spName = `sp_${savepointDepth}`;
    savepointDepth++;
    try {
      this.db.exec(`SAVEPOINT ${spName}`);
      const result = await fn(this);
      this.db.exec(`RELEASE ${spName}`);
      return result;
    } catch (e) {
      this.db.exec(`ROLLBACK TO ${spName}`);
      throw e;
    } finally {
      savepointDepth--;
    }
  }

  // â”€â”€ Migration helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async getSchemaVersion(): Promise<number> {
    const row = await this.get<{ value: string }>(
      "SELECT value FROM app_settings WHERE key = 'schema_version'",
    );
    return row ? parseInt(row.value, 10) || 0 : 0;
  }

  async setSchemaVersion(version: number): Promise<void> {
    await this.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)",
      [String(version)],
    );
  }

  async columnExists(table: string, column: string): Promise<boolean> {
    const rows = this.db.pragma(`table_info('${table}')`) as Array<{ name: string }>;
    return rows.some(r => r.name === column);
  }

  // â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async close(): Promise<void> {
    this.db.close();
  }

  /** Return the SQL dialect marker (for SQL transformation in migrations). */
  getDialect(): 'sqlite' {
    return 'sqlite';
  }
}
