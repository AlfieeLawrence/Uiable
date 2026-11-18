---
title: Troubleshooting
description: Common install, Docker, secrets unlock, and tunnel fixes.
order: 90
slug: troubleshooting
---

# Troubleshooting

| Symptom | Try |
| --- | --- |
| Cannot open dashboard | Confirm `UIABLE_BIND` / port; use SSH `-L` or Connect tunnel |
| Install fails on Umbrel | Do not reinstall Docker; start Umbrel’s Docker, re-run `install.sh` |
| Restic “password not configured” | Unlock secrets (`scripts/secrets.sh unlock` or UI), set profile password |
| Self-update health-check failed | Check `UIABLE_HEALTH_URL` / port; use **Rollback** on Updates → Uiable |
| "NetworkManager (nmcli) is not available" on Network | Uiable now uses iwd / wpa_supplicant / netplan / systemd-networkd instead (see the backend card), or click **Install NetworkManager** (not offered on umbrelOS/immutable hosts) |
| Lost accounts after move | Data is in volume `uiable-data` — see README recover section |

More: [Connect troubleshooting](https://github.com/AlfieeLawrence/Uiable-Connect/blob/main/docs/troubleshooting.md)

## Files: permission denied

Tick **Use sudo** in Files (or **Save as sudo** in the editor) and enter the host sudo password when prompted. It stays in memory for the session and is never written to the audit log. If sudo is passwordless on the host (`sudo -n`), no password is needed.


## Network: no NetworkManager

Uiable checks the **host** (via `nsenter`) for NetworkManager first. Without it, the Network page uses what the host has: **iwd** or **wpa_supplicant** for Wi-Fi, **netplan** (`/etc/netplan/90-uiable.yaml`) or **systemd-networkd** (`/etc/systemd/network/10-uiable-<iface>.network`) for static/DHCP settings, and `ip link` for up/down. Install `iw` to scan Wi-Fi on netplan-only hosts.

**Install NetworkManager** (admin) installs and starts it with the host package manager and streams the log. The default **Wi-Fi only** mode writes `/etc/NetworkManager/conf.d/90-uiable.conf` so wired interfaces stay with netplan / systemd-networkd / ifupdown; delete that file to let NetworkManager manage everything. The connection may drop briefly while it starts.

## Network: Wi-Fi says connected but nothing changes / switching wired and Wi-Fi

Connecting to Wi-Fi now waits (up to ~40s) until the adapter has joined the network **and** has an IP address. If it can't, you get the real reason (Wi-Fi blocked by rfkill, `wpasupplicant` not installed for netplan, wrong password, network not found / regulatory domain unset, DHCP timeout) and Uiable's Wi-Fi config is rolled back.

The **Connection** card shows which interface is the active uplink (default route) and each interface's IP, gateway, DNS and Wi-Fi signal. **Wired / Wi-Fi** sets route priorities (NetworkManager `route-metric`, netplan `dhcp4-overrides`, or a systemd-networkd drop-in):

| Option | Effect |
| --- | --- |
| Prefer wired | Both up; wired metric 100, Wi-Fi 600. Unplug the cable and traffic moves to Wi-Fi. |
| Prefer Wi-Fi | The reverse. |
| Wired only / Wi-Fi only | The other interface keeps its local IP but gets no default route (no failover). |

The server's IP changes when it fails over, so reserve both addresses on your router or set static IPs. IP settings, Wired / Wi-Fi and Disconnect are applied **netplan-try style**: you must click **Keep** within 60 seconds, otherwise (for example if you lost access) Uiable restores the previous settings by itself.
