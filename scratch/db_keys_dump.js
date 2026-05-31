const Database = require('better-sqlite3');
const path = require('path');
const dbPath = path.resolve(__dirname, '../data/suny.db');
const db = new Database(dbPath);
const keys = db.prepare('SELECT * FROM api_keys').all();
console.log('API Keys:', JSON.stringify(keys, null, 2));
const settings = db.prepare('SELECT * FROM app_settings').all();
console.log('App Settings:', JSON.stringify(settings, null, 2));
db.close();
