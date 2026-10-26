#!/usr/bin/env bash
# Uiable secrets helper (Data Wibble pattern — OpenSSL AES-256-CBC + PBKDF2).
#   ./scripts/secrets.sh status|unlock|lock|rekey
# Passphrase: prompt | UIABLE_SECRETS_PASSPHRASE | UIABLE_SECRETS_KEY_FILE
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
UIABLE_SECRETS_PBKDF2_ITER="${UIABLE_SECRETS_PBKDF2_ITER:-600000}"

_ui_data_dir() {
  if [ -n "${UIABLE_DATA_DIR:-}" ]; then printf '%s\n' "$UIABLE_DATA_DIR"; return; fi
  if [ -d /var/lib/uiable ]; then printf '%s\n' /var/lib/uiable; return; fi
  printf '%s\n' "$ROOT/data"
}
_ui_encrypted() { printf '%s/secrets.env.enc\n' "$(_ui_data_dir)"; }
_ui_legacy() { printf '%s/secrets.env\n' "$(_ui_data_dir)"; }
_ui_runtime_dir() {
  if [ -d /run ] && [ -w /run ]; then d=/run/uiable
  elif [ -d /dev/shm ] && [ -w /dev/shm ]; then d=/dev/shm/uiable
  else d="$(_ui_data_dir)/runtime"; fi
  mkdir -p "$d" 2>/dev/null || true
  chmod 700 "$d" 2>/dev/null || true
  printf '%s\n' "$d"
}
_ui_unlocked() { printf '%s/secrets.env\n' "$(_ui_runtime_dir)"; }
_ui_shred() {
  local f="$1"; [ -f "$f" ] || return 0
  if command -v shred >/dev/null 2>&1; then shred -u "$f" 2>/dev/null || rm -f "$f"
  else rm -f "$f"; fi
}
_ui_pass_file() {
  local confirm="${1:-0}" pf
  if [ -n "${UIABLE_SECRETS_PASSPHRASE:-}" ]; then
    pf="$(mktemp)"; chmod 600 "$pf"; printf '%s' "$UIABLE_SECRETS_PASSPHRASE" > "$pf"
    _UI_PASS_FILE="$pf"; return 0
  fi
  if [ -n "${UIABLE_SECRETS_KEY_FILE:-}" ] && [ -f "$UIABLE_SECRETS_KEY_FILE" ]; then
    _UI_PASS_FILE="$UIABLE_SECRETS_KEY_FILE"; return 0
  fi
  if [ ! -t 0 ]; then echo "Passphrase required (UIABLE_SECRETS_PASSPHRASE or UIABLE_SECRETS_KEY_FILE)" >&2; return 1; fi
  pf="$(mktemp)"; chmod 600 "$pf"
  read -r -s -p "Secrets passphrase: " p1; echo >&2
  printf '%s' "$p1" > "$pf"
  if [ "$confirm" = 1 ]; then
    read -r -s -p "Confirm passphrase: " p2; echo >&2
    [ "$p1" = "$p2" ] || { _ui_shred "$pf"; echo "Mismatch" >&2; return 1; }
  fi
  _UI_PASS_FILE="$pf"
}
_ui_clear_pass() {
  if [ -n "${_UI_PASS_FILE:-}" ] && [ "${_UI_PASS_FILE}" != "${UIABLE_SECRETS_KEY_FILE:-}" ]; then
    _ui_shred "$_UI_PASS_FILE"
  fi
  unset _UI_PASS_FILE || true
}

cmd="${1:-status}"
case "$cmd" in
  status)
    echo "Data dir: $(_ui_data_dir)"
    enc="$(_ui_encrypted)"; un="$(_ui_unlocked)"; leg="$(_ui_legacy)"
    if [ -f "$enc" ]; then echo "Encrypted: yes ($enc)"; else echo "Encrypted: no"; fi
    if [ -f "$un" ]; then echo "Unlocked:  yes ($un)"; else echo "Unlocked:  no"; fi
    if [ -f "$leg" ]; then echo "Legacy plaintext: YES at $leg (unlock to migrate)"; fi
    ;;
  unlock)
    mkdir -p "$(_ui_data_dir)"; chmod 700 "$(_ui_data_dir)" 2>/dev/null || true
    enc="$(_ui_encrypted)"; un="$(_ui_unlocked)"; leg="$(_ui_legacy)"
    if [ -f "$un" ]; then echo "Already unlocked at $un"; exit 0; fi
    _ui_pass_file 0 || exit 1
    if [ -f "$enc" ]; then
      openssl enc -d -aes-256-cbc -pbkdf2 -iter "$UIABLE_SECRETS_PBKDF2_ITER" \
        -in "$enc" -out "$un" -pass "file:${_UI_PASS_FILE}" || {
        openssl enc -d -aes-256-cbc -pbkdf2 -in "$enc" -out "$un" -pass "file:${_UI_PASS_FILE}" || {
          rm -f "$un"; _ui_clear_pass; echo "Decrypt failed"; exit 1
        }
      }
      chmod 600 "$un"
      echo "Unlocked into $un"
    elif [ -f "$leg" ]; then
      echo "Migrating legacy plaintext → encrypted..."
      openssl enc -aes-256-cbc -pbkdf2 -iter "$UIABLE_SECRETS_PBKDF2_ITER" -salt \
        -in "$leg" -out "$enc" -pass "file:${_UI_PASS_FILE}"
      chmod 600 "$enc"
      cp -a "$leg" "$un"; chmod 600 "$un"
      _ui_shred "$leg"
      echo "Encrypted at $enc; unlocked at $un"
    else
      echo "# Uiable secrets" > "$un"; chmod 600 "$un"
      openssl enc -aes-256-cbc -pbkdf2 -iter "$UIABLE_SECRETS_PBKDF2_ITER" -salt \
        -in "$un" -out "$enc" -pass "file:${_UI_PASS_FILE}"
      chmod 600 "$enc"
      echo "Created empty encrypted secrets at $enc"
    fi
    _ui_clear_pass
    ;;
  lock)
    _ui_shred "$(_ui_unlocked)"
    echo "Scrubbed runtime plaintext. Encrypted kept at $(_ui_encrypted)."
    ;;
  *)
    echo "Usage: $0 status|unlock|lock" >&2; exit 2 ;;
esac
