'use strict';
// File integrity watches: periodic sha256 of configured paths; alert on change.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const host = require('./host');
const audit = require('./audit');
let alerts = null;
try { alerts = require('./alerts'); } catch (_) {}

const router = express.Router();
router.use(express.json({ limit: '256kb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let FILE = null;
let state = { paths: [], intervalMinutes: 60, lastRun: null, alertOnChange: true, scheduleEnabled: true };
let timer = null;

function init(dataDir) {
  FILE = path.join(dataDir, 'integrity.json');
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) {}
  schedule();
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!state.scheduleEnabled) return;
  if (!state.paths || !state.paths.length) return;
  const ms = Math.max(5, Number(state.intervalMinutes) || 60) * 60 * 1000;
  timer = setInterval(() => tick().catch((e) => console.error('[integrity]', e.message)), ms);
  setTimeout(() => tick().catch(() => {}), 15000);
}

async function hashHostFile(p) {
  // Prefer sha256sum on host so paths under /host work in nsenter mode.
  if (await host.has('sha256sum')) {
    const r = await host.run('sha256sum', [p], { timeout: 120000 });
    if (r.code === 0) {
      const m = r.stdout.trim().match(/^([a-f0-9]{64})\s+/i);
      if (m) return m[1].toLowerCase();
    }
  }
  // Fallback: read via host filesystem root if mounted
  const root = host.HOST_ROOT || '/';
  const full = p.startsWith(root) ? p : path.join(root, p.replace(/^\//, ''));
  const buf = await fsp.readFile(full);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function tick() {
  let changed = 0;
  for (const entry of state.paths) {
    try {
      const hash = await hashHostFile(entry.path);
      if (entry.hash && entry.hash !== hash) {
        entry.lastChange = new Date().toISOString();
        entry.previousHash = entry.hash;
        entry.hash = hash;
        changed += 1;
        audit.write({ user: 'system', action: 'integrity.change', details: { path: entry.path, hash: hash.slice(0, 12) + '…' } });
        if (state.alertOnChange !== false && alerts && typeof alerts.notify === 'function') {
          alerts.notify('integrity:' + entry.path, 'File integrity change', entry.path + ' hash changed to ' + hash.slice(0, 16) + '…').catch(() => {});
        }
      } else {
        entry.hash = hash;
        entry.lastOk = new Date().toISOString();
      }
      entry.error = null;
    } catch (e) {
      entry.error = e.message;
    }
  }
  state.lastRun = new Date().toISOString();
  save();
  return { changed };
}

function publicState() {
  return {
    intervalMinutes: state.intervalMinutes,
    lastRun: state.lastRun,
    alertOnChange: state.alertOnChange !== false,
    scheduleEnabled: state.scheduleEnabled !== false,
    paths: (state.paths || []).map((p) => ({
      id: p.id, path: p.path, hash: p.hash ? p.hash.slice(0, 16) + '…' : null,
      lastOk: p.lastOk || null, lastChange: p.lastChange || null, error: p.error || null,
    })),
  };
}

router.get('/', wrap(async (req, res) => res.json(publicState())));

router.put('/', wrap(async (req, res) => {
  if (req.body.intervalMinutes != null) state.intervalMinutes = Math.max(5, Number(req.body.intervalMinutes) || 60);
  if (typeof req.body.alertOnChange === 'boolean') state.alertOnChange = req.body.alertOnChange;
  if (typeof req.body.scheduleEnabled === 'boolean') state.scheduleEnabled = req.body.scheduleEnabled;
  save(); schedule();
  audit.write({ user: req.session.username, action: 'integrity.settings', details: { intervalMinutes: state.intervalMinutes, alertOnChange: state.alertOnChange, scheduleEnabled: state.scheduleEnabled } });
  res.json(publicState());
}));

router.post('/paths', wrap(async (req, res) => {
  const p = String(req.body.path || '').trim();
  if (!p.startsWith('/') || p.includes('\0') || p.includes('\n')) throw bad('Absolute path required');
  if (state.paths.some((x) => x.path === p)) throw bad('Already watching that path', 409);
  const id = 'w_' + Date.now().toString(36);
  const hash = await hashHostFile(p);
  state.paths.push({ id, path: p, hash, lastOk: new Date().toISOString() });
  save(); schedule();
  audit.write({ user: req.session.username, action: 'integrity.add', details: { path: p } });
  res.json(publicState());
}));

router.delete('/paths/:id', wrap(async (req, res) => {
  const i = state.paths.findIndex((x) => x.id === req.params.id);
  if (i < 0) throw bad('Not found', 404);
  const [gone] = state.paths.splice(i, 1);
  save(); schedule();
  audit.write({ user: req.session.username, action: 'integrity.remove', details: { path: gone.path } });
  res.json(publicState());
}));

router.post('/scan', wrap(async (req, res) => {
  const r = await tick();
  audit.write({ user: req.session.username, action: 'integrity.scan', details: r });
  res.json(Object.assign({ ok: true }, publicState(), r));
}));

module.exports = Object.assign(router, { init, tick });
