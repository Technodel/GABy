const Database = require('better-sqlite3');
const db = new Database('data/suny.db');

const result = db.prepare(
  "UPDATE api_keys SET model_id_override = 'claude-sonnet-4-20250514' WHERE provider = 'Anthropic' AND model_id_override = 'claude-3-5-sonnet-20241022'"
).run();
console.log('Updated', result.changes, 'rows');

const updated = db.prepare("SELECT id, mode, label, model_id_override FROM api_keys WHERE provider = 'Anthropic'").all();
console.log(JSON.stringify(updated, null, 2));

db.close();
