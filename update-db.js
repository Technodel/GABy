const db = require('better-sqlite3')('/var/www/suny/current-new-2/suny.db');
db.prepare("UPDATE pricing_modes SET description = 'Complicated high level coding' WHERE mode = 'opus'").run();
console.log('Done');
