---
title: Updates and releases
description: GitHub Releases, self-updater, checksums, and rollback.
order: 11
slug: updates
---

# Updates and releases

## GitHub Releases

Tag pushes (`v*`) run [.github/workflows/release.yml](../.github/workflows/release.yml):

- `uiable.zip` / `uiable.tar.gz` (and versioned copies) with top-level `uiable/`
- `checksums.txt` (sha256)
- Multi-arch image on GHCR: `ghcr.io/alfieelawrence/uiable:<version>` and `:latest`

## On the server

```bash
cd /opt/uiable
sudo ./install.sh       # foreground; rebuilds uiable:local
```

Or use **Updates → Uiable** in the dashboard (self-updater): pins a release, verifies sha256 when published, health-checks, keeps a backup tree for **Rollback**.

## From Connect

Connect can detect Uiable over SSH and offer Install / Update. See [Connect’s install-uiable guide](https://github.com/AlfieeLawrence/Uiable-Connect/blob/main/docs/install-uiable.md).
