'use strict';
// Friendly cron editor for a user's crontab and /etc/cron.d files.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const audit = require('./audit');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const PRESETS = [
  { label: 'Every minute', expr: '* * * * *' },
  { label: 'Every 5 minutes', expr: '*/5 * * * *' },
  { label: 'Every hour', expr: '0 * * * *' },
  { label: 'Every day at 02:00', expr: '0 2 * * *' },
  { label: 'Every Sunday at 03:00', expr: '0 3 * * 0' },
  { label: 'Weekdays at 09:00', expr: '0 9 * * 1-5' },
  { label: 'First of month at 00:30', expr: '30 0 1 * *' },
];

function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return { type: 'comment', text: line };
  // cron.d has an extra user field
  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) return { type: 'raw', text: line };
  return { type: 'job', expr: parts.slice(0, 5).join(' '), rest: parts.slice(5).join(' '), text: line };
}

/** Next N run times for a 5-field cron expression (local time). Simple evaluator, no deps. */
function nextRuns(expr, n = 5, from = new Date()) {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) return [];
  const parse = (f, min, max) => {
    const set = new Set();
    for (const part of f.split(',')) {
      const [range, stepS] = part.split('/');
      const step = Number(stepS) || 1;
      let a, b;
      if (range === '*') { a = min; b = max; }
      else if (range.includes('-')) { [a, b] = range.split('-').map(Number); }
      else { a = b = Number(range); }
      if (!Number.isFinite(a)) continue;
      for (let i = a; i <= b; i += step) if (i >= min && i <= max) set.add(i);
    }
    return set;
  };
  const [mins, hours, doms, mons, dows] = [
    parse(fields[0], 0, 59), parse(fields[1], 0, 23), parse(fields[2], 1, 31), parse(fields[3], 1, 12), parse(fields[4], 0, 7),
  ];
  if (dows.has(7)) dows.add(0); // Sunday
  const out = [];
  const d = new Date(from.getTime()); d.setSeconds(0, 0); d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 366 * 24 * 60 && out.length < n; i++) {
    if (mons.has(d.getMonth() + 1) && hours.has(d.getHours()) && mins.has(d.getMinutes())) {
      const domOk = doms.has(d.getDate());
      const dowOk = dows.has(d.getDay());
      // cron OR of dom/dow when both aren't *
      const domAny = fields[2] === '*';
      const dowAny = fields[4] === '*';
      if ((domAny && dowAny) || (domAny && dowOk) || (dowAny && domOk) || (!domAny && !dowAny && (domOk || dowOk))) {
        out.push(new Date(d.getTime()).toISOString());
      }
    }
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

router.get('/presets', (req, res) => res.json({ presets: PRESETS }));

router.get('/user/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw bad('Bad username');
  const r = await host.run('crontab', ['-u', name, '-l'], { timeout: 10000 });
  // exit 1 with "no crontab" is fine
  const text = r.code === 0 ? r.stdout : '';
  const lines = text.split('\n').map(parseLine);
  res.json({ user: name, text, lines, exists: r.code === 0 });
}));

router.put('/user/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(name)) throw bad('Bad username');
  const text = String(req.body.text ?? '');
  const r = await host.run('crontab', ['-u', name, '-'], { input: text.endsWith('\n') ? text : text + '\n', timeout: 10000 });
  if (r.code !== 0) throw bad(`crontab: ${(r.stderr || r.stdout).trim()}`, 500);
  audit.write({ user: req.session.username, action: 'cron.user.save', details: { name } });
  res.json({ ok: true });
}));

router.get('/system', wrap(async (req, res) => {
  const dir = path.join(host.HOST_ROOT, 'etc/cron.d');
  let files = [];
  try {
    files = await Promise.all((await fsp.readdir(dir)).filter((n) => !n.startsWith('.')).map(async (n) => {
      const text = await fsp.readFile(path.join(dir, n), 'utf8').catch(() => '');
      return { name: n, text, lines: text.split('\n').map(parseLine) };
    }));
  } catch (e) { return res.json({ available: false, message: e.message, files: [] }); }
  res.json({ available: true, files });
}));

router.put('/system/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw bad('Bad file name');
  const text = String(req.body.text ?? '');
  // cron.d files need a trailing newline and typically a user field
  const local = path.join(host.HOST_ROOT, 'etc/cron.d', name);
  await fsp.writeFile(local, text.endsWith('\n') ? text : text + '\n', { mode: 0o644 });
  audit.write({ user: req.session.username, action: 'cron.system.save', details: { name } });
  res.json({ ok: true });
}));

router.delete('/system/:name', wrap(async (req, res) => {
  const name = String(req.params.name);
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw bad('Bad file name');
  await fsp.unlink(path.join(host.HOST_ROOT, 'etc/cron.d', name));
  audit.write({ user: req.session.username, action: 'cron.system.delete', details: { name } });
  res.json({ ok: true });
}));

router.post('/next', wrap(async (req, res) => {
  res.json({ next: nextRuns(String(req.body.expr || ''), Number(req.body.count) || 5) });
}));

module.exports = Object.assign(router, { nextRuns, PRESETS });
