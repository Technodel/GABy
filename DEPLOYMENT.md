# SUNy Deployment Guide

Deploy SUNy to a VPS behind nginx with Docker, TLS, and persistent storage.

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Environment Setup](#2-environment-setup)
3. [Deploy via Docker](#3-deploy-via-docker)
4. [SSL/TLS with Let's Encrypt](#4-ssltls-with-lets-encrypt)
5. [Verify Deployment](#5-verify-deployment)
6. [Monitoring & Logs](#6-monitoring--logs)
7. [Backup & Restore](#7-backup--restore)
8. [Rollback Procedure](#8-rollback-procedure)
9. [Common Issues](#9-common-issues)

---

## 1. Prerequisites

- VPS with **Ubuntu 22.04+** (or any Linux with Docker support)
- A domain name pointing to your VPS IP (e.g., `suny.example.com`)
- Ports **80** and **443** open in your firewall
- Docker and Docker Compose v2 installed on the VPS

### SSH Access (VPS)

```bash
ssh -p 2222 user@suny.technodel.tech
```

Default SSH port is **2222** (not 22).

### Install Node.js (Ubuntu)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

### Install PM2 globally

```bash
npm install -y pm2
```

---

## 2. Environment Setup

### Clone the repository

```bash
git clone <your-repo-url> /opt/suny
cd /opt/suny
```

### Configure environment variables

```bash
cp .env.example .env
nano .env
```

**Required variables — must be set:**

| Variable | Description | Example |
|----------|-------------|---------|
| `SUNY_ADMIN_PASSWORD` | Admin login password (used for one-time bootstrap hash) | `my-strong-p@ss` |
| `SUNY_SECRET_JWT` | JWT signing secret (min 16 chars) | `a-very-long-random-string-at-least-16-chars` |
| `SUNY_ALLOWED_ORIGIN` | Your VPS domain | `https://suny.example.com` |

**Optional variables (set to enable features):**

| Variable | Description | Example |
|----------|-------------|---------|
| `GROQ_API_KEY` | Groq API key (free mode, supports legacy `SUNY_GROQ_KEY` too) | `gsk_your_key` |
| `OPENROUTER_API_KEY` | OpenRouter key (free mode fallback, supports legacy `SUNY_OPENROUTER_KEY`) | `sk-or-your-key` |
| `DEEPSEEK_API_KEY` | DeepSeek API key (fast/smart/pro modes, supports legacy `SUNY_DEEPSEEK_KEY`) | `sk-your-key` |
| `GEMINI_API_KEY` | Gemini API key (additional provider) | `your-gemini-key` |
| `SUNY_PORT` | Server port (default: 3500) | `3500` |
| `SUNY_DB_PATH` | DB file path (default: `./data/suny.db`) | `/data/suny.db` |
| `SUNY_ALLOWED_ORIGIN` | CORS allowed origin | `https://suny.example.com` |

---

## 3. Deploy via Docker

### Option A: PM2 + tsx (direct, no Docker)

```bash
# Install dependencies
npm install
cd src/renderer && npm install && npx vite build && cd ../..

# Build bridge
cd bridge && npm install && npm pack && cd ..

# Start with PM2
pm2 start ecosystem.config.js

# Save PM2 process list for auto-restart on reboot
pm2 save
pm2 startup
```

### Option B: Docker (containerized)

```bash
docker compose build --no-cache
docker compose up -d
```

### Check status

```bash
# PM2
pm2 status
pm2 logs --lines=50

# Docker
docker compose ps
docker compose logs --tail=50
```

### Stop / Restart

```bash
# PM2
pm2 restart suny-server

# Docker
docker compose down
```

### Update to a new version

```bash
git pull
npm install

# PM2
pm2 restart suny-server

# Docker
docker compose build --no-cache
docker compose up -d
```

---

## 4. SSL/TLS with Let's Encrypt

The `nginx.conf` expects certificates at:
```
/etc/letsencrypt/live/suny.example.com/fullchain.pem
/etc/letsencrypt/live/suny.example.com/privkey.pem
```

### Install certbot and get certificates

```bash
sudo apt install -y certbot
sudo certbot certonly --standalone -d suny.example.com
```

### Auto-renewal

Certbot installs a systemd timer automatically. Test it:

```bash
sudo certbot renew --dry-run
```

### Update nginx.conf

Replace `SUNy.technodel.tech` with your domain in `nginx.conf`.  
The nginx reverse proxy forwards to `http://localhost:3500` (the default SUNy port):

| Line | Change |
|------|--------|
| `server_name` | `SUNy.technodel.tech` → `suny.example.com` |
| `ssl_certificate` | Update path to your domain |
| `ssl_certificate_key` | Update path to your domain |

Then reload nginx:

```bash
sudo nginx -s reload
```

---

## 5. Verify Deployment

### Health check

```bash
curl https://suny.example.com/api/health
```

Expected response:
```json
{
  "status": "ok",
  "uptime": 123.45,
  "db": "connected",
  "timestamp": "2026-05-16T12:00:00.000Z",
  "version": "3.0"
}
```

### Feature flags

```bash
curl https://suny.example.com/api/feature-flags
```

### WebSocket test

The WebSocket endpoint is available at `wss://suny.example.com/ws`.  
Nginx is configured with long timeouts (86400s) for WebSocket connections.

### Docker health check

```bash
docker inspect --format='{{json .State.Health}}' suny
```

---

## 6. Monitoring & Logs

### View logs

```bash
# All logs
docker compose logs --tail=100 -f

# Specific service
docker compose logs suny --tail=50 -f
```

### Restart policy

The compose file sets `restart: unless-stopped`. The container restarts automatically on:
- Crash
- Host reboot
- Docker daemon restart

### Health check

Docker health check runs every 30s (`GET /api/health`). After 3 failures the container is marked unhealthy but keeps running (no auto-kill).

---

## 7. Backup & Restore

### Backup SQLite database

```bash
# Locate the volume
docker volume inspect suny_suny_data

# Backup while running (SQLite WAL mode allows concurrent reads)
docker run --rm -v suny_suny_data:/data -v $(pwd):/backup alpine \
  cp /data/suny.db /backup/suny-$(date +%Y%m%d-%H%M%S).db
```

### Restore

```bash
docker compose down
docker run --rm -v suny_suny_data:/data -v $(pwd):/backup alpine \
  sh -c "cp /backup/suny-restore.db /data/suny.db"
docker compose up -d
```

---

## 8. Rollback Procedure

### Option A: Roll back to previous Docker image

```bash
# List tagged images
docker images suny-suny

# Tag the previous working version
docker tag suny-suny:<previous-tag> suny-suny:latest

# Re-deploy
docker compose up -d
```

### Option B: Roll back to previous git commit

```bash
cd /opt/suny
git log --oneline -10
git checkout <previous-working-commit-hash>
docker compose build --no-cache
docker compose up -d
```

### Option C: Restore database from backup

If a bad deployment corrupted data:

```bash
docker compose down
# Restore from backup (see section 7)
docker compose up -d
```

### Rollback checklist

1. Stop the current container: `docker compose down`
2. Revert code or image
3. Restore DB backup if needed
4. Start: `docker compose up -d`
5. Verify: `curl /api/health`
6. Test a basic user flow

---

## 9. Common Issues

### Issue: Container exits immediately

Check logs:

```bash
docker compose logs suny
```

Common causes:
- `SUNY_DB_PATH` directory doesn't exist — ensure the volume is mounted
- Port conflict — change `SUNY_PORT`
- Missing `.env` file — copy from `.env.example`

### Issue: WebSocket disconnects under long responses

Nginx is configured with 86400s (24h) timeout for WebSocket paths.  
Verify in nginx.conf that `proxy_read_timeout 86400` is set inside the `location ~ ^/(ws|bridge)` block.

### Issue: SSL certificate not found

Ensure certbot paths in nginx.conf match your actual certificate location:

```bash
ls /etc/letsencrypt/live/suny.example.com/
```

### Issue: CORS errors in browser

Check `SUNY_ALLOWED_ORIGIN` in `.env` — it must match your frontend URL exactly (including protocol).

### Issue: Database locked / SQLITE_BUSY

SQLite uses WAL mode (set automatically). If you see lock errors:
- Ensure only one container writes to the database
- Check that no manual process has an open handle on the file

### Issue: Docker health check fails

```bash
# Test manually from inside the container
docker exec suny wget -qO- http://localhost:3500/api/health
```

If this fails, the server isn't responding. Check:
- Is the server listening on the right port?
- Are all env vars correct?
- Did the database migrate successfully?

### Issue: SSH connection timeout

The VPS SSH port is 2222, not the default 22:
```bash
ssh -p 2222 user@suny.technodel.tech
```

### Issue: PM2 fails with tsx not found

Ensure tsx is installed globally or in the project:
```bash
npm install -g tsx
# or
npx tsx src/server/index.ts
```
