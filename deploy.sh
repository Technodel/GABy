#!/bin/bash
# SUNy VPS Deploy Script
# Pulls latest code, installs deps, rebuilds, restarts PM2
set -e

REPO_DIR="/var/www/suny"

cd $REPO_DIR
echo "==> Pulling latest changes..."
git pull origin main

echo "==> Installing dependencies..."
npm install --omit=dev

echo "==> Building..."
npm run build

echo "==> Restarting with PM2..."
pm2 restart suny || pm2 start dist/server/index.js --name suny

echo "==> Done! SUNy is live at suny.technodel.tech"
pm2 status
