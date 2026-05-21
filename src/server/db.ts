import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { seedBehavioralRules } from './behavioral-rules';

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
    db.pragma('synchronous = NORMAL');      // safe with WAL — 2-5x faster than FULL
    db.pragma('cache_size = -64000');        // 64 MB page cache
    db.pragma('busy_timeout = 5000');        // wait up to 5s instead of immediate SQLITE_BUSY
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

  // ── Migration 4: Add role column + create default admin user ─────────────
  {
    version: 4,
    name: 'Add role column to users, create default admin user, clean test users',
    up: (db) => {
      // Add role column if missing
      if (!columnExists(db, 'users', 'role')) {
        db.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
        console.log('[db] Migration 4: Added role column to users table');
      }

      // Remove test users with fake password_hash "hash"
      // Disable FK temporarily — these users may have orphaned refs in various tables
      db.pragma('foreign_keys = OFF');
      const result = db.prepare("DELETE FROM users WHERE password_hash = 'hash'").run();
      db.pragma('foreign_keys = ON');
      if (result.changes > 0) {
        console.log(`[db] Migration 4: Removed ${result.changes} test user(s) with invalid password hashes`);
      }

      // Create default admin user 'galaxy' if not exists
      const galaxy = db.prepare("SELECT id FROM users WHERE username = 'galaxy'").get();
      if (!galaxy) {
        const bcrypt = require('bcryptjs');
        const hash = bcrypt.hashSync('301088', 12);
        db.prepare(
          "INSERT INTO users (username, password_hash, balance, is_active, role, display_name) VALUES (?, ?, ?, 1, 'admin', ?)"
        ).run('galaxy', hash, 1000, 'Galaxy Admin');
        console.log('[db] Migration 4: Created default admin user "galaxy"');
      } else {
        // Ensure existing galaxy user has admin role
        db.prepare("UPDATE users SET role = 'admin' WHERE username = 'galaxy' AND (role IS NULL OR role = 'user')").run();
      }
    },
  },

  // ── Migration 5: Seed OpenRouter + Gemini fallback API keys ──────────────
  {
    version: 5,
    name: 'Seed OpenRouter and Gemini fallback API keys for fast/smart/pro modes',
    up: (db) => {
      const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;
      const geminiKey = process.env.GEMINI_API_KEY || process.env.SUNY_GEMINI_KEY;

      if (openrouterKey) {
        for (const mode of ['fast', 'smart', 'pro']) {
          const existing = db.prepare('SELECT id FROM api_keys WHERE provider = ? AND mode = ? AND priority = 2').get('OpenRouter', mode);
          if (!existing) {
            db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
              .run('OpenRouter', openrouterKey, mode, `OpenRouter (fallback)`, 2, 'deepseek/deepseek-chat');
          }
        }
      }
      if (geminiKey) {
        for (const mode of ['fast', 'smart', 'pro']) {
          const existing = db.prepare('SELECT id FROM api_keys WHERE provider = ? AND mode = ? AND priority = 3').get('Gemini', mode);
          if (!existing) {
            db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
              .run('Gemini', geminiKey, mode, `Gemini (fallback 2)`, 3, 'gemini-2.0-flash');
          }
        }
      }
    },
  },

  // ── Migration 6: Fix OpenRouter model_id_override (deepseek-chat → deepseek/deepseek-chat) ──
  {
    version: 6,
    name: 'Fix OpenRouter model_id_override — deepseek-chat is ambiguous on OpenRouter',
    up: (db) => {
      const result = db.prepare(
        "UPDATE api_keys SET model_id_override = 'deepseek/deepseek-chat' WHERE provider = 'OpenRouter' AND model_id_override = 'deepseek-chat'"
      ).run();
      console.log(`[db] Migration v6: Updated ${result.changes} OpenRouter key(s) — deepseek-chat → deepseek/deepseek-chat`);
    },
  },
  // ── Migration 7: Pinned files per user/project ────────────────────────────
  {
    version: 7,
    name: 'Create pinned_files table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pinned_files (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          project_id INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          created_at TEXT DEFAULT (datetime('now')),
          UNIQUE(user_id, project_id, file_path),
          FOREIGN KEY(user_id) REFERENCES users(id),
          FOREIGN KEY(project_id) REFERENCES projects(id)
        )
      `);
      console.log('[db] Migration v7: Created pinned_files table');
    },
  },
  // ── Migration 8: Semantic code chunk vectors ──────────────────────────────
  {
    version: 8,
    name: 'Create code_chunks table for vector context',
    up: (db) => {
      db.exec(`
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
          UNIQUE(project_id, file_path, symbol_name, symbol_type),
          FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE INDEX IF NOT EXISTS idx_code_chunks_project ON code_chunks(project_id);
        CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project_id, file_path);
      `);
      console.log('[db] Migration v8: Created code_chunks table');
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
      role TEXT DEFAULT 'user',
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
      .run('free', '⚡ Free', 'Great for quick tasks and light use', 'cost * 2.0', 0.00000059, 0.00000079, 'llama-3.3-70b-versatile');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('fast', '🚀 Fast', 'Fast and efficient for everyday coding', 'cost * 2.5', 0.00000027, 0.0000011, 'deepseek-chat');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('smart', '🧠 Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-chat');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('pro', '💎 Pro', 'Maximum quality for your hardest challenges', 'cost * 3.0', 0.00000055, 0.00000219, 'deepseek-chat');
  }

  // Update existing mode configs to current defaults (modes_v2_seeded flag)
  const modesV2Seeded = db.prepare("SELECT value FROM app_settings WHERE key='modes_v2_seeded'").get();
  if (!modesV2Seeded) {
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='free'`)
      .run('⚡ AFree', 'Almost free - great for quick tasks', 'llama-3.3-70b-versatile', 0.00000059, 0.00000079);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='fast'`)
      .run('🚀 Fast Smart', 'Smart and affordable, excellent for coding and image analysis', 'meta-llama/llama-3.2-11b-vision-instruct:free', 0.00000027, 0.0000011);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='pro'`)
      .run('🧠 Smart Pro', 'Maximum intelligence for complex analysis and image understanding', 'meta-llama/Llama-3.2-11B-Vision-Instruct', 0.00000055, 0.00000219);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v2_seeded', 'true')").run();
  }

  // ── v4: Configure modes per user preference ──────────────────────────
  // Free  → llama-3.3-70b-versatile — fast for simple tasks
  // Fast  → deepseek-chat — reliable coding assistant
  // Smart → deepseek-chat — advanced reasoning
  // Pro   → deepseek-chat — maximum quality
  const modesV4 = db.prepare("SELECT value FROM app_settings WHERE key='modes_v4_models'").get();
  if (!modesV4) {
    // Insert smart mode if it doesn't exist (wasn't in original seed)
    const smartExists = db.prepare("SELECT COUNT(*) as c FROM pricing_modes WHERE mode = 'smart'").get() as { c: number };
    if (smartExists.c === 0) {
      db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('smart', '🧠 Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-chat');
    }
    // Update pricing_modes model_ids
    db.prepare(`UPDATE pricing_modes SET model_id = ? WHERE mode = 'free'`).run('llama-3.3-70b-versatile');
    db.prepare(`UPDATE pricing_modes SET model_id = ? WHERE mode = 'fast'`).run('deepseek-chat');
    db.prepare(`UPDATE pricing_modes SET model_id = ? WHERE mode = 'smart'`).run('deepseek-chat');
    db.prepare(`UPDATE pricing_modes SET model_id = ? WHERE mode = 'pro'`).run('deepseek-chat');
    // Update API key model overrides
    db.prepare(`UPDATE api_keys SET model_id_override = 'llama-3.3-70b-versatile' WHERE mode = 'free'`).run();
    db.prepare(`UPDATE api_keys SET model_id_override = 'deepseek-chat' WHERE mode = 'fast'`).run();
    db.prepare(`UPDATE api_keys SET model_id_override = 'deepseek-chat' WHERE mode = 'smart'`).run();
    db.prepare(`UPDATE api_keys SET model_id_override = 'deepseek-chat' WHERE mode = 'pro'`).run();
    // Add DeepSeek as primary provider for fast/smart/pro modes
    const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.SUNY_DEEPSEEK_KEY;
    if (deepseekKey) {
      db.prepare(`INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'fast', '🚀 Fast – DeepSeek V3', 1, 'deepseek-chat');
      db.prepare(`INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'smart', '🧠 Smart – DeepSeek Pro', 1, 'deepseek-chat');
      db.prepare(`INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'pro', '💎 Pro – DeepSeek Pro', 1, 'deepseek-chat');
      // Free mode uses Groq, but also register DeepSeek as fallback
      db.prepare(`INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'free', '⚡ Free – DeepSeek (fallback)', 2, 'deepseek-chat');
    }
    // Ensure Groq is the primary provider for free mode
    const groqKey = process.env.GROQ_API_KEY || process.env.SUNY_GROQ_KEY;
    if (groqKey) {
      db.prepare(`INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Groq', groqKey, 'free', '⚡ Free – Groq', 1, 'llama-3.3-70b-versatile');
    }
    // Update display names and descriptions
    db.prepare(`UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'free'`)
      .run('⚡ Free', 'Groq Llama 3.3 70B — lightning fast for quick tasks');
    db.prepare(`UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'fast'`)
      .run('🚀 Fast', 'DeepSeek V3 — reliable, excellent instruction following for everyday coding');
    db.prepare(`UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'smart'`)
      .run('🧠 Smart', 'DeepSeek Pro — advanced reasoning for complex tasks');
    db.prepare(`UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'pro'`)
      .run('💎 Pro', 'DeepSeek Pro — maximum quality for your hardest challenges');
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v4_models', 'true')").run();
    console.log('[db] Configured modes: Free=Groq, Fast/Smart/Pro=DeepSeek (v4)');
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
    const groqKey = process.env.GROQ_API_KEY || process.env.SUNY_GROQ_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.SUNY_DEEPSEEK_KEY;
    // Free → Groq (primary). Fast/Smart/Pro → DeepSeek.
    if (groqKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Groq', groqKey, 'free', '⚡ Free – Groq (default)', 1, 'llama-3.3-70b-versatile');
    }
    if (deepseekKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'fast', '🚀 Fast – DeepSeek V3', 1, 'deepseek-chat');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'smart', '🧠 Smart – DeepSeek Pro', 1, 'deepseek-chat');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'pro', '💎 Pro – DeepSeek Pro', 1, 'deepseek-chat');
      // DeepSeek as fallback for free in case Groq fails
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'free', '⚡ Free – DeepSeek (fallback)', 2, 'deepseek-chat');
    }
    // OpenRouter fallback for fast/smart/pro (routes through OpenRouter API)
    const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;
    if (openrouterKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'fast', '🚀 Fast – OpenRouter (fallback)', 2, 'deepseek/deepseek-chat');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'smart', '🧠 Smart – OpenRouter (fallback)', 2, 'deepseek/deepseek-chat');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'pro', '💎 Pro – OpenRouter (fallback)', 2, 'deepseek/deepseek-chat');
    }
    // Gemini fallback for fast/smart/pro
    const geminiKey = process.env.GEMINI_API_KEY || process.env.SUNY_GEMINI_KEY;
    if (geminiKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Gemini', geminiKey, 'fast', '🚀 Fast – Gemini (fallback 2)', 3, 'gemini-2.0-flash');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Gemini', geminiKey, 'smart', '🧠 Smart – Gemini (fallback 2)', 3, 'gemini-2.0-flash');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Gemini', geminiKey, 'pro', '💎 Pro – Gemini (fallback 2)', 3, 'gemini-2.0-flash');
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

  // ── Seed feature flags: ON by default for launch-ready capabilities ──
  const featureFlagDefaults: Array<[string, string, string, string]> = [
    ['ff_behavioral_rules',    'on',  'Behavioral Rules',   'Learn from past tasks and inject rules into future prompts'],
    ['ff_training_scorer',     'on',  'Training Scorer',    'LLM-as-Judge scoring of SUNy outputs after each task'],
    ['ff_training_loader',     'on',  'Training Loader',    'Auto-load injection files and behavioral rules into system prompt'],
    ['ff_goal_tracker',        'on',  'Goal Tracker',       'Persistent multi-horizon goal tracking across sessions'],
    ['ff_code_index',          'on',  'Code Index',         'Semantic code index for intelligent code search'],
    ['ff_vector_context',      'on',  'Vector Context',     'Semantic chunk retrieval: inject most relevant code chunks into every prompt'],
    ['ff_confidence_scoring',  'on',  'Confidence Scoring', 'Self-reported uncertainty tracking with escalation'],
    ['ff_failure_memory',      'on',  'Failure Memory',     'Remember and avoid repeating past mistakes'],
    ['ff_multi_agent_review',  'on',  'Multi-Agent Review', 'Silent code review after every task'],
    ['ff_test_generator',      'on',  'Test Generator',     'Auto-generate tests after feature implementation'],
    ['ff_operation_audit',     'on',  'Operation Audit',    'Detailed operation logging for debugging'],
    ['ff_project_lock',        'on',  'Project Lock',       'Prevent concurrent edits to the same project'],
    ['ff_hypothesis_engine',   'on',  'Hypothesis Engine',  'Parallel strategy testing for complex tasks before main agent loop'],
  ];
  const insertFlag = db.prepare('INSERT OR IGNORE INTO feature_flags (key, value, label, description) VALUES (?, ?, ?, ?)');
  for (const [key, value, label, desc] of featureFlagDefaults) {
    insertFlag.run(key, value, label, desc);
  }

  // ── Seed AiderDesk behavioral rules (idempotent, high-confidence patterns) ──
  try {
    seedBehavioralRules(1);
  } catch (e) {
    console.warn('[db] seedBehavioralRules skipped (behavioral_rules table may not exist yet):', (e as Error).message);
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
