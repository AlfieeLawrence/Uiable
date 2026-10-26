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

function request(method, path, { body, raw } = {}) {
  return new Promise((resolve, reject) => {
    if (!available()) return reject(Object.assign(new Error(`No Docker/Podman socket (tried ${DOCKER_SOCK} and ${PODMAN_SOCK})`), { status: 503 }));
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCK, path, method,
      headers: Object.assign({ Host: 'docker' }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      timeout: 60000,
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

module.exports = {
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
