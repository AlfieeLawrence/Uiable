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

## Range view on Home / Dashboard (1.2.8)

Clicking a stat graph opens a detail view backed by `GET /api/metrics/range?metric=cpu|mem|disk|net|temp|gpu&range=1h|6h|24h|7d&points=240`. The server averages stored samples into equal time buckets (with per-bucket min/max for the shaded band) and returns a summary (`min`, `avg`, `max`, `current`). Ranges longer than retention are clamped (`clamped: true`) and greyed out in the UI. Since 1.2.8 network rates (`rx`, `tx`) and disk read/write rates (`dr`, `dw`) are recorded too — older samples have no network data.

