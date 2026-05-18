const path = require('path');
process.chdir('/var/www/suny/current-new');
const Database = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'));
const db = new Database(path.join(process.cwd(), 'data', 'suny.db'));

// Check schema
const cols = db.prepare("PRAGMA table_info(users)").all();
console.log('Users table columns:', JSON.stringify(cols));

// Find empy
const user = db.prepare('SELECT id, username, display_name FROM users WHERE username = ?').get('empy');
console.log('User empy:', JSON.stringify(user));

// List all users
const all = db.prepare('SELECT id, username, display_name FROM users').all();
console.log('All users:', JSON.stringify(all));

db.close();
