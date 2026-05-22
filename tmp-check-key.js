const Database = require('better-sqlite3');
const db = new Database('data/suny.db');

// Check if Anthropic keys have actual key values (not empty/null)
const keys = db.prepare("SELECT id, mode, provider, LENGTH(key_value) as key_len, model_id_override, is_active FROM api_keys WHERE provider = 'Anthropic' AND is_active = 1").all();
console.log('=== Anthropic active keys ===');
keys.forEach(k => {
  const hasKey = k.key_len > 10;
  console.log(`id=${k.id} mode=${k.mode} model=${k.model_id_override} key_len=${k.key_len} hasRealKey=${hasKey}`);
});

db.close();
