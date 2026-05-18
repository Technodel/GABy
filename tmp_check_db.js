const { execSync } = require('child_process');
const result = execSync('sqlite3 /var/www/suny/current-new/data/suny.db ".tables"', {encoding:'utf8'});
console.log('Tables:', result);

const users = execSync('sqlite3 -header -column /var/www/suny/current-new/data/suny.db "SELECT id, username, role, credits, password FROM users;"', {encoding:'utf8'});
console.log('Users:', users);

const settings = execSync('sqlite3 -header -column /var/www/suny/current-new/data/suny.db "SELECT key, value FROM app_settings;"', {encoding:'utf8'});
console.log('Settings:', settings);
