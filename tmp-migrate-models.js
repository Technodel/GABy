const Database = require('better-sqlite3');
const db = new Database('./data/suny.db');

console.log('=== 1. Update pricing_modes model_id ===');

db.prepare(`UPDATE pricing_modes SET model_id = 'deepseek-chat', updated_at = datetime('now') WHERE mode = 'free'`).run();
console.log('  free: deepseek-chat (DeepSeek Flash)');

db.prepare(`UPDATE pricing_modes SET model_id = 'deepseek-reasoner', updated_at = datetime('now') WHERE mode = 'smart'`).run();
console.log('  smart: deepseek-reasoner (DeepSeek R1/Pro)');

db.prepare(`UPDATE pricing_modes SET model_id = 'deepseek-chat', updated_at = datetime('now') WHERE mode = 'pro'`).run();
console.log('  pro: deepseek-chat (DeepSeek V3)');

console.log('\n=== 2. Free mode: DeepSeek Flash primary, Groq fallback ===');

// Deactivate old Groq primary (id=1), reactivate DeepSeek (id=7) as primary
db.prepare(`UPDATE api_keys SET is_active = 0 WHERE id = 1`).run();
db.prepare(`UPDATE api_keys SET priority = 1, is_active = 1 WHERE id = 7`).run();
console.log('  DeepSeek (id=7) → priority 1 primary');

// Add Groq back as priority 2 fallback using a COPY of the original
const groqKey = db.prepare(`SELECT key_value, model_id_override FROM api_keys WHERE id = 1`).get();
if (groqKey) {
  const existingGroq = db.prepare(`SELECT id FROM api_keys WHERE provider = 'Groq' AND mode = 'free' AND priority = 2`).get();
  if (!existingGroq) {
    db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override)
      VALUES ('Groq', ?, 'free', 1, 'Groq (fallback)', 2, ?)`).run(groqKey.key_value, groqKey.model_id_override);
    console.log('  Groq → priority 2 fallback');
  }
}

console.log('\n=== 3. Smart mode: DeepSeek R1 primary ===');

db.prepare(`UPDATE api_keys SET model_id_override = 'deepseek-reasoner', label = 'DeepSeek R1 (primary)' WHERE id = 5`).run();
console.log('  Smart DeepSeek (id=5): deepseek-reasoner');

console.log('\n=== 4. Pro mode: DeepSeek primary + Anthropic Claude Sonnet ===');

// NOTE: Anthropic key was added manually via admin UI or DB direct insert (id=22)
// This script is a reference only — do NOT store real keys in source control.
const ANTHROPIC_KEY = 'ANTHROPIC_KEY_PLACEHOLDER_REPLACE_IN_ADMIN';

// Check if Anthropic already exists
const existingAnthropic = db.prepare(`SELECT id FROM api_keys WHERE provider = 'Anthropic' AND mode = 'pro'`).get();
if (!existingAnthropic) {
  // Keep DeepSeek as priority 1 primary for pro
  db.prepare(`UPDATE api_keys SET priority = 1, label = 'DeepSeek V3 (primary)' WHERE id = 6`).run();
  // Add Claude Sonnet as priority 2 fallback
  db.prepare(`INSERT INTO api_keys (provider, key_value, mode, is_active, label, priority, model_id_override)
    VALUES ('Anthropic', ?, 'pro', 1, 'Claude Sonnet (fallback)', 2, 'claude-sonnet-4-20250514')`).run(ANTHROPIC_KEY);
  console.log('  Anthropic Claude Sonnet → priority 2 (pro fallback)');
} else {
  console.log('  Anthropic key already exists for pro (id=' + existingAnthropic.id + '), updating key value');
  db.prepare(`UPDATE api_keys SET key_value = ?, is_active = 1 WHERE id = ?`).run(ANTHROPIC_KEY, existingAnthropic.id);
}

console.log('\n=== 5. Verify ===');
const modes = db.prepare('SELECT mode, model_id FROM pricing_modes ORDER BY id').all();
console.table(modes);
const keys = db.prepare(`
  SELECT id, provider, mode, priority, is_active, substr(model_id_override,1,30) as model
  FROM api_keys
  WHERE mode IN ('free','smart','pro') AND is_active = 1
  ORDER BY mode, priority, id
`).all();
console.table(keys);

db.close();
console.log('\nDone!');
