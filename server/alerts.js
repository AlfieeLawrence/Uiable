'use strict';
// Threshold alerts + container-down detection. Loop runs only when a channel is configured.
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
  channels: {
    email: { enabled: false, to: '', from: '', host: '', port: 587, secure: false, user: '', pass: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    webhook: { enabled: false, url: '', headers: {} },
    discord: { enabled: false, webhookUrl: '' },
    ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
  },
  rules: {
    cpu: { enabled: true, above: 90, forMinutes: 2 },
    mem: { enabled: true, above: 90, forMinutes: 2 },
    disk: { enabled: true, above: 90 },
    temp: { enabled: true, above: 85 },
    containerDown: { enabled: true, names: [] },
  },
  cooldownMinutes: 30,
};
const cooldowns = new Map();
const breaches = new Map();
const knownRunning = new Set();
let timer = null;
let lastCheck = 0;
let HISTORY_FILE = null;
const history = []; // newest last, capped
const HISTORY_MAX = 200;
// Quieter cooldowns: after a fire, next cooldown doubles up to max (per key)
const cooldownBoost = new Map();

function init(dataDir) {
  FILE = path.join(dataDir, 'alerts.json');
  try {
    const loaded = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    state = Object.assign(state, loaded);
    state.channels = Object.assign({
      email: state.channels && state.channels.email,
      telegram: state.channels && state.channels.telegram,
      webhook: { enabled: false, url: '', headers: {} },
      discord: { enabled: false, webhookUrl: '' },
      ntfy: { enabled: false, server: 'https://ntfy.sh', topic: '', token: '' },
    }, loaded.channels || {});
  } catch (_) {}
  if (typeof state.cooldownMinutes !== 'number') state.cooldownMinutes = 30;
  if (state.quietMode == null) state.quietMode = true; // smarter cooldowns on by default
  HISTORY_FILE = path.join(path.dirname(FILE), 'alerts-history.jsonl');
  try {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (const line of lines.slice(-HISTORY_MAX)) {
      try { history.push(JSON.parse(line)); } catch (_) {}
    }
  } catch (_) {}
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
  const c = s.channels || {};
  if (c.email && c.email.pass) c.email.pass = '••••••';
  if (c.telegram && c.telegram.botToken) c.telegram.botToken = c.telegram.botToken.slice(0, 8) + '…';
  if (c.ntfy && c.ntfy.token) c.ntfy.token = c.ntfy.token.slice(0, 6) + '…';
  if (c.discord && c.discord.webhookUrl && c.discord.webhookUrl.length > 40) {
    c.discord.webhookUrl = c.discord.webhookUrl.slice(0, 32) + '…';
  }
  s.running = !!(timer);
  s.lastCheck = lastCheck || null;
  s.quietMode = state.quietMode !== false;
  s.historyCount = history.length;
  return s;
}
function channelConfigured() {
  const c = state.channels || {};
  const e = c.email || {}, tg = c.telegram || {}, w = c.webhook || {}, d = c.discord || {}, n = c.ntfy || {};
  return (e.enabled && e.host && e.to)
    || (tg.enabled && tg.botToken && tg.chatId)
    || (w.enabled && w.url)
    || (d.enabled && d.webhookUrl)
    || (n.enabled && n.topic);
}
function schedule() {
  const want = state.enabled && channelConfigured();
  if (want && !timer) timer = setInterval(() => tick().catch((e) => console.error('[alerts]', e.message)), 60 * 1000);
  if (!want && timer) { clearInterval(timer); timer = null; }
}

function httpJson(urlStr, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('Bad URL')); }
    const lib = u.protocol === 'http:' ? http : https;
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = lib.request({
      protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method,
      headers: Object.assign(
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers
      ),
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', (x) => { if (d.length < 1e6) d += x; });
      res.on('end', () => (res.statusCode < 300 ? resolve(d) : reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 200)))));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function sendEmail(subject, text) {
  const c = state.channels.email;
  if (!c || !c.enabled || !c.host || !c.to) return;
  const nodemailer = require('nodemailer');
  const transport = nodemailer.createTransport({
    host: c.host, port: Number(c.port) || 587, secure: !!c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
  });
  await transport.sendMail({ from: c.from || c.user || 'uiable@localhost', to: c.to, subject, text });
}
function sendTelegram(text) {
  const c = state.channels.telegram;
  if (!c || !c.enabled || !c.botToken || !c.chatId) return Promise.resolve();
  return httpJson('https://api.telegram.org/bot' + c.botToken + '/sendMessage', {
    body: { chat_id: c.chatId, text, disable_web_page_preview: true },
  });
}
async function sendWebhook(title, text) {
  const c = state.channels.webhook;
  if (!c || !c.enabled || !c.url) return;
  const headers = (c.headers && typeof c.headers === 'object') ? c.headers : {};
  await httpJson(c.url, { headers, body: { text, title, source: 'uiable', ts: new Date().toISOString() } });
}
async function sendDiscord(title, text) {
  const c = state.channels.discord;
  if (!c || !c.enabled || !c.webhookUrl) return;
  await httpJson(c.webhookUrl, { body: { content: '**' + title + '**\n' + text.slice(0, 1800) } });
}
async function sendNtfy(title, text) {
  const c = state.channels.ntfy;
  if (!c || !c.enabled || !c.topic) return;
  const base = String(c.server || 'https://ntfy.sh').replace(/\/$/, '');
  const headers = { 'Title': title, 'Content-Type': 'text/plain' };
  if (c.token) headers.Authorization = 'Bearer ' + c.token;
  await httpJson(base + '/' + encodeURIComponent(c.topic), { method: 'POST', headers, body: text });
}

function pushHistory(entry) {
  history.push(entry);
  while (history.length > HISTORY_MAX) history.shift();
  if (HISTORY_FILE) {
    try { fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 }); } catch (_) {}
  }
}

async function fire(key, title, body) {
  const base = (state.cooldownMinutes || 30) * 60 * 1000;
  const boost = state.quietMode === false ? 1 : (cooldownBoost.get(key) || 1);
  const cd = base * boost;
  if (Date.now() - (cooldowns.get(key) || 0) < cd) return false;
  cooldowns.set(key, Date.now());
  if (state.quietMode !== false) cooldownBoost.set(key, Math.min(8, boost * 2));
  const text = 'Uiable alert: ' + title + '\n\n' + body + '\n\nHost: ' + ((await stats.snapshot().catch(() => ({ info: {} }))).info.hostname || '?');
  const results = [];
  try { await sendEmail('[Uiable] ' + title, text); results.push('email:ok'); } catch (e) { results.push('email:' + e.message); }
  try { await sendTelegram(text); results.push('telegram:ok'); } catch (e) { results.push('telegram:' + e.message); }
  try { await sendWebhook(title, text); results.push('webhook:ok'); } catch (e) { results.push('webhook:' + e.message); }
  try { await sendDiscord(title, text); results.push('discord:ok'); } catch (e) { results.push('discord:' + e.message); }
  try { await sendNtfy(title, text); results.push('ntfy:ok'); } catch (e) { results.push('ntfy:' + e.message); }
  const entry = { t: new Date().toISOString(), key, title, body: String(body).slice(0, 500), results, cooldownBoost: boost };
  pushHistory(entry);
  audit.write({ user: 'system', action: 'alerts.fired', details: { key, title, results } });
  return true;
}

/** Used by integrity / other modules — respects cooldowns. */
async function notify(key, title, body) {
  return fire(key, title, body);
}

function sustained(key, minutes, active) {
  if (!active) {
    breaches.delete(key);
    // Recovering: ease cooldown boost back down
    if (cooldownBoost.has(key)) cooldownBoost.set(key, Math.max(1, Math.floor((cooldownBoost.get(key) || 1) / 2)));
    return false;
  }
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
    await fire('cpu', 'CPU ' + snap.cpu.usage.toFixed(0) + '%', 'CPU has been at or above ' + r.cpu.above + '% for ' + r.cpu.forMinutes + ' minute(s). Load: ' + snap.load.join(', '));
  }
  const memPct = snap.memory.total ? (snap.memory.used / snap.memory.total) * 100 : 0;
  if (r.mem.enabled && sustained('mem', r.mem.forMinutes, memPct >= r.mem.above)) {
    await fire('mem', 'Memory ' + memPct.toFixed(0) + '%', 'RAM has been at or above ' + r.mem.above + '% for ' + r.mem.forMinutes + ' minute(s).');
  }
  if (r.disk.enabled) {
    for (const d of snap.disks) {
      const p = d.size ? (d.used / d.size) * 100 : 0;
      if (p >= r.disk.above) await fire('disk:' + d.mount, 'Disk ' + d.mount + ' ' + p.toFixed(0) + '%', d.mount + ' (' + d.fs + ') is ' + p.toFixed(0) + '% full.');
    }
  }
  if (r.temp.enabled) {
    for (const t of snap.temps || []) {
      if (t.celsius >= r.temp.above) await fire('temp:' + t.sensor, 'Temperature ' + t.celsius.toFixed(0) + 'C', t.sensor + ' ' + t.label + ' is ' + t.celsius.toFixed(1) + 'C.');
    }
  }
  if (r.containerDown.enabled && docker.available()) {
    try {
      const list = await docker.containers();
      const running = new Set(list.filter((c) => c.State === 'running').map((c) => c.Names[0].replace(/^\//, '')));
      const watch = (r.containerDown.names && r.containerDown.names.length) ? r.containerDown.names : [...knownRunning];
      for (const n of running) knownRunning.add(n);
      for (const n of watch) {
        if (knownRunning.has(n) && !running.has(n)) await fire('ctr:' + n, 'Container down: ' + n, n + ' was running and is now not.');
      }
    } catch (_) {}
  }
}

router.get('/', wrap(async (req, res) => res.json(publicState())));
router.put('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.enabled === 'boolean') state.enabled = b.enabled;
  if (b.cooldownMinutes != null) state.cooldownMinutes = Math.max(1, Number(b.cooldownMinutes) || 30);
  if (typeof b.quietMode === 'boolean') state.quietMode = b.quietMode;
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
      const tg = b.channels.telegram;
      Object.assign(state.channels.telegram, { enabled: !!tg.enabled, chatId: tg.chatId || '' });
      if (tg.botToken && !String(tg.botToken).endsWith('…')) state.channels.telegram.botToken = tg.botToken;
    }
    if (b.channels.webhook) {
      const w = b.channels.webhook;
      Object.assign(state.channels.webhook, {
        enabled: !!w.enabled, url: w.url || '',
        headers: (w.headers && typeof w.headers === 'object') ? w.headers : (state.channels.webhook.headers || {}),
      });
    }
    if (b.channels.discord) {
      const d = b.channels.discord;
      Object.assign(state.channels.discord, { enabled: !!d.enabled });
      if (d.webhookUrl && !String(d.webhookUrl).endsWith('…')) state.channels.discord.webhookUrl = d.webhookUrl;
    }
    if (b.channels.ntfy) {
      const n = b.channels.ntfy;
      Object.assign(state.channels.ntfy, {
        enabled: !!n.enabled, server: n.server || 'https://ntfy.sh', topic: n.topic || '',
      });
      if (n.token && !String(n.token).endsWith('…')) state.channels.ntfy.token = n.token;
    }
  }
  save();
  audit.write({ user: req.session.username, action: 'alerts.save' });
  res.json(publicState());
}));

router.get('/history', wrap(async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json({ events: history.slice(-limit).reverse() });
}));

router.post('/test', wrap(async (req, res) => {
  const which = (req.body && req.body.channel) || 'all';
  const results = {};
  const title = 'Uiable test alert';
  const text = 'This is a test from Uiable.';
  async function one(name, fn) {
    if (which !== 'all' && which !== name) return;
    try { await fn(); results[name] = 'sent'; } catch (e) { results[name] = e.message; }
  }
  await one('email', () => sendEmail('[Uiable] Test alert', text));
  await one('telegram', () => sendTelegram(text));
  await one('webhook', () => sendWebhook(title, text));
  await one('discord', () => sendDiscord(title, text));
  await one('ntfy', () => sendNtfy(title, text));
  pushHistory({ t: new Date().toISOString(), key: 'test:' + which, title, body: text, results: Object.entries(results).map(([k,v]) => k + ':' + v), test: true });
  res.json({ ok: true, results });
}));

module.exports = Object.assign(router, { init, tick, schedule, notify, fire });
