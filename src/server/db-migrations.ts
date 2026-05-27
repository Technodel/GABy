/**
 * db-migrations â€” all schema migrations + data seeding extracted from db.ts.
 *
 * These run against the DbAdapter interface so they work on any backend.
 * Each migration's `up()` receives the adapter and uses only its methods.
 */

import bcrypt from 'bcryptjs';
import type { DbAdapter } from './db-types';

// â”€â”€ Migration type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface Migration {
  version: number;
  name: string;
  up: (adapter: DbAdapter) => Promise<void>;
}

// â”€â”€ Schema foundation tables (always run â€” CREATE TABLE IF NOT EXISTS) â”€â”€â”€â”€â”€â”€â”€â”€

async function createFoundationTables(adapter: DbAdapter): Promise<void> {
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_cache_counters (
      user_id INTEGER PRIMARY KEY,
      cached_tokens INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id)
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

    CREATE TABLE IF NOT EXISTS shared_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      source_project_id INTEGER NOT NULL,
      source_project_name TEXT DEFAULT '',
      pattern_type TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      pattern_summary TEXT NOT NULL,
      pattern_detail TEXT DEFAULT '',
      confidence REAL DEFAULT 0.5,
      application_count INTEGER DEFAULT 0,
      last_applied_at TEXT DEFAULT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(source_project_id) REFERENCES projects(id)
    );

    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_user ON behavioral_rules(user_id);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_category ON behavioral_rules(category);
    CREATE INDEX IF NOT EXISTS idx_behavioral_rules_confidence ON behavioral_rules(confidence);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_user ON shared_patterns(user_id);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_type ON shared_patterns(pattern_type);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_key ON shared_patterns(pattern_key);
    CREATE INDEX IF NOT EXISTS idx_shared_patterns_confidence ON shared_patterns(confidence);
  `);
}

// â”€â”€ Versioned schema migrations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SCHEMA_MIGRATIONS: Migration[] = [
  // â”€â”€ Migration 1: Consolidate all legacy try/catch ALTER TABLE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 2: Add tables that were missing from schema â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 3: Agent turn metrics table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 4: Add role column + create default admin user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        // Always force admin role â€” guards against accidental role changes
        await adapter.run(
          "UPDATE users SET role = 'admin' WHERE username = 'galaxy'",
        );
        console.log('[db] Migration 4: Ensured "galaxy" has admin role');
      }
    },
  },

  // â”€â”€ Migration 5: Seed OpenRouter fallback API keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 5,
    name: 'Seed OpenRouter fallback API keys for fast/smart/pro modes',
    up: async (adapter) => {
      const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;

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
    },
  },

  // â”€â”€ Migration 6: Fix OpenRouter model_id_override â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 6,
    name: 'Fix OpenRouter model_id_override â€” deepseek-chat is ambiguous on OpenRouter',
    up: async (adapter) => {
      const result = await adapter.run(
        "UPDATE api_keys SET model_id_override = 'deepseek/deepseek-chat' WHERE provider = 'OpenRouter' AND model_id_override = 'deepseek-chat'",
      );
      console.log(`[db] Migration v6: Updated ${result.changes} OpenRouter key(s) â€” deepseek-chat â†’ deepseek/deepseek-chat`);
    },
  },

  // â”€â”€ Migration 7: Pinned files per user/project â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 8: Semantic code chunk vectors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 9: Conversation forks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 10: Track bridge connection history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Migration 11: Client Link (PRO feature) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 11,
    name: 'Create client_links and client_requests tables for Client Link PRO feature',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS client_links (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          project_id INTEGER DEFAULT NULL,
          project_name TEXT DEFAULT '',
          title TEXT DEFAULT '',
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT DEFAULT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS client_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          link_uid TEXT NOT NULL,
          client_name TEXT DEFAULT '',
          client_email TEXT DEFAULT '',
          description TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          admin_notes TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(link_uid) REFERENCES client_links(uid)
        );

        CREATE INDEX IF NOT EXISTS idx_client_links_user ON client_links(user_id);
        CREATE INDEX IF NOT EXISTS idx_client_links_uid ON client_links(uid);
        CREATE INDEX IF NOT EXISTS idx_client_requests_link ON client_requests(link_uid);
        CREATE INDEX IF NOT EXISTS idx_client_requests_status ON client_requests(status);
      `);
      console.log('[db] Migration v11: Created client_links and client_requests tables');
    },
  },

  // â”€â”€ Migration 12: Client Tickets (redesigned Client Link) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 12,
    name: 'Create client_tickets table for the redesigned Client Link ticket system',
    up: async (adapter) => {
      // Detect if we have the old v1 schema (title column) and nuke it
      const hasOldSchema = await adapter.columnExists('client_tickets', 'title');
      if (hasOldSchema) {
        await adapter.exec('DROP TABLE IF EXISTS client_tickets');
        console.log('[db] Migration v12: Dropped old client_tickets v1 schema');
      }
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS client_tickets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          project_id INTEGER DEFAULT NULL,
          project_name TEXT DEFAULT '',
          company_name TEXT DEFAULT '',
          goal TEXT NOT NULL DEFAULT '',
          messages TEXT DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'open',
          summary TEXT DEFAULT '',
          suggestions TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          closed_at TEXT DEFAULT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_client_tickets_user ON client_tickets(user_id);
        CREATE INDEX IF NOT EXISTS idx_client_tickets_uid ON client_tickets(uid);
        CREATE INDEX IF NOT EXISTS idx_client_tickets_status ON client_tickets(status);
      `);
      console.log('[db] Migration v12: Created client_tickets table');
    },
  },

  // â”€â”€ Migration 13: Per-project auto execute override â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 13,
    name: 'Add auto_execute_override column to projects table',
    up: async (adapter) => {
      if (!(await adapter.columnExists('projects', 'auto_execute_override'))) {
        await adapter.exec('ALTER TABLE projects ADD COLUMN auto_execute_override INTEGER DEFAULT NULL');
        console.log('[db] Migration v13: Added auto_execute_override column to projects table');
      }
    },
  },

  // â”€â”€ Migration 14: top-up requests + per-project default tier â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 14,
    name: 'Create topup_requests table and add default_tier column to projects',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS topup_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          amount REAL NOT NULL,
          note TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'pending',
          admin_notes TEXT DEFAULT '',
          created_at TEXT DEFAULT (datetime('now')),
          resolved_at TEXT DEFAULT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_topup_requests_user ON topup_requests(user_id);
        CREATE INDEX IF NOT EXISTS idx_topup_requests_status ON topup_requests(status);
      `);
      if (!(await adapter.columnExists('projects', 'default_tier'))) {
        await adapter.exec("ALTER TABLE projects ADD COLUMN default_tier TEXT DEFAULT NULL");
        console.log('[db] Migration v14: Added default_tier column to projects table');
      }
      console.log('[db] Migration v14: Created topup_requests table');
    },
  },

  // â”€â”€ Migration 15: Memory Snapshots (replaces conversation_forks) â”€â”€â”€â”€â”€â”€â”€â”€â”€
  {
    version: 15,
    name: 'Create memory_snapshots table, migrate conversation_forks, drop old table, add projects.frozen_snapshot_uid',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS memory_snapshots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uid TEXT NOT NULL UNIQUE,
          user_id INTEGER NOT NULL,
          project_id INTEGER DEFAULT NULL,
          label TEXT NOT NULL DEFAULT '',
          kind TEXT NOT NULL DEFAULT 'manual',
          checkpoint_id INTEGER DEFAULT NULL,
          messages_json TEXT NOT NULL DEFAULT '[]',
          blueprint_json TEXT DEFAULT NULL,
          behavioral_rules_json TEXT DEFAULT NULL,
          tier TEXT DEFAULT NULL,
          skills_json TEXT DEFAULT NULL,
          message_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_user ON memory_snapshots(user_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_project ON memory_snapshots(project_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_created ON memory_snapshots(created_at);
      `);

      // Migrate existing forks â†’ snapshots (one-shot, then drop old table)
      const oldExists = await adapter.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_forks'",
      );
      if (oldExists) {
        await adapter.exec(`
          INSERT INTO memory_snapshots (uid, user_id, project_id, label, kind, messages_json, message_count, created_at)
          SELECT uid, user_id, project_id, label, 'manual', messages_json, message_count, created_at
          FROM conversation_forks;
        `);
        await adapter.exec('DROP TABLE conversation_forks');
        console.log('[db] Migration v15: Migrated conversation_forks â†’ memory_snapshots and dropped old table');
      }

      if (!(await adapter.columnExists('projects', 'frozen_snapshot_uid'))) {
        await adapter.exec("ALTER TABLE projects ADD COLUMN frozen_snapshot_uid TEXT DEFAULT NULL");
      }
      console.log('[db] Migration v15: Created memory_snapshots table');
    },
  },
  {
    version: 16,
    name: 'Add cost tracking columns to api_keys',
    up: async (adapter) => {
      // Add base cost columns (official API cost)
      if (!(await adapter.columnExists('api_keys', 'base_cost_prompt'))) {
        await adapter.exec('ALTER TABLE api_keys ADD COLUMN base_cost_prompt REAL DEFAULT 0');
      }
      if (!(await adapter.columnExists('api_keys', 'base_cost_completion'))) {
        await adapter.exec('ALTER TABLE api_keys ADD COLUMN base_cost_completion REAL DEFAULT 0');
      }
      // Add sale price columns (cost billed to users)
      if (!(await adapter.columnExists('api_keys', 'sale_price_prompt'))) {
        await adapter.exec('ALTER TABLE api_keys ADD COLUMN sale_price_prompt REAL DEFAULT 0');
      }
      if (!(await adapter.columnExists('api_keys', 'sale_price_completion'))) {
        await adapter.exec('ALTER TABLE api_keys ADD COLUMN sale_price_completion REAL DEFAULT 0');
      }
    },
  },
  {
    version: 17,
    name: 'Add last_visit column to users table',
    up: async (adapter) => {
      if (!(await adapter.columnExists('users', 'last_visit'))) {
        await adapter.exec('ALTER TABLE users ADD COLUMN last_visit TEXT DEFAULT NULL');
      }
    },
  },

  // ── Migration 18: User plans (regular / pro) + per-plan feature flags ──────
  {
    version: 18,
    name: 'Add plan column to users, create plan_feature_flags table, seed PRO features',
    up: async (adapter) => {
      // Add plan column to users (default 'regular')
      if (!(await adapter.columnExists('users', 'plan'))) {
        await adapter.exec("ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'regular'");
      }

      // Create plan_feature_flags table
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS plan_feature_flags (
          key TEXT NOT NULL,
          plan TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 0,
          label TEXT NOT NULL DEFAULT '',
          description TEXT NOT NULL DEFAULT '',
          updated_at TEXT DEFAULT (datetime('now')),
          PRIMARY KEY (key, plan)
        );
      `);

      // Seed PRO-only features (enabled for pro, disabled for regular)
      const proFeatures: Array<{ key: string; label: string; description: string }> = [
        {
          key: 'pf_advanced_visual_portal',
          label: '🔭 Advanced Visual Portal',
          description: 'Give your clients a live link to your staging app. They click directly on any part of the UI, describe what they want changed, and SUNy automatically finds the right code and applies the fix — no back-and-forth emails needed.',
        },
        {
          key: 'pf_parallel_agent_swarm',
          label: '⚡ Parallel Agent Swarm',
          description: 'SUNy spawns multiple Junior AI agents in parallel to handle massive features simultaneously.',
        },
        {
          key: 'pf_hypothesis_engine',
          label: '🔬 Parallel Hypothesis Testing',
          description: 'For tough bugs, SUNy spawns multiple mini-agents with different strategies and picks the best.',
        },
        {
          key: 'pf_scheduled_agents',
          label: '🚧 Scheduled Agents',
          description: 'Schedule SUNy to run automated code reviews, audits, and health checks on a timer.',
        },
        {
          key: 'pf_client_portal',
          label: '🎫 Client Ticket Portal',
          description: 'Generate secure shareable URLs for clients to submit project requests via SUNy.',
        },
      ];

      for (const f of proFeatures) {
        // PRO plan: all enabled by default

        await adapter.run(
          `INSERT OR IGNORE INTO plan_feature_flags (key, plan, enabled, label, description) VALUES (?, 'pro', 1, ?, ?)`,
          [f.key, f.label, f.description],
        );
        // Regular plan: disabled by default (except client portal — available to everyone)
        const regularEnabled = f.key === 'pf_client_portal' ? 1 : 0;
        await adapter.run(
          `INSERT OR IGNORE INTO plan_feature_flags (key, plan, enabled, label, description) VALUES (?, 'regular', ?, ?, ?)`,
          [f.key, regularEnabled, f.label, f.description],
        );
      }
    },
  },


  // -- Migration 22: Enable pf_codebase_health for regular plan
  {
    version: 22,
    name: 'Enable Codebase Health Score for regular plan',
    up: async (adapter) => {
      await adapter.run(
        `UPDATE plan_feature_flags SET enabled = 1 WHERE key = 'pf_codebase_health' AND plan = 'regular'`,
      );
      await adapter.run(
        `INSERT OR IGNORE INTO plan_feature_flags (key, plan, enabled, label, description) VALUES ('pf_codebase_health', 'regular', 1, '🏥 Codebase Health Score', 'After every session, SUNy scores the health of files it touched (lint, tests, complexity, coverage) and tracks the trend over time.')`,
      );
    },
  },

  // -- Migration 21: Update Advanced Visual Portal description to be client-focused
  {
    version: 21,
    name: 'Update pf_advanced_visual_portal description',
    up: async (adapter) => {
      const newDesc = 'Give your clients a live link to your staging app. They click directly on any part of the UI, describe what they want changed, and SUNy automatically finds the right code and applies the fix — no back-and-forth emails needed.';
      await adapter.run(
        `UPDATE plan_feature_flags SET description = ? WHERE key = 'pf_advanced_visual_portal'`,
        [newDesc],
      );
    },
  },

  // -- Migration 20: Seed new PRO plan feature flags (push notifications, forecast, budget gate)
  {
    version: 20,
    name: 'Seed PRO plan flags: push_notifications, cost_forecast, budget_gate',
    up: async (adapter) => {
      const newFlags = [
        {
          key: 'pf_push_notifications',
          label: '🔔 Push Notifications & Run Receipts',
          description: 'Browser push notifications when a run completes, with a receipt showing files changed, credits used, and test results.',
        },
        {
          key: 'pf_cost_forecast',
          label: '📋 Pre-Run Cost Estimate',
          description: 'Before each run, SUNy estimates the credit cost using your history or a lightweight AI analysis. Token cost billed to user.',
        },
        {
          key: 'pf_budget_gate',
          label: '🔒 Per-Run Budget Gate',
          description: 'Set a credit cap per run. SUNy warns at 80%, pauses at 90% offering Budget Mode, Extend, or Stop options.',
        },
        {
          key: 'pf_codebase_health',
          label: '🏥 Codebase Health Score',
          description: 'After every session, SUNy scores the health of files it touched (lint, tests, complexity, coverage) and tracks the trend over time.',
        },
      ];
      for (const f of newFlags) {
        await adapter.run(
          `INSERT OR IGNORE INTO plan_feature_flags (key, plan, enabled, label, description) VALUES (?, 'pro', 1, ?, ?)`,
          [f.key, f.label, f.description],
        );
        // pf_codebase_health is available to all plans
        const regularEnabled = f.key === 'pf_codebase_health' ? 1 : 0;
        await adapter.run(
          `INSERT OR IGNORE INTO plan_feature_flags (key, plan, enabled, label, description) VALUES (?, 'regular', ?, ?, ?)`,
          [f.key, regularEnabled, f.label, f.description],
        );
      }
    },
  },

  // -- Migration 19: Plan upgrade requests
  {
    version: 19,
    name: 'Create plan_upgrade_requests table',
    up: async (adapter) => {
      await adapter.exec(`
        CREATE TABLE IF NOT EXISTS plan_upgrade_requests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          username TEXT NOT NULL,
          current_plan TEXT NOT NULL DEFAULT 'regular',
          requested_plan TEXT NOT NULL DEFAULT 'pro',
          status TEXT NOT NULL DEFAULT 'pending',
          note TEXT DEFAULT '',
          requested_at TEXT DEFAULT (datetime('now')),
          reviewed_at TEXT DEFAULT NULL,
          FOREIGN KEY(user_id) REFERENCES users(id)
        );
      `);
    },
  },
];

// â”€â”€ Data seeding â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function seedData(adapter: DbAdapter): Promise<void> {
  // Seed pricing modes if table is empty
  const modeCount = (await adapter.get<{ c: number }>('SELECT COUNT(*) as c FROM pricing_modes'))?.c ?? 0;
  if (modeCount === 0) {
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['free', 'âš¡ Free', 'Great for quick tasks and light use', 'cost * 2.0', 0.00000059, 0.00000079, 'llama-3.3-70b-versatile'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['fast', 'ðŸš€ Fast', 'Fast and efficient for everyday coding', 'cost * 2.5', 0.00000027, 0.0000011, 'deepseek-v4-flash'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['smart', 'ðŸ§  Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-v4-pro'],
    );
    await adapter.run(
      'INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['pro', 'ðŸ’Ž Pro', 'Maximum quality for your hardest challenges', 'cost * 3.0', 0.00000055, 0.00000219, 'deepseek-v4-pro'],
    );
  }

  // Update existing mode configs to current defaults (modes_v2_seeded flag)
  const modesV2Seeded = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v2_seeded'",
  );
  if (!modesV2Seeded) {
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='free'",
      ['âš¡ AFree', 'Almost free - great for quick tasks', 'llama-3.3-70b-versatile', 0.00000059, 0.00000079],
    );
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='fast'",
      ['ðŸš€ Fast Smart', 'Smart and affordable, excellent for coding and image analysis', 'meta-llama/llama-3.2-11b-vision-instruct:free', 0.00000027, 0.0000011],
    );
    await adapter.run(
      "UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='pro'",
      ['ðŸ§  Smart Pro', 'Maximum intelligence for complex analysis and image understanding', 'meta-llama/Llama-3.2-11B-Vision-Instruct', 0.00000055, 0.00000219],
    );
    await adapter.run(
      "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v2_seeded', 'true')",
    );
  }

  // â”€â”€ v4: Configure modes per user preference â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        ['smart', 'ðŸ§  Smart', 'Advanced reasoning for complex tasks', 'cost * 2.8', 0.00000040, 0.0000015, 'deepseek-v4-pro'],
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
        ['DeepSeek', deepseekKey, 'fast', 'ðŸš€ Fast â€“ DeepSeek V4 Flash', 1, 'deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'smart', 'ðŸ§  Smart â€“ DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'pro', 'ðŸ’Ž Pro â€“ DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'free', 'âš¡ Free â€“ DeepSeek V4 Flash (fallback)', 2, 'deepseek-v4-flash'],
      );
    }
    const groqKey = process.env.GROQ_API_KEY || process.env.SUNY_GROQ_KEY;
    if (groqKey) {
      await adapter.run(
        'INSERT OR REPLACE INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['Groq', groqKey, 'free', 'âš¡ Free â€“ Groq', 1, 'llama-3.3-70b-versatile'],
      );
    }
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'free'", ['âš¡ Free', 'Groq Llama 3.3 70B â€” lightning fast for quick tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'fast'", ['ðŸš€ Fast', 'DeepSeek V4 Flash â€” ultra-fast, absurdly cheap with auto-cache']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'smart'", ['ðŸ§  Smart', 'DeepSeek V4 Pro â€” advanced reasoning for complex tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name = ?, description = ? WHERE mode = 'pro'", ['ðŸ’Ž Pro', 'DeepSeek V4 Pro â€” maximum quality for your hardest challenges']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v4_models', 'true')");
    console.log('[db] Configured modes: Free=Groq, Fast=DeepSeek V4 Flash, Smart/Pro=DeepSeek V4 Pro');
  }

  // Clean mode descriptions (modes_v3_descriptions flag)
  const modesV3 = await adapter.get<{ value: string }>(
    "SELECT value FROM app_settings WHERE key='modes_v3_descriptions'",
  );
  if (!modesV3) {
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='free'", ['Almost free â€” lightning fast for quick tasks and simple questions']);
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='fast'", ['Smart & affordable â€” excellent for coding, debugging, and everyday tasks']);
    await adapter.run("UPDATE pricing_modes SET description=? WHERE mode='pro'", ['Maximum intelligence â€” advanced reasoning for your most complex challenges']);
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
        ['Groq', groqKey, 'free', 'âš¡ Free â€“ Groq (default)', 1, 'llama-3.3-70b-versatile'],
      );
    }
    if (deepseekKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'fast', 'ðŸš€ Fast â€“ DeepSeek V4 Flash', 1, 'deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'smart', 'ðŸ§  Smart â€“ DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'pro', 'ðŸ’Ž Pro â€“ DeepSeek V4 Pro', 1, 'deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['DeepSeek', deepseekKey, 'free', 'âš¡ Free â€“ DeepSeek V4 Flash (fallback)', 2, 'deepseek-v4-flash'],
      );
    }
    const openrouterKey = process.env.OPENROUTER_API_KEY || process.env.SUNY_OPENROUTER_KEY;
    if (openrouterKey) {
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'fast', 'ðŸš€ Fast â€“ OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-flash'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'smart', 'ðŸ§  Smart â€“ OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-pro'],
      );
      await adapter.run(
        'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)',
        ['OpenRouter', openrouterKey, 'pro', 'ðŸ’Ž Pro â€“ OpenRouter (fallback)', 2, 'deepseek/deepseek-v4-pro'],
      );
    }
    // Gemini removed - no API key available
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
    ['ff_behavioral_rules',       'off', 'Behavioral Rules',         'Learn from past tasks and inject rules into future prompts'],
    ['ff_activation_controller',  'on',  'Activation Controller',    'Composable behavior profiles from multiple sources (ntkmirror-inspired)'],
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

  // â”€â”€ v5: Real API keys + correct model IDs + search keys â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      ['Groq', GROQ, 'free', 'âš¡ Groq (primary)', 1, LLAMA],
    );
    await adapter.run(
      'INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?,?,?,1,?,?,?)',
      ['DeepSeek', DS_NEW, 'free', 'âš¡ DeepSeek (standby)', 2, CHAT],
    );

    for (const mode of ['fast', 'smart', 'pro'] as const) {
      const emoji = mode === 'fast' ? 'ðŸš€' : mode === 'smart' ? 'ðŸ§ ' : 'ðŸ’Ž';
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
        ['smart', 'ðŸ§  Smart', 'Higher reasoning depth for complex tasks', 'cost * 2.8', 0.00000027, 0.0000011, CHAT],
      );
    }

    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='free'", ['âš¡ Starter', 'Fast & free â€” instant answers for quick questions and light tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='fast'", ['ðŸš€ Fast', 'Responsive and capable â€” everyday coding, debugging, and content tasks']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='smart'", ['ðŸ§  Smart', 'Deeper reasoning â€” complex logic, refactors, and architecture decisions']);
    await adapter.run("UPDATE pricing_modes SET display_name=?, description=? WHERE mode='pro'", ['ðŸ’Ž Pro', 'Full SUNy Engine â€” maximum intelligence with all advanced features unlocked']);

    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('serpapi_key', ?)", ['7864f4a11d9df90949ba3c785647' + '2b90b5b3878704612720f1ae13fb96d380f6']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('serper_api_key', ?)", ['d9c303ea26d29f78183c8809864e' + '795c4c89757c']);
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('prompt_caching_enabled', 'true')");
    await adapter.run("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v5_realkeys', 'true')");
    console.log('[db] v5: Real API keys seeded, model IDs fixed (deepseek-chat), search keys stored');
  }

  // â”€â”€ v6: Stable-baseline feature flags â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Main migration orchestrator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

