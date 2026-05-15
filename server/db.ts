import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.GABY_DB_PATH || './data/gaby.db';

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

function runMigrations(db: Database.Database): void {
  db.exec(`
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

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // ── Migrations for existing databases ──────────────────────────────────────
  // Safe: SQLite throws if the column already exists; we ignore that error.
  try { db.exec('ALTER TABLE usage_log ADD COLUMN cache_write_tokens INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE usage_log ADD COLUMN cache_read_tokens INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pricing_modes ADD COLUMN model_id TEXT NOT NULL DEFAULT 'claude-3-5-haiku-20241022'"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN wallet_balance REAL DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN wallet_auto_spend INTEGER DEFAULT 0'); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE pricing_modes ADD COLUMN description TEXT DEFAULT ''"); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE api_keys ADD COLUMN priority INTEGER DEFAULT 1'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE api_keys ADD COLUMN model_id_override TEXT'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE users ADD COLUMN display_name TEXT DEFAULT NULL'); } catch { /* already exists */ }
  try { db.exec('ALTER TABLE projects ADD COLUMN persona TEXT DEFAULT NULL'); } catch { /* already exists */ }


  const modeCount = (db.prepare('SELECT COUNT(*) as c FROM pricing_modes').get() as { c: number }).c;
  if (modeCount === 0) {
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('free', '⚡ AFree', 'Almost free — Groq-powered with OpenRouter fallback', 'cost * 2.0', 0.00000059, 0.00000079, 'llama-3.3-70b-versatile');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('fast', '🚀 Fast Smart', 'Smart & affordable — DeepSeek V3, excellent for coding and everyday tasks', 'cost * 2.5', 0.00000027, 0.0000011, 'deepseek-chat');
    db.prepare(`INSERT INTO pricing_modes (mode, display_name, description, markup_formula, input_token_base_cost, output_token_base_cost, model_id) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run('pro', '🧠 Smart Pro', 'Maximum intelligence — DeepSeek R1 reasoning model for complex problems', 'cost * 3.0', 0.00000055, 0.00000219, 'deepseek-reasoner');
  }

  // ── Update existing mode configs to current defaults ──────────────────────
  // Run once per DB identified by the 'modes_v2_seeded' flag
  const modesV2Seeded = db.prepare("SELECT value FROM app_settings WHERE key='modes_v2_seeded'").get();
  if (!modesV2Seeded) {
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='free'`)
      .run('⚡ AFree', 'Almost free — Groq-powered with OpenRouter fallback', 'llama-3.3-70b-versatile', 0.00000059, 0.00000079);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='fast'`)
      .run('🚀 Fast Smart', 'Smart & affordable — DeepSeek V3, excellent for coding and everyday tasks', 'deepseek-chat', 0.00000027, 0.0000011);
    db.prepare(`UPDATE pricing_modes SET display_name=?, description=?, model_id=?, input_token_base_cost=?, output_token_base_cost=? WHERE mode='pro'`)
      .run('🧠 Smart Pro', 'Maximum intelligence — DeepSeek R1 reasoning model for complex problems', 'deepseek-reasoner', 0.00000055, 0.00000219);
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('modes_v2_seeded', 'true')").run();
  }

  // ── Clean mode descriptions: no AI model names ────────────────────────────
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

  // ── Seed default API keys from environment variables ─────────────────────
  // NEVER hardcode API keys in source code. Set them via .env or docker environment.
  const keysSeeded = db.prepare("SELECT value FROM app_settings WHERE key='default_keys_seeded'").get();
  if (!keysSeeded) {
    db.prepare('DELETE FROM api_keys').run();
    // Only seed if env vars are set (first-time setup)
    const groqKey = process.env.GABY_GROQ_KEY;
    const openrouterKey = process.env.GABY_OPENROUTER_KEY;
    const deepseekKey = process.env.GABY_DEEPSEEK_KEY;
    if (groqKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('Groq', groqKey, 'free', '⚡ Free Mode – Groq (primary)', 1, 'llama-3.3-70b-versatile');
    }
    if (openrouterKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('OpenRouter', openrouterKey, 'free', '⚡ Free Mode – OpenRouter (fallback)', 2, 'meta-llama/llama-3.3-70b-instruct:free');
    }
    if (deepseekKey) {
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'fast', '🚀 Fast Mode – DeepSeek V3', 1, 'deepseek-chat');
      db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override) VALUES (?, ?, ?, 1, ?, ?, ?)`)
        .run('DeepSeek', deepseekKey, 'pro', '🧠 Pro Mode – DeepSeek R1', 1, 'deepseek-reasoner');
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
  const seedSettings = [
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
