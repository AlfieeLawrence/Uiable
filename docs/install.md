---
title: Install
description: Installer, Compose, bare metal, ports, and Umbrel notes.
order: 10
slug: install
---

# Install

## Recommended: release zip + installer

```bash
# from https://github.com/AlfieeLawrence/uiable/releases/latest
unzip uiable.zip -d ~
cd ~/uiable
sudo ./install.sh                 # 127.0.0.1:8080
sudo ./install.sh --port 9090
```

- Installs Docker via get.docker.com **only if missing**
- On **Umbrel OS** never reinstalls Docker; uses the existing daemon
- Copies to `/opt/uiable`, writes `.env`, runs `docker compose up -d --build`
- Data lives in volume **`uiable-data`** (fixed name)

One-liner with a hosted archive:

```bash
curl -fsSL https://github.com/AlfieeLawrence/uiable/releases/latest/download/uiable.tar.gz | tar -xz
cd uiable && sudo ./install.sh
```

## Compose by hand

```bash
docker compose up -d --build
```

## Bare metal (no Docker)

```bash
npm ci --omit=dev
sudo UIABLE_DATA_DIR=/var/lib/uiable node server/index.js
```

## Port / bind

`.env` next to `docker-compose.yml` (see `.env.example`):

```ini
UIABLE_PORT=8080
UIABLE_BIND=127.0.0.1
```

Keep bind on localhost unless you put it behind a firewall, VPN, or HTTPS proxy. Set `UIABLE_SECURE_COOKIE=1` when serving over HTTPS.

## Security model

Uiable is effectively **root on the host** (`privileged`, host PID/net, Docker socket, `/host`). Prefer **localhost + SSH tunnel (or Connect) + strong password + 2FA**.
