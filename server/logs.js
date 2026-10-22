'use strict';
// Unified logs: host journal (journalctl) with /var/log fallback, plus container logs.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const docker = require('./docker');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

async function journalAvailable() {
  const r = await host.run('journalctl', ['-n', '0'], { timeout: 5000 });
  return r.code === 0 || /No entries/i.test(r.stderr + r.stdout);
}

router.get('/sources', wrap(async (req, res) => {
  const journal = await journalAvailable();
  let files = [];
  try {
    const dir = path.join(host.HOST_ROOT, 'var/log');
    const walk = async (d, depth) => {
      if (depth > 2) return;
      let ents; try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory() && !e.name.startsWith('.')) await walk(full, depth + 1);
        else if (e.isFile() && /\.(log|log\.\d+|1|2)?$/.test(e.name) || e.name === 'syslog' || e.name === 'messages' || e.name === 'auth.log' || e.name === 'kern.log') {
          files.push(full.slice(host.HOST_ROOT === '/' ? 0 : host.HOST_ROOT.length) || full);
        }
      }
    };
    await walk(dir, 0);
    files = files.filter((f) => !/\.(gz|xz|bz2)$/.test(f)).sort().slice(0, 80);
  } catch (_) {}
  let containers = [];
  try { containers = (await docker.containers()).map((c) => ({ id: c.Id, name: c.Names[0].replace(/^\//, ''), state: c.State })); } catch (_) {}
  res.json({ journal, files, containers });
}));

router.get('/query', wrap(async (req, res) => {
  const source = req.query.source || 'journal';
  const q = String(req.query.q || '');
  const since = String(req.query.since || '1 hour ago');
  const priority = String(req.query.priority || '');
  const unit = String(req.query.unit || '');
  const tail = Math.min(2000, Math.max(1, Number(req.query.tail) || 200));

  if (source === 'journal') {
    if (!(await journalAvailable())) {
      // fall back to syslog
      return res.json(await readFileLog('/var/log/syslog', { q, tail }) || await readFileLog('/var/log/messages', { q, tail }) || { lines: [], message: 'journalctl and /var/log/{syslog,messages} are unavailable.' });
    }
    const args = ['-n', String(tail), '--no-pager', '-o', 'short-iso'];
    if (since) args.push('--since', since);
    if (priority) args.push('-p', priority);
    if (unit) args.push('-u', unit);
    if (q) args.push('--grep', q);
    const r = await host.run('journalctl', args, { timeout: 30000 });
    return res.json({ lines: (r.stdout || r.stderr).split('\n').filter(Boolean), source: 'journal' });
  }
  if (source.startsWith('file:')) {
    const fp = source.slice(5);
    if (!fp.startsWith('/var/log/') || fp.includes('..')) throw bad('Only files under /var/log are allowed');
    return res.json(await readFileLog(fp, { q, tail }));
  }
  if (source.startsWith('container:')) {
    const id = source.slice(10);
    if (!/^[\w.\-]+$/.test(id)) throw bad('Bad container id');
    const logs = await docker.logs(id, tail);
    let lines = logs.split('\n');
    if (q) { const ql = q.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(ql)); }
    return res.json({ lines, source });
  }
  throw bad('Unknown source');
}));

async function readFileLog(hostPath, { q, tail }) {
  const local = host.hostPath(hostPath).local;
  let text;
  try {
    const st = await fsp.stat(local);
    const size = Math.min(st.size, 2 * 1024 * 1024);
    const fh = await fsp.open(local, 'r');
    try {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, Math.max(0, st.size - size));
      text = buf.toString('utf8');
    } finally { await fh.close(); }
  } catch (e) { return null; }
  let lines = text.split('\n');
  if (q) { const ql = q.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(ql)); }
  return { lines: lines.slice(-tail), source: 'file:' + hostPath };
}

// Live follow over websocket is registered from index.js
async function follow(ws, url) {
  const source = url.searchParams.get('source') || 'journal';
  const q = url.searchParams.get('q') || '';
  if (source === 'journal') {
    const args = ['-f', '-n', '50', '--no-pager', '-o', 'short-iso'];
    if (q) args.push('--grep', q);
    const [c, a] = host.hostSpawnArgs('journalctl', args);
    const { spawn } = require('child_process');
    const child = spawn(c, a, { env: host.hostEnv() });
    child.stdout.on('data', (d) => { if (ws.readyState === 1) ws.send(d.toString()); });
    child.stderr.on('data', (d) => { if (ws.readyState === 1) ws.send(d.toString()); });
    const kill = () => { try { child.kill('SIGTERM'); } catch (_) {} };
    ws.on('close', kill); child.on('close', () => { if (ws.readyState === 1) ws.close(); });
    return;
  }
  if (source.startsWith('container:')) {
    // poll docker logs since last timestamp every 2s while the socket is open
    const id = source.slice(10);
    let since = Math.floor(Date.now() / 1000) - 5;
    const tick = async () => {
      if (ws.readyState !== 1) return;
      try {
        const http = require('http');
        const buf = await new Promise((resolve, reject) => {
          const req = http.request({ socketPath: docker.SOCK, path: `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&timestamps=1&since=${since}`, method: 'GET' }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve(Buffer.concat(chunks)));
          });
          req.on('error', reject); req.end();
        });
        // demux frames
        let i = 0, out = '';
        while (i + 8 <= buf.length) {
          const len = buf.readUInt32BE(i + 4);
          out += buf.slice(i + 8, i + 8 + len).toString('utf8');
          i += 8 + len;
        }
        if (out) {
          since = Math.floor(Date.now() / 1000);
          let lines = out.split('\n').filter(Boolean);
          if (q) { const ql = q.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(ql)); }
          if (lines.length && ws.readyState === 1) ws.send(lines.join('\n') + '\n');
        }
      } catch (e) { if (ws.readyState === 1) ws.send(`[error] ${e.message}\n`); }
      if (ws.readyState === 1) setTimeout(tick, 2000);
    };
    tick();
    return;
  }
  ws.close(1008, 'unsupported source for follow');
}

module.exports = Object.assign(router, { follow });
