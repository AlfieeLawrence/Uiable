---
title: Backups
description: Restic/rsync profiles with secrets stored outside backups.json.
order: 32
slug: backups
---

# Backups

**Backups** app: restic (preferred) or rsync profiles. Destinations and schedules live in `backups.json`. Passwords and cloud keys go into encrypted secrets (see [Security](security.md)). Unlock secrets before the first restic run if the store is locked.
