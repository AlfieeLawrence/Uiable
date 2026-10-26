---
title: Metrics history
description: SQLite metrics retention (default 7 days) and dashboard controls.
order: 30
slug: metrics
---

# Metrics history

The **Metrics history** app stores CPU/mem/disk/GPU/temp/load samples in SQLite under `$UIABLE_DATA_DIR/metrics/history.sqlite`.

- Default retention: **7 days** (1–90)
- Change retention on the Metrics page (persisted in `metrics/settings.json`)
- Older samples are deleted on prune / settings save
- Legacy daily JSONL files are migrated once into SQLite
