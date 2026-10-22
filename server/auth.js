'use strict';
// Accounts (bcrypt), roles, TOTP 2FA + backup codes, session cookies, CSRF and
// login rate limiting. Everything lives in DATA_DIR (a Docker volume) as JSON.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const DATA_DIR = path.resolve(process.env.UIABLE_DATA_DIR || path.join(__dirname, '..', 'data'));
const CONFIG = path.join(DATA_DIR, 'config.json');
const SESSIONS = path.join(DATA_DIR, 'sessions.json');
const COOKIE = 'uiable_sid';
const SESSION_TTL = (Number(process.env.UIABLE_SESSION_HOURS) || 24 * 7) * 3600 * 1000;
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), BCRYPT_ROUNDS);

// Role model. Higher number = more power. Routes ask for a minimum role.
const ROLES = { viewer: 0, operator: 1, admin: 2 };
const ROLE_NAMES = Object.keys(ROLES);

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });

function load(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return dflt; } }
function save(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });

let config = load(CONFIG, { users: [] });
// migrate accounts created before roles existed: they were all admins
let migrated = false;
config.users.forEach((u) => { if (!ROLES.hasOwnProperty(u.role)) { u.role = 'admin'; migrated = true; } });
if (migrated) save(CONFIG, config);

const sessions = new Map(Object.entries(load(SESSIONS, {})));
let saveTimer = null;
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const now = Date.now();
    const obj = {};
    for (const [k, v] of sessions) if (v.expires > now) obj[k] = v; else sessions.delete(k);
    save(SESSIONS, obj);
  }, 200);
}

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const needsSetup = () => !config.users.length;
const validUser = (u) => /^[A-Za-z0-9_.\-@]{1,64}$/.test(String(u || ''));
function checkPassword(p) { if (typeof p !== 'string' || p.length < 8) throw err('Password must be at least 8 characters'); }
const findUser = (name) => config.users.find((u) => u.username.toLowerCase() === String(name || '').toLowerCase());
const adminCount = () => config.users.filter((u) => u.role === 'admin').length;

async function createUser(username, password, role = 'admin') {
  if (!validUser(username)) throw err('Username may contain letters, digits, . _ - @');
  if (!ROLES.hasOwnProperty(role)) throw err('Unknown role');
  checkPassword(password);
  if (findUser(username)) throw err('That account already exists', 409);
  const rec = { username, role, hash: await bcrypt.hash(password, BCRYPT_ROUNDS), created: new Date().toISOString() };
  const dflt = linuxSettings().defaultUser;
  if (dflt && (role === 'admin' || linuxSettings().allowed.includes(dflt))) rec.linuxUser = dflt;
  config.users.push(rec);
  save(CONFIG, config);
}

async function verify(username, password) {
  const u = findUser(username);
  // always run bcrypt so timing doesn't reveal which usernames exist
  const ok = await bcrypt.compare(String(password || ''), u ? u.hash : DUMMY_HASH);
  return ok && u ? u : null;
}

function killSessions(username) {
  for (const [k, s] of sessions) if (s.username === username) sessions.delete(k);
  persistSessions();
}

async function setPassword(username, password) {
  checkPassword(password);
  const u = findUser(username);
  if (!u) throw err('No such account', 404);
  u.hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  save(CONFIG, config);
  killSessions(u.username);
}

function setRole(username, role) {
  const u = findUser(username);
  if (!u) throw err('No such account', 404);
  if (!ROLES.hasOwnProperty(role)) throw err('Unknown role');
  if (u.role === 'admin' && role !== 'admin' && adminCount() <= 1) throw err('There must always be at least one admin');
  u.role = role;
  save(CONFIG, config);
}

function deleteUser(username) {
  const u = findUser(username);
  if (!u) throw err('No such account', 404);
  if (config.users.length <= 1) throw err('Cannot delete the last account');
  if (u.role === 'admin' && adminCount() <= 1) throw err('Cannot delete the last admin');
  config.users = config.users.filter((x) => x !== u);
  save(CONFIG, config);
  killSessions(u.username);
}

// ---- Linux account binding
function linuxSettings() {
  const l = (config.settings && config.settings.linux) || {};
  return { defaultUser: l.defaultUser || '', allowed: Array.isArray(l.allowed) ? l.allowed : [] };
}
function setLinuxSettings({ defaultUser, allowed }) {
  config.settings = config.settings || {};
  config.settings.linux = { defaultUser: String(defaultUser || ''), allowed: [...new Set((allowed || []).map(String))].filter((n) => n !== 'root') };
  save(CONFIG, config);
  return linuxSettings();
}
/** Bind (or clear with '') the Linux user for an account. skip=true records "ask me later" dismissal. */
function setLinuxUser(username, linuxUser, { skip } = {}) {
  const u = findUser(username);
  if (!u) throw err('No such account', 404);
  const before = u.linuxUser || '';
  if (skip) u.bindSkipped = true;
  else { if (linuxUser) u.linuxUser = linuxUser; else delete u.linuxUser; delete u.bindSkipped; }
  save(CONFIG, config);
  return { before, after: u.linuxUser || '' };
}

function listUsers() {
  return config.users.map((u) => ({ username: u.username, displayName: u.displayName || '', linuxUser: u.linuxUser || '', needsBinding: !u.linuxUser && !u.bindSkipped, role: u.role, created: u.created, twoFactor: !!(u.totp && u.totp.enabled) }));
}

/**
 * Rename a dashboard account. Everything keyed by username inside config
 * (hash, role, 2FA secret, backup codes) lives on the user record, so it moves
 * with it. Live sessions and pending 2FA tickets are re-pointed so nobody is
 * signed out. Returns { from, to } (canonical names).
 */
function renameUser(oldName, newName) {
  newName = String(newName || '').trim();
  const u = findUser(oldName);
  if (!u) throw err('No such account', 404);
  if (!validUser(newName)) throw err('Username may contain letters, digits, . _ - @ (max 64)');
  const clash = findUser(newName);
  if (clash && clash !== u) throw err('That username is already taken', 409);
  if (u.username === newName) throw err('That is already the username');
  const from = u.username;
  const admins = adminCount();
  u.username = newName;
  u.renamed = (u.renamed || []).concat({ from, at: new Date().toISOString() }).slice(-20);
  if (admins !== adminCount() || !adminCount()) { u.username = from; throw err('There must always be at least one admin'); }
  save(CONFIG, config);
  for (const s of sessions.values()) if (s.username === from) s.username = newName;
  persistSessions();
  for (const p of pending.values()) if (p.username === from) p.username = newName;
  return { from, to: newName };
}

function setDisplayName(username, name) {
  const u = findUser(username);
  if (!u) throw err('No such account', 404);
  name = String(name || '').trim();
  if (name.length > 64 || /[<>\u0000-\u001f]/.test(name)) throw err('Display name: up to 64 characters, no < > or control characters');
  if (name) u.displayName = name; else delete u.displayName;
  save(CONFIG, config);
  return name;
}

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 30 s, 6 digits)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of clean) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6);
  return String(code).padStart(6, '0');
}
const counterNow = () => Math.floor(Date.now() / 30000);
/** Returns the matched counter (to block replay) or -1. Accepts +-1 step of clock drift. */
function checkTotp(secret, code, lastCounter = -1) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return -1;
  const c = counterNow();
  for (const d of [0, -1, 1]) {
    const ctr = c + d;
    if (ctr <= lastCounter) continue;
    const a = Buffer.from(hotp(secret, ctr)); const b = Buffer.from(code);
    if (crypto.timingSafeEqual(a, b)) return ctr;
  }
  return -1;
}
const hashCode = (c) => crypto.createHash('sha256').update(String(c).replace(/[\s-]/g, '').toLowerCase()).digest('hex');

async function totpBegin(username, issuer) {
  const u = findUser(username); if (!u) throw err('No such account', 404);
  const secret = b32encode(crypto.randomBytes(20));
  u.totpPending = { secret, at: Date.now() };
  save(CONFIG, config);
  const label = encodeURIComponent(`${issuer}:${u.username}`);
  const uri = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  const qr = await require('qrcode').toDataURL(uri, { margin: 1, width: 220 }); // loaded only when enrolling
  return { secret, uri, qr };
}
function totpEnable(username, code) {
  const u = findUser(username); if (!u || !u.totpPending) throw err('Start enrolment first');
  if (Date.now() - u.totpPending.at > 15 * 60 * 1000) throw err('Enrolment expired, start again');
  const ctr = checkTotp(u.totpPending.secret, code);
  if (ctr < 0) throw err('That code is not valid. Check the time on your phone and try again.');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  u.totp = { secret: u.totpPending.secret, enabled: true, last: ctr };
  u.backup = codes.map(hashCode);
  delete u.totpPending;
  save(CONFIG, config);
  return codes;
}
function totpDisable(username) {
  const u = findUser(username); if (!u) throw err('No such account', 404);
  delete u.totp; delete u.backup; delete u.totpPending;
  save(CONFIG, config);
}
function regenBackup(username) {
  const u = findUser(username); if (!u || !u.totp) throw err('2FA is not enabled');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
  u.backup = codes.map(hashCode); save(CONFIG, config);
  return codes;
}
/** Second factor check: TOTP code or a one-time backup code. */
function verifySecond(u, code) {
  if (!u.totp || !u.totp.enabled) return { ok: true };
  const ctr = checkTotp(u.totp.secret, code, u.totp.last);
  if (ctr >= 0) { u.totp.last = ctr; save(CONFIG, config); return { ok: true, method: 'totp' }; }
  const h = hashCode(code);
  const i = (u.backup || []).indexOf(h);
  if (i >= 0) { u.backup.splice(i, 1); save(CONFIG, config); return { ok: true, method: 'backup', remaining: u.backup.length }; }
  return { ok: false };
}
const has2fa = (u) => !!(u && u.totp && u.totp.enabled);

// Short-lived ticket between "password OK" and "2FA code OK".
const pending = new Map();
function issueTicket(username) {
  const t = crypto.randomBytes(24).toString('base64url');
  pending.set(t, { username, exp: Date.now() + 5 * 60 * 1000, tries: 0 });
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  return t;
}
function takeTicket(t) {
  const p = pending.get(String(t || ''));
  if (!p || p.exp < Date.now()) { pending.delete(t); return null; }
  if (++p.tries > 5) { pending.delete(t); return null; }
  return p;
}
const dropTicket = (t) => pending.delete(t);

// ------------------------------------------------------------------ sessions
function createSession(res, username) {
  const token = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(24).toString('base64url');
  sessions.set(hashToken(token), { username, csrf, created: Date.now(), expires: Date.now() + SESSION_TTL });
  persistSessions();
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL / 1000)}${process.env.UIABLE_SECURE_COOKIE === '1' ? '; Secure' : ''}`);
  return csrf;
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}

/** Returns the session with the user's *current* role (role changes apply immediately). */
function getSession(req) {
  const t = parseCookies(req.headers.cookie)[COOKIE];
  if (!t) return null;
  const key = hashToken(t);
  const s = sessions.get(key);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(key); persistSessions(); return null; }
  const u = config.users.find((x) => x.username === s.username);
  if (!u) return null;
  return Object.assign({ key, role: u.role }, s);
}

function destroySession(req, res) {
  const s = getSession(req);
  if (s) { sessions.delete(s.key); persistSessions(); }
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function sameOrigin(req) {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true;
  try { return new URL(src).host === req.headers.host; } catch (_) { return false; }
}

// --- login rate limiting: 10 failures per 15 minutes per IP
const attempts = new Map();
function rateLimited(ip) {
  const a = attempts.get(ip);
  if (!a) return false;
  if (Date.now() - a.first > 15 * 60 * 1000) { attempts.delete(ip); return false; }
  return a.count >= 10;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() - a.first > 15 * 60 * 1000) attempts.set(ip, { first: Date.now(), count: 1 }); else a.count++;
}
function clearFailures(ip) { attempts.delete(ip); }

/** Express middleware: requires a session; enforces CSRF on unsafe methods. */
function requireAuth(req, res, next) {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not signed in' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const tok = Buffer.from(String(req.headers['x-csrf-token'] || ''));
    const want = Buffer.from(s.csrf);
    if (tok.length !== want.length || !crypto.timingSafeEqual(tok, want) || !sameOrigin(req)) {
      return res.status(403).json({ error: 'CSRF check failed. Reload the page.' });
    }
  }
  req.session = s;
  next();
}

const atLeast = (role, min) => (ROLES[role] ?? -1) >= ROLES[min];
/** Middleware: require at least `min` role. */
const role = (min) => (req, res, next) => (req.session && atLeast(req.session.role, min) ? next() : res.status(403).json({ error: `This needs the ${min} role` }));
/** Middleware: GET/HEAD need `readMin`, anything else needs `writeMin`. */
const rw = (readMin, writeMin) => (req, res, next) => role(['GET', 'HEAD'].includes(req.method) ? readMin : writeMin)(req, res, next);

module.exports = {
  DATA_DIR, ROLES, ROLE_NAMES, needsSetup, createUser, verify, setPassword, setRole, deleteUser, listUsers, findUser, renameUser, setDisplayName, linuxSettings, setLinuxSettings, setLinuxUser,
  createSession, getSession, destroySession, requireAuth, sameOrigin, killSessions,
  rateLimited, recordFailure, clearFailures, atLeast, role, rw,
  totpBegin, totpEnable, totpDisable, regenBackup, verifySecond, has2fa, issueTicket, takeTicket, dropTicket,
  _hotp: hotp, _counterNow: counterNow,
};
