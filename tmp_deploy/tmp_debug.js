const Database = require('better-sqlite3');
const db = new Database('./data/suny.db');
const user = db.prepare('SELECT id, username, balance, wallet_balance, wallet_auto_spend FROM users WHERE username = ?').get('testbench');
console.log('testbench:', JSON.stringify(user));
const limit = db.prepare("SELECT * FROM app_settings WHERE key LIKE '%token%limit%' OR key LIKE '%daily%'").all();
console.log('settings:', JSON.stringify(limit));
const allSettings = db.prepare("SELECT * FROM app_settings").all();
console.log('all_settings:', JSON.stringify(allSettings));
db.close();
