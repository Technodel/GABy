const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const db = new Database('data/suny.db');

// Get the admin hash
const row = db.prepare("SELECT value FROM app_settings WHERE key = 'admin_password_hash'").get();
const adminHash = row.value;

// Update galaxy user
db.prepare("UPDATE users SET password_hash = ? WHERE username = 'galaxy'").run(adminHash);

// Verify
const user = db.prepare("SELECT username, password_hash FROM users WHERE username = 'galaxy'").get();
const match = bcrypt.compareSync('301088', user.password_hash);
console.log('Updated. bcrypt compare 301088:', match);

db.close();
