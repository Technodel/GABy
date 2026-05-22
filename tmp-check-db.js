const Database = require('/var/www/suny/current-new-2/node_modules/better-sqlite3');
const db = new Database('/var/www/suny/current-new-2/data/suny.db');

console.log('=== pricing_modes ===');
const modes = db.prepare('SELECT mode, model_id FROM pricing_modes').all();
console.log(JSON.stringify(modes, null, 2));

console.log('\n=== api_keys (active, pro mode, anthropic) ===');
const keys = db.prepare("SELECT id, provider, mode, is_active, label, priority, model_id_override FROM api_keys WHERE mode = 'pro' AND provider = 'Anthropic'").all();
console.log(JSON.stringify(keys, null, 2));

console.log('\n=== api_keys (all active) ===');
const allKeys = db.prepare('SELECT id, provider, mode, is_active, label, priority, model_id_override FROM api_keys WHERE is_active = 1 ORDER BY mode, priority').all();
console.log(JSON.stringify(allKeys, null, 2));

db.close();
