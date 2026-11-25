# Uiable

A lightweight, self-hosted dashboard for any Linux server, shipped as one Docker container.
Umbrel-style look (app grid, rounded cards, dock, dark/light modes) with Termius-style tools
(SFTP file manager, tabbed web terminal) plus an app store, alerts, roles, 2FA and more.

> **Companion desktop app:** [Uiable Connect](https://github.com/AlfieeLawrence/Uiable-Connect) for Windows and macOS saves your servers and logins, opens the SSH tunnel to this dashboard in one click, and gives you a terminal, file manager and port forwards even on servers without Uiable.

**Download:** grab `uiable.zip` from the [latest release](https://github.com/AlfieeLawrence/uiable/releases/latest).

**Docs (website-ready):** see [`docs/`](docs/) — start at [`docs/README.md`](docs/README.md); machine index [`docs/manifest.json`](docs/manifest.json).

## Features

| App | Who | What |
| --- | --- | --- |
| **Home** | any | Customisable grid (widgets, app shortcuts, containers, scripts, folders, links) with per-user layout, edit mode, and customisable dock. **All apps** launcher with search. Click a stat widget for a full-detail view (1h / 6h / 24h / 7d history, min / avg / max, breakdown). Setup checklist and a short first-run tour. |
| **Dashboard** | any | Live CPU / RAM / disk / network / temps / uptime over websocket (only while a client is connected). Every graph expands to a large view with stored history ranges, per-core / per-disk / per-interface breakdown and hover tooltips. Storage card uses the largest real disk (or a Settings-chosen primary mount) — important on Umbrel/rugix where `/` and config are tiny. |
| **Files** | viewer+ | Browse the host, drag-and-drop upload (files and folders), download, rename, delete, chmod, text editor. Dotfiles via "Hidden files". **Use sudo** + **Save as sudo** for root-only paths (session sudo password). Normal saves keep owner/group/mode and preserve symlinks. |
| **App store** | viewer / op+ | One-click install of Jellyfin, Pi-hole, Nextcloud, Home Assistant, Uptime Kuma, Vaultwarden, Portainer, Syncthing as compose stacks. Configurable ports/volumes; warns on port 80 conflicts (Umbrel). **Can be turned off** in Settings → General → Features (hidden everywhere and blocked server-side; on by default). |
| **Stacks** | viewer / op+ | List, create, edit YAML, validate, up / down / pull, logs. Includes app-store stacks. |
| **Docker** | viewer / op+ | Containers, images, volumes: start/stop/restart (with Undo), remove/prune (typed confirmation), health dots and live sparklines. Per-container page: live stats graphs, logs (follow + search), env vars (secrets masked), ports, mounts, networks, one-click **Redeploy** with the latest image. |
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
| **Everywhere** | any | **Ctrl/⌘ K** command palette (pages, containers, settings, actions), keyboard shortcuts (**?**), notifications bell (audit, alerts, failed jobs, updates), skeleton loading and empty states, phone tab bar, AA contrast on every theme, reduced-motion support. See [docs/interface.md](docs/interface.md). |
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
* Network management prefers NetworkManager (`nmcli`). Without it, Uiable falls back to iwd (`iwctl`) or wpa_supplicant (`wpa_cli`) for Wi-Fi, netplan or systemd-networkd for static/DHCP IP settings, and `ip` for bringing interfaces up/down; the Network page shows which backend is active and what isn't supported. On hosts that can take packages (apt, dnf, yum, pacman, zypper, apk) there is a one-click **Install NetworkManager** button (Wi-Fi only by default, so wired interfaces stay with your existing config). It's hidden on appliance/immutable hosts such as umbrelOS.
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

- **1.2.8** - Linking a dashboard account to a Linux user now needs that Linux user's password: pick the user, type its Linux password, **Verify & link**. Checked against the host's `/etc/shadow` with the host's own crypt (yescrypt `$y$`, sha512 `$6$`, sha256 `$5$`, …; PAM `unix_chkpwd` fallback), password on stdin only, never stored/logged/returned. Wrong password shows an inline error and saves nothing; changing the link asks again; admins linking other accounts need the target Linux user's password too. Locked, passwordless and expired accounts are refused. 5 wrong tries per user + Linux account in 15 min, then a lockout (429). Attempts are audit-logged (`account.linux-verify`) with the password redacted. The default Linux user is now pre-selected in the first-login dialog instead of being linked automatically. See docs/security.md.
  - **Interface (1.2.8):** **Ctrl/⌘ K command palette** (pages, containers with start/stop/restart, settings, actions) and keyboard shortcuts with a **?** help sheet (`g h` home, `g d` docker, `n` notifications, `t` theme, `/` search…). New design tokens (spacing, radii, type scale, focus ring, touch size) shared by every theme; unified buttons, inputs, dialogs and Connect-style toasts (bottom-right, ✕, action button, countdown). **Skeleton** loading and friendly **empty states** with next-step buttons. **Stop / restart wait 5 s with Undo** instead of a confirm dialog (still runs if you close the page); **removing containers, images, volumes, stacks and pruning need the name typed**. **Phones:** bottom tab bar (Home, Apps, Docker, Search, Activity), 44 px touch targets, swipe-down to close dialogs, no sideways scrolling. **Live status:** container health dots and CPU sparklines in the Docker list, a health dot on the Docker dock/tab icon and a running-containers pill in the top bar. **Notifications bell**: recent audit actions, fired alerts, failed jobs and update notices, each linking to its source; unread badge. **Accessibility:** skip link, visible focus rings, focus-trapped dialogs, ARIA labels on icon buttons, live regions for toasts, reduced-motion support, WCAG AA contrast on all five themes (adjusted muted/accent colours; `test/contrast.test.js`). **Onboarding:** skippable first-run tour (re-run from Settings → Appearance) and a setup checklist (2FA, HTTPS, backups, alerts, update checks, Linux account link). **Container page** (`#/docker/c/<name>`): live CPU / memory / network / disk graphs, logs with follow + search + save, environment with secrets masked (admins can reveal, audit-logged `docker.env.reveal`), ports, mounts, networks, and **Redeploy** (pull latest + recreate with the same settings; compose services via `docker compose up -d --force-recreate`; rolls back if recreate fails). **Dashboard stat details:** clicking a CPU / memory / disk / network / temperature / GPU graph on Home or Dashboard opens a large view with Live / 1h / 6h / 24h / 7d from stored metrics history (`GET /api/metrics/range`), current / average / min / max, per-core / per-device breakdown and hover tooltips.
  - **App store switch:** Settings → General → Features → App store. When off it is hidden from the dock, Home, All apps, the palette and the dashboard, and `/api/apps/*` returns 404 `feature-off` server-side. **On by default**, including for existing installs (missing setting = on). New `GET/PUT /api/features` (PUT admin-only, audit `settings.features`).
  - **Fixes:** network history in Metrics was always empty (sampler read a field that never existed) — now recorded, plus disk read/write rates. `GET /api/docker/containers/:id/inspect` no longer returns secret env values to non-admins. Store and Home icons that failed to load now hide properly (the inline `onerror` was blocked by the CSP).
- **1.2.7** - Wi-Fi on cards without PMF (802.11w), e.g. the Intel Centrino Advanced-N 6205 (iwldvm): these associated and then dropped every time with "Failed to configure IGTK" on WPA2/WPA3-mixed networks, because wpa_supplicant enabled PMF and the driver can't install the management-frame key. Uiable now detects this up front (`iw phy` ciphers: no BIP-CMAC-128 / 00-0f-ac:6, or the iwldvm driver when `iw` is missing) or from the log, remembers it per adapter, and joins like NetworkManager does: WPA2-PSK only with PMF off. On netplan + networkd hosts (netplan has no PMF setting) the adapter switches to Uiable's own `uiable-wpa@<dev>` wpa_supplicant service plus a systemd-networkd `.network` file (IP settings and Wired / Wi-Fi priority carried over, persists across reboots, rolled back if it doesn't connect), and its netplan Wi-Fi entry is removed so only one supplicant runs. wpa_cli hosts get `key_mgmt=WPA-PSK ieee80211w=0`, iwd gets `ManagementFrameProtection=0`, and NetworkManager is left to negotiate as before and only falls back to `wifi-sec.pmf 1` if the driver fails. WPA3-only networks on such cards show a clear message (set the router to WPA2/WPA3 mixed with PMF optional, or use a newer card). NetworkManager is recommended for these cards. Diagnostics show PMF support, the `iw phy` cipher list, the Uiable supplicant status, and how to install `iw`/`rfkill` when they're missing. Installing NetworkManager retires `uiable-wpa@<dev>`.
- **1.2.6** - Wi-Fi: WPA3 (SAE) networks now work on netplan + wpa_supplicant and wpa_cli hosts (scans detect SAE; WPA3-only networks get `key-management: sae` with PMF, WPA2/WPA3 transition networks use WPA2-PSK and retry once with SAE). Wi-Fi joined through netplan is pinned to `renderer: networkd`, and leftover NetworkManager files (`/etc/netplan/90-NM-*.yaml`, Uiable's NM conf.d drop-in) are moved to `/etc/netplan/uiable-disabled/` after NetworkManager is removed, so they can't take the adapter. "Wrong Wi-Fi password" is only shown on explicit evidence (WRONG_KEY / "pre-shared key may be incorrect" / NM or iwd saying so) and not when two Wi-Fi managers fight over the adapter; other failures show the detected security type and the log lines from this attempt only (passwords removed). The wait is now up to 60s. New **Diagnostics** button on the Wi-Fi card (rfkill, iw, nmcli, service states, netplan, NM conf.d, journal; scrubbed, with Copy), a **Show password** toggle, and connect errors open a dialog with the log. After **Install NetworkManager**, Uiable hands the Wi-Fi to NM (drops its own netplan Wi-Fi entry, radio on, `nmcli device set <dev> managed yes`). Dialogs now lock the page behind them (no background scrolling, including iOS).
- **1.2.5** - Network: Wi-Fi connect is verified (only reports success once the interface has an IP, otherwise shows the real reason), new **Connection** panel (which link is in use, IP/gateway/DNS per interface), **Wired / Wi-Fi** switch (prefer wired with Wi-Fi failover, prefer Wi-Fi, wired only, Wi-Fi only) and auto-rollback: risky changes revert by themselves after 60s unless you confirm. **Connect** on a Wi-Fi interface brings up its saved network (`nmcli connection up`, iwd known network, wpa_supplicant/netplan saved network) or opens a network picker, instead of failing with "A 'wireless' setting is required". The page re-detects the backend after **Install NetworkManager** finishes. Full UI polish: install/job logs grow to fill the dialog (live status, follow toggle, no mid-word breaks), wide tables scroll inside their card instead of stretching the page on phones/tablets, Settings no longer overflows below 1100px, modals fit small screens (long titles, wrapping buttons, `dvh`), resizable script/stack/ping output, 16px inputs on iOS, fixed the Storage RAID/ZFS panel crash.
- **1.2.4** - Network page works without NetworkManager: falls back to iwd (`iwctl`) or wpa_supplicant (`wpa_cli`) for Wi-Fi, netplan or systemd-networkd for static/DHCP IP settings (new **IP settings…** per interface), and `ip link` for up/down, with a backend card showing what is active and unsupported. One-click **Install NetworkManager** (apt/dnf/yum/pacman/zypper/apk, live log; Wi-Fi-only by default so wired config stays unmanaged), hidden on umbrelOS/immutable hosts. Wi-Fi passwords never logged; wpa_supplicant gets a derived PSK, not the plaintext. Host PATH includes `/snap/bin`; Podman detected as a container. `npm test` unit tests.
- **1.2.3** - Fix boot crash: /api/health registered on `api` before the router was declared (TDZ `ReferenceError` / Restarting (1)). Route is now on `app` as public liveness.
- **1.2.0** - Metrics history (SQLite, 7-day default retention), themes, MIT LICENSE, audit secret redaction, encrypted secrets (OpenSSL AES-256-CBC PBKDF2), self-updater with checksum/health/rollback, backups/WireGuard/integrity, alerts (webhook/Discord/ntfy + history), API token scopes/expiry, RAID/ZFS safe actions, fail2ban, Podman socket, GPU/cpuTemp stats, GitHub Release CI, structured docs.
- **1.1.3** - Removed the non-working "Done" button from the script run/output dialog (Close stays). Long script names in the Scripts list and editor header now truncate with "…" and scroll on hover (the list row was overflowing its card).
- **1.1.2** - Scripts and terminals run outside the dashboard 256M memory limit (systemd-run scope, else cgroup move), so big builds like `pnpm build` are no longer "Killed". Scripts now run like an SSH session: your login shell with ~/.profile, ~/.bash_profile and ~/.bashrc loaded (nvm, pnpm, ~/.local/bin, aliases).
