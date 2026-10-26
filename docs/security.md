---
title: Security and secrets
description: Password redaction, encrypted secrets.env.enc, API tokens, roles.
order: 20
slug: security
---

# Security and secrets

## Audit logging

Password and token change paths never store plaintext secrets. Bodies on sensitive routes are logged as `{ secrets: "omitted" }`. Historical `audit.log` is scrubbed on startup.

## Encrypted secrets (Data Wibble pattern)

- **At rest:** `$UIABLE_DATA_DIR/secrets.env.enc` — OpenSSL AES-256-CBC + PBKDF2 (600000 iterations)
- **Runtime:** `/run/uiable/secrets.env` or `/dev/shm/uiable/secrets.env` (mode 600); **lock** shreds plaintext
- **Public config** (e.g. `backups.json`) holds paths/schedules only — never restic passwords or cloud keys
- Unlock via dashboard, `scripts/secrets.sh unlock`, or `UIABLE_SECRETS_PASSPHRASE` / `UIABLE_SECRETS_KEY_FILE`
- API returns “configured?” flags only — never secret values

## API tokens

Settings → API tokens: Bearer `uk_…`, scopes **read** (GET only) or **operator**, optional expiry, last-used, revoke / revoke-all. Roles still apply.

## Roles

admin · operator · viewer — enforced server-side.
