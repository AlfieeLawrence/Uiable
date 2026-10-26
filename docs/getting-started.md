---
title: Getting started
description: What Uiable is, how it relates to Connect, and your first install.
order: 1
slug: getting-started
---

# Getting started

Uiable runs **on** your Linux server as a privileged Docker container and gives you a browser dashboard: stats, files, Docker/stacks, terminal, firewall, updates, alerts, and more.

[Uiable Connect](https://github.com/AlfieeLawrence/Uiable-Connect) runs on your laptop/phone. It stores SSH logins, opens tunnels to this dashboard, and can install or update Uiable over SSH.

## Pick a path

| You want… | Do this |
| --- | --- |
| Install on a server from SSH | Download `uiable.zip` from [Releases](https://github.com/AlfieeLawrence/uiable/releases), unpack, `sudo ./install.sh` — or use Connect’s **Install Uiable** action |
| Reach a localhost-bound dashboard | `ssh -L 8080:localhost:8080 you@server` or **Open Uiable dashboard** in Connect |
| Day-to-day SSH/SFTP without the dashboard | Use Connect alone |

Next: [Install](install.md).
