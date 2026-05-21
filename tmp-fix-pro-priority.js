const Database = require('better-sqlite3');
const db = new Database('./data/suny.db');

// Deactivate HuggingFace id:3 for pro mode (collides with Anthropic at priority 2)
const existing = db.prepare('SELECT id, provider, priority FROM api_keys WHERE id = 3').get();
console.log('Before - HuggingFace (id:3):', existing);

db.prepare('UPDATE api_keys SET is_active = 0 WHERE id = 3').run();
console.log('Deactivated HuggingFace (id:3) — no longer needed for pro mode');

// Make Anthropic (id:22) priority 2 (primary fallback), bump OpenRouter (id:17) to priority 3
db.prepare('UPDATE api_keys SET priority = 2 WHERE id = 22').run();
console.log('Anthropic Claude (id:22) → priority 2 (primary Pro fallback)');
const openRouter17 = db.prepare('SELECT id, priority FROM api_keys WHERE id = 17').get();
if (openRouter17 && openRouter17.priority !== 3) {
  db.prepare('UPDATE api_keys SET priority = 3 WHERE id = 17').run();
  console.log('OpenRouter (id:17) → priority 3');
}

// Verify Pro mode ordering
const proKeys = db.prepare('SELECT id, provider, priority, is_active, model_id_override FROM api_keys WHERE mode = ? AND is_active = 1 ORDER BY priority ASC, id ASC').all('pro');
console.log('\nPro mode keys (active, by priority):');
console.table(proKeys);

// Verify all modes
for (const mode of ['free', 'fast', 'smart', 'pro']) {
  const keys = db.prepare('SELECT id, provider, priority, is_active, model_id_override FROM api_keys WHERE mode = ? AND is_active = 1 ORDER BY priority ASC, id ASC').all(mode);
  console.log(`\n${mode} mode active keys:`);
  console.table(keys);
}

db.close();
console.log('\nDone!');
