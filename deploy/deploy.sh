#!/usr/bin/env bash
# Deploys the latest main branch. Run on the server as the "scoretracker" user
# from /srv/score-tracker:  ./deploy/deploy.sh
#
# Restarting needs sudo for systemctl; allow just that command for this user:
#   echo 'scoretracker ALL=(root) NOPASSWD: /usr/bin/systemctl restart score-tracker' | sudo tee /etc/sudoers.d/score-tracker
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull --ff-only origin main

echo "==> Installing server dependencies"
# Includes devDependencies: drizzle-kit is needed to run migrations
npm ci

echo "==> Building the React app"
npm --prefix client ci
npm --prefix client run build

echo "==> Applying database migrations"
npm run db:migrate

echo "==> Restarting (graceful: WebSocket clients reconnect on their own)"
sudo systemctl restart score-tracker

echo "==> Waiting for the health check"
for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:8000/health > /dev/null; then
        curl -sS http://127.0.0.1:8000/health
        echo
        echo "==> Deployed"
        exit 0
    fi
    sleep 1
done

echo "!! Health check failed after 30s. Recent logs:" >&2
journalctl -u score-tracker -n 50 --no-pager >&2
exit 1
