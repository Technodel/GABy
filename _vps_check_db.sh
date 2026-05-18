cd /var/www/suny/current-new
echo "=== ADMIN HASH ==="
sqlite3 data/suny.db "SELECT key FROM app_settings WHERE key='admin_password_hash';"
echo "=== DB SETTINGS ==="
sqlite3 data/suny.db "SELECT key FROM app_settings ORDER BY key;"
