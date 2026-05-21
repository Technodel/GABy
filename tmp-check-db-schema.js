const Database = require('better-sqlite3');
const db = new Database('data/suny.db');
const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='api_keys'").all();
console.log('API Keys Table Schema:');
console.log(JSON.stringify(schema, null, 2));

console.log('\n=== api_keys ===');
const keys = db.prepare('SELECT * FROM api_keys ORDER BY mode, priority').all();
console.log(JSON.stringify(keys, null, 2));
db.close();
