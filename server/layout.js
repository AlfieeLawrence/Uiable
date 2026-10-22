'use strict';
// Per-user home layout + dock. Stored under DATA_DIR/layouts/<user>.json.
const express = require('express');
const fsp = require('fs').promises;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');
const auth = require('./auth');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const DIR = () => path.join(auth.DATA_DIR, 'layouts');
const ICONS = () => path.join(auth.DATA_DIR, 'tile-icons');
const fileOf = (user) => path.join(DIR(), String(user).toLowerCase().replace(/[^a-z0-9_.\-@]/g, '_') + '.json');

const SIZES = new Set(['1x1', '2x1', '2x2']);
const TILE_TYPES = new Set(['app', 'container', 'stack', 'script', 'folder', 'link', 'widget']);
const WIDGETS = new Set([
  'cpu', 'mem', 'disk', 'net', 'clock', 'uptime', 'containers', 'processes',
  'notes', 'audit', 'updates', 'storage',
]);
const DOCK_TYPES = new Set(['home', 'launcher', 'app', 'container', 'stack', 'script', 'folder', 'link', 'theme']);

function uid() { return crypto.randomBytes(4).toString('hex'); }

function defaultLayout() {
  // 8-column grid. Sensible starter: live widgets + key apps.
  const tiles = [
    { id: uid(), type: 'widget', widget: 'cpu', x: 0, y: 0, w: 2, h: 1, name: 'CPU', color: '#7c5cff' },
    { id: uid(), type: 'widget', widget: 'mem', x: 2, y: 0, w: 2, h: 1, name: 'Memory', color: '#22c1c3' },
    { id: uid(), type: 'widget', widget: 'disk', x: 4, y: 0, w: 2, h: 1, name: 'Storage', color: '#14b8a6' },
    { id: uid(), type: 'widget', widget: 'net', x: 6, y: 0, w: 2, h: 1, name: 'Network', color: '#f472b6' },
    { id: uid(), type: 'widget', widget: 'clock', x: 0, y: 1, w: 2, h: 1, name: 'Clock', color: '#64748b' },
    { id: uid(), type: 'widget', widget: 'uptime', x: 2, y: 1, w: 2, h: 1, name: 'Uptime', color: '#94a3b8' },
    { id: uid(), type: 'widget', widget: 'containers', x: 4, y: 1, w: 2, h: 1, name: 'Containers', color: '#0ea5e9' },
    { id: uid(), type: 'app', app: 'files', x: 6, y: 1, w: 1, h: 1 },
    { id: uid(), type: 'app', app: 'docker', x: 7, y: 1, w: 1, h: 1 },
    { id: uid(), type: 'app', app: 'apps', x: 0, y: 2, w: 1, h: 1 },
    { id: uid(), type: 'app', app: 'stacks', x: 1, y: 2, w: 1, h: 1 },
    { id: uid(), type: 'app', app: 'logs', x: 2, y: 2, w: 1, h: 1 },
    { id: uid(), type: 'app', app: 'settings', x: 3, y: 2, w: 1, h: 1 },
  ];
  const dock = [
    { type: 'home' },
    { type: 'launcher' },
    { type: 'app', app: 'files' },
    { type: 'app', app: 'docker' },
    { type: 'app', app: 'apps' },
    { type: 'app', app: 'settings' },
    { type: 'theme' },
  ];
  return { version: 1, tiles, dock };
}

function sizeToWH(size) {
  if (size === '2x2') return { w: 2, h: 2 };
  if (size === '2x1') return { w: 2, h: 1 };
  return { w: 1, h: 1 };
}

function normalizeTile(t) {
  if (!t || typeof t !== 'object') throw bad('Bad tile');
  const type = String(t.type || '');
  if (!TILE_TYPES.has(type)) throw bad('Unknown tile type: ' + type);
  const id = String(t.id || uid()).slice(0, 32);
  let w = Math.min(2, Math.max(1, Number(t.w) || 1)) | 0;
  let h = Math.min(2, Math.max(1, Number(t.h) || 1)) | 0;
  if (t.size && SIZES.has(t.size)) { const s = sizeToWH(t.size); w = s.w; h = s.h; }
  const x = Math.max(0, Math.min(16, Number(t.x) || 0)) | 0;
  const y = Math.max(0, Math.min(40, Number(t.y) || 0)) | 0;
  const out = {
    id, type, x, y, w, h,
    name: t.name != null ? String(t.name).slice(0, 64) : '',
    color: t.color ? String(t.color).slice(0, 32) : '',
    icon: t.icon ? String(t.icon).slice(0, 128) : '',
    iconKind: t.iconKind ? String(t.iconKind).slice(0, 16) : '', // pack | emoji | upload | app
  };
  if (type === 'app') out.app = String(t.app || '').slice(0, 64);
  if (type === 'container') out.ref = String(t.ref || t.container || '').slice(0, 128);
  if (type === 'stack') out.ref = String(t.ref || t.stack || '').slice(0, 64);
  if (type === 'script') out.ref = String(t.ref || t.script || '').slice(0, 64);
  if (type === 'folder') out.path = String(t.path || '/').slice(0, 512);
  if (type === 'link') out.url = String(t.url || '').slice(0, 1024);
  if (type === 'widget') {
    out.widget = String(t.widget || '');
    if (!WIDGETS.has(out.widget)) throw bad('Unknown widget: ' + out.widget);
    if (out.widget === 'notes') out.text = String(t.text || '').slice(0, 4000);
  }
  return out;
}

function normalizeDock(items) {
  if (!Array.isArray(items)) throw bad('Dock must be an array');
  const out = [];
  let hasHome = false, hasLauncher = false;
  for (const d of items.slice(0, 24)) {
    if (!d || typeof d !== 'object') continue;
    const type = String(d.type || '');
    if (!DOCK_TYPES.has(type)) continue;
    const item = { type };
    if (type === 'app') item.app = String(d.app || '').slice(0, 64);
    if (type === 'container' || type === 'stack' || type === 'script') item.ref = String(d.ref || '').slice(0, 128);
    if (type === 'folder') item.path = String(d.path || '/').slice(0, 512);
    if (type === 'link') item.url = String(d.url || '').slice(0, 1024);
    if (d.name) item.name = String(d.name).slice(0, 64);
    if (d.icon) item.icon = String(d.icon).slice(0, 128);
    if (d.iconKind) item.iconKind = String(d.iconKind).slice(0, 16);
    if (d.color) item.color = String(d.color).slice(0, 32);
    if (type === 'home') hasHome = true;
    if (type === 'launcher') hasLauncher = true;
    out.push(item);
  }
  // Always keep Home + All apps (pinned at front if missing)
  if (!hasLauncher) out.unshift({ type: 'launcher' });
  if (!hasHome) out.unshift({ type: 'home' });
  // Dedupe home/launcher — keep first of each
  const seen = new Set();
  return out.filter((d) => {
    if (d.type === 'home' || d.type === 'launcher') {
      if (seen.has(d.type)) return false;
      seen.add(d.type);
    }
    return true;
  });
}

function normalizeLayout(body) {
  const tiles = Array.isArray(body.tiles) ? body.tiles.map(normalizeTile).slice(0, 64) : [];
  const dock = normalizeDock(body.dock || defaultLayout().dock);
  return { version: 1, tiles, dock };
}

async function ensureDirs() {
  await fsp.mkdir(DIR(), { recursive: true, mode: 0o700 });
  await fsp.mkdir(ICONS(), { recursive: true, mode: 0o700 });
}

async function readLayout(user) {
  await ensureDirs();
  try {
    const raw = JSON.parse(await fsp.readFile(fileOf(user), 'utf8'));
    return normalizeLayout(raw);
  } catch (_) {
    return defaultLayout();
  }
}

async function writeLayout(user, layout) {
  await ensureDirs();
  const clean = normalizeLayout(layout);
  const fp = fileOf(user);
  const tmp = fp + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, fp);
  return clean;
}

router.get('/', wrap(async (req, res) => {
  const layout = await readLayout(req.session.username);
  res.json({ layout, default: false });
}));

router.get('/default', wrap(async (req, res) => {
  res.json({ layout: defaultLayout() });
}));

router.put('/', wrap(async (req, res) => {
  const layout = await writeLayout(req.session.username, req.body || {});
  res.json({ ok: true, layout });
}));

router.post('/reset', wrap(async (req, res) => {
  const layout = await writeLayout(req.session.username, defaultLayout());
  res.json({ ok: true, layout });
}));

// Upload a custom tile icon (png/jpg/webp/svg/gif), max 256 KB
router.post('/icon', (req, res, next) => {
  ensureDirs().then(() => {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: 256 * 1024 } });
    let saved = null, errMsg = null;
    bb.on('file', (name, file, info) => {
      const ext = path.extname(info.filename || '').toLowerCase() || '.png';
      if (!/\.(png|jpe?g|webp|gif|svg)$/i.test(ext)) { file.resume(); errMsg = 'Unsupported image type'; return; }
      const id = uid() + ext.replace('jpeg', 'jpg');
      const dest = path.join(ICONS(), req.session.username.toLowerCase().replace(/[^a-z0-9_.\-@]/g, '_') + '-' + id);
      const ws = fs.createWriteStream(dest, { mode: 0o600 });
      file.pipe(ws);
      ws.on('finish', () => { saved = '/api/layout/icon/' + path.basename(dest); });
      file.on('limit', () => { errMsg = 'Image too large (max 256 KB)'; try { fs.unlinkSync(dest); } catch (_) {} });
    });
    bb.on('error', (e) => next(e));
    bb.on('finish', () => {
      if (errMsg) return res.status(400).json({ error: errMsg });
      if (!saved) return res.status(400).json({ error: 'No file' });
      res.json({ ok: true, url: saved });
    });
    req.pipe(bb);
  }).catch(next);
});

router.get('/icon/:name', wrap(async (req, res) => {
  const name = path.basename(req.params.name);
  if (!/^[a-z0-9_.\-@]+\-(?:[a-f0-9]+)(?:\.(?:png|jpe?g|webp|gif|svg))$/i.test(name)) throw bad('Bad icon', 404);
  // Only own icons (prefix = username)
  const prefix = req.session.username.toLowerCase().replace(/[^a-z0-9_.\-@]/g, '_');
  if (!name.startsWith(prefix + '-')) throw bad('Forbidden', 403);
  const fp = path.join(ICONS(), name);
  await fsp.access(fp);
  res.sendFile(fp);
}));

/** Move a user's layout file and uploaded icons to a new username. */
async function renameUser(from, to) {
  await ensureDirs();
  const key = (u) => String(u).toLowerCase().replace(/[^a-z0-9_.\-@]/g, '_');
  const oldK = key(from), newK = key(to);
  if (oldK === newK) return { moved: 0 };
  const map = {};
  for (const f of await fsp.readdir(ICONS()).catch(() => [])) {
    if (!f.startsWith(oldK + '-')) continue;
    const rest = f.slice(oldK.length + 1);
    if (!/^[a-f0-9]+\.[a-z]+$/i.test(rest)) continue; // prefix of a longer name, not ours
    await fsp.rename(path.join(ICONS(), f), path.join(ICONS(), newK + '-' + rest));
    map['/api/layout/icon/' + f] = '/api/layout/icon/' + newK + '-' + rest;
  }
  let text = null;
  try { text = await fsp.readFile(fileOf(from), 'utf8'); } catch (_) {}
  if (text != null) {
    const raw = JSON.parse(text);
    for (const t of raw.tiles || []) if (t && map[t.icon]) t.icon = map[t.icon];
    await fsp.writeFile(fileOf(to), JSON.stringify(raw, null, 2), { mode: 0o600 });
    await fsp.unlink(fileOf(from)).catch(() => {});
  }
  return { icons: Object.keys(map).length, layout: text != null };
}

module.exports = { renameUser, router, defaultLayout, readLayout, normalizeLayout };
