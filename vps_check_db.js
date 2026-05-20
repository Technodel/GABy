var DB = require("better-sqlite3");
var db = new DB("/var/www/suny/current-new-2/data/suny.db");
console.log("Users:", JSON.stringify(db.prepare("SELECT id, username, role, balance FROM users").all()));
console.log("API keys:", db.prepare("SELECT COUNT(*) as c FROM api_keys").get().c);
db.close();
