'use strict';
// Listening sockets from /proc/<pid>/net (no ss/netstat spawn). With pid: host,
// PID 1's net namespace is the host's.
const fsp = require('fs').promises;
const host = require('./host');

const NET = host.MODE === 'nsenter' ? '/proc/1/net' : '/proc/net';

function hexAddr(h) {
  if (h.length === 8) return [3, 2, 1, 0].map((i) => parseInt(h.substr(i * 2, 2), 16)).join('.');
  // IPv6: four little-endian 32-bit words
  const words = [];
  for (let w = 0; w < 4; w++) {
    const s = h.substr(w * 8, 8);
    words.push(s.substr(6, 2) + s.substr(4, 2), s.substr(2, 2) + s.substr(0, 2));
  }
  return words.join(':').replace(/(^|:)0{1,3}/g, '$1').replace(/(:0)+/, '::').replace(/::$/, '::');
}

async function parse(file, proto) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  return text.split('\n').slice(1).filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    if (p.length < 10 || p[3] !== '0A') return null; // 0A = LISTEN
    const [lip, lp] = p[1].split(':');
    return { proto, address: hexAddr(lip), port: parseInt(lp, 16), inode: p[9] };
  }).filter(Boolean);
}

async function listening() {
  const rows = (await Promise.all([
    parse(`${NET}/tcp`, 'tcp'), parse(`${NET}/tcp6`, 'tcp6'),
    parse(`${NET}/udp`, 'udp'), parse(`${NET}/udp6`, 'udp6'),
  ])).flat();
  // Deduplicate (IPv4-mapped IPv6). Prefer IPv4.
  const seen = new Map();
  for (const r of rows) {
    const k = `${r.proto.replace('6', '')}:${r.port}`;
    if (!seen.has(k) || r.proto.length < seen.get(k).proto.length) seen.set(k, r);
  }
  return [...seen.values()].sort((a, b) => a.port - b.port || a.proto.localeCompare(b.proto));
}

/** Returns ports that would collide with a desired list of {port, proto?} bindings. */
async function conflicts(wanted) {
  const live = await listening();
  return wanted.map((w) => {
    const hit = live.find((l) => l.port === Number(w.port) && (!w.proto || l.proto.startsWith(w.proto)));
    return hit ? Object.assign({}, w, { usedBy: `${hit.address}:${hit.port}/${hit.proto}` }) : null;
  }).filter(Boolean);
}

module.exports = { listening, conflicts };
