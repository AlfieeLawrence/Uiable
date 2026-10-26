'use strict';
// Append-only audit log (JSON lines) in DATA_DIR.
// Secrets (passwords, tokens, keys) are NEVER stored — only that a change happened.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let FILE = null;
let lastPrune = 0;
const RETENTION_DAYS = () => Math.max(1, Number(process.env.UIABLE_AUDIT_DAYS) || 90);

const SECRET_KEYS = /pass(word|wd)?|current|oldpass|newpass|secret|token|code|otp|cookie|smtp|bot.?token|authorization|api[_-]?key|bearer|private|credential|chpasswd|wifi.?pass/i;
const SECRET_PATH = /\/password\b|\/login|\/setup|\/wifi\/connect|\/2fa\/|\/tokens?\b|\/account\/2fa|\/self\/apply/i;
const DETAIL_ALLOW = new Set(['secrets', 'username', 'ssid', 'name', 'channel', 'target', 'from', 'to', 'role', 'self', 'note', 'ok', 'id', 'kind', 'job', 'path', 'action', 'spec', 'port', 'jail', 'ip', 'iface', 'app', 'tag', 'enabled']);

function init(dataDir) {
  FILE = path.join(dataDir, 'audit.log');
  scrubSecrets().catch((e) => console.error('[audit] scrub:', e.message));
}

function isSecretKey(k) { return SECRET_KEYS.test(String(k || '')); }

function sanitize(body, { pathHint } = {}) {
  if (pathHint && SECRET_PATH.test(pathHint)) {
    const out = { secrets: 'omitted' };
    if (body && typeof body === 'object') {
      for (const k of ['username', 'ssid', 'name', 'channel', 'role']) {
        if (body[k] != null) out[k] = String(body[k]).slice(0, 64);
      }
    }
    return out;
  }
  if (!body || typeof body !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (isSecretKey(k)) { out[k] = '[redacted]'; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = sanitize(v);
      if (nested) out[k] = nested;
      continue;
    }
    if (typeof v === 'string') out[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = '[' + v.length + ' items]';
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const e = Object.assign({}, entry);
  const hint = String(e.action || '');
  if (e.details) {
    if (SECRET_PATH.test(hint) || /password|login|2fa|token|wifi\/connect/i.test(hint)) {
      const trimmed = { secrets: 'omitted' };
      if (typeof e.details === 'object') {
        for (const [k, v] of Object.entries(e.details)) {
          if (DETAIL_ALLOW.has(k) && !isSecretKey(k)) trimmed[k] = typeof v === 'string' ? String(v).slice(0, 64) : v;
          else if (isSecretKey(k)) trimmed[k] = '[redacted]';
        }
      }
      e.details = trimmed;
    } else {
      e.details = sanitize(e.details, { pathHint: hint });
    }
  }
  for (const k of Object.keys(e)) {
    if (isSecretKey(k) && k !== 'user') e[k] = '[redacted]';
  }
  return e;
}

function write(entry) {
  if (!FILE) return;
  const safe = sanitizeEntry(Object.assign({ t: new Date().toISOString() }, entry));
  fs.appendFile(FILE, JSON.stringify(safe) + '\n', { mode: 0o600 }, () => {});
  if (Date.now() - lastPrune > 24 * 3600 * 1000) { lastPrune = Date.now(); prune().catch(() => {}); }
}

async function scrubSecrets() {
  if (!FILE) return { changed: false };
  let text;
  try { text = await fsp.readFile(FILE, 'utf8'); } catch (_) { return { changed: false, reason: 'missing' }; }
  if (!text) return { changed: false };
  const out = [];
  let changed = 0;
  for (const l of text.split('\n')) {
    if (!l) continue;
    let e;
    try { e = JSON.parse(l); } catch (_) { out.push(l); continue; }
    const safe = sanitizeEntry(e);
    const after = JSON.stringify(safe);
    if (after !== l) changed += 1;
    out.push(after);
  }
  if (!changed) return { changed: false, lines: out.length };
  const tmp = FILE + '.scrub.tmp';
  await fsp.writeFile(tmp, out.length ? out.join('\n') + '\n' : '', { mode: 0o600 });
  await fsp.rename(tmp, FILE);
  console.log('[audit] scrubbed ' + changed + ' historical entries');
  return { changed: true, count: changed, lines: out.length };
}

async function prune() {
  const cutoff = Date.now() - RETENTION_DAYS() * 86400 * 1000;
  let text;
  try { text = await fsp.readFile(FILE, 'utf8'); } catch (_) { return; }
  const keep = text.split('\n').filter((l) => {
    if (!l) return false;
    try { return Date.parse(JSON.parse(l).t) >= cutoff; } catch (_) { return false; }
  });
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
  await fsp.rename(tmp, FILE);
}

async function search({ q = '', user = '', action = '', limit = 200 } = {}) {
  let text = '';
  try { text = await fsp.readFile(FILE, 'utf8'); } catch (_) {}
  const ql = String(q).toLowerCase();
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i]; if (!l) continue;
    let e; try { e = sanitizeEntry(JSON.parse(l)); } catch (_) { continue; }
    if (user && e.user !== user) continue;
    if (action && !String(e.action || '').startsWith(action)) continue;
    if (ql && !JSON.stringify(e).toLowerCase().includes(ql)) continue;
    out.push(e);
  }
  return { entries: out, retentionDays: RETENTION_DAYS() };
}

function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const started = Date.now();
  const pathHint = (req.baseUrl || '') + (req.path || '');
  res.on('finish', () => {
    const target = (req.params && (req.params.name || req.params.id)) || undefined;
    write({
      user: req.session ? req.session.username : (req.auditUser || null),
      role: req.session ? req.session.role : undefined,
      ip: req.socket && req.socket.remoteAddress,
      action: (req.method + ' ' + pathHint).replace(/\/api/, ''),
      status: res.statusCode,
      ok: res.statusCode < 400,
      ms: Date.now() - started,
      details: sanitize(req.body, { pathHint }),
      ...(target ? { target: String(target).slice(0, 64) } : {}),
    });
  });
  next();
}

module.exports = { init, write, search, prune, middleware, sanitize, scrubSecrets, SECRET_KEYS, SECRET_PATH };
