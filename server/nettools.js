'use strict';
// Network tools: ping, traceroute, DNS, Cloudflare speed test, LAN discovery.
// Each tool runs only when the user clicks; nothing in the background.
const express = require('express');
const dns = require('dns').promises;
const http = require('http');
const https = require('https');
const { performance } = require('perf_hooks');
const host = require('./host');
const jobs = require('./jobs');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function safeHost(h) {
  h = String(h || '').trim();
  // Allow IPv4, IPv6, and hostnames. Reject shell metacharacters.
  if (!h || h.length > 253 || /[^\w.:\-\[\]]/.test(h)) throw bad('Invalid host');
  return h;
}

router.post('/ping', wrap(async (req, res) => {
  const target = safeHost(req.body.host);
  const count = Math.min(20, Math.max(1, Number(req.body.count) || 4));
  let r = await host.run('ping', ['-c', String(count), '-W', '3', target], { timeout: 60000 });
  if (r.code === 127 || /No such file|not found/i.test(r.stderr)) {
    r = await host.run('ping', ['-4', '-c', String(count), '-W', '3', target], { timeout: 60000 });
  }
  if (r.code === 127 || /No such file|not found/i.test(r.stderr)) {
    // No ping binary: TCP connect probe to port 80/443 as a lightweight fallback.
    const net = require('net');
    const lines = [`PING ${target} (TCP connect fallback — install iputils-ping for ICMP):`];
    let ok = 0;
    for (let i = 0; i < count; i++) {
      const ms = await new Promise((resolve) => {
        const t0 = performance.now();
        const s = net.connect({ host: target, port: 80, timeout: 3000 }, () => { const dt = performance.now() - t0; s.destroy(); resolve(dt); });
        s.on('error', () => {
          const s2 = net.connect({ host: target, port: 443, timeout: 3000 }, () => { const dt = performance.now() - t0; s2.destroy(); resolve(dt); });
          s2.on('error', () => resolve(-1));
          s2.on('timeout', () => { s2.destroy(); resolve(-1); });
        });
        s.on('timeout', () => { s.destroy(); resolve(-1); });
      });
      if (ms >= 0) { ok++; lines.push(`seq=${i} time=${ms.toFixed(1)} ms (tcp)`); } else lines.push(`seq=${i} failed`);
    }
    lines.push(`${ok}/${count} succeeded`);
    return res.json({ ok: ok > 0, output: lines.join('\n'), code: ok > 0 ? 0 : 1, fallback: 'tcp' });
  }
  res.json({ ok: r.code === 0, output: (r.stdout || r.stderr).trim(), code: r.code });
}));

router.post('/traceroute', wrap(async (req, res) => {
  const target = safeHost(req.body.host);
  const bin = (await host.has('traceroute')) ? 'traceroute' : (await host.has('tracepath')) ? 'tracepath' : null;
  if (!bin) throw bad('traceroute/tracepath not installed on the host', 501);
  const args = bin === 'traceroute' ? ['-n', '-w', '2', '-q', '1', '-m', '20', target] : ['-n', target];
  // Long-running: use a job so the UI can stream output.
  const job = jobs.runHost(`${bin} ${target}`, req.session.username, bin, args, { timeout: 120000 });
  res.json({ ok: true, job: jobs.view(job) });
}));

router.post('/dns', wrap(async (req, res) => {
  const name = safeHost(req.body.name);
  const type = String(req.body.type || 'A').toUpperCase();
  if (!['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS', 'SOA', 'PTR', 'SRV', 'ANY'].includes(type)) throw bad('Bad query type');
  // Prefer dig on the host (uses system resolvers); fall back to Node dns.
  if (await host.has('dig')) {
    const r = await host.run('dig', ['+noall', '+answer', name, type], { timeout: 15000 });
    return res.json({ ok: r.code === 0, output: r.stdout.trim(), source: 'dig' });
  }
  try {
    let records;
    if (type === 'A') records = await dns.resolve4(name);
    else if (type === 'AAAA') records = await dns.resolve6(name);
    else if (type === 'MX') records = await dns.resolveMx(name);
    else if (type === 'TXT') records = await dns.resolveTxt(name);
    else if (type === 'CNAME') records = await dns.resolveCname(name);
    else if (type === 'NS') records = await dns.resolveNs(name);
    else if (type === 'PTR') records = await dns.reverse(name);
    else records = await dns.resolve(name, type);
    res.json({ ok: true, records, source: 'node' });
  } catch (e) { res.json({ ok: false, error: e.message, source: 'node' }); }
}));

router.post('/speedtest', wrap(async (req, res) => {
  // Cloudflare speed endpoints: download a few sizes, upload a blob, measure latency.
  const sizes = [100_000, 1_000_000, 5_000_000]; // 100KB, 1MB, 5MB
  const results = { latencyMs: [], downloadMbps: [], uploadMbps: [] };

  const fetchBuf = (url, opts = {}) => new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const t0 = performance.now();
    const req2 = lib.request(url, { method: opts.method || 'GET', headers: opts.headers || {}, timeout: 60000 }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({ ms: performance.now() - t0, buf: Buffer.concat(chunks), status: r.statusCode }));
    });
    req2.on('error', reject);
    req2.on('timeout', () => req2.destroy(new Error('timeout')));
    if (opts.body) req2.write(opts.body);
    req2.end();
  });

  // Latency: 4 small metadata hits
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetchBuf('https://speed.cloudflare.com/meta');
      results.latencyMs.push(r.ms);
    } catch (_) {}
  }
  // Download
  for (const n of sizes) {
    try {
      const r = await fetchBuf(`https://speed.cloudflare.com/__down?bytes=${n}`);
      if (r.status === 200 && r.buf.length) results.downloadMbps.push((r.buf.length * 8) / (r.ms / 1000) / 1e6);
    } catch (_) {}
  }
  // Upload
  for (const n of [100_000, 1_000_000]) {
    try {
      const body = Buffer.alloc(n, 0x61);
      const r = await fetchBuf('https://speed.cloudflare.com/__up', { method: 'POST', body, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': n } });
      if (r.status && r.status < 500) results.uploadMbps.push((n * 8) / (r.ms / 1000) / 1e6);
    } catch (_) {}
  }
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  res.json({
    ok: true,
    latencyMs: avg(results.latencyMs),
    downloadMbps: avg(results.downloadMbps),
    uploadMbps: avg(results.uploadMbps),
    samples: results,
  });
}));

router.get('/lan', wrap(async (req, res) => {
  // Neighbour table from /proc (no spawn). Optional ping sweep is a separate POST.
  const neighFile = host.MODE === 'nsenter' ? '/proc/1/net/arp' : '/proc/net/arp';
  const text = await require('fs').promises.readFile(neighFile, 'utf8').catch(() => '');
  const neighbours = text.split('\n').slice(1).filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    return { ip: p[0], hw: p[3] === '0x0' ? null : p[3], device: p[5], state: p[2] };
  }).filter((n) => n.ip && n.hw && n.hw !== '00:00:00:00:00:00');

  // Also try `ip neigh` for IPv6 / richer state
  const ipn = await host.run('ip', ['neigh'], { timeout: 8000 });
  if (ipn.code === 0) {
    ipn.stdout.split('\n').filter(Boolean).forEach((l) => {
      const m = l.match(/^(\S+)\s+dev\s+(\S+)(?:\s+lladdr\s+(\S+))?\s+(\S+)/);
      if (!m) return;
      if (!neighbours.some((n) => n.ip === m[1])) neighbours.push({ ip: m[1], hw: m[3] || null, device: m[2], state: m[4] });
    });
  }
  res.json({ neighbours });
}));

router.post('/lan/sweep', wrap(async (req, res) => {
  // Ping sweep of a /24. Slow and chatty; run as a job.
  const cidr = String(req.body.cidr || '');
  const m = cidr.match(/^(\d+\.\d+\.\d+)\.(\d+)\/24$/);
  if (!m) throw bad('Provide a /24 like 192.168.1.0/24');
  const base = m[1];
  const job = jobs.runFn(`Ping sweep ${cidr}`, req.session.username, async (log) => {
    log(`Sweeping ${base}.0/24…\n`);
    const alive = [];
    // Batch of 25 parallel pings at a time
    const ips = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`);
    for (let i = 0; i < ips.length; i += 25) {
      const batch = ips.slice(i, i + 25);
      await Promise.all(batch.map(async (ip) => {
        const r = await host.run('ping', ['-c', '1', '-W', '1', ip], { timeout: 3000 });
        if (r.code === 0) { alive.push(ip); log(`  up  ${ip}\n`); }
      }));
    }
    log(`\nDone. ${alive.length} host(s) responded.\n`);
  });
  res.json({ ok: true, job: jobs.view(job) });
}));

module.exports = router;
