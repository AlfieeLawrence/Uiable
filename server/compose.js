'use strict';
// Compose stacks: listed from DATA_DIR/stacks (and the optional Caddy proxy).
// Uses the host's `docker compose` via nsenter so behaviour matches the CLI.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const host = require('./host');
const jobs = require('./jobs');
const audit = require('./audit');

// Stacks live on the host FS (under /host when containerised) so the host's Docker
// daemon can resolve compose files and bind-mount paths. Default: /var/lib/uiable/stacks.
const STACKS = () => {
  const env = process.env.UIABLE_STACKS_DIR;
  if (env) return env.startsWith(host.HOST_ROOT) || host.HOST_ROOT === '/' ? env : path.join(host.HOST_ROOT, env);
  return path.join(host.HOST_ROOT, 'var/lib/uiable/stacks');
};
const stacksHostPath = (localPath) => {
  // Convert a path inside the container's HOST_ROOT view to the path the host Docker sees.
  if (host.HOST_ROOT === '/' || !localPath.startsWith(host.HOST_ROOT)) return localPath;
  return localPath.slice(host.HOST_ROOT.length) || '/';
};
const router = express.Router();
router.use(express.json({ limit: '2mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,48}$/;
const nameOk = (n) => { if (!NAME_RE.test(String(n || ''))) throw bad('Stack name: lowercase letters, digits, - and _; max 49 chars'); return String(n); };
const dirOf = (n) => path.join(STACKS(), nameOk(n));
const fileOf = (n) => path.join(dirOf(n), 'docker-compose.yml');

async function ensureRoot() { await fsp.mkdir(STACKS(), { recursive: true, mode: 0o700 }); }

async function composeCmd() {
  // Prefer the modern plugin, fall back to docker-compose.
  const a = await host.run('docker', ['compose', 'version'], { timeout: 8000 });
  if (a.code === 0) return ['docker', ['compose']];
  const b = await host.run('docker-compose', ['version'], { timeout: 8000 });
  if (b.code === 0) return ['docker-compose', []];
  throw bad('Docker Compose is not available on the host', 501);
}

async function list() {
  await ensureRoot();
  const names = (await fsp.readdir(STACKS()).catch(() => [])).sort();
  const out = [];
  for (const name of names) {
    const file = path.join(STACKS(), name, 'docker-compose.yml');
    try {
      await fsp.access(file);
      let meta = {};
      try { meta = JSON.parse(await fsp.readFile(path.join(STACKS(), name, 'uiable.json'), 'utf8')); } catch (_) {}
      const yml = await fsp.readFile(file, 'utf8');
      let services = 0;
      try { services = Object.keys((yaml.load(yml) || {}).services || {}).length; } catch (_) {}
      out.push({ name, path: file, services, meta, bytes: Buffer.byteLength(yml) });
    } catch (_) {}
  }
  return out;
}

async function status(name) {
  const [bin, prefix] = await composeCmd();
  const r = await host.run(bin, [...prefix, '-f', stacksHostPath(fileOf(name)), '-p', name, 'ps', '--format', 'json'], { timeout: 30000 });
  // `ps --format json` prints one JSON object per line on Compose V2.
  const containers = r.stdout.trim().split('\n').filter(Boolean).flatMap((l) => { try { const o = JSON.parse(l); return Array.isArray(o) ? o : [o]; } catch (_) { return []; } });
  return { containers, raw: r.code !== 0 ? (r.stderr || r.stdout).trim() : undefined };
}

router.get('/', wrap(async (req, res) => {
  const stacks = await list();
  // attach running counts cheaply from the Docker socket (one call)
  let running = {};
  try {
    const ctrs = await require('./docker').containers();
    ctrs.forEach((c) => {
      const p = c.Labels && c.Labels['com.docker.compose.project'];
      if (!p) return;
      running[p] = running[p] || { running: 0, total: 0 };
      running[p].total++;
      if (c.State === 'running') running[p].running++;
    });
  } catch (_) {}
  res.json({ stacks: stacks.map((s) => Object.assign(s, { state: running[s.name] || { running: 0, total: 0 } })), root: STACKS() });
}));

router.get('/:name', wrap(async (req, res) => {
  const name = nameOk(req.params.name);
  const yml = await fsp.readFile(fileOf(name), 'utf8');
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dirOf(name), 'uiable.json'), 'utf8')); } catch (_) {}
  let st = { containers: [] };
  try { st = await status(name); } catch (e) { st.error = e.message; }
  res.json({ name, yaml: yml, meta, status: st });
}));

router.post('/validate', wrap(async (req, res) => {
  try { const doc = yaml.load(req.body.yaml || ''); if (!doc || typeof doc !== 'object') throw new Error('Empty document'); if (!doc.services) throw new Error('Missing top-level "services"'); res.json({ ok: true, services: Object.keys(doc.services) }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
}));

router.post('/', wrap(async (req, res) => {
  const name = nameOk(req.body.name);
  await ensureRoot();
  try { await fsp.access(fileOf(name)); throw bad('A stack with that name already exists', 409); } catch (e) { if (e.status) throw e; }
  try { yaml.load(req.body.yaml || ''); } catch (e) { throw bad('YAML: ' + e.message); }
  await fsp.mkdir(dirOf(name), { recursive: true, mode: 0o700 });
  await fsp.writeFile(fileOf(name), req.body.yaml, { mode: 0o600 });
  if (req.body.meta) await fsp.writeFile(path.join(dirOf(name), 'uiable.json'), JSON.stringify(req.body.meta, null, 2), { mode: 0o600 });
  audit.write({ user: req.session.username, action: 'stacks.create', details: { name } });
  res.json({ ok: true, name });
}));

router.put('/:name', wrap(async (req, res) => {
  const name = nameOk(req.params.name);
  try { yaml.load(req.body.yaml || ''); } catch (e) { throw bad('YAML: ' + e.message); }
  await fsp.access(fileOf(name));
  await fsp.writeFile(fileOf(name), req.body.yaml, { mode: 0o600 });
  audit.write({ user: req.session.username, action: 'stacks.update', details: { name } });
  res.json({ ok: true });
}));

router.delete('/:name', wrap(async (req, res) => {
  const name = nameOk(req.params.name);
  // refuse to delete while containers are running unless force=1
  if (req.query.force !== '1') {
    try { const st = await status(name); if (st.containers.some((c) => /running|restarting/i.test(c.State || c.Status || ''))) throw bad('Stack is still running. Bring it down first, or pass force=1.', 409); } catch (e) { if (e.status) throw e; }
  }
  await fsp.rm(dirOf(name), { recursive: true, force: true });
  audit.write({ user: req.session.username, action: 'stacks.delete', details: { name } });
  res.json({ ok: true });
}));

router.post('/:name/:action', wrap(async (req, res) => {
  const name = nameOk(req.params.name);
  const action = req.params.action;
  const map = { up: ['up', '-d', '--remove-orphans'], down: ['down'], pull: ['pull'], restart: ['restart'], stop: ['stop'], start: ['start'] };
  if (!map[action]) throw bad('Bad action');
  await fsp.access(fileOf(name));
  const [bin, prefix] = await composeCmd();
  const job = jobs.runHost(`compose ${action} ${name}`, req.session.username, bin, [...prefix, '-f', stacksHostPath(fileOf(name)), '-p', name, ...map[action]], { timeout: 30 * 60 * 1000 });
  audit.write({ user: req.session.username, action: `stacks.${action}`, details: { name, job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));

router.get('/:name/logs', wrap(async (req, res) => {
  const name = nameOk(req.params.name);
  const [bin, prefix] = await composeCmd();
  const r = await host.run(bin, [...prefix, '-f', stacksHostPath(fileOf(name)), '-p', name, 'logs', '--no-color', '--tail', String(Math.min(2000, Number(req.query.tail) || 200))], { timeout: 30000 });
  res.json({ logs: (r.stdout + r.stderr).trim() });
}));

module.exports = Object.assign(router, { STACKS, list, nameOk, dirOf, fileOf, ensureRoot, composeCmd, stacksHostPath });
