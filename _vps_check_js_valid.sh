#!/bin/bash
FILE=/var/www/suny/current-new/src/renderer/dist/assets/index-DAHLdOop.js
echo "=== SIZE ==="
stat -c%s "$FILE"
echo "=== FIRST 100 CHARS ==="
head -c 100 "$FILE"
echo ""
echo "=== LAST 100 CHARS ==="
tail -c 100 "$FILE"
echo ""
echo "=== PARSE CHECK ==="
node --check "$FILE" 2>&1 && echo "PARSE OK" || echo "PARSE FAILED"
