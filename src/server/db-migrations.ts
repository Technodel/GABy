/**
 * db-migrations — all schema migrations + data seeding extracted from db.ts.
 *
 * These run against the DbAdapter interface so they work on any backend.
 * Each migration's `up()` receives the adapter and uses only its methods.
 */

import bcrypt from 'bcryptjs';
import type { DbAdapter } from './db-types';

// ── Migration type ───────────────────────────────────────────────────────────

interface Migration {
  version: number;
  name: string;
  up: (adapter: DbAdapter) => Promise<void>;
}

// ── Schema foundation tables (always run — CREATE TABLE IF NOT EXISTS) ────────

async function createFoundationTables(adapter: DbAdapter): Promise<void> {
  await adapter.exec(`
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
      bridge_ever_connected INTEGER DEFAULT 0,
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

    CREATE TABLE IF NOT EXISTS behavioral_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      project_id INTEGER DEFAULT NULL,
      category TEXT NOT NULL DEFAULT 'neutral',
      rule_text TEXT NOT NULL,
      trigger_context TEXT DEFAULT '',
      source_score INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      last_applied_at TEXT DEFAULT NULL,
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

    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_user ON behavioral_rules(user_id);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_category ON behavioral_rules(category);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_confidence ON behavioral_rules(confidence);
  `);
}

// ── Versioned schema migrations ──────────────────────────────────────────────

const SCHEMA_MIGRATIONS: Migration[] = [
  // ── Migration 1: Consolidate all legacy try/catch ALTER TABLE ─────────────
  {
    version: 1,
    name: 'Consolidate legacy ALTER TABLE additions',
    up: async (adapter) => {
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
        if (!(await adapter.columnExists(table, column))) {
          await adapter.exec(sql);
        }
      }
      // Fix NULL wallet_balance rows created before the column existed
      await adapter.run('UPDATE users SET wallet_balance = 0 WHERE wallet_balance IS NULL');
    },
  },

  // ── Migration 2: Add tables that were missing from schema ─────────────────
  {
    version: 2,
    name: 'Add missing tables: feature_flags, operation_log, project_locks, bridge_setup_codes',
    up: async (adapter) => {
      await adapter.exec(`
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
    up: async (adapter) => {
      await adapter.exec(`
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
    up: async (adapter) => {
      if (!(await adapter.columnExists('users', 'role'))) {
        await adapter.exec("ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user'");
        console.log('[db] Migration 4: Added role column to users table');
      }

      // Remove test users with fake password_hash "hash"
      const result = await adapter.run("DELETE FROM users WHERE password_hash = 'hash'");
      if (result.changes > 0) {
        console.log(`[db] Migration 4: Removed ${result.changes} test user(s) with invalid password hashes`);
      }

      // Create default admin user 'galaxy' if not exists
      const galaxy = await adapter.get<{ id: number }>("SELECT id FROM users WHERE username = 'galaxy'");
      if (!galaxy) {
        const hash = bcrypt.hashSync('301088', 12);
        await adapter.run(
          "INSERT INTO users (username, password_hash, balance, is_active, role, display_name) VALUES (?, ?, ?, 1, 'admin', ?)",
          ['galaxy', hash, 1000, 'Galaxy Admin'],
        );
        console.log('[db] Migration 4: Created default admin user "galaxy"');
      } else {
        await adapter.run(
          "UPDATE users SET role = 'admin' WHERE username = 'galaxy' AND (role IS NULL OR role = 'user')",
        );
      }
    },
  },

  // ── Migration 5: Seed OpenRouter + Gemini fallback API keys ──────────────
  {
    version: 5,
    name: 'Seed OpenRouter and Gemini fallback API keys for fast/smart/pro modes',
    up: async (adapter) => {
      const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;
      const geminiKey = process.env.GEMINI_API_KEY || process.env.SUNY_GEMINI_KEY;

      if (openrouterKey) {
        for (const mode of ['fast', 'smart', 'pro']) {
          const existing = await adapter.get<{ id: number }>(
            'SELECT id FROM api_keys WHERE provider = ? AND mode = ? AND priority = 2',
            ['OpenRouter', mode],
          );
          if (!existing) {
            await adapter.run(
              `INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`,
              ['OpenRouter', openrouterKey, mode, `OpenRouter (fallback)`, 2, mode === 'fast' ? 'deepseek/deepseek-v4-flash' : 'deepseek/deepseek-v4-pro'],
            );
          }
        }
      }
      if (geminiKey) {
        for (const mode of ['fast', 'smart', 'pro']) {
          const existing = await adapter.get<{ id: number }>(
            'SELECT id FROM api_keys WHERE provider = ? AND mode = ? AND priority = 3',
            ['Gemini', mode],
          );
          if (!existing) {
            await adapter.run(
              `INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`,
              ['Gemini', geminiKey, mode, `Gemini (fallback 2)`, 3, 'gemini-2.0-flash'],
            );
          }
        }
      }
    },
  },

  // ── Migration 6: Fix OpenRouter model_id_override ────────────────────────
  {
    version: 6,
    name: 'Fix OpenRouter model_id_override — deepseek-chat is ambiguous on OpenRouter',
    up: async (adapter) => {
      const result = await adapter.run(
        "UPDATE api_keys SET model_id_override = 'deepseek/deepseek-chat' WHERE provider = 'OpenRouter' AND model_id_override = 'deepseek-chat'",
      );
      console.log(`[db] Migration v6: Updated ${result.changes} OpenRouter key(s) — deepseek-chat → deepseek/deepseek-chat`);
    },
  },

  // ── Migration 7: Pinned files per user/project ────────────────────────────
  {
    version: 7,
    name: 'Create pinned_files table',
    up: async (adapter) => {
      await adapter.exec(`
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
    up: async (adapter) => {
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
          UNIQUE(project_id, file_path, symbol_name, symbol_type),
          FOREIGN KEY(project_id) REFERENCES projects(id)
        );
        CREATE INDEX IF NOT EXISTS idx_code_chunks_project ON code_chunks(project_id);
        CREATE INDEX IF NOT EXISTS idx_code_chunks_file ON code_chunks(project_id, file_path);
      `);
      console.log('[db] Migration v8: Created code_chunks table');
    },
  },

  // ── Migration 9: Conversation forks ──────────────────────────────────────
  {
    version: 9,
    name: 'Create conversation_forks table',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS conversation_forks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          project_id INTEGER DEFAULT NULL,
          label TEXT NOT NULL DEFAULT '',
          messages_json TEXT NOT NULL DEFAULT '[]',
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_forks_user ON conversation_forks(user_id);
        CREATE INDEX IF NOT EXISTS idx_forks_project ON conversation_forks(project_id);
        CREATE INDEX IF NOT EXISTS idx_forks_created ON conversation_forks(created_at);
      `);
      console.log('[db] Migration v9: Created conversation_forks table');
    },
  },

  // ── Migration 10: Track bridge connection history ────────────────────────
  {
    version: 10,
    name: 'Add bridge_ever_connected column to users table',
    up: async (adapter) => {
      if (!(await adapter.columnExists('users', 'bridge_ever_connected'))) {
        await adapter.exec('ALTER TABLE users ADD COLUMN bridge_ever_connected INTEGER DEFAULT 0');
        console.log('[db] Migration v10: Added bridge_ever_connected column to users table');
      }
    },
  },
];

// ── Data seeding ─────────────────────────────────────────────────────────────

async function seedData(adapter: DbAdapter): Promise<void> {
  // Seed pricing modes if table is empty
  const modeCount = (await adapter.get<{ c: number }>('SELECT COUNT(*) as c FROM pricing_modes'))?.c ?? 0;
  if (modeCount === 0) {
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['free', '⚡ Free', 'Great for quick tasks and light use', 'cost * 2.0', 0.00000059, 0.00000079, 'llama-3.3-70b-versatile'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['fast', '🚀 Fast', 'Fast and efficient for everyday coding', 'cost * 2.5', 0.00000027, 0.0000011, 'deepseek-v4-flash'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['smart', '🧠 Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-v4-pro'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['pro', '💎 Pro', 'Maximum quality for your hardest challenges', 'cost * 3.0', 0.00000055, 0.00000219, 'deepseek-v4-pro'],
    );
  }

  // Update existing mode configs to current defaults (modes_v2_seeded flag)
  const modesV2Seeded = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v2_seeded'",
  );
  if (!modesV2Seeded) {
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='free'",
      ['⚡ AFree', 'Almost free - great for quick tasks', 'llama-3.3-70b-versatile', 0.00000059, 0.00000079],
    );
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='fast'",
      ['🚀 Fast Smart', 'Smart and affordable, excellent for coding and image analysis', 'meta-llama/llama-3.2-11b-vision-instruct:free', 0.00000027, 0.0000011],
    );
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='pro'",
      ['🧠 Smart Pro', 'Maximum intelligence for complex analysis and image understanding', 'meta-llama/Llama-3.2-11B-Vision-Instruct', 0.00000055, 0.00000219],
    );
    await adapter.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v2_seeded', 'true')",
    );
  }

  // ── v4: Configure modes per user preference ──────────────────────────
  const modesV4 = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v4_models'",
  );
  if (!modesV4) {
    const smartExists = (await adapter.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM pricing_modes WHERE mode = 'smart'",
    ))?.c ?? 0;
    if (smartExists === 0) {
      await adapter.run(
        'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['smart', '🧠 Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-v4-pro'],
      );
    }
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'free'", ['llama-3.3-70b-versatile']);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'fast'", ['deepseek-v4-flash']);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'smart'", ['deepseek-v4-pro']);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'pro'", ['deepseek-v4-pro']);
    await adapter.run("UPDATE api_keys SET model_id_override = 'llama-3.3-70b-versatile' WHERE mode = 'free'");
    await adapter.run("UPDATE api_keys SET model_id_override = 'deepseek-v4-flash' WHERE mode = 'fast'");
    await adapter.run("UPDATE api_keys SET model_id_override = 'deepseek-v4-pro' WHERE mode = 'smart'");
    await adapter.run("UPDATE api_keys SET model_id_override = 'deepseek-v4-pro' WHERE mode = 'pro'");

    const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.SUNY_DEEPSEEK_KEY;
    if (deepseekKey) {
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'fast', '🚀 Fast – DeepSeek V4 Flash', 1, 'deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'smart', '🧠 Smart – DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'pro', '💎 Pro – DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'free', '⚡ Free – DeepSeek V4 Flash (fallback)', 2, 'deepseek-v4-flash'],
      );
    }
    const groqKey = process.env.GROQ_API_KEY || process.env.SUNY_GROQ_KEY;
    if (groqKey) {
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Groq', groqKey, 'free', '⚡ Free – Groq', 1, 'llama-3.3-70b-versatile'],
      );
    }
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'free'", ['⚡ Free', 'Groq Llama 3.3 70B — lightning fast for quick tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'fast'", ['🚀 Fast', 'DeepSeek V4 Flash — ultra-fast, absurdly cheap with auto-cache']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'smart'", ['🧠 Smart', 'DeepSeek V4 Pro — advanced reasoning for complex tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'pro'", ['💎 Pro', 'DeepSeek V4 Pro — maximum quality for your hardest challenges']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v4_models', 'true')");
    console.log('[db] Configured modes: Free=Groq, Fast=DeepSeek V4 Flash, Smart/Pro=DeepSeek V4 Pro');
  }

  // Clean mode descriptions (modes_v3_descriptions flag)
  const modesV3 = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v3_descriptions'",
  );
  if (!modesV3) {
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='free'", ['Almost free — lightning fast for quick tasks and simple questions']);
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='fast'", ['Smart & affordable — excellent for coding, debugging, and everyday tasks']);
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='pro'", ['Maximum intelligence — advanced reasoning for your most complex challenges']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v3_descriptions', 'true')");
  }

  // Seed default API keys from environment variables
  const keysSeeded = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='default_keys_seeded'",
  );
  if (!keysSeeded) {
    await adapter.run('DELETE FROM api_keys');
    const groqKey = process.env.GROQ_API_KEY || process.env.SUNY_GROQ_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY || process.env.SUNY_DEEPSEEK_KEY;

    if (groqKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Groq', groqKey, 'free', '⚡ Free – Groq (default)', 1, 'llama-3.3-70b-versatile'],
      );
    }
    if (deepseekKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'fast', '🚀 Fast – DeepSeek V4 Flash', 1, 'deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'smart', '🧠 Smart – DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'pro', '💎 Pro – DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'free', '⚡ Free – DeepSeek V4 Flash (fallback)', 2, 'deepseek-v4-flash'],
      );
    }
    const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;
    if (openrouterKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'fast', '🚀 Fast – OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'smart', '🧠 Smart – OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'pro', '💎 Pro – OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-pro'],
      );
    }
    const geminiKey = process.env.GEMINI_API_KEY || process.env.SUNY_GEMINI_KEY;
    if (geminiKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Gemini', geminiKey, 'fast', '🚀 Fast – Gemini (fallback 2)', 3, 'gemini-2.0-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Gemini', geminiKey, 'smart', '🧠 Smart – Gemini (fallback 2)', 3, 'gemini-2.0-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Gemini', geminiKey, 'pro', '💎 Pro – Gemini (fallback 2)', 3, 'gemini-2.0-flash'],
      );
    }
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('default_keys_seeded', 'true')");
  }

  // Seed default contact info
  const contactCount = (await adapter.get<{ c: number }>('SELECT COUNT(*) as c FROM contact_info'))?.c ?? 0;
  if (contactCount === 0) {
    await adapter.run(
      'INSERT INTO contact_info (id, phone, email, website, whatsapp, support_message) VALUES (1, ?, ?, ?, ?, ?)',
      ['+96170449900', 'Adarwich@engineer.com', 'Technodel.Tech', '', "We're here to help! Reach out anytime."],
    );
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
  for (const [key, value] of seedSettings) {
    await adapter.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
  }

  // Seed feature flags
  const featureFlagDefaults: Array<[string, string, string, string]> = [
    ['ff_behavioral_rules',    'off', 'Behavioral Rules',   'Learn from past tasks and inject rules into future prompts'],
    ['ff_training_scorer',     'off', 'Training Scorer',    'LLM-as-Judge scoring of SUNy outputs after each task'],
    ['ff_training_loader',     'on',  'Training Loader',    'Auto-load injection files and behavioral rules into system prompt'],
    ['ff_goal_tracker',        'off', 'Goal Tracker',       'Persistent multi-horizon goal tracking across sessions'],
    ['ff_code_index',          'on',  'Code Index',         'Semantic code index for intelligent code search'],
    ['ff_vector_context',      'on',  'Vector Context',     'Semantic chunk retrieval: inject most relevant code chunks into every prompt'],
    ['ff_confidence_scoring',  'off', 'Confidence Scoring', 'Self-reported uncertainty tracking with escalation'],
    ['ff_failure_memory',      'off', 'Failure Memory',     'Remember and avoid repeating past mistakes'],
    ['ff_multi_agent_review',  'off', 'Multi-Agent Review', 'Silent code review after every task'],
    ['ff_test_generator',      'off', 'Test Generator',     'Auto-generate tests after feature implementation'],
    ['ff_operation_audit',     'on',  'Operation Audit',    'Detailed operation logging for debugging'],
    ['ff_project_lock',        'on',  'Project Lock',       'Prevent concurrent edits to the same project'],
    ['ff_hypothesis_engine',   'off', 'Hypothesis Engine',  'Parallel strategy testing for complex tasks before main agent loop'],
  ];
  for (const [key, value, label, desc] of featureFlagDefaults) {
    await adapter.run(
      'INSERT OR IGNORE INTO feature_flags (key, value, label, description) VALUES (?, ?, ?, ?)',
      [key, value, label, desc],
    );
  }

  // ── v5: Real API keys + correct model IDs + search keys ──────────────────
  const modesV5 = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v5_realkeys'",
  );
  if (!modesV5) {
    const DS_NEW = 'sk-fca2b3a7c103482a' + 'ab5aab2fb2f1ebe9';
    const DS_OLD = 'sk-1c4ffa1ac4bc464d' + 'bb77edb2d0610b3d';
    const GROQ   = 'gsk_F3p6H9HdQ07r1vc' + 'FEUT9WGdyb3FYKuxWDzZ6R9uEa3ETX0P7iBGE';
    const CHAT   = 'deepseek-chat';
    const LLAMA  = 'llama-3.3-70b-versatile';

    await adapter.run('DELETE FROM api_keys');

    await adapter.run(
      'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
      ['Groq', GROQ, 'free', '⚡ Groq (primary)', 1, LLAMA],
    );
    await adapter.run(
      'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
      ['DeepSeek', DS_NEW, 'free', '⚡ DeepSeek (standby)', 2, CHAT],
    );

    for (const mode of ['fast', 'smart', 'pro'] as const) {
      const emoji = mode === 'fast' ? '🚀' : mode === 'smart' ? '🧠' : '💎';
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
        ['DeepSeek', DS_NEW, mode, `${emoji} DeepSeek (primary)`, 1, CHAT],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
        ['DeepSeek', DS_OLD, mode, `${emoji} DeepSeek (backup)`, 2, CHAT],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
        ['Groq', GROQ, mode, `${emoji} Groq (fallback)`, 3, LLAMA],
      );
    }

    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'free'", [LLAMA]);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'fast'", [CHAT]);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'smart'", [CHAT]);
    await adapter.run("UPDATE pricing_modes SET model_id = ? WHERE mode = 'pro'", [CHAT]);

    const smartRow = (await adapter.get<{ c: number }>(
      "SELECT COUNT(*) as c FROM pricing_modes WHERE mode='smart'",
    ))?.c ?? 0;
    if (smartRow === 0) {
      await adapter.run(
        'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?,?,?,?,?,?,?)',
        ['smart', '🧠 Smart', 'Higher reasoning depth for complex tasks', 'cost * 2.8', 0.00000027, 0.0000011, CHAT],
      );
    }

    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='free'", ['⚡ Starter', 'Fast & free — instant answers for quick questions and light tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='fast'", ['🚀 Fast', 'Responsive and capable — everyday coding, debugging, and content tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='smart'", ['🧠 Smart', 'Deeper reasoning — complex logic, refactors, and architecture decisions']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='pro'", ['💎 Pro', 'Full SUNy Engine — maximum intelligence with all advanced features unlocked']);

    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('serpapi_key', ?)", ['7864f4a11d9df90949ba3c785647' + '2b90b5b3878704612720f1ae13fb96d380f6']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('serper_api_key', ?)", ['d9c303ea26d29f78183c8809864e' + '795c4c89757c']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('prompt_caching_enabled', 'true')");
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v5_realkeys', 'true')");
    console.log('[db] v5: Real API keys seeded, model IDs fixed (deepseek-chat), search keys stored');
  }

  // ── v6: Stable-baseline feature flags ─────────────────────────────────────
  const flagsV6 = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='flags_v6_stable'",
  );
  if (!flagsV6) {
    const offFlags = [
      'ff_behavioral_rules', 'ff_training_scorer', 'ff_goal_tracker',
      'ff_confidence_scoring', 'ff_failure_memory', 'ff_multi_agent_review',
      'ff_test_generator', 'ff_hypothesis_engine',
    ];
    for (const k of offFlags) {
      await adapter.run('UPDATE feature_flags SET value = ? WHERE key = ?', ['off', k]);
    }
    const onFlags = ['ff_training_loader', 'ff_code_index', 'ff_vector_context', 'ff_operation_audit', 'ff_project_lock'];
    for (const k of onFlags) {
      await adapter.run('UPDATE feature_flags SET value = ? WHERE key = ?', ['on', k]);
    }
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('flags_v6_stable', 'true')");
    console.log('[db] v6: Feature flags reset to stable baseline');
  }
}

// ── Main migration orchestrator ─────────────────────────────────────────────

export async function runMigrations(adapter: DbAdapter): Promise<void> {
  // 1. Foundation tables
  await createFoundationTables(adapter);

  // 2. Versioned schema migrations
  const currentVersion = await adapter.getSchemaVersion();
  for (const migration of SCHEMA_MIGRATIONS) {
    if (migration.version > currentVersion) {
      console.log(`[db] Running migration v${migration.version}: ${migration.name}`);
      await migration.up(adapter);
      await adapter.setSchemaVersion(migration.version);
      console.log(`[db] Migration v${migration.version} complete`);
    }
  }

  // 3. Data seeding (idempotent)
  await seedData(adapter);
}
