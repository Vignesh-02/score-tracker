# Deploying Score Tracker

One Ubuntu/Debian VPS: **Nginx** serves the React app and proxies the API and
WebSocket to **Node**, which **systemd** keeps running.

```
browser ──HTTPS──► Nginx :443 ──► /           client/dist (static files)
                              ├──► /matches    ┐
                              ├──► /health     ├─► Node 127.0.0.1:8000 (systemd)
                              └──► /ws         ┘        └─► Neon Postgres
```

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

# 3. Secrets: copy your .env to the server (never commit it), readable only by the app
sudo -u scoretracker nano /srv/score-tracker/.env     # paste values
sudo chmod 600 /srv/score-tracker/.env
sudo -u scoretracker mkdir -p /srv/score-tracker/apminsightdata

# 4. Service (edit paths/user first if yours differ)
sudo cp /srv/score-tracker/deploy/score-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable score-tracker

# 5. Allow deploy.sh to restart the service without a password
echo 'scoretracker ALL=(root) NOPASSWD: /usr/bin/systemctl restart score-tracker' \
  | sudo tee /etc/sudoers.d/score-tracker

# 6. First deploy: installs, builds the client, migrates, starts, checks /health
sudo -u scoretracker /srv/score-tracker/deploy/deploy.sh

# 7. HTTPS certificate first (the site config below refers to its files).
#    All four names need DNS A records pointing at this server (see DNS below).
#    khelscores.com must be the first -d: the certificate folder is named after it.
sudo certbot certonly --nginx \
  -d khelscores.com -d www.khelscores.com \
  -d khelscores.in -d www.khelscores.in

# 8. Nginx site
sudo cp /srv/score-tracker/deploy/nginx/score-tracker.conf /etc/nginx/sites-available/score-tracker
sudo ln -s /etc/nginx/sites-available/score-tracker /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# 9. Firewall: only SSH and web traffic; port 8000 stays private
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

Before step 7, check each one resolves: `dig +short khelscores.in` should
print the VPS IP.

In `.env` on the server, set `ARCJET_ENV=production` (or remove it) so Arcjet
uses real visitor IPs. Server-specific settings (`HOST`, `PORT`,
`TRUSTED_PROXIES`, `NODE_ENV`) are in the service file and override `.env`.

## Every deploy

```bash
sudo -u scoretracker /srv/score-tracker/deploy/deploy.sh
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
