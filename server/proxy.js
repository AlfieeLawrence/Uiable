'use strict';
// Optional Caddy reverse proxy. The Caddy container is only started when the
// user enables it. Internal-CA certs, root cert download, alternate HTTP/HTTPS ports.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const compose = require('./compose');
const ports = require('./ports');
const jobs = require('./jobs');
const audit = require('./audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const NAME = 'uiable-proxy';
const dir = () => path.join(compose.STACKS(), NAME);
const caddyfilePath = () => path.join(dir(), 'Caddyfile');
const dataDir = () => path.join(dir(), 'data');
const configDir = () => path.join(dir(), 'config');
const stateFile = () => path.join(dir(), 'uiable.json');

async function loadState() {
  try { return JSON.parse(await fsp.readFile(stateFile(), 'utf8')); }
  catch (_) { return { enabled: false, httpPort: 80, httpsPort: 443, routes: [] }; }
}
async function saveState(s) { await fsp.mkdir(dir(), { recursive: true, mode: 0o700 }); await fsp.writeFile(stateFile(), JSON.stringify(s, null, 2), { mode: 0o600 }); }

function renderCaddyfile(state) {
  // Global options: internal CA for local HTTPS.
  const lines = [
    `{`,
    `\tlocal_certs`,
    `\tauto_https disable_redirects`,
    `\thttp_port ${Number(state.httpPort) || 80}`,
    `\thttps_port ${Number(state.httpsPort) || 443}`,
    `}`,
    '',
  ];
  for (const r of state.routes || []) {
    if (!r.host || !r.upstream) continue;
    const hostName = String(r.host).replace(/[^a-zA-Z0-9.*\-]/g, '');
    lines.push(`${hostName} {`);
    lines.push(`\ttls internal`);
    lines.push(`\treverse_proxy ${r.upstream}`);
    lines.push(`}`);
    lines.push('');
  }
  return lines.join('\n');
}

function renderCompose(state) {
  return `services:
  caddy:
    image: caddy:2-alpine
    container_name: uiable-caddy
    restart: unless-stopped
    ports:
      - "${Number(state.httpPort) || 80}:80"
      - "${Number(state.httpsPort) || 443}:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./data:/data
      - ./config:/config
`;
}

router.get('/', wrap(async (req, res) => {
  const state = await loadState();
  let running = false;
  try {
    const ctrs = await require('./docker').containers();
    running = ctrs.some((c) => c.Names.some((n) => n.replace(/^\//, '') === 'uiable-caddy') && c.State === 'running');
  } catch (_) {}
  const hits = await ports.conflicts([
    { port: state.httpPort || 80, proto: 'tcp' },
    { port: state.httpsPort || 443, proto: 'tcp' },
  ]);
  res.json({ ...state, running, conflicts: hits, stack: NAME });
}));

router.put('/', wrap(async (req, res) => {
  const cur = await loadState();
  const next = {
    enabled: typeof req.body.enabled === 'boolean' ? req.body.enabled : cur.enabled,
    httpPort: Number(req.body.httpPort) || cur.httpPort || 80,
    httpsPort: Number(req.body.httpsPort) || cur.httpsPort || 443,
    routes: Array.isArray(req.body.routes) ? req.body.routes.map((r) => ({
      host: String(r.host || '').trim(),
      upstream: String(r.upstream || '').trim(),
      label: String(r.label || '').trim(),
    })).filter((r) => r.host && r.upstream) : cur.routes,
  };
  // Port conflict check when enabling / changing ports
  if (next.enabled) {
    const hits = await ports.conflicts([
      { port: next.httpPort, proto: 'tcp' },
      { port: next.httpsPort, proto: 'tcp' },
    ]);
    // Ignore conflicts that are our own caddy container
    const filtered = [];
    for (const h of hits) {
      // We can't reliably map inode → container here; warn and let the user pick alternate ports.
      filtered.push(h);
    }
    if (filtered.length && !req.body.force && (next.httpPort !== cur.httpPort || next.httpsPort !== cur.httpsPort || !cur.enabled)) {
      // Only hard-fail when the port is in use AND it's not already our stack running on it
      let ours = false;
      try {
        const ctrs = await require('./docker').containers();
        ours = ctrs.some((c) => c.Names.some((n) => n.includes('uiable-caddy')) && c.State === 'running');
      } catch (_) {}
      if (!ours) {
        throw bad(`Port conflict: ${filtered.map((f) => f.usedBy).join(', ')}. Choose alternate HTTP/HTTPS ports (Umbrel and many apps use 80/443).`, 409);
      }
    }
  }
  await fsp.mkdir(dataDir(), { recursive: true });
  await fsp.mkdir(configDir(), { recursive: true });
  await fsp.writeFile(caddyfilePath(), renderCaddyfile(next), { mode: 0o644 });
  await fsp.writeFile(compose.fileOf(NAME), renderCompose(next), { mode: 0o600 });
  await saveState(next);

  const [bin, prefix] = await compose.composeCmd();
  let job = null;
  if (next.enabled) {
    job = jobs.runHost('Start Caddy proxy', req.session.username, bin, [...prefix, '-f', compose.stacksHostPath(compose.fileOf(NAME)), '-p', NAME, 'up', '-d', '--remove-orphans'], { timeout: 10 * 60 * 1000 });
  } else {
    // Only stop if the stack exists
    try {
      await fsp.access(compose.fileOf(NAME));
      job = jobs.runHost('Stop Caddy proxy', req.session.username, bin, [...prefix, '-f', compose.stacksHostPath(compose.fileOf(NAME)), '-p', NAME, 'down'], { timeout: 5 * 60 * 1000 });
    } catch (_) {}
  }
  audit.write({ user: req.session.username, action: 'proxy.save', details: { enabled: next.enabled, job: job && job.id } });
  res.json({ ok: true, ...next, job: job && jobs.view(job) });
}));

router.get('/root-cert', wrap(async (req, res) => {
  // Caddy stores the local CA at /data/caddy/pki/authorities/local/root.crt inside its volume.
  const candidates = [
    path.join(dataDir(), 'caddy/pki/authorities/local/root.crt'),
    path.join(dataDir(), 'pki/authorities/local/root.crt'),
  ];
  for (const p of candidates) {
    try {
      const crt = await fsp.readFile(p);
      res.setHeader('Content-Type', 'application/x-x509-ca-cert');
      res.setHeader('Content-Disposition', 'attachment; filename="uiable-caddy-root.crt"');
      return res.send(crt);
    } catch (_) {}
  }
  throw bad('Root certificate not found yet. Enable the proxy and open an HTTPS site once so Caddy can mint the CA.', 404);
}));

module.exports = router;
