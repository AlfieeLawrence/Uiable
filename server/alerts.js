'use strict';
// Threshold alerts + container-down detection. The loop only runs when at least
// one channel is configured; it ticks every ~60 s and never does work idle.
const express = require('express');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const stats = require('./stats');
const docker = require('./docker');
const audit = require('./audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let FILE = null;
let state = {
  enabled: false,
  channels: { email: { enabled: false, to: '', from: '', host: '', port: 587, secure: false, user: '', pass: '' }, telegram: { enabled: false, botToken: '', chatId: '' } },
  rules: {
    cpu: { enabled: true, above: 90, forMinutes: 2 },
    mem: { enabled: true, above: 90, forMinutes: 2 },
    disk: { enabled: true, above: 90 },
    temp: { enabled: true, above: 85 },
    containerDown: { enabled: true, names: [] }, // empty = any previously-running named container
  },
  cooldownMinutes: 30,
};
const cooldowns = new Map(); // key -> lastFiredAt
const breaches = new Map(); // key -> firstBreachedAt
const knownRunning = new Set(); // container names we have seen running
let timer = null;
let lastCheck = 0;

function init(dataDir) {
  FILE = path.join(dataDir, 'alerts.json');
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) {}
  // strip secrets from accidental logging later; keep them in memory
  schedule();
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  schedule();
}
function publicState() {
  const s = JSON.parse(JSON.stringify(state));
  if (s.channels.email.pass) s.channels.email.pass = '••••••';
  if (s.channels.telegram.botToken) s.channels.telegram.botToken = s.channels.telegram.botToken.slice(0, 8) + '…';
  return s;
}
function channelConfigured() {
  const e = state.channels.email, t = state.channels.telegram;
  return (e.enabled && e.host && e.to) || (t.enabled && t.botToken && t.chatId);
}
function schedule() {
  const want = state.enabled && channelConfigured();
  if (want && !timer) timer = setInterval(() => tick().catch((e) => console.error('[alerts]', e.message)), 60 * 1000);
  if (!want && timer) { clearInterval(timer); timer = null; }
}

async function sendEmail(subject, text) {
  const c = state.channels.email;
  if (!c.enabled || !c.host || !c.to) return;
  const nodemailer = require('nodemailer'); // loaded only when used
  const transport = nodemailer.createTransport({
    host: c.host, port: Number(c.port) || 587, secure: !!c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  await transport.sendMail({ from: c.from || c.user || 'uiable@localhost', to: c.to, subject, text });
}
function sendTelegram(text) {
  const c = state.channels.telegram;
  if (!c.enabled || !c.botToken || !c.chatId) return Promise.resolve();
  const body = JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true });
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${c.botToken}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let d = ''; res.on('data', (x) => d += x); res.on('end', () => (res.statusCode < 300 ? resolve(d) : reject(new Error('Telegram: ' + d))));
    });
    req.on('error', reject); req.end(body);
  });
}

async function fire(key, title, body) {
  const cd = (state.cooldownMinutes || 30) * 60 * 1000;
  if (Date.now() - (cooldowns.get(key) || 0) < cd) return;
  cooldowns.set(key, Date.now());
  const text = `Uiable alert: ${title}\n\n${body}\n\nHost: ${(await stats.snapshot().catch(() => ({ info: {} }))).info.hostname || '?'}`;
  const results = [];
  try { await sendEmail(`[Uiable] ${title}`, text); results.push('email'); } catch (e) { results.push('email:' + e.message); }
  try { await sendTelegram(text); results.push('telegram'); } catch (e) { results.push('telegram:' + e.message); }
  audit.write({ user: 'system', action: 'alerts.fired', details: { key, title, results } });
}

function sustained(key, minutes, active) {
  if (!active) { breaches.delete(key); return false; }
  if (!breaches.has(key)) breaches.set(key, Date.now());
  return Date.now() - breaches.get(key) >= (minutes || 0) * 60 * 1000;
}

async function tick() {
  if (!state.enabled || !channelConfigured()) return;
  lastCheck = Date.now();
  let snap;
  try { snap = await stats.snapshot(); } catch (_) { return; }
  const r = state.rules;
  if (r.cpu.enabled && sustained('cpu', r.cpu.forMinutes, snap.cpu.usage >= r.cpu.above)) {
    await fire('cpu', `CPU ${snap.cpu.usage.toFixed(0)}%`, `CPU has been at or above ${r.cpu.above}% for ${r.cpu.forMinutes} minute(s). Load: ${snap.load.join(', ')}`);
  }
  const memPct = snap.memory.total ? (snap.memory.used / snap.memory.total) * 100 : 0;
  if (r.mem.enabled && sustained('mem', r.mem.forMinutes, memPct >= r.mem.above)) {
    await fire('mem', `Memory ${memPct.toFixed(0)}%`, `RAM has been at or above ${r.mem.above}% for ${r.mem.forMinutes} minute(s).`);
  }
  if (r.disk.enabled) {
    for (const d of snap.disks) {
      const p = d.size ? (d.used / d.size) * 100 : 0;
      if (p >= r.disk.above) await fire('disk:' + d.mount, `Disk ${d.mount} ${p.toFixed(0)}%`, `${d.mount} (${d.fs}) is ${p.toFixed(0)}% full.`);
    }
  }
  if (r.temp.enabled) {
    for (const t of snap.temps) {
      if (t.celsius >= r.temp.above) await fire('temp:' + t.sensor, `Temperature ${t.celsius.toFixed(0)}°C`, `${t.sensor} ${t.label} is ${t.celsius.toFixed(1)}°C.`);
    }
  }
  if (r.containerDown.enabled && docker.available()) {
    try {
      const list = await docker.containers();
      const running = new Set(list.filter((c) => c.State === 'running').map((c) => c.Names[0].replace(/^\//, '')));
      const watch = (r.containerDown.names && r.containerDown.names.length) ? r.containerDown.names : [...knownRunning];
      for (const n of running) knownRunning.add(n);
      for (const n of watch) {
        if (knownRunning.has(n) && !running.has(n)) await fire('ctr:' + n, `Container down: ${n}`, `${n} was running and is now not.`);
      }
    } catch (_) {}
  }
}

router.get('/', (req, res) => res.json(Object.assign(publicState(), { running: !!timer, lastCheck })));
router.put('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') state.enabled = b.enabled;
  if (typeof b.cooldownMinutes === 'number') state.cooldownMinutes = Math.max(1, Math.min(24 * 60, b.cooldownMinutes));
  if (b.rules) {
    for (const k of Object.keys(state.rules)) {
      if (!b.rules[k]) continue;
      Object.assign(state.rules[k], b.rules[k]);
    }
  }
  if (b.channels) {
    if (b.channels.email) {
      const e = b.channels.email;
      Object.assign(state.channels.email, {
        enabled: !!e.enabled, to: e.to || '', from: e.from || '', host: e.host || '', port: Number(e.port) || 587, secure: !!e.secure, user: e.user || '',
      });
      if (e.pass && e.pass !== '••••••') state.channels.email.pass = e.pass;
    }
    if (b.channels.telegram) {
      const t = b.channels.telegram;
      Object.assign(state.channels.telegram, { enabled: !!t.enabled, chatId: t.chatId || '' });
      if (t.botToken && !t.botToken.endsWith('…')) state.channels.telegram.botToken = t.botToken;
    }
  }
  save();
  audit.write({ user: req.session.username, action: 'alerts.save' });
  res.json(publicState());
}));

router.post('/test', wrap(async (req, res) => {
  const which = req.body.channel || 'all';
  const results = {};
  if (which === 'all' || which === 'email') {
    try { await sendEmail('[Uiable] Test alert', 'This is a test from Uiable. If you received it, email alerts work.'); results.email = 'sent'; }
    catch (e) { results.email = e.message; }
  }
  if (which === 'all' || which === 'telegram') {
    try { await sendTelegram('Uiable test alert: if you see this, Telegram works.'); results.telegram = 'sent'; }
    catch (e) { results.telegram = e.message; }
  }
  res.json({ ok: true, results });
}));

module.exports = Object.assign(router, { init, tick, schedule });
