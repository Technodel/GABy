#!/bin/bash
echo "=== JS SIZE ==="
ls -la /var/www/suny/current-new/src/renderer/dist/assets/index-DAHLdOop.js
echo "=== JS START ==="
head -c 500 /var/www/suny/current-new/src/renderer/dist/assets/index-DAHLdOop.js
echo ""
echo "=== JS END ==="
tail -c 500 /var/www/suny/current-new/src/renderer/dist/assets/index-DAHLdOop.js
