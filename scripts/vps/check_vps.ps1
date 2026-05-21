ssh -p 2222 -o StrictHostKeyChecking=no -o ConnectTimeout=10 root@72.62.235.63 @'
cd /var/www/suny/current-new-2
echo "=== PWD ==="
pwd
echo "=== PM2 STATUS ==="
pm2 list
echo "=== WHAT PM2 IS RUNNING ==="
pm2 show suny | grep -E "exec_mode|script|exec_interpreter|cwd|status"
echo "=== CHECK IF CURRENT-NEW-2 HAS OTHER DB COPIES ==="
ls -la data/
echo "=== USERS IN DB ==="
node -e "const DB = require('better-sqlite3'); const db = new DB('data/suny.db'); console.log(JSON.stringify(db.prepare('SELECT id, username, role, balance FROM users').all(), null, 2)); console.log('API keys:', db.prepare('SELECT COUNT(*) as c FROM api_keys').get().c); db.close();"
echo "=== CHECK OTHER DB FILES ==="
find /var/www/suny -name "suny.db" 2>/dev/null
'@
