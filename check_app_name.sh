#!/bin/bash
echo "=== dist index.html title ==="
grep -o '<title>[^<]*</title>' /var/www/suny/current-new/src/renderer/dist/index.html
echo "=== app name in JS ==="
grep -o 'GABy\|SUNy\|Consider it done\|Smart Unstoppable' /var/www/suny/current-new/src/renderer/dist/assets/index-WgmZ8vkc.js | sort | uniq -c | sort -rn
echo "=== login page content ==="
grep -o 'Sign In\|Sign Up\|Sign in\|admin' /var/www/suny/current-new/src/renderer/dist/assets/index-WgmZ8vkc.js | sort | uniq -c | sort -rn
