import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.SUNY_DB_PATH || './data/suny.db';

// Ensure data directory exists
const dataDir = path.dirname(path.resolve(DB_PATH));
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(path.resolve(DB_PATH));
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  }
  return db;
}

// ── Migration helpers ───────────────────────────────────────────────────────

function getSchemaVersion(db: Database.Database): number {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").get() as { value: string } | undefined;
  return row ? parseInt(row.value, 10) || 0 : 0;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('schema_version', ?)").run(String(version));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info('${table}')`) as Array<{ name: string }>;
  return rows.some(r => r.name === column);
}

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const SCHEMA_MIGRATIONS: Migration[] = [
  // ── Migration 1: Consolidate all legacy try/catch ALTER TABLE ─────────────
  {
    version: 1,
    name: 'Consolidate legacy ALTER TABLE additions',
    up: (db) => {
      const alterCols: Array<{ table: string; column: string; sql: string }> = [
        { table: 'usage_log', column: 'cache_write_tokens', sql: 'ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER DEFAULT 0' },
        { table: 'usage_log', column: 'cache_read_tokens', sql: 'ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER DEFAULT 0' },
        { table: 'usage_log', column: 'project_id', sql: 'ALTER TABLE usage_log ADD COLUMN project_id INTEGER DEFAULT NULL' },
        { table: 'pricing_modes', column: 'model_id', sql: "ALTER TABLE pricing_modes ADD COLUMN model_id TEXT NOT NULL DEFAULT 'claude-3-5-haiku-20241022'" },
        { table: 'users', column: 'wallet_balance', sql: 'ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0' },
        { table: 'users', column: 'wallet_auto_spend', sql: 'ALTER TABLE users ADD COLUMN wallet_auto_spend INTEGER DEFAULT 0' },
        { table: 'pricing_modes', column: 'description', sql: "ALTER TABLE pricing_modes ADD COLUMN description TEXT DEFAULT ''" },
        { table: 'api_keys', column: 'priority', sql: 'ALTER TABLE api_keys ADD COLUMN priority INTEGER DEFAULT 1' },
        { table: 'api_keys', column: 'model_id_override', sql: 'ALTER TABLE api_keys ADD COLUMN model_id_override TEXT' },
        { table: 'users', column: 'display_name', sql: 'ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL' },
        { table: 'projects', column: 'persona', sql: 'ALTER TABLE projects ADD COLUMN persona TEXT DEFAULT NULL' },
      ];
      for (const { table, column, sql } of alterCols) {
        if (!columnExists(db, table, column)) {
          db.exec(sql);
        }
      }
      // Fix NULL wallet_balance rows created before the column existed
      db.exec('UPDATE users SET wallet_balance = 0 WHERE wallet_balance IS NULL');
    },
  },

  // ── Migration 2: Add tables that were missing from schema ─────────────────
  {
    version: 2,
    name: 'Add missing tables: feature_flags, operation_log, project_locks, bridge_setup_codes',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS feature_flags (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT 'off',
          label TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS operation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          project_id INTEGER,
          session_id TEXT,
          operation TEXT NOT NULL,
          tool_name TEXT,
          status TEXT NOT NULL DEFAULT 'started',
          detail TEXT DEFAULT '',
          duration_ms INTEGER DEFAULT 0,
          timestamp TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS project_locks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          session_id TEXT NOT NULL,
          locked_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS bridge_setup_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          code TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          server_url TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          redeemed_at TEXT,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
      `);
    },
  },

  // ── Migration 3: Agent turn metrics table ─────────────────────────────────
  {
    version: 3,
    name: 'Add agent_turn_metrics table for production monitoring',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_turn_metrics (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id        INTEGER NOT NULL,
          session_id     TEXT    NOT NULL,
          project_id     INTEGER DEFAULT NULL,
          mode           TEXT    NOT NULL DEFAULT 'fast',
          tool_calls     INTEGER NOT NULL DEFAULT 0,
          input_tokens   INTEGER NOT NULL DEFAULT 0,
          output_tokens  INTEGER NOT NULL DEFAULT 0,
          cost_usd       REAL    NOT NULL DEFAULT 0,
          success        INTEGER NOT NULL DEFAULT 0,
          error_category TEXT    DEFAULT NULL,
          duration_ms    INTEGER NOT NULL DEFAULT 0,
          ts             TEXT    DEFAULT (datetime('now')),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_atm_ts      ON agent_turn_metrics(ts);
        CREATE INDEX IF NOT EXISTS idx_atm_user_id ON agent_turn_metrics(user_id);
        CREATE INDEX IF NOT EXISTS idx_atm_success ON agent_turn_metrics(success);
      `);
    },
  },
];

// ── Schema foundations (always run — CREATE TABLE IF NOT EXISTS) ────────────

function createFoundationTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance REAL DEFAULT 0,
      wallet_balance REAL DEFAULT 0,
      wallet_auto_spend INTEGER DEFAULT 0,
      is_active INTEGER DEFAULT 1,
      selected_mode TEXT DEFAULT 'fast',
      created_at TEXT DEFAULT (datetime('now')),
      max_tokens_per_session INTEGER DEFAULT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      key_value TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'fast',
      is_active INTEGER DEFAULT 1,
      label TEXT
    );

    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id TEXT,
      project_id INTEGER DEFAULT NULL,
      mode TEXT DEFAULT 'fast',
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      raw_cost REAL DEFAULT 0,
      charged_cost REAL DEFAULT 0,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS pricing_modes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      markup_formula TEXT NOT NULL DEFAULT '1.5',
      input_token_base_cost REAL DEFAULT 0,
      output_token_base_cost REAL DEFAULT 0,
      model_id TEXT NOT NULL DEFAULT 'claude-3-5-haiku-20241022',
      global_max_tokens INTEGER DEFAULT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contact_info (
      id INTEGER PRIMARY KEY DEFAULT 1,
      phone TEXT DEFAULT '+96170449900',
      email TEXT DEFAULT 'Adarwich@engineer.com',
      website TEXT DEFAULT 'Technodel.Tech',
      whatsapp TEXT DEFAULT '',
      support_message TEXT DEFAULT 'We''re here to help! Reach out anytime.',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS user_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      local_path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

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
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS user_project_state (
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      messages_json TEXT NOT NULL DEFAULT '[]',
      memories_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, project_id),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(project_id) REFERENCES projects(id)
    );
  `);
}

// ── Data seeding ────────────────────────────────────────────────────────────

function seedData(db: Database.Database): void {
  // Seed pricing modes if table is empty
  const modeCount = (db.prepare('SELECT COUNT(*) as c FROM pricing_modes').get() as { c: number }).c;
  if (modeCount === 0) {
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('free', '⚡ AFree', 'Almost free — Groq-powered with OpenRouter fallback', 'cost * 2.0', 0.00000059, 0.00000079, 'llama-3.3-70b-versatile');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('fast', '🚀 Fast Smart', 'Smart & affordable — OpenRouter Llama Vision, excellent for coding and image analysis', 'cost * 2.5', 0.00000027, 0.0000011, 'meta-llama/llama-3.2-11b-vision-instruct:free');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('pro', '🧠 Smart Pro', 'Maximum intelligence — HuggingFace Llama Vision for complex analysis and image understanding', 'cost * 3.0', 0.00000055, 0.00000219, 'meta-llama/Llama-3.2-11B-Vision-Instruct');
  }

  // Update existing mode configs to current defaults (modes_v2_seeded flag)
  const modesV2Seeded = db.prepare("SELECT value FROM app_settings WHERE key='modes_v2_seeded'").get();
  if (!modesV2Seeded) {
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='free'`)
      .run('⚡ AFree', 'Almost free — Groq-powered with OpenRouter fallback', 'llama-3.3-70b-versatile', 0.00000059, 0.00000079);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='fast'`)
      .run('🚀 Fast Smart', 'Smart & affordable — OpenRouter Llama Vision, excellent for coding and image analysis', 'meta-llama/llama-3.2-11b-vision-instruct:free', 0.00000027, 0.0000011);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='pro'`)
      .run('🧠 Smart Pro', 'Maximum intelligence — HuggingFace Llama Vision for complex analysis and image understanding', 'meta-llama/Llama-3.2-11B-Vision-Instruct', 0.00000055, 0.00000219);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v2_seeded', 'true')").run();
  }

  // Clean mode descriptions (modes_v3_descriptions flag)
  const modesV3 = db.prepare("SELECT value FROM app_settings WHERE key='modes_v3_descriptions'").get();
  if (!modesV3) {
    db.prepare("UPDATE pricing_modes SET description=? WHERE mode='free'")
      .run('Almost free — lightning fast for quick tasks and simple questions');
    db.prepare("UPDATE pricing_modes SET description=? WHERE mode='fast'")
      .run('Smart & affordable — excellent for coding, debugging, and everyday tasks');
    db.prepare("UPDATE pricing_modes SET description=? WHERE mode='pro'")
      .run('Maximum intelligence — advanced reasoning for your most complex challenges');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v3_descriptions', 'true')").run();
  }

  // Seed default API keys from environment variables
  const keysSeeded = db.prepare("SELECT value FROM app_settings WHERE key='default_keys_seeded'").get();
  if (!keysSeeded) {
    db.prepare('DELETE FROM api_keys').run();
    const groqKey = process.env.SUNY_GROQ_KEY;
    const openrouterKey = process.env.SUNY_OPENROUTER_KEY;
    if (groqKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Groq', groqKey, 'free', '⚡ Free Mode – Groq', 1, 'llama-3.3-70b-versatile');
    }
    if (openrouterKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'fast', '🚀 Fast Mode – OpenRouter Llama Vision', 1, 'meta-llama/llama-3.2-11b-vision-instruct:free');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'pro', '🧠 Pro Mode – OpenRouter (fallback)', 2, 'meta-llama/llama-3.2-11b-vision-instruct:free');
    }
    const huggingfaceKey = process.env.SUNY_HUGGINGFACE_KEY;
    if (huggingfaceKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('HuggingFace', huggingfaceKey, 'pro', '🧠 Pro Mode – HuggingFace Llama Vision', 1, 'meta-llama/Llama-3.2-11B-Vision-Instruct');
    }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_keys_seeded', 'true')").run();
  }

  // Seed default contact info if not present
  const contactCount = (db.prepare('SELECT COUNT(*) as c FROM contact_info').get() as { c: number }).c;
  if (contactCount === 0) {
    db.prepare(`
      INSERT INTO contact_info (id, phone, email, website, whatsapp, support_message)
      VALUES (1, '+96170449900', 'Adarwich@engineer.com', 'Technodel.Tech', '', 'We''re here to help! Reach out anytime.')
    `).run();
  }

  // Seed default app settings
  const seedSettings: Array<[string, string]> = [
    ['allow_registration', 'true'],
    ['auto_approve', 'true'],
    ['dark_mode', 'true'],
    ['prompt_caching_enabled', 'true'],
    ['auto_backup_enabled', 'false'],
    ['auto_backup_trigger', 'task'],
    ['auto_backup_interval', '50000'],
  ];
  const insertSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)');
  for (const [key, value] of seedSettings) {
    insertSetting.run(key, value);
  }
}

// ── Main migration orchestrator ─────────────────────────────────────────────

function runMigrations(db: Database.Database): void {
  // 1. Foundation tables (always run — CREATE TABLE IF NOT EXISTS)
  createFoundationTables(db);

  // 2. Versioned schema migrations
  const currentVersion = getSchemaVersion(db);
  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version > currentVersion) {
      console.log(`[db] Running migration v${migration.version}: ${migration.name}`);
      migration.up(db);
      setSchemaVersion(db, migration.version);
      console.log(`[db] Migration v${migration.version} complete`);
    }
  }

  // 3. Data seeding (idempotent — uses app_settings flags)
  seedData(db);
}
