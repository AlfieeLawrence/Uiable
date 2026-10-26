---
title: Storage RAID and ZFS
description: Inventory plus safe start/stop/scrub actions.
order: 33
slug: storage
---

# Storage, RAID, and ZFS

Storage page lists disks (SMART) plus **MD RAID** (`mdadm`) and **ZFS** pools when tools are installed.

Safe actions only (strong confirms):

- mdadm **start** / **stop** (stop requires confirming the array name)
- zpool **scrub** (and scrub-stop)

No create/destroy from the UI.
