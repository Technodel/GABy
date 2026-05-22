const Database = require('better-sqlite3');
const db = new Database('data/suny.db');

// Check ALL Anthropic keys
console.log('=== ALL Anthropic keys ===');
const keys = db.prepare("SELECT id, mode, label, model_id_override, is_active FROM api_keys WHERE provider = 'Anthropic'").all();
console.table(keys);

// Check pricing modes
console.log('\n=== pricing_modes ===');
const modes = db.prepare('SELECT mode, model_id FROM pricing_modes').all();
console.table(modes);

db.close();
