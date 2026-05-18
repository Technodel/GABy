cd /var/www/suny/current-new
echo "=== DIST CONTENTS ==="
ls -la src/renderer/dist/
echo "=== DIST ASSETS ==="
ls -la src/renderer/dist/assets/ 2>/dev/null
echo "=== PM2 STATUS ==="
pm2 list | grep suny
echo "=== ENV CHECK ==="
grep -c SUNY_ADMIN_PASSWORD .env 2>/dev/null || echo "NOT FOUND"
echo "=== DB ADMIN HASH ==="
sqlite3 data/suny.db "SELECT key, substr(value,1,30) FROM app_settings WHERE key='admin_password_hash';"
echo "=== DB USERS ==="
sqlite3 data/suny.db "SELECT id, username, substr(password_hash,1,30) as pw_prefix FROM users;"
echo "=== DB APP_SETTINGS KEYS ==="
sqlite3 data/suny.db "SELECT key FROM app_settings;"
