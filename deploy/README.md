# Deploying Score Tracker

One Ubuntu/Debian VPS: **Nginx** serves the React app and proxies the API and
WebSocket to **Node**, which **systemd** keeps running.

```
browser ──HTTPS──► Nginx :443 ──► /           client/dist (static files)
                              ├──► /matches    ┐
                              ├──► /health     ├─► Node 127.0.0.1:8000 (systemd)
                              └──► /ws         ┘        └─► Postgres 127.0.0.1:5432
```

Postgres runs on the same server and only listens on 127.0.0.1, so it isn't
reachable from the internet.

| File | Goes to |
|---|---|
| `score-tracker.service` | `/etc/systemd/system/score-tracker.service` |
| `nginx/score-tracker.conf` | `/etc/nginx/sites-available/score-tracker` |
| `deploy.sh` | run from the repo on the server for every deploy |

## One-time setup

```bash
# 1. Node 20+ (system-wide, so systemd finds it at /usr/bin/node), Nginx, certbot
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx git

# 2. A user that only runs this app, and the app folder
sudo useradd --system --create-home --shell /bin/bash scoretracker
sudo mkdir -p /srv/score-tracker && sudo chown scoretracker: /srv/score-tracker
sudo -u scoretracker git clone https://github.com/Vignesh-02/score-tracker.git /srv/score-tracker

# 3. Secrets: copy your .env to the server (never commit it), readable only by the app.
#    Leave DATABASE_URL and DATABASE_URL_POOLED out; step 4 adds them.
sudo -u scoretracker nano /srv/score-tracker/.env     # paste values
sudo chmod 600 /srv/score-tracker/.env
sudo -u scoretracker mkdir -p /srv/score-tracker/apminsightdata

# 4. Postgres, with a database and login for the app. This writes the
#    connection string (with a random password) straight into .env.
#    Run each sudo line on its own: pasting several lines at once can make
#    sudo swallow the ones after it.
sudo apt install -y postgresql
PGPASS=$(openssl rand -hex 24)
sudo -u postgres psql -c "CREATE ROLE scoretracker LOGIN PASSWORD '$PGPASS';"
sudo -u postgres createdb -O scoretracker scoretracker
URL="postgresql://scoretracker:$PGPASS@127.0.0.1:5432/scoretracker"
printf 'DATABASE_URL=%s\nDATABASE_URL_POOLED=%s\n' "$URL" "$URL" | sudo tee -a /srv/score-tracker/.env > /dev/null
psql "$URL" -Atc "select 'connected'"    # should print: connected

# 5. Service (edit paths/user first if yours differ)
sudo cp /srv/score-tracker/deploy/score-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable score-tracker

# 6. Allow deploy.sh to restart the service without a password
echo 'scoretracker ALL=(root) NOPASSWD: /usr/bin/systemctl restart score-tracker' \
  | sudo tee /etc/sudoers.d/score-tracker

# 7. First deploy: installs, builds the client, migrates, starts, checks /health
sudo -u scoretracker /srv/score-tracker/deploy/deploy.sh

# 8. HTTPS certificate first (the site config below refers to its files).
#    All four names need DNS A records pointing at this server (see DNS below).
#    khelscores.com must be the first -d: the certificate folder is named after it.
sudo certbot certonly --nginx \
  -d khelscores.com -d www.khelscores.com \
  -d khelscores.in -d www.khelscores.in

# 9. Nginx site
sudo cp /srv/score-tracker/deploy/nginx/score-tracker.conf /etc/nginx/sites-available/score-tracker
sudo ln -s /etc/nginx/sites-available/score-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 10. Firewall: only SSH and web traffic; port 8000 stays private
sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable
```

## DNS

The site is served at **https://khelscores.com**; the other names redirect
there. At each registrar, add these records (value = the VPS's public IP):

| Domain | Type | Name | Value |
|---|---|---|---|
| khelscores.com | A | `@` | VPS IP |
| khelscores.com | A | `www` | VPS IP |
| khelscores.in | A | `@` | VPS IP |
| khelscores.in | A | `www` | VPS IP |

Before step 8, check each one resolves: `dig +short khelscores.in` should
print the VPS IP.

In `.env` on the server, set `ARCJET_ENV=production` (or remove it) so Arcjet
uses real visitor IPs. Server-specific settings (`HOST`, `PORT`,
`TRUSTED_PROXIES`, `NODE_ENV`) are in the service file and override `.env`.

## Every deploy

```bash
sudo -u scoretracker /srv/score-tracker/deploy/deploy.sh
```

If a deploy changes `deploy/score-tracker.service`, install it again first:

```bash
sudo cp /srv/score-tracker/deploy/score-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
```

Restarting is graceful: in-flight requests finish, WebSocket clients get
"going away" (1001) and reconnect within a few seconds.

## Monitoring

- **Uptime:** point a monitor (UptimeRobot, Better Stack, Site24x7) at
  `https://khelscores.com/health`. It returns 503 when the database is
  unreachable; `"status": "degraded"` (still 200) means football-data.org
  syncing is behind.
- **Logs:** `journalctl -u score-tracker -f` (live), or `-n 200` for recent.
- **Crashes:** systemd restarts the app 2s after it exits. To see restarts:
  `systemctl status score-tracker` and `journalctl -u score-tracker | grep -i "shutting down\|uncaught"`.

## Backups

Postgres is backed up every night at 03:15 server time (UTC), one file per
weekday, so the last 7 days are kept. Set it up once:

```bash
sudo mkdir -p /var/backups/score-tracker && sudo chown postgres: /var/backups/score-tracker
sudo tee /etc/cron.d/score-tracker-backup > /dev/null <<'CRON'
15 3 * * * postgres pg_dump -Fc scoretracker > /var/backups/score-tracker/scoretracker-$(date +\%a).dump
CRON
```

- **Check:** `ls -lh /var/backups/score-tracker/` should show a file for each
  night since setup.
- **Restore** (replaces the current data; stop the app first):
  ```bash
  sudo systemctl stop score-tracker
  sudo -u postgres pg_restore --clean --if-exists -d scoretracker /var/backups/score-tracker/scoretracker-Mon.dump
  sudo systemctl start score-tracker
  ```

The backups are on the same server as the database, so they protect against
mistakes, not against losing the server. For that, copy them somewhere else
from time to time, e.g. `scp root@SERVER:/var/backups/score-tracker/*.dump .`
