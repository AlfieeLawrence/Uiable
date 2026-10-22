# Uiable

A lightweight, self-hosted dashboard for any Linux server, shipped as one Docker container.
Umbrel-style look (app grid, rounded cards, dock, dark/light modes) with Termius-style tools
(SFTP file manager, tabbed web terminal) plus an app store, alerts, roles, 2FA and more.

> **Companion desktop app:** [Uiable Connect](https://github.com/AlfieeLawrence/uiable-connect) for Windows and macOS saves your servers and logins, opens the SSH tunnel to this dashboard in one click, and gives you a terminal, file manager and port forwards even on servers without Uiable.

**Download:** grab `uiable.zip` from the [latest release](https://github.com/AlfieeLawrence/uiable/releases/latest).

## Features

| App | Who | What |
| --- | --- | --- |
| **Home** | any | Customisable grid (widgets, app shortcuts, containers, scripts, folders, links) with per-user layout, edit mode, and customisable dock. **All apps** launcher with search. |
| **Dashboard** | any | Live CPU / RAM / disk / network / temps / uptime over websocket (only while a client is connected). Storage card uses the largest real disk (or a Settings-chosen primary mount) — important on Umbrel/rugix where `/` and config are tiny. |
| **Files** | viewer+ | Browse the host, drag-and-drop upload (files and folders), download, rename, delete, chmod, text editor. Dotfiles via "Hidden files". Saves keep owner/group/mode and preserve symlinks. |
| **App store** | viewer / op+ | One-click install of Jellyfin, Pi-hole, Nextcloud, Home Assistant, Uptime Kuma, Vaultwarden, Portainer, Syncthing as compose stacks. Configurable ports/volumes; warns on port 80 conflicts (Umbrel). |
| **Stacks** | viewer / op+ | List, create, edit YAML, validate, up / down / pull, logs. Includes app-store stacks. |
| **Docker** | viewer / op+ | Containers, images, volumes: start/stop/restart/remove, logs, stats, prune. |
| **Logs** | any | Host journal (`journalctl`, `/var/log` fallback) and container logs, search/filter, live follow. |
| **Terminal** | admin | Real host shell via nsenter + xterm.js. Tabs, "open as user". |
| **Processes / Services** | viewer / op+ | Top-style process list with kill; systemd start/stop/restart/enable/disable. |
| **Storage** | viewer / admin | Disks & partitions, SMART health, mount/unmount (+ optional fstab), format with typed confirm, folder usage drill-down. |
| **Net tools** | viewer / op+ | Ping, traceroute, DNS, Cloudflare speed test, LAN neighbours, optional /24 ping sweep. |
| **Updates** | admin | Host package updates (apt/dnf/apk) and container image updates by digest compare; one-click apply (compose recreate when applicable). |
| **Firewall** | admin | UFW (preferred) or iptables; list rules & listening ports. Refuses to block SSH (22) or the Uiable port. |
| **Scheduled** | admin | User crontabs and `/etc/cron.d`, presets, next-run preview. |
| **Proxy** | admin | Optional Caddy container for local HTTPS domains with internal CA + root cert download. Alternate 80/443 ports. **Caddy only runs when you enable it.** |
| **Audit log** | admin | Who did what (user, action, IP, time), searchable, retention (default 90 days). |
| **Settings** | varies | Wi-Fi / network, hostname, timezone, Linux users, dashboard accounts & roles, **2FA (TOTP)**, **alerts** (SMTP + Telegram), theme, power. |

### Roles (enforced server-side)

- **admin** — full access (users, settings, terminal, power, firewall, updates, proxy, audit, alerts).
- **operator** — Docker, services, stacks, app store install, files write, net tools. No users / settings / terminal / power.
- **viewer** — read-only (dashboard, lists, logs, downloads).

### Auth

First-run admin setup, bcrypt passwords, optional per-user TOTP with QR enrolment and backup codes,
HttpOnly `SameSite=Strict` cookies, CSRF tokens, same-origin checks, login rate limiting.
Accounts, sessions, layouts and settings live in the Docker volume named exactly **`uiable-data`** (fixed name, not tied to the folder or compose project), so deleting or moving the app folder never touches your data. On first start with an empty volume, Uiable copies data from an older project-scoped volume (`uiable_uiable-data`, `<folder>_uiable-data`) automatically and writes `MIGRATED.json` noting the source; the old volume is left in place.

---

## Install

### Option A: installer (recommended)

```bash
cd ~/uiable
sudo ./install.sh                 # 127.0.0.1:8080
sudo ./install.sh --port 9090
sudo ./install.sh --uninstall
```

- Installs Docker via get.docker.com **only if Docker is missing**.
- On **Umbrel OS** (detected via `/etc/umbrel-release`, `/home/umbrel/umbrel`, etc.) it never installs Docker and uses the existing daemon.
- Does **not** require `unzip` (falls back to busybox or python3; `.tar.gz` URLs work too).
- Copies the app to `/opt/uiable`, writes `.env`, runs `docker compose up -d --build`.

One-liner (hosted archive):

```bash
curl -fsSL https://your-host/uiable/install.sh | sudo UIABLE_URL=https://your-host/uiable.tar.gz sh
```

### Option B: Compose by hand

```bash
docker compose up -d --build
```

### Option C: bare metal (no Docker)

```bash
npm ci --omit=dev
sudo UIABLE_DATA_DIR=/var/lib/uiable node server/index.js
```

## Connect

```bash
ssh -L 8080:localhost:8080 you@your-server
```

Open **http://localhost:8080** and create the admin account.

## Port / bind

`.env` next to `docker-compose.yml` (see `.env.example`):

```ini
UIABLE_PORT=8080
UIABLE_BIND=127.0.0.1
```

Because of `network_mode: host`, these are the host's addresses. Keep the bind on localhost unless you put it behind a firewall, VPN or HTTPS proxy. Set `UIABLE_SECURE_COOKIE=1` when serving over HTTPS.

Other env vars: `UIABLE_SESSION_HOURS`, `UIABLE_STATS_INTERVAL_MS` (default 3000), `UIABLE_AUDIT_DAYS` (default 90), `UIABLE_MAX_UPLOAD`, `DOCKER_SOCK`.

## Security trade-offs

Uiable is effectively **root on the host** (`privileged`, `pid: host`, `uts: host`, `network_mode: host`, host FS at `/host`, Docker socket, `/dev`). Anyone who can sign in with a sufficiently privileged role can do almost anything. The model is: **localhost bind + SSH tunnel + strong password (+ 2FA)**. Operator and viewer roles limit the blast radius for day-to-day accounts.

## Lightweight by design

* **Measured** (x86_64, full feature set): idle **~63 MB RSS / 0.000 % CPU** (re-measured after home-layout feature); live home ~same with stats websocket only while visible. Compose caps at **256 MB RAM** and 1 CPU; Node `--max-old-space-size=96`.
* No work when idle: no timers, polling or child processes with zero clients. Stats stream only while a dashboard websocket is open (every 3 s); the browser pauses it when the tab is hidden.
* Alerts tick every ~60 s **only if enabled and a channel is configured**. Update checks run on demand (or when you click Check); no always-on update loop.
* Caddy is **not** started unless you enable the Proxy app.
* Hot paths read `/proc` / `/sys` / `statfs` directly (no `ps`/`df`/`hostname` spawns). Page JS is lazy-loaded per app. No frontend build, no blur/backdrop-filter.
* Runtime deps: express, ws, bcryptjs, busboy, node-pty, js-yaml, qrcode, nodemailer (+ xterm in the browser).

## Notes

* Systemd hosts get the best Services / hostname / timezone experience; fallbacks exist.
* Wi-Fi needs NetworkManager (`nmcli`).
* SMART needs `smartmontools` on the host; traceroute needs `traceroute` or `tracepath`.
* App-store stacks live under `$UIABLE_DATA_DIR/stacks/`.
* Absolute symlinks in the file manager resolve to the target; the editor opens text files up to 5 MB.


## Update

The zip contains a top-level `uiable/` folder. Always start with `docker compose up -d --build` so the image (`uiable:local`) is rebuilt from the source you just unpacked; the running version and build date are shown in **Settings → About** and at the bottom of the home screen.


From a normal SSH session (foreground), in the install folder:

```bash
cd /opt/uiable          # or wherever you keep the release
sudo -v                 # refresh sudo credentials BEFORE any backgrounded step
sudo ./install.sh       # rebuilds and restarts the container
```

Updating by hand from any folder is also safe, because the data volume name is fixed:

```bash
docker rm -f uiable; rm -rf ~/uiable; unzip uiable.zip -d ~    # creates ~/uiable
cd ~/uiable && docker compose up -d --build     # rebuilds image uiable:local from source, reuses the uiable-data volume
```

Never run `docker compose down -v` or `docker volume rm uiable-data` unless you want to wipe all accounts.

### Recovering data from an older volume

```bash
docker volume ls | grep uiable                      # e.g. uiable_uiable-data, uiable-data
docker run --rm -v uiable_uiable-data:/d busybox ls -l /d   # the one with config.json is your old data
docker stop uiable
docker run --rm -v uiable_uiable-data:/from:ro -v uiable-data:/to busybox sh -c 'cp -a /from/. /to/'
docker start uiable
```

Always run `sudo -v` first if anything in the update will be backgrounded, or just run `install.sh` in the **foreground** from a normal SSH session so the sudo password prompt is not lost.

## Layout

```
server/         Express API, auth/roles/2FA, feature modules
server/apps/    App-store catalog + installer
public/         Vanilla JS frontend (lazy-loaded per app)
docker-compose.yml  mem_limit 256m, cpus 1.0, privileged host access
install.sh      Docker-aware installer (Umbrel-friendly)
```

## Changelog

- **1.1.3** - Removed the non-working "Done" button from the script run/output dialog (Close stays). Long script names in the Scripts list and editor header now truncate with "…" and scroll on hover (the list row was overflowing its card).
- **1.1.2** - Scripts and terminals run outside the dashboard 256M memory limit (systemd-run scope, else cgroup move), so big builds like `pnpm build` are no longer "Killed". Scripts now run like an SSH session: your login shell with ~/.profile, ~/.bash_profile and ~/.bashrc loaded (nvm, pnpm, ~/.local/bin, aliases).
