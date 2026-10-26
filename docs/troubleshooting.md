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
| Lost accounts after move | Data is in volume `uiable-data` — see README recover section |

More: [Connect troubleshooting](https://github.com/AlfieeLawrence/Uiable-Connect/blob/main/docs/troubleshooting.md)

## Files: permission denied

Tick **Use sudo** in Files (or **Save as sudo** in the editor) and enter the host sudo password when prompted. It stays in memory for the session and is never written to the audit log. If sudo is passwordless on the host (`sudo -n`), no password is needed.

