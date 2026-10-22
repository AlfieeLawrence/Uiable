'use strict';
// Host package updates (apt/dnf/apk) and Docker image updates (digest compare).
// Checking only happens on demand or from the alerts loop (every few hours).
const express = require('express');
const host = require('./host');
const docker = require('./docker');
const jobs = require('./jobs');
const audit = require('./audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let cache = { at: 0, packages: null, images: null };
const CACHE_MS = 30 * 60 * 1000;

async function detectPkg() {
  if ((await host.has('apt-get'))) return 'apt';
  if ((await host.has('dnf'))) return 'dnf';
  if ((await host.has('apk'))) return 'apk';
  return null;
}

async function hostPackages(force) {
  if (!force && cache.packages && Date.now() - cache.at < CACHE_MS) return cache.packages;
  const kind = await detectPkg();
  if (!kind) return { available: false, message: 'No supported package manager (apt, dnf or apk) found on the host.', updates: [], kind: null };
  let updates = [], message = null;
  if (kind === 'apt') {
    // Update the index only when asked (network call). Listing uses the cached index.
    if (force) await host.run('apt-get', ['update', '-qq'], { timeout: 5 * 60 * 1000 });
    const r = await host.run('apt', ['list', '--upgradable'], { timeout: 60000 });
    updates = r.stdout.split('\n').slice(1).filter((l) => l.includes('/')).map((l) => {
      // name/suite version arch [upgradable from: old]
      const m = l.match(/^([^/\s]+)\/\S+\s+(\S+)\s+(\S+)\s+\[upgradable from: ([^\]]+)\]/);
      return m ? { name: m[1], newVersion: m[2], arch: m[3], oldVersion: m[4] } : null;
    }).filter(Boolean);
  } else if (kind === 'dnf') {
    if (force) await host.run('dnf', ['check-update', '-q'], { timeout: 5 * 60 * 1000 });
    const r = await host.run('dnf', ['check-update', '-q'], { timeout: 120000 });
    // exit 100 = updates available
    updates = r.stdout.split('\n').filter((l) => /^\S+\.\S+\s+\S+\s+\S+/.test(l)).map((l) => {
      const [nameArch, ver, repo] = l.trim().split(/\s+/);
      return { name: nameArch.replace(/\.[^.]+$/, ''), newVersion: ver, arch: nameArch.split('.').pop(), oldVersion: '', repo };
    });
  } else if (kind === 'apk') {
    if (force) await host.run('apk', ['update'], { timeout: 5 * 60 * 1000 });
    const r = await host.run('apk', ['version', '-l', '<'], { timeout: 60000 });
    updates = r.stdout.split('\n').filter(Boolean).map((l) => {
      const m = l.match(/^(\S+)\s+-\s+(\S+)\s+<\s+(\S+)/);
      return m ? { name: m[1], oldVersion: m[2], newVersion: m[3], arch: '' } : null;
    }).filter(Boolean);
  }
  const result = { available: true, kind, updates, message, checkedAt: Date.now() };
  cache.packages = result; cache.at = Date.now();
  return result;
}

async function imageDigest(ref) {
  // Prefer the registry's current digest without downloading the layers.
  const r = await host.run('docker', ['manifest', 'inspect', '--verbose', ref], { timeout: 60000 });
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.stdout);
      const d = Array.isArray(j) ? (j[0].Descriptor || j[0].SchemaV2Manifest?.config) : (j.Descriptor || j);
      const dig = d?.digest || d?.Digest || (Array.isArray(j) ? j[0]?.Descriptor?.digest : null);
      if (dig) return dig;
      // multi-arch index
      if (j.mediaType && j.manifests) return j.digest || null;
    } catch (_) {}
    const m = r.stdout.match(/"digest"\s*:\s*"(sha256:[a-f0-9]+)"/);
    if (m) return m[1];
  }
  return null;
}

async function imageUpdates(force) {
  if (!force && cache.images && Date.now() - cache.at < CACHE_MS) return cache.images;
  if (!docker.available()) return { available: false, message: 'Docker socket not available.', images: [] };
  const list = await docker.images();
  const ctrs = await docker.containers();
  // Only check images that are actually used by a container (tagged ones).
  const used = new Map();
  ctrs.forEach((c) => {
    const tag = c.Image;
    if (!tag || tag.includes('sha256:')) return;
    used.set(tag, used.get(tag) || { tag, containers: [], localId: c.ImageID || c.Id });
    used.get(tag).containers.push(c.Names[0].replace(/^\//, ''));
  });
  // Resolve local RepoDigests for a proper compare.
  const byId = new Map(list.map((i) => [i.Id, i]));
  const images = [];
  for (const [tag, info] of used) {
    const img = [...byId.values()].find((i) => (i.RepoTags || []).includes(tag)) || byId.get(info.localId);
    const localDigests = (img && img.RepoDigests) || [];
    const local = localDigests.map((d) => d.split('@')[1]).filter(Boolean)[0] || null;
    let remote = null, err = null, update = false;
    try {
      remote = await imageDigest(tag);
      if (local && remote) update = local !== remote;
      else if (!local && remote) update = true; // no local digest recorded, assume check is advisory
    } catch (e) { err = e.message; }
    images.push({ tag, local, remote, update, containers: info.containers, error: err, compose: (() => {
      const c = ctrs.find((x) => (x.Image === tag) && x.Labels && x.Labels['com.docker.compose.project']);
      return c ? { project: c.Labels['com.docker.compose.project'], service: c.Labels['com.docker.compose.service'], workingDir: c.Labels['com.docker.compose.project.working_dir'] } : null;
    })() });
  }
  const result = { available: true, images, checkedAt: Date.now() };
  cache.images = result; cache.at = Date.now();
  return result;
}

router.get('/host', wrap(async (req, res) => res.json(await hostPackages(req.query.refresh === '1'))));
router.get('/images', wrap(async (req, res) => res.json(await imageUpdates(req.query.refresh === '1'))));

router.post('/host/apply', wrap(async (req, res) => {
  const kind = await detectPkg();
  if (!kind) throw bad('No package manager', 501);
  let job;
  if (kind === 'apt') job = jobs.runHost('apt upgrade', req.session.username, 'sh', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade'], { timeout: 60 * 60 * 1000 });
  else if (kind === 'dnf') job = jobs.runHost('dnf upgrade', req.session.username, 'dnf', ['-y', 'upgrade'], { timeout: 60 * 60 * 1000 });
  else job = jobs.runHost('apk upgrade', req.session.username, 'apk', ['upgrade'], { timeout: 60 * 60 * 1000 });
  cache.packages = null;
  audit.write({ user: req.session.username, action: 'updates.host.apply', details: { job: job.id, kind } });
  res.json({ ok: true, job: jobs.view(job) });
}));

router.post('/images/apply', wrap(async (req, res) => {
  const tag = String(req.body.tag || '');
  if (!/^[\w.\/\-:@]+$/.test(tag)) throw bad('Bad image tag');
  const info = (await imageUpdates(false)).images.find((i) => i.tag === tag);
  const job = jobs.runFn(`Update image ${tag}`, req.session.username, async (log) => {
    log(`Pulling ${tag}…\n`);
    const pull = await host.run('docker', ['pull', tag], { timeout: 30 * 60 * 1000 });
    log(pull.stdout + pull.stderr);
    if (pull.code !== 0) throw new Error('Pull failed');
    // Recreate containers that use this image.
    const ctrs = (await docker.containers()).filter((c) => c.Image === tag);
    for (const c of ctrs) {
      const name = c.Names[0].replace(/^\//, '');
      const compose = c.Labels && c.Labels['com.docker.compose.project'];
      if (compose && c.Labels['com.docker.compose.project.working_dir']) {
        const dir = c.Labels['com.docker.compose.project.working_dir'];
        const file = c.Labels['com.docker.compose.project.config_files'] || 'docker-compose.yml';
        log(`\nRecreating via compose project "${compose}"…\n`);
        const r = await host.run('docker', ['compose', '-f', file.includes('/') ? file : `${dir}/${file}`, '-p', compose, 'up', '-d', '--no-deps', '--force-recreate', c.Labels['com.docker.compose.service']], { timeout: 10 * 60 * 1000 });
        log(r.stdout + r.stderr);
        if (r.code !== 0) throw new Error(`compose recreate failed for ${name}`);
      } else {
        log(`\nRecreating ${name} with the same config…\n`);
        // Capture the create args via inspect, then force-recreate with `docker run` equivalents is hard;
        // use `docker container recreate` pattern: stop → rename → run --volumes-from → remove old.
        const insp = await docker.inspect(c.Id);
        const wasRunning = insp.State.Running;
        if (wasRunning) await docker.action(c.Id, 'stop');
        const old = `${name}_old_${Date.now()}`;
        await host.run('docker', ['rename', name, old], { timeout: 15000 });
        const args = ['run', '-d', '--name', name];
        (insp.HostConfig.Binds || []).forEach((b) => args.push('-v', b));
        (insp.HostConfig.PortBindings ? Object.entries(insp.HostConfig.PortBindings) : []).forEach(([k, v]) => {
          (v || []).forEach((p) => args.push('-p', `${p.HostIp ? p.HostIp + ':' : ''}${p.HostPort}:${k}`));
        });
        (insp.Config.Env || []).forEach((e) => args.push('-e', e));
        if (insp.HostConfig.NetworkMode && insp.HostConfig.NetworkMode !== 'default') args.push('--network', insp.HostConfig.NetworkMode);
        if (insp.HostConfig.RestartPolicy && insp.HostConfig.RestartPolicy.Name) args.push('--restart', insp.HostConfig.RestartPolicy.Name);
        if (insp.HostConfig.Privileged) args.push('--privileged');
        if (insp.Config.Cmd && insp.Config.Cmd.length) { args.push(tag); args.push(...insp.Config.Cmd); } else args.push(tag);
        const run = await host.run('docker', args, { timeout: 5 * 60 * 1000 });
        log(run.stdout + run.stderr);
        if (run.code !== 0) {
          log('Recreate failed; restoring old container name.\n');
          await host.run('docker', ['rename', old, name], { timeout: 15000 });
          if (wasRunning) await docker.action(c.Id, 'start');
          throw new Error(`Failed to recreate ${name}`);
        }
        await host.run('docker', ['rm', '-f', old], { timeout: 30000 });
        log(`Recreated ${name}.\n`);
      }
    }
    if (!ctrs.length) log('No containers used this image; pull only.\n');
  });
  cache.images = null;
  audit.write({ user: req.session.username, action: 'updates.images.apply', details: { tag, job: job.id, compose: info && info.compose } });
  res.json({ ok: true, job: jobs.view(job) });
}));

module.exports = Object.assign(router, { hostPackages, imageUpdates });
