const Database = require('better-sqlite3');
const db = new Database('data/suny.db');

// Full galaxy user record
const user = db.prepare("SELECT * FROM users WHERE username = 'galaxy'").get();
console.log('=== full galaxy user record ===');
console.log(JSON.stringify(user, null, 2));

// Test bcrypt
const bcrypt = require('bcryptjs');
const testPassword = '301088';
if (user && user.password_hash) {
  const match = bcrypt.compareSync(testPassword, user.password_hash);
  console.log('\nbcrypt compare 301088 vs user.password_hash:', match);
}

if (user && user.is_active !== 1) {
  console.log('\n*** PROBLEM: is_active =', user.is_active, '— must be 1 for login ***');
}

db.close();
