cd /var/www/suny/current-new-2
echo "=== PM2 STATUS ==="
pm2 list
echo "=== PM2 SHOW SUNY ==="
pm2 show suny 2>&1
echo "=== CHECK DATA DIR ==="
ls -la data/
echo "=== OTHER DB FILES ==="
find /var/www/suny -name "suny.db" 2>/dev/null
echo "=== DB USERS ==="
node -e "var DB = require('better-sqlite3'); var db = new DB('data/suny.db'); console.log(JSON.stringify(db.prepare('SELECT id, username, role, balance FROM users').all())); console.log('API keys count:', db.prepare('SELECT COUNT(*) as c FROM api_keys').get().c); db.close();"
