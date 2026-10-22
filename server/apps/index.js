'use strict';
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const yaml = require('js-yaml');
const catalog = require('./catalog');
const compose = require('../compose');
const ports = require('../ports');
const jobs = require('../jobs');
const audit = require('../audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const byId = (id) => { const a = catalog.find((x) => x.id === id); if (!a) throw bad('Unknown app', 404); return a; };

function renderYaml(app, cfg) {
  if (typeof app.compose === 'function') {
    return yaml.dump(app.compose(cfg), { lineWidth: 120, noRefs: true });
  }
  const portsList = (app.ports || []).map((p) => {
    const host = Number(cfg.ports[p.key] ?? p.default);
    return p.protocol === 'udp' ? `${host}:${p.container}/udp` : `${host}:${p.container}`;
  });
  const volumes = (app.volumes || []).map((v) => `${cfg.volumes[v.key] || v.default}:${v.container}`);
  const environment = {};
  (app.env || []).forEach((e) => { const val = cfg.env[e.key] ?? e.default; if (val !== '' && val != null) environment[e.key] = String(val); });
  const svc = {
    image: app.image, container_name: cfg.name || app.id, restart: 'unless-stopped',
  };
  if (portsList.length) svc.ports = portsList;
  if (volumes.length) svc.volumes = volumes;
  if (Object.keys(environment).length) svc.environment = environment;
  const extra = typeof app.extra === 'function' ? app.extra(cfg) : null;
  if (extra) Object.assign(svc, extra);
  return yaml.dump({ services: { [cfg.name || app.id]: svc } }, { lineWidth: 120, noRefs: true });
}

router.get('/', wrap(async (req, res) => {
  const installed = new Set((await compose.list()).map((s) => s.name));
  // also mark by meta.app id
  const stacks = await compose.list();
  const byApp = {};
  for (const s of stacks) if (s.meta && s.meta.app) byApp[s.meta.app] = s.name;
  const openBy = {};
  for (const s of stacks) if (s.meta && s.meta.app && s.meta.open) openBy[s.meta.app] = s.meta.open;
  res.json({
    apps: catalog.map((a) => ({
      id: a.id, name: a.name, category: a.category, blurb: a.blurb, icon: a.icon, color: a.color, image: a.image,
      featured: !!a.featured, description: a.blurb,
      ports: a.ports, volumes: a.volumes, env: a.env.map((e) => ({ key: e.key, label: e.label, default: e.secret ? '' : e.default, secret: !!e.secret })),
      installed: !!byApp[a.id] || installed.has(a.id),
      stack: byApp[a.id] || (installed.has(a.id) ? a.id : null),
      open: openBy[a.id] || null,
    })),
  });
}));

router.post('/:id/install', wrap(async (req, res) => {
  const app = byId(req.params.id);
  const name = compose.nameOk(req.body.name || app.id);
  const cfg = {
    name,
    ports: Object.assign({}, ...app.ports.map((p) => ({ [p.key]: Number(req.body.ports?.[p.key] ?? p.default) }))),
    volumes: Object.assign({}, ...app.volumes.map((v) => ({ [v.key]: String(req.body.volumes?.[v.key] ?? v.default) }))),
    env: Object.assign({}, ...app.env.map((e) => ({ [e.key]: String(req.body.env?.[e.key] ?? e.default ?? '') }))),
  };
  // port conflicts
  const wanted = app.ports.map((p) => ({ port: cfg.ports[p.key], proto: (p.protocol || 'tcp').replace('udp', 'udp').replace('tcp', 'tcp'), key: p.key, warnConflict: p.warnConflict }));
  const hits = await ports.conflicts(wanted.map((w) => ({ port: w.port, proto: w.proto.startsWith('udp') ? 'udp' : 'tcp' })));
  if (hits.length && !req.body.force) {
    const msgs = hits.map((h) => {
      const w = wanted.find((x) => x.port === h.port);
      const note = w && w.warnConflict === 80 ? ' (Umbrel and many apps also want port 80)' : '';
      return `Port ${h.port} is already in use by ${h.usedBy}${note}`;
    });
    throw bad(msgs.join('. ') + '. Change the port or pass force=true.', 409);
  }
  const yml = renderYaml(app, cfg);
  await compose.ensureRoot();
  try { await fsp.access(compose.fileOf(name)); throw bad(`Stack "${name}" already exists`, 409); } catch (e) { if (e.status) throw e; }
  await fsp.mkdir(compose.dirOf(name), { recursive: true, mode: 0o700 });
  await fsp.writeFile(compose.fileOf(name), yml, { mode: 0o600 });
  await fsp.writeFile(path.join(compose.dirOf(name), 'uiable.json'), JSON.stringify({ app: app.id, open: app.open(cfg), cfg, installedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const [bin, prefix] = await compose.composeCmd();
  const job = jobs.runHost(`Install ${app.name}`, req.session.username, bin, [...prefix, '-f', compose.stacksHostPath(compose.fileOf(name)), '-p', name, 'up', '-d', '--remove-orphans'], { timeout: 30 * 60 * 1000 });
  audit.write({ user: req.session.username, action: 'apps.install', details: { app: app.id, name, job: job.id } });
  res.json({ ok: true, name, open: app.open(cfg), job: jobs.view(job) });
}));

router.post('/:id/uninstall', wrap(async (req, res) => {
  const app = byId(req.params.id);
  const stacks = await compose.list();
  const stack = stacks.find((s) => (s.meta && s.meta.app === app.id) || s.name === app.id);
  if (!stack) throw bad('App is not installed', 404);
  const [bin, prefix] = await compose.composeCmd();
  const job = jobs.runHost(`Uninstall ${app.name}`, req.session.username, bin, [...prefix, '-f', compose.stacksHostPath(compose.fileOf(stack.name)), '-p', stack.name, 'down', ...(req.body.removeVolumes ? ['-v'] : ['--remove-orphans'])], {
    timeout: 10 * 60 * 1000,
    onDone: async (j) => {
      if (j.state === 'done' && req.body.removeFiles !== false) {
        try { await fsp.rm(compose.dirOf(stack.name), { recursive: true, force: true }); } catch (_) {}
      }
    },
  });
  audit.write({ user: req.session.username, action: 'apps.uninstall', details: { app: app.id, name: stack.name, job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));

module.exports = router;
