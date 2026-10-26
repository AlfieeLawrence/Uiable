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


// ---- Uiable agent self-update (GitHub releases) ----
const REPO = () => process.env.UIABLE_UPDATE_REPO || 'AlfieeLawrence/uiable';
const https = require('https');

function currentVersion() {
  try { return require('../BUILD_INFO.json').version; } catch (_) {}
  try { return require('../package.json').version; } catch (_) {}
  return '0.0.0';
}

function ghGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com', path, method: 'GET',
      headers: {
        'User-Agent': 'Uiable-SelfUpdater',
        'Accept': 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN } : {}),
      },
      timeout: 20000,
    }, (res) => {
      let d = '';
      res.on('data', (x) => { if (d.length < 5e6) d += x; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('GitHub HTTP ' + res.statusCode + ': ' + d.slice(0, 200)));
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

function cmpVer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, '').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}


async function fetchRelease(tag) {
  const repo = REPO();
  if (tag && tag !== 'latest') {
    return ghGet('/repos/' + repo + '/releases/tags/' + encodeURIComponent(tag.startsWith('v') ? tag : 'v' + tag));
  }
  return ghGet('/repos/' + repo + '/releases/latest');
}

function pickAsset(rel) {
  const assets = rel.assets || [];
  const pkg = assets.find((a) => /\.(tar\.gz|tgz|zip)$/i.test(a.name)) || null;
  const sum = assets.find((a) => /sha256|checksums?\.txt$/i.test(a.name))
    || assets.find((a) => pkg && a.name === pkg.name + '.sha256')
    || assets.find((a) => pkg && a.name === pkg.name + '.sha256sum')
    || null;
  return { pkg, sum };
}

async function fetchTextUrl(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const lib = String(url).startsWith('http:') ? http : https;
    const req = lib.get(url, { headers: { 'User-Agent': 'uiable', Accept: 'application/octet-stream' }, timeout: 60000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchTextUrl(res.headers.location).then(resolve, reject);
      }
      let d = '';
      res.on('data', (x) => { if (d.length < 2e6) d += x; });
      res.on('end', () => res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode)) : resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function parseChecksum(text, assetName) {
  if (!text) return null;
  const lines = text.trim().split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/([a-fA-F0-9]{64})\s+\*?(\S+)/) || line.match(/^([a-fA-F0-9]{64})\s*$/);
    if (!m) continue;
    if (!m[2] || m[2] === assetName || m[2].endsWith('/' + assetName) || assetName.endsWith(m[2])) return m[1].toLowerCase();
    if (lines.length === 1) return m[1].toLowerCase();
  }
  // bare hash file
  const bare = text.trim().match(/^([a-fA-F0-9]{64})$/m);
  return bare ? bare[1].toLowerCase() : null;
}

function installDir() { return process.env.UIABLE_DIR || '/opt/uiable'; }
function backupDir() { return process.env.UIABLE_BACKUP_DIR || (installDir() + '.bak'); }
function healthUrl() {
  return process.env.UIABLE_HEALTH_URL || ('http://127.0.0.1:' + (process.env.UIABLE_PORT || process.env.PORT || '8080') + '/api/health');
}

router.get('/self', wrap(async (req, res) => {
  const current = currentVersion();
  const repo = REPO();
  const pin = req.query.version || req.query.tag || null;
  try {
    const rel = await fetchRelease(pin);
    const latest = (rel.tag_name || rel.name || '').replace(/^v/, '');
    const { pkg, sum } = pickAsset(rel);
    const bak = backupDir();
    let rollbackReady = false;
    try {
      const st = await host.run('sh', ['-c', 'test -d "$0" && test -f "$0/package.json" && echo yes', bak], { timeout: 5000 });
      rollbackReady = (st.stdout || '').includes('yes');
    } catch (_) {}
    res.json({
      available: true,
      current,
      latest,
      pinned: pin || null,
      update: latest ? cmpVer(latest, current) > 0 : false,
      name: rel.name || rel.tag_name,
      url: rel.html_url,
      publishedAt: rel.published_at,
      asset: pkg ? { name: pkg.name, size: pkg.size, url: pkg.browser_download_url } : null,
      checksumAsset: sum ? { name: sum.name, url: sum.browser_download_url } : null,
      repo,
      rollbackReady,
      backupDir: bak,
      note: 'Apply pins a release, verifies sha256 when published, health-checks, then swaps. Rollback restores the previous tree.',
    });
  } catch (e) {
    res.json({ available: false, current, repo, message: e.message, update: false });
  }
}));

router.post('/self/apply', wrap(async (req, res) => {
  const current = currentVersion();
  const repo = REPO();
  const pin = (req.body && (req.body.version || req.body.tag)) || null;
  const rel = await fetchRelease(pin);
  const latest = (rel.tag_name || '').replace(/^v/, '');
  if (!latest) throw bad('No release tag');
  if (!pin && cmpVer(latest, current) <= 0) throw bad('Already up to date (current ' + current + ')');
  const { pkg, sum } = pickAsset(rel);
  const url = pkg ? pkg.browser_download_url : (rel.tarball_url || null);
  if (!url) throw bad('No downloadable asset on release', 404);
  let expectSha = null;
  if (sum && sum.browser_download_url) {
    try {
      const txt = await fetchTextUrl(sum.browser_download_url);
      expectSha = parseChecksum(txt, pkg ? pkg.name : '');
    } catch (e) {
      throw bad('Checksum asset present but could not be fetched: ' + e.message, 502);
    }
    if (!expectSha) throw bad('Checksum asset present but no sha256 found for ' + (pkg && pkg.name), 502);
  }
  const dest = installDir();
  const bak = backupDir();
  const job = jobs.runFn('Uiable self-update to ' + latest, req.session.username, async (log) => {
    log('Current: ' + current + ' → ' + latest + (pin ? ' (pinned)' : '') + '\n');
    log('Downloading ' + url + '\n');
    const tmp = '/tmp/uiable-update-' + Date.now();
    await host.run('mkdir', ['-p', tmp], { timeout: 5000 });
    const dl = await host.run('sh', ['-c', 'curl -fsSL "$0" -o "$1/pkg" || wget -qO "$1/pkg" "$0"', url, tmp], { timeout: 10 * 60 * 1000 });
    if (dl.code !== 0) throw new Error('Download failed: ' + (dl.stderr || dl.stdout));
    if (expectSha) {
      log('Verifying sha256 ' + expectSha.slice(0, 12) + '…\n');
      const hs = await host.run('sha256sum', [tmp + '/pkg'], { timeout: 120000 });
      const got = ((hs.stdout || '').trim().split(/\s+/)[0] || '').toLowerCase();
      if (got !== expectSha) throw new Error('Checksum mismatch: got ' + got + ' expected ' + expectSha);
      log('Checksum OK\n');
    } else {
      log('No checksum asset on release — skipping verify\n');
    }
    // Stage extract for health peek
    const stage = tmp + '/stage';
    await host.run('mkdir', ['-p', stage], { timeout: 5000 });
    let ex;
    if (pkg && /\.zip$/i.test(pkg.name)) {
      ex = await host.run('sh', ['-c', 'unzip -qo "$0/pkg" -d "$0/x" && cp -a "$0/x"/. "$1"/', tmp, stage], { timeout: 5 * 60 * 1000 });
    } else {
      ex = await host.run('sh', ['-c', 'tar -xzf "$0/pkg" -C "$0" && src=$(find "$0" -maxdepth 2 -type d -name server | head -1 | xargs dirname) && cp -a "$src"/. "$1"/', tmp, stage], { timeout: 5 * 60 * 1000 });
    }
    if (ex.code !== 0) throw new Error('Extract failed: ' + (ex.stderr || ex.stdout));
    const peek = await host.run('sh', ['-c', 'test -f "$0/package.json" && test -d "$0/server" && echo ok', stage], { timeout: 5000 });
    if (!(peek.stdout || '').includes('ok')) throw new Error('Health-check before swap failed: package.json/server missing in archive');
    log('Pre-swap archive health-check OK\n');
    // Backup current install for rollback
    log('Backing up ' + dest + ' → ' + bak + '\n');
    await host.run('sh', ['-c', 'rm -rf "$1" && mkdir -p "$1" && if [ -d "$0" ]; then cp -a "$0"/. "$1"/; fi', dest, bak], { timeout: 5 * 60 * 1000 });
    log('Installing into ' + dest + '\n');
    const inst = await host.run('sh', ['-c', 'mkdir -p "$0" && cp -a "$1"/. "$0"/', dest, stage], { timeout: 5 * 60 * 1000 });
    if (inst.code !== 0) throw new Error('Install copy failed');
    log('Rebuilding container...\n');
    const up = await host.run('sh', ['-c', 'cd "$0" && (docker compose up -d --build || docker-compose up -d --build)', dest], { timeout: 20 * 60 * 1000 });
    log((up.stdout || '') + (up.stderr || ''));
    if (up.code !== 0) throw new Error('compose up failed — try POST /updates/self/rollback');
    // Post-swap health
    log('Waiting for health at ' + healthUrl() + '\n');
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const h = await host.run('sh', ['-c', 'curl -fsS -o /dev/null -w "%{http_code}" "$0" || wget -qO- "$0" >/dev/null && echo 200', healthUrl()], { timeout: 10000 });
      if ((h.stdout || '').includes('200') || (h.stdout || '').trim() === '200') { healthy = true; break; }
    }
    if (!healthy) {
      log('Post-swap health-check failed — automatic rollback\n');
      const rb = await host.run('sh', ['-c', 'if [ -d "$1" ]; then rm -rf "$0"/* "$0"/.[!.]* 2>/dev/null; cp -a "$1"/. "$0"/; cd "$0" && (docker compose up -d --build || docker-compose up -d --build); fi', dest, bak], { timeout: 20 * 60 * 1000 });
      log((rb.stdout || '') + (rb.stderr || ''));
      throw new Error('Health-check failed after swap; rolled back to previous install');
    }
    log('Healthy. New version should be ' + latest + '\n');
    await host.run('rm', ['-rf', tmp], { timeout: 10000 });
  });
  audit.write({ user: req.session.username, action: 'updates.self.apply', details: { from: current, to: latest, pin, checksum: !!expectSha, job: job.id } });
  res.json({ ok: true, job: jobs.view(job), to: latest, checksum: !!expectSha });
}));

router.post('/self/rollback', wrap(async (req, res) => {
  const dest = installDir();
  const bak = backupDir();
  const job = jobs.runFn('Uiable rollback', req.session.username, async (log) => {
    const check = await host.run('sh', ['-c', 'test -d "$0" && test -f "$0/package.json" && echo yes', bak], { timeout: 5000 });
    if (!(check.stdout || '').includes('yes')) throw new Error('No rollback tree at ' + bak);
    log('Restoring ' + bak + ' → ' + dest + '\n');
    const r = await host.run('sh', ['-c', 'mkdir -p "$0" && rm -rf "$0"/* "$0"/.[!.]* 2>/dev/null; cp -a "$1"/. "$0"/ && cd "$0" && (docker compose up -d --build || docker-compose up -d --build)', dest, bak], { timeout: 20 * 60 * 1000 });
    log((r.stdout || '') + (r.stderr || ''));
    if (r.code !== 0) throw new Error('Rollback compose failed');
    log('Rollback complete\n');
  });
  audit.write({ user: req.session.username, action: 'updates.self.rollback', details: { job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));



module.exports = Object.assign(router, { hostPackages, imageUpdates });
