const D = require('better-sqlite3');
const d = new D('data/suny.db');
console.log('USERS:');
console.log(JSON.stringify(d.prepare('SELECT id, username, role FROM users').all(), null, 2));
console.log('API KEYS count:', d.prepare('SELECT COUNT(*) as c FROM api_keys').get().c);
console.log('CWD:', process.cwd());
d.close();
