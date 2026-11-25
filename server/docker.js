'use strict';
// Minimal Docker Engine API client over the unix socket (no docker CLI needed).
const http = require('http');
const fs = require('fs');

const DOCKER_SOCK = process.env.DOCKER_SOCK || '/var/run/docker.sock';
const PODMAN_SOCK = process.env.PODMAN_SOCK || '/var/run/podman/podman.sock';
let ENGINE = null; // 'docker' | 'podman' | null
let SOCK = DOCKER_SOCK;

function detectEngine() {
  if (ENGINE) return ENGINE;
  const prefer = (process.env.UIABLE_CONTAINER_ENGINE || '').toLowerCase();
  const candidates = prefer === 'podman'
    ? [[PODMAN_SOCK, 'podman'], [DOCKER_SOCK, 'docker']]
    : prefer === 'docker'
      ? [[DOCKER_SOCK, 'docker'], [PODMAN_SOCK, 'podman']]
      : [[DOCKER_SOCK, 'docker'], [PODMAN_SOCK, 'podman']];
  for (const [sock, name] of candidates) {
    try {
      if (fs.statSync(sock).isSocket()) { SOCK = sock; ENGINE = name; return ENGINE; }
    } catch (_) {}
  }
  ENGINE = null;
  return null;
}

function available() { return !!detectEngine(); }
function engine() { return detectEngine(); }
function socketPath() { detectEngine(); return SOCK; }

function request(method, path, { body, raw, timeout } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(Object.assign(new Error(`No Docker/Podman socket (tried ${DOCKER_SOCK} and ${PODMAN_SOCK})`), { status: 503 }));
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCK, path, method,
      headers: Object.assign({ Host: 'docker' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: timeout || 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          let msg = buf.toString();
          try { msg = JSON.parse(msg).message || msg; } catch (_) {}
          return reject(Object.assign(new Error(msg || `Docker error ${res.statusCode}`), { status: res.statusCode }));
        }
        if (raw) return resolve(buf);
        const s = buf.toString();
        if (!s) return resolve(null);
        try { resolve(JSON.parse(s)); } catch (_) { resolve(s); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker request timed out')));
    req.on('error', (e) => reject(Object.assign(e, { status: e.status || 502 })));
    if (data) req.write(data);
    req.end();
  });
}

// Docker multiplexes stdout/stderr with 8-byte frame headers when the container has no TTY.
function demux(buf) {
  const out = [];
  let i = 0;
  const looksMux = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2 || buf[0] === 0) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMux) return buf.toString('utf8');
  while (i + 8 <= buf.length) {
    const len = buf.readUInt32BE(i + 4);
    out.push(buf.slice(i + 8, i + 8 + len).toString('utf8'));
    i += 8 + len;
  }
  return out.join('');
}

const id = (s) => { if (!/^[\w.\-:/@]+$/.test(String(s))) throw Object.assign(new Error('Bad id'), { status: 400 }); return encodeURIComponent(s); };

function calcStats(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const ncpu = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cache = s.memory_stats?.stats?.inactive_file ?? s.memory_stats?.stats?.cache ?? 0;
  let rx = 0, tx = 0;
  Object.values(s.networks || {}).forEach((n) => { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; });
  let br = 0, bw = 0;
  (s.blkio_stats?.io_service_bytes_recursive || []).forEach((b) => { if (/read/i.test(b.op)) br += b.value; if (/write/i.test(b.op)) bw += b.value; });
  return {
    cpu: sysDelta > 0 ? (cpuDelta / sysDelta) * ncpu * 100 : 0,
    memUsed: Math.max(0, (s.memory_stats?.usage || 0) - cache),
    memLimit: s.memory_stats?.limit || 0,
    netRx: rx, netTx: tx, blockRead: br, blockWrite: bw,
    pids: s.pids_stats?.current || 0,
  };
}


// ---- 1.2.8: container page helpers ----------------------------------------
// Env keys whose values are secrets. Values of other keys still get URL
// credentials (scheme://user:pass@host) masked.
const SECRET_ENV = /pass(word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private|credential|auth|cookie|session|salt|signing|encryption|_key$|^key$|license/i;
const MASK = '••••••';
function maskEnv(env) {
  const masked = [];
  const out = (env || []).map((e) => {
    const s = String(e); const i = s.indexOf('=');
    if (i < 0) return s;
    const k = s.slice(0, i); const v = s.slice(i + 1);
    if (v && SECRET_ENV.test(k)) { masked.push(k); return `${k}=${MASK}`; }
    const v2 = v.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)([^@\s]+)@/gi, (m, a) => `${a}${MASK}@`);
    if (v2 !== v) masked.push(k);
    return `${k}=${v2}`;
  });
  return { env: out, masked };
}

/** Inspect output with secret env values masked (reveal=true returns it as-is). */
async function detail(cid, { reveal } = {}) {
  const insp = await module.exports.inspect(cid);
  if (reveal || !insp || !insp.Config) return { inspect: insp, masked: [] };
  const m = maskEnv(insp.Config.Env);
  const copy = Object.assign({}, insp, { Config: Object.assign({}, insp.Config, { Env: m.env }) });
  return { inspect: copy, masked: m.masked };
}

// Live CPU/memory for every running container (container list sparklines).
// One shared, short-lived cache so many open tabs don't multiply the work.
let statsCache = { at: 0, data: null, pending: null };
async function statsAll({ maxAgeMs = 4000, concurrency = 6 } = {}) {
  if (statsCache.data && Date.now() - statsCache.at < maxAgeMs) return statsCache.data;
  if (statsCache.pending) return statsCache.pending;
  statsCache.pending = (async () => {
    const list = (await module.exports.containers()).filter((c) => c.State === 'running');
    const out = {};
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const c = list[i++];
        try { out[c.Id] = await module.exports.stats(c.Id); } catch (_) { /* container went away */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    statsCache = { at: Date.now(), data: { at: Date.now(), stats: out }, pending: null };
    return statsCache.data;
  })().catch((e) => { statsCache.pending = null; throw e; });
  return statsCache.pending;
}

/** "repo[:tag]" / "repo@sha256:…" → { fromImage, tag } for POST /images/create. */
function parseImageRef(ref) {
  const r = String(ref || '');
  if (!r || /^sha256:/.test(r) || /^[a-f0-9]{12,64}$/.test(r)) return null;
  const at = r.indexOf('@');
  if (at > 0) return { fromImage: r.slice(0, at), tag: r.slice(at + 1) };
  const slash = r.lastIndexOf('/'); const colon = r.lastIndexOf(':');
  if (colon > slash) return { fromImage: r.slice(0, colon), tag: r.slice(colon + 1) };
  return { fromImage: r, tag: 'latest' };
}

/**
 * Body for POST /containers/create that reproduces an inspected container on
 * `image`. Runtime-only fields are dropped; the first network goes into
 * NetworkingConfig, the rest are returned in `extraNetworks` to connect after.
 */
function buildCreateSpec(insp, image) {
  const cfg = JSON.parse(JSON.stringify(insp.Config || {}));
  const hc = JSON.parse(JSON.stringify(insp.HostConfig || {}));
  cfg.Image = image || cfg.Image;
  // Docker sets Hostname to the short id when none was given: let the new container get its own.
  if (cfg.Hostname && insp.Id && insp.Id.startsWith(cfg.Hostname)) delete cfg.Hostname;
  const nets = Object.entries((insp.NetworkSettings && insp.NetworkSettings.Networks) || {});
  const mode = hc.NetworkMode || 'default';
  const endpoint = (n) => {
    const o = {};
    if (n.IPAMConfig && Object.values(n.IPAMConfig).some(Boolean)) o.IPAMConfig = n.IPAMConfig;
    if (Array.isArray(n.Links) && n.Links.length) o.Links = n.Links;
    if (Array.isArray(n.Aliases) && n.Aliases.length) o.Aliases = n.Aliases.filter((a) => !(insp.Id || '').startsWith(a));
    if (n.DriverOpts) o.DriverOpts = n.DriverOpts;
    return o;
  };
  const shared = /^(host|none|container:)/.test(mode);
  const first = shared ? null : (nets.find(([name]) => name === mode) || nets[0]);
  const spec = Object.assign({}, cfg, { HostConfig: hc });
  if (first) spec.NetworkingConfig = { EndpointsConfig: { [first[0]]: endpoint(first[1]) } };
  const extraNetworks = shared ? [] : nets.filter((n) => n !== first).map(([name, n]) => ({ name, endpoint: endpoint(n) }));
  return { spec, extraNetworks };
}

async function pullImage(ref, log = () => {}) {
  const p = parseImageRef(ref);
  if (!p) throw Object.assign(new Error(`Can't pull "${ref}": the container uses an image ID, not a name`), { status: 400 });
  log(`Pulling ${p.fromImage}:${p.tag}…\n`);
  const buf = await request('POST', `/images/create?fromImage=${encodeURIComponent(p.fromImage)}&tag=${encodeURIComponent(p.tag)}`, { raw: true, timeout: 30 * 60 * 1000 });
  let last = '';
  for (const line of buf.toString().split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.error || j.errorDetail) throw new Error(j.error || (j.errorDetail && j.errorDetail.message) || 'Pull failed');
    if (j.status && j.status !== last && !j.progressDetail?.current) { last = j.status; if (/Digest|Status|Pulling from|Downloaded/.test(j.status)) log(j.status + (j.id ? ` ${j.id}` : '') + '\n'); }
  }
}

/**
 * Pull the container's image (optional) and recreate it with the same settings.
 * Old container is renamed, not removed, until the new one is created and started;
 * any failure puts the old one back.
 */
async function recreate(cid, { pull = true, log = () => {}, runHost } = {}) {
  const insp = await module.exports.inspect(cid);
  const name = String(insp.Name || '').replace(/^\//, '');
  const image = insp.Config && insp.Config.Image;
  const L = (insp.Config && insp.Config.Labels) || {};
  if (L['com.docker.compose.project'] && L['com.docker.compose.service'] && L['com.docker.compose.project.working_dir'] && runHost) {
    const dir = L['com.docker.compose.project.working_dir'];
    const files = String(L['com.docker.compose.project.config_files'] || 'docker-compose.yml').split(',').map((f) => (f.startsWith('/') ? f : `${dir}/${f}`));
    const base = ['compose', ...files.flatMap((f) => ['-f', f]), '-p', L['com.docker.compose.project']];
    const svc = L['com.docker.compose.service'];
    log(`Compose project "${L['com.docker.compose.project']}", service "${svc}"\n`);
    if (pull) {
      const r = await runHost('docker', [...base, 'pull', svc], { timeout: 30 * 60 * 1000 });
      log(r.stdout + r.stderr);
      if (r.code === 127) log('docker CLI not found on the host; recreating through the Docker API instead.\n');
      else if (r.code !== 0) throw new Error('docker compose pull failed');
    }
    const r2 = await runHost('docker', [...base, 'up', '-d', '--no-deps', '--force-recreate', svc], { timeout: 10 * 60 * 1000 });
    if (r2.code !== 127) {
      log(r2.stdout + r2.stderr);
      if (r2.code !== 0) throw new Error('docker compose up failed');
      log(`Recreated ${name}.\n`);
      return { name, via: 'compose' };
    }
  }
  if (pull) await pullImage(image, log);
  const { spec, extraNetworks } = buildCreateSpec(insp, image);
  const wasRunning = !!(insp.State && insp.State.Running);
  const old = `${name}_old_${Date.now()}`;
  let newId = null;
  if (wasRunning) { log(`Stopping ${name}…\n`); await request('POST', `/containers/${id(insp.Id)}/stop?t=20`); }
  await request('POST', `/containers/${id(insp.Id)}/rename?name=${encodeURIComponent(old)}`);
  try {
    log(`Creating ${name} from ${image}…\n`);
    const created = await request('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });
    newId = created.Id;
    for (const n of extraNetworks) await request('POST', `/networks/${id(n.name)}/connect`, { body: { Container: newId, EndpointConfig: n.endpoint } });
    if (wasRunning) { log('Starting…\n'); await request('POST', `/containers/${id(newId)}/start`); }
  } catch (e) {
    log(`Failed: ${e.message}\nRestoring the previous container…\n`);
    if (newId) await request('DELETE', `/containers/${id(newId)}?force=1&v=0`).catch(() => {});
    await request('POST', `/containers/${id(insp.Id)}/rename?name=${encodeURIComponent(name)}`).catch(() => {});
    if (wasRunning) await request('POST', `/containers/${id(insp.Id)}/start`).catch(() => {});
    throw e;
  }
  await request('DELETE', `/containers/${id(insp.Id)}?force=1&v=0`).catch((e) => log(`Note: couldn't remove ${old}: ${e.message}\n`));
  log(`Recreated ${name} (${String(newId).slice(0, 12)}).\n`);
  return { name, via: 'api', id: newId };
}

module.exports = {
  maskEnv, detail, statsAll, parseImageRef, buildCreateSpec, pullImage, recreate, _request: request,
  get SOCK() { return socketPath(); },
  available, engine, socketPath,
  info: () => request('GET', '/info'),
  containers: () => request('GET', '/containers/json?all=1'),
  action: (cid, act) => {
    if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(act)) throw Object.assign(new Error('Bad action'), { status: 400 });
    return request('POST', `/containers/${id(cid)}/${act}`);
  },
  remove: (cid) => request('DELETE', `/containers/${id(cid)}?force=1&v=0`),
  inspect: (cid) => request('GET', `/containers/${id(cid)}/json`),
  logs: async (cid, tail = 500) => {
    const buf = await request('GET', `/containers/${id(cid)}/logs?stdout=1&stderr=1&timestamps=1&tail=${Math.min(5000, Math.max(1, tail | 0))}`, { raw: true });
    return demux(buf);
  },
  stats: async (cid) => calcStats(await request('GET', `/containers/${id(cid)}/stats?stream=false`)),
  images: () => request('GET', '/images/json'),
  removeImage: (iid) => request('DELETE', `/images/${id(iid)}?force=0`),
  volumes: () => request('GET', '/volumes'),
  removeVolume: (name) => request('DELETE', `/volumes/${id(name)}`),
  prune: (what) => {
    const map = { images: '/images/prune?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D', containers: '/containers/prune', volumes: '/volumes/prune' };
    if (!map[what]) throw Object.assign(new Error('Bad prune target'), { status: 400 });
    return request('POST', map[what]);
  },
};
