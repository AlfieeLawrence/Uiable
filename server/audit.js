'use strict';
// Append-only audit log (JSON lines) in DATA_DIR. No timers: retention is
// enforced lazily, at most once a day, when a new entry is written.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

let FILE = null;
let lastPrune = 0;
const RETENTION_DAYS = () => Math.max(1, Number(process.env.UIABLE_AUDIT_DAYS) || 90);
const SECRET_KEYS = /pass|secret|token|code|key|otp|cookie|smtp_pass|botToken/i;

function init(dataDir) { FILE = path.join(dataDir, 'audit.log'); }

function sanitize(body) {
  if (!body || typeof body !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (SECRET_KEYS.test(k)) { out[k] = '***'; continue; }
    if (typeof v === 'string') out[k] = v.length > 120 ? v.slice(0, 120) + '…' : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = `[${v.length} items]`;
  }
  return Object.keys(out).length ? out : undefined;
}

function write(entry) {
  if (!FILE) return;
  const line = JSON.stringify(Object.assign({ t: new Date().toISOString() }, entry)) + '\n';
  fs.appendFile(FILE, line, { mode: 0o600 }, () => {});
  if (Date.now() - lastPrune > 24 * 3600 * 1000) { lastPrune = Date.now(); prune().catch(() => {}); }
}

async function prune() {
  const cutoff = Date.now() - RETENTION_DAYS() * 86400 * 1000;
  let text;
  try { text = await fsp.readFile(FILE, 'utf8'); } catch (_) { return; }
  const keep = text.split('\n').filter((l) => { if (!l) return false; try { return Date.parse(JSON.parse(l).t) >= cutoff; } catch (_) { return false; } });
  const tmp = FILE + '.tmp';
  await fsp.writeFile(tmp, keep.length ? keep.join('\n') + '\n' : '', { mode: 0o600 });
  await fsp.rename(tmp, FILE);
}

/** Search newest-first. Reads the file only when someone asks. */
async function search({ q = '', user = '', action = '', limit = 200 } = {}) {
  let text = '';
  try { text = await fsp.readFile(FILE, 'utf8'); } catch (_) {}
  const ql = String(q).toLowerCase();
  const out = [];
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i]; if (!l) continue;
    let e; try { e = JSON.parse(l); } catch (_) { continue; }
    if (user && e.user !== user) continue;
    if (action && !String(e.action || '').startsWith(action)) continue;
    if (ql && !l.toLowerCase().includes(ql)) continue;
    out.push(e);
  }
  return { entries: out, retentionDays: RETENTION_DAYS() };
}

/** Express middleware: record every state-changing API call after it finishes. */
function middleware(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const started = Date.now();
  res.on('finish', () => {
    write({
      user: req.session ? req.session.username : (req.auditUser || null),
      role: req.session ? req.session.role : undefined,
      ip: req.socket.remoteAddress,
      action: `${req.method} ${req.baseUrl}${req.path}`.replace(/\/api/, ''),
      status: res.statusCode,
      ok: res.statusCode < 400,
      ms: Date.now() - started,
      details: sanitize(req.body),
    });
  });
  next();
}

module.exports = { init, write, search, prune, middleware, sanitize };
