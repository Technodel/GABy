---
description: Deploy SUNy to VPS (72.62.235.63)
---

## Deploy to VPS

// turbo
1. Stash any remote changes and pull latest code
```
ssh -p 2222 root@72.62.235.63 "cd /var/www/suny/current-new-2 && git stash && git pull origin main"
```

// turbo
2. Install dependencies
```
ssh -p 2222 root@72.62.235.63 "cd /var/www/suny/current-new-2 && npm install"
```

// turbo
3. Build server
```
ssh -p 2222 root@72.62.235.63 "cd /var/www/suny/current-new-2 && node scripts/build.js"
```

// turbo
4. Build frontend
```
ssh -p 2222 root@72.62.235.63 "cd /var/www/suny/current-new-2/src/renderer && npx vite build"
```

// turbo
5. Restart PM2
```
ssh -p 2222 root@72.62.235.63 "pm2 restart suny"
```

// turbo
6. Verify locally on VPS
```
ssh -p 2222 root@72.62.235.63 "curl -s -w '\nHTTP %{http_code}\n' http://localhost:3500/"
```
