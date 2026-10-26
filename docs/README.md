---
title: Documentation
description: Guides for installing and operating the Uiable server dashboard.
order: 0
slug: index
---

# Uiable documentation

Uiable is a lightweight self-hosted Linux server dashboard (Docker). Pair it with **[Uiable Connect](https://github.com/AlfieeLawrence/Uiable-Connect)** on desktop/mobile for SSH, SFTP, tunnels, and one-click install/update of this dashboard.

**Download:** [GitHub Releases](https://github.com/AlfieeLawrence/uiable/releases) (`uiable.zip` / `uiable.tar.gz`)  
**Source:** [AlfieeLawrence/uiable](https://github.com/AlfieeLawrence/uiable)  
**Companion docs:** [Uiable Connect docs](https://github.com/AlfieeLawrence/Uiable-Connect/tree/main/docs)

## Start here

1. [Getting started](getting-started.md)
2. [Install](install.md)
3. [Updates and releases](updates.md)
4. Day-to-day: [Metrics](metrics.md) · [Alerts](alerts.md) · [Backups](backups.md) · [Storage](storage.md) · [WireGuard](wireguard.md) · [Integrity](integrity.md)
5. [Security and secrets](security.md)
6. [Uiable Connect](connect.md)
7. [Troubleshooting](troubleshooting.md)

## For website ingest

Pages are one topic per Markdown file with YAML frontmatter (`title`, `description`, `order`, `slug`). A machine-readable index lives in [`manifest.json`](manifest.json).

Stable paths under `/docs/` are intended to stay fetchable from the marketing site (raw GitHub or a docs build step). Cross-link field: `companion` in the manifest points at Connect.
