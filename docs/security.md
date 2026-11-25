---
title: Security and secrets
description: Password redaction, encrypted secrets.env.enc, API tokens, roles, Linux account linking.
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

## Linking a Linux account

Each dashboard account can be linked to one Linux user on the server (first login, **Settings → My account → Linked Linux user**, or an admin's **Settings → Accounts → Linux user**). The linked user is the default for new terminal tabs, the user scripts run as, and the owner of uploads; non-admins always run as it.

- **Linking or changing the link needs that Linux user's password.** Pick the user, type its Linux login password, then **Verify & link**. Nothing is saved unless the password is right; a wrong one shows an error in the dialog and clears the field.
- **Admins too:** linking another dashboard account still needs the target Linux user's password (ask its owner). Unlinking, or re-saving the same user, doesn't need a password.
- **The default Linux user** (Settings → Accounts → Linux account linking) is only pre-selected in the first-login dialog; new accounts are no longer linked to it automatically. Links made before 1.2.8 stay as they are.
- **How it's checked:** the hash is read from the host's `/etc/shadow` and the typed password is hashed with the host's own `crypt(3)` (yescrypt `$y$` — Ubuntu's default — plus sha512 `$6$`, sha256 `$5$`, bcrypt and the rest of libxcrypt) through `perl`, run on the host, with the password on **stdin** only (never on a command line, in the environment, or in logs), and compared in constant time. If perl is missing it falls back to PAM's `unix_chkpwd`.
- **Refused:** locked accounts (`!`/`*` in shadow — including root on a default Ubuntu install; admins already run as root when not linked), accounts without a password, and expired accounts.
- **Rate limit:** 5 wrong passwords per dashboard user + Linux user in 15 minutes (and 15 per dashboard user across all Linux users), then HTTP 429 until the window passes. A correct password resets the count.
- **Audit:** every attempt is logged as `account.linux-verify` (ok / wrong / locked / rate-limited) and the change as `account.linux-bind` with `verified: true`. Request bodies on `/linux-user` are logged as `{ secrets: "omitted" }`; the password is never stored, logged or returned.

## Container environment variables (1.2.8)

The container page and `GET /api/docker/containers/:id/inspect` mask values whose names look secret (password, secret, token, API/access key, private, credential, auth, cookie, session, salt, signing, encryption, `*_KEY`, license) and credentials inside URLs (`scheme://user:pass@host`). Viewers and operators only ever receive the masked values. Admins can press **Reveal** (`GET …/detail?reveal=1`), which is written to the audit log as `docker.env.reveal`.

