'use strict';
/**
 * Uiable secrets — Data Wibble pattern (Gray).
 *
 * At-rest:  $DATA_DIR/secrets.env.enc  (OpenSSL AES-256-CBC + PBKDF2, iter 600000)
 * Runtime:  /run/uiable/secrets.env or /dev/shm/uiable/secrets.env (mode 600); lock shreds it
 * Public config (backups.json, .env) must NEVER hold passwords/keys.
 *
 * Passphrase: UIABLE_SECRETS_PASSPHRASE | UIABLE_SECRETS_KEY_FILE | API unlock body (not logged).
 * Do not invent custom crypto — openssl enc only.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const express = require('express');
const audit = require('./audit');

const router = express.Router();
router.use(express.json({ limit: '64kb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const PBKDF2_ITER = Number(process.env.UIABLE_SECRETS_PBKDF2_ITER) || 600000;

let DATA_DIR = null;

function encryptedPath() {
  return path.join(DATA_DIR, 'secrets.env.enc');
}
function legacyPlainPath() {
  return path.join(DATA_DIR, 'secrets.env');
}
function runtimeDir() {
  const candidates = ['/run/uiable', '/dev/shm/uiable', path.join(DATA_DIR, 'runtime')];
  for (const d of candidates) {
    try {
      if (d.startsWith(DATA_DIR) || fs.existsSync(path.dirname(d))) {
        fs.mkdirSync(d, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(d, 0o700); } catch (_) {}
        return d;
      }
    } catch (_) {}
  }
  const fb = path.join(DATA_DIR, 'runtime');
  fs.mkdirSync(fb, { recursive: true, mode: 0o700 });
  return fb;
}
function unlockedPath() {
  return path.join(runtimeDir(), 'secrets.env');
}

function runOpenSsl(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn('openssl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = Buffer.alloc(0);
    let stderr = '';
    child.stdout.on('data', (d) => { stdout = Buffer.concat([stdout, d]); });
    child.stderr.on('data', (d) => { if (stderr.length < 4000) stderr += d; });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e.message || e) }));
    child.on('close', (code) => resolve({ code: code == null ? 137 : code, stdout, stderr }));
    if (input != null) child.stdin.end(input); else child.stdin.end();
  });
}

function shredFile(p) {
  try {
    if (!fs.existsSync(p)) return;
    // Best-effort overwrite then unlink (shred may be missing on Windows host tools)
    const st = fs.statSync(p);
    if (st.isFile() && st.size > 0 && st.size < 8e6) {
      try { fs.writeFileSync(p, Buffer.alloc(st.size, 0)); } catch (_) {}
    }
    fs.unlinkSync(p);
  } catch (_) {}
}

function lockMode(p) {
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

function resolvePassphrase(explicit) {
  if (explicit != null && String(explicit).length) return String(explicit);
  if (process.env.UIABLE_SECRETS_PASSPHRASE) return process.env.UIABLE_SECRETS_PASSPHRASE;
  const kf = process.env.UIABLE_SECRETS_KEY_FILE;
  if (kf && fs.existsSync(kf)) {
    return fs.readFileSync(kf, 'utf8').replace(/\r?\n$/, '');
  }
  return null;
}

async function withPassFile(passphrase, fn) {
  const pass = resolvePassphrase(passphrase);
  if (!pass) throw bad('Secrets passphrase required (UIABLE_SECRETS_PASSPHRASE, UIABLE_SECRETS_KEY_FILE, or unlock body)', 401);
  const pf = path.join(os.tmpdir(), 'uiable-pass-' + process.pid + '-' + Date.now());
  fs.writeFileSync(pf, pass, { mode: 0o600 });
  try {
    return await fn(pf);
  } finally {
    shredFile(pf);
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line || line.trim().startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) out[k] = v;
  }
  return out;
}
function serializeEnv(obj) {
  const lines = ['# Uiable secrets — runtime plaintext (tmpfs). Do not copy off this host.'];
  for (const k of Object.keys(obj).sort()) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    const v = String(obj[k] == null ? '' : obj[k]);
    lines.push(k + '=' + v.replace(/\n/g, ''));
  }
  return lines.join('\n') + '\n';
}

function encryptedReady() {
  try { return fs.existsSync(encryptedPath()) && fs.statSync(encryptedPath()).size > 0; } catch (_) { return false; }
}
function unlockedReady() {
  try { return fs.existsSync(unlockedPath()) && fs.statSync(unlockedPath()).size > 0; } catch (_) { return false; }
}

async function encryptFile(srcPath, destPath, passphrase) {
  await withPassFile(passphrase, async (pf) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    const r = await runOpenSsl([
      'enc', '-aes-256-cbc', '-pbkdf2', '-iter', String(PBKDF2_ITER), '-salt',
      '-in', srcPath, '-out', destPath, '-pass', 'file:' + pf,
    ]);
    if (r.code !== 0) throw bad('Failed to encrypt secrets: ' + (r.stderr || '').trim().slice(0, 200), 500);
    lockMode(destPath);
  });
}

async function decryptTo(encPath, destPath, passphrase) {
  await withPassFile(passphrase, async (pf) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true, mode: 0o700 });
    let r = await runOpenSsl([
      'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', String(PBKDF2_ITER),
      '-in', encPath, '-out', destPath, '-pass', 'file:' + pf,
    ]);
    if (r.code !== 0) {
      // legacy openssl default iter
      r = await runOpenSsl([
        'enc', '-d', '-aes-256-cbc', '-pbkdf2',
        '-in', encPath, '-out', destPath, '-pass', 'file:' + pf,
      ]);
    }
    if (r.code !== 0) {
      shredFile(destPath);
      throw bad('Decrypt failed — wrong passphrase or corrupt secrets.env.enc', 401);
    }
    lockMode(destPath);
  });
}

async function readUnlockedMap() {
  if (unlockedReady()) return parseEnv(fs.readFileSync(unlockedPath(), 'utf8'));
  if (fs.existsSync(legacyPlainPath())) return parseEnv(fs.readFileSync(legacyPlainPath(), 'utf8'));
  return null;
}

async function writeSecretsMap(map, passphrase) {
  const text = serializeEnv(map);
  const tmp = path.join(runtimeDir(), 'secrets.env.tmp.' + Date.now());
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    await encryptFile(tmp, encryptedPath(), passphrase);
    fs.copyFileSync(tmp, unlockedPath());
    lockMode(unlockedPath());
  } finally {
    shredFile(tmp);
  }
}

function status() {
  return {
    encrypted: encryptedReady(),
    unlocked: unlockedReady(),
    legacyPlaintext: fs.existsSync(legacyPlainPath()),
    encryptedPath: encryptedPath(),
    unlockedPath: unlockedPath(),
    pbkdf2Iter: PBKDF2_ITER,
    // Never list secret values — only keys present (names only) when unlocked
    keys: unlockedReady() ? Object.keys(parseEnv(fs.readFileSync(unlockedPath(), 'utf8'))) : [],
  };
}

async function unlock(passphrase) {
  if (!DATA_DIR) throw bad('Secrets not initialized', 500);
  if (unlockedReady()) return status();
  if (encryptedReady()) {
    await decryptTo(encryptedPath(), unlockedPath(), passphrase);
    return status();
  }
  if (fs.existsSync(legacyPlainPath())) {
    const map = parseEnv(fs.readFileSync(legacyPlainPath(), 'utf8'));
    await writeSecretsMap(map, passphrase);
    shredFile(legacyPlainPath());
    return status();
  }
  // First-time: create empty encrypted store
  await writeSecretsMap({}, passphrase);
  return status();
}

function lock() {
  shredFile(unlockedPath());
  return status();
}

/** Get a secret value (runtime only). Returns null if locked/missing. Never log the value. */
function get(key) {
  const map = unlockedReady() ? parseEnv(fs.readFileSync(unlockedPath(), 'utf8')) : null;
  if (!map) return null;
  return map[key] != null ? map[key] : null;
}

function has(key) {
  return get(key) != null && String(get(key)).length > 0;
}

/** Set/update keys; requires unlocked or passphrase. Does not return values. */
async function setMany(updates, passphrase) {
  let map = await readUnlockedMap();
  if (!map) {
    if (encryptedReady()) {
      await unlock(passphrase);
      map = await readUnlockedMap() || {};
    } else {
      map = {};
    }
  }
  for (const [k, v] of Object.entries(updates || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw bad('Bad secret key: ' + k);
    if (v == null || v === '') delete map[k];
    else map[k] = String(v);
  }
  const pass = resolvePassphrase(passphrase);
  if (!pass && !encryptedReady()) throw bad('Passphrase required to create secrets store', 401);
  await writeSecretsMap(map, pass || resolvePassphrase(null));
  return { ok: true, keys: Object.keys(map) };
}

function backupSecretKey(profileId, kind) {
  const id = String(profileId || '').replace(/[^a-zA-Z0-9_]/g, '_');
  if (kind === 'aws') return 'BACKUP_' + id + '_AWS_SECRET_ACCESS_KEY';
  if (kind === 'b2') return 'BACKUP_' + id + '_B2_KEY';
  return 'BACKUP_' + id + '_RESTIC_PASSWORD';
}

/** Env injected only for a backup job — never returned via API. */
function envForBackup(profile) {
  const env = {};
  if (!profile) return env;
  const pw = get(backupSecretKey(profile.id, 'restic'));
  if (pw) env.RESTIC_PASSWORD = pw;
  else if (profile.passwordEnv && process.env[profile.passwordEnv]) {
    env.RESTIC_PASSWORD = process.env[profile.passwordEnv];
  }
  const aws = get(backupSecretKey(profile.id, 'aws'));
  if (aws) env.AWS_SECRET_ACCESS_KEY = aws;
  const awsKey = get('BACKUP_' + String(profile.id).replace(/[^a-zA-Z0-9_]/g, '_') + '_AWS_ACCESS_KEY_ID');
  if (awsKey) env.AWS_ACCESS_KEY_ID = awsKey;
  const b2 = get(backupSecretKey(profile.id, 'b2'));
  if (b2) env.B2_ACCOUNT_KEY = b2;
  return env;
}

function configuredFlags(profileId) {
  return {
    resticPassword: has(backupSecretKey(profileId, 'restic')),
    awsSecret: has(backupSecretKey(profileId, 'aws')),
    b2Key: has(backupSecretKey(profileId, 'b2')),
  };
}

/** Migrate plaintext passwords out of backups.json profiles into encrypted secrets. */
async function migrateFromBackupProfiles(profiles, passphrase) {
  const updates = {};
  let moved = 0;
  for (const p of profiles || []) {
    if (p.password) {
      updates[backupSecretKey(p.id, 'restic')] = p.password;
      delete p.password;
      moved += 1;
    }
    if (p.awsSecretAccessKey) {
      updates[backupSecretKey(p.id, 'aws')] = p.awsSecretAccessKey;
      delete p.awsSecretAccessKey;
      moved += 1;
    }
    if (p.b2Key) {
      updates[backupSecretKey(p.id, 'b2')] = p.b2Key;
      delete p.b2Key;
      moved += 1;
    }
  }
  if (moved) {
    if (!unlockedReady() && !encryptedReady()) {
      if (!resolvePassphrase(passphrase)) {
        // Create store with empty passphrase refused — use ephemeral random if env provides none?
        // Require passphrase for first encrypt.
        throw bad('Passphrase required to migrate backup secrets into secrets.env.enc', 401);
      }
    }
    await setMany(updates, passphrase);
  }
  return { moved };
}

function init(dataDir) {
  DATA_DIR = dataDir;
  try { fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
  // Auto-unlock if passphrase available via env/key file
  if (!unlockedReady() && encryptedReady() && resolvePassphrase(null)) {
    unlock(null).catch((e) => console.error('[secrets] auto-unlock failed:', e.message));
  } else if (!unlockedReady() && fs.existsSync(legacyPlainPath()) && resolvePassphrase(null)) {
    unlock(null).catch((e) => console.error('[secrets] migrate/unlock failed:', e.message));
  }
}

router.get('/status', wrap(async (req, res) => res.json(status())));
router.post('/unlock', wrap(async (req, res) => {
  const pass = req.body && req.body.passphrase;
  // never audit the passphrase
  const st = await unlock(pass);
  audit.write({ user: req.session.username, action: 'secrets.unlock', details: { encrypted: st.encrypted } });
  res.json(st);
}));
router.post('/lock', wrap(async (req, res) => {
  const st = lock();
  audit.write({ user: req.session.username, action: 'secrets.lock' });
  res.json(st);
}));
router.put('/keys', wrap(async (req, res) => {
  const keys = (req.body && req.body.keys) || {};
  // Only accept known-looking keys; values never echoed
  const r = await setMany(keys, req.body && req.body.passphrase);
  audit.write({ user: req.session.username, action: 'secrets.set', details: { keys: Object.keys(keys) } });
  res.json({ ok: true, keys: r.keys });
}));

module.exports = Object.assign(router, {
  init, status, unlock, lock, get, has, setMany,
  envForBackup, configuredFlags, backupSecretKey, migrateFromBackupProfiles,
  encryptedPath, unlockedPath, PBKDF2_ITER,
});
