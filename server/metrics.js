'use strict';
// Persistent metrics history (SQLite via node:sqlite). Default retain 7 days; dashboard-controllable.
// Migrates legacy DATA_DIR/metrics/*.jsonl on first open.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const stats = require('./stats');

const router = express.Router();
router.use(express.json({ limit: '32kb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let DIR = null;
let DB_PATH = null;
let SETTINGS_PATH = null;
let db = null;
let timer = null;
let lastSample = 0;
let settings = { retainDays: 7, intervalSec: 60 };

const INTERVAL_MS = () => Math.max(15, Number(settings.intervalSec) || 60) * 1000;
const RETAIN_DAYS = () => Math.max(1, Math.min(90, Number(settings.retainDays) || 7));

function loadSettings() {
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (s.retainDays != null) settings.retainDays = Math.max(1, Math.min(90, Number(s.retainDays) || 7));
    if (s.intervalSec != null) settings.intervalSec = Math.max(15, Math.min(3600, Number(s.intervalSec) || 60));
  } catch (_) {}
  // env override only if settings file missing retain
  if (!fs.existsSync(SETTINGS_PATH) && process.env.UIABLE_METRICS_DAYS) {
    settings.retainDays = Math.max(1, Number(process.env.UIABLE_METRICS_DAYS) || 7);
  }
}
function saveSettings() {
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_PATH);
}

function openDb() {
  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS samples (
      t INTEGER PRIMARY KEY,
      cpu REAL, mem REAL, disk REAL, rx REAL, tx REAL,
      temp REAL, gpu REAL, load1 REAL
    );
    CREATE INDEX IF NOT EXISTS idx_samples_t ON samples(t);
  `);
}

async function migrateJsonl() {
  if (!DIR || !db) return { imported: 0 };
  let names = [];
  try { names = (await fsp.readdir(DIR)).filter((n) => n.endsWith('.jsonl')); } catch (_) { return { imported: 0 }; }
  let imported = 0;
  const insert = db.prepare('INSERT OR IGNORE INTO samples (t,cpu,mem,disk,rx,tx,temp,gpu,load1) VALUES (?,?,?,?,?,?,?,?,?)');
  for (const n of names) {
    let text = '';
    try { text = await fsp.readFile(path.join(DIR, n), 'utf8'); } catch (_) { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch (_) { continue; }
      if (!row.t) continue;
      insert.run(row.t, row.cpu, row.mem, row.disk, row.rx, row.tx, row.temp, row.gpu, row.load1);
      imported += 1;
    }
    try {
      await fsp.rename(path.join(DIR, n), path.join(DIR, n + '.migrated'));
    } catch (_) {
      try { await fsp.unlink(path.join(DIR, n)); } catch (_) {}
    }
  }
  return { imported };
}

function init(dataDir) {
  DIR = path.join(dataDir, 'metrics');
  DB_PATH = path.join(DIR, 'history.sqlite');
  SETTINGS_PATH = path.join(DIR, 'settings.json');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  loadSettings();
  openDb();
  migrateJsonl().then((r) => { if (r.imported) console.log('[metrics] migrated', r.imported, 'jsonl samples → sqlite'); }).catch(() => {});
  start();
  prune();
}

function start() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => sample().catch((e) => console.error('[metrics]', e.message)), INTERVAL_MS());
  setTimeout(() => sample().catch(() => {}), 5000);
}
function stop() { if (timer) { clearInterval(timer); timer = null; } }

function sample() {
  return (async () => {
    if (!db) return;
    const now = Date.now();
    if (now - lastSample < INTERVAL_MS() * 0.8) return;
    lastSample = now;
    const s = await stats.snapshot();
    const row = {
      t: now,
      cpu: s.cpu && s.cpu.usage != null ? Number(s.cpu.usage) : null,
      mem: null, disk: null,
      rx: s.network && s.network.rxSec != null ? Number(s.network.rxSec) : null,
      tx: s.network && s.network.txSec != null ? Number(s.network.txSec) : null,
      temp: s.cpuTemp != null ? Number(s.cpuTemp) : null,
      gpu: s.gpu && s.gpu.util != null ? Number(s.gpu.util) : null,
      load1: Array.isArray(s.load) && s.load[0] != null ? Number(s.load[0]) : null,
    };
    if (s.memory) {
      if (s.memory.percent != null) row.mem = Number(s.memory.percent);
      else if (s.memory.used != null && s.memory.total) row.mem = (Number(s.memory.used) / Number(s.memory.total)) * 100;
    }
    const pd = s.primaryDisk || (s.disks && s.disks[0]);
    if (pd) {
      if (pd.percent != null) row.disk = Number(pd.percent);
      else if (pd.used != null && pd.size) row.disk = (Number(pd.used) / Number(pd.size)) * 100;
    }
    db.prepare('INSERT OR REPLACE INTO samples (t,cpu,mem,disk,rx,tx,temp,gpu,load1) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(row.t, row.cpu, row.mem, row.disk, row.rx, row.tx, row.temp, row.gpu, row.load1);
  })();
}

function prune() {
  if (!db) return { deleted: 0 };
  const cutoff = Date.now() - RETAIN_DAYS() * 86400 * 1000;
  const info = db.prepare('DELETE FROM samples WHERE t < ?').run(cutoff);
  return { deleted: info.changes || 0, cutoff, retainDays: RETAIN_DAYS() };
}

function readRange(fromMs, toMs) {
  if (!db) return [];
  return db.prepare('SELECT t,cpu,mem,disk,rx,tx,temp,gpu,load1 FROM samples WHERE t >= ? AND t <= ? ORDER BY t ASC')
    .all(fromMs, toMs);
}

function downsample(rows, maxPoints) {
  if (rows.length <= maxPoints) return rows;
  const step = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += step) out.push(rows[i]);
  if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
  return out;
}

router.get('/history', wrap(async (req, res) => {
  const hours = Math.min(24 * RETAIN_DAYS(), Math.max(1, Number(req.query.hours) || 24));
  const toMs = Date.now();
  const fromMs = toMs - hours * 3600 * 1000;
  const maxPoints = Math.min(2000, Math.max(50, Number(req.query.points) || 400));
  const rows = downsample(readRange(fromMs, toMs), maxPoints);
  res.json({
    from: fromMs, to: toMs, hours, points: rows.length,
    retainDays: RETAIN_DAYS(), intervalSec: INTERVAL_MS() / 1000, backend: 'sqlite',
    samples: rows,
  });
}));

router.get('/status', wrap(async (req, res) => {
  let count = 0;
  try { count = db.prepare('SELECT COUNT(*) AS c FROM samples').get().c; } catch (_) {}
  res.json({
    ok: true, backend: 'sqlite', samples: count,
    retainDays: RETAIN_DAYS(), intervalSec: INTERVAL_MS() / 1000, lastSample, db: DB_PATH,
  });
}));

router.get('/settings', wrap(async (req, res) => {
  res.json({ retainDays: RETAIN_DAYS(), intervalSec: INTERVAL_MS() / 1000 });
}));

router.put('/settings', wrap(async (req, res) => {
  const b = req.body || {};
  if (b.retainDays != null) settings.retainDays = Math.max(1, Math.min(90, Number(b.retainDays) || 7));
  if (b.intervalSec != null) {
    settings.intervalSec = Math.max(15, Math.min(3600, Number(b.intervalSec) || 60));
    start();
  }
  saveSettings();
  const pruned = prune();
  res.json({ retainDays: RETAIN_DAYS(), intervalSec: INTERVAL_MS() / 1000, pruned });
}));

router.post('/prune', wrap(async (req, res) => res.json(Object.assign({ ok: true }, prune()))));

module.exports = Object.assign(router, { init, sample, prune, stop, RETAIN_DAYS });
