'use strict';
// Native WireGuard peer management via `wg` / `wg-quick` on the host.
const express = require('express');
const host = require('./host');
const audit = require('./audit');
const crypto = require('crypto');

const router = express.Router();
router.use(express.json({ limit: '256kb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fail = (r, what) => bad(what + ': ' + (r.stderr || r.stdout || 'exit ' + r.code).trim(), 500);

function ifaceName(s) {
  const n = String(s || 'wg0');
  if (!/^[\w.-]{1,16}$/.test(n)) throw bad('Bad interface name');
  return n;
}

router.get('/', wrap(async (req, res) => {
  if (!(await host.has('wg'))) {
    return res.json({ available: false, message: 'WireGuard tools (wg) not found on this host. Install wireguard-tools.', interfaces: [] });
  }
  const r = await host.run('wg', ['show', 'all', 'dump'], { timeout: 10000 });
  if (r.code !== 0) throw fail(r, 'wg show');
  const ifaces = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    if (p.length < 5) continue;
    const name = p[0];
    if (!ifaces[name]) {
      // interface line: name private public listen keepalive fwmark
      ifaces[name] = {
        name,
        publicKey: p[2] || '',
        listenPort: Number(p[3]) || null,
        peers: [],
      };
      continue;
    }
    // peer line: name public preshared endpoint allowed ips latest handshake transfer-rx transfer-tx keepalive
    ifaces[name].peers.push({
      publicKey: p[1],
      endpoint: p[3] || null,
      allowedIps: (p[4] || '').split(',').map((s) => s.trim()).filter(Boolean),
      latestHandshake: Number(p[5]) || 0,
      transferRx: Number(p[6]) || 0,
      transferTx: Number(p[7]) || 0,
      persistentKeepalive: Number(p[8]) || 0,
    });
  }
  // first line of each iface in dump is the iface itself; peers follow. Re-parse carefully:
  // Actually wg dump: first record per iface has 5 fields (iface), peers have 9. Rebuild:
  const rebuilt = {};
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    const name = p[0];
    if (!rebuilt[name]) rebuilt[name] = { name, publicKey: '', listenPort: null, peers: [] };
    if (p.length === 5) {
      rebuilt[name].publicKey = p[2] || '';
      rebuilt[name].listenPort = Number(p[3]) || null;
    } else if (p.length >= 9) {
      rebuilt[name].peers.push({
        publicKey: p[1],
        endpoint: p[3] || null,
        allowedIps: (p[4] || '').split(',').map((s) => s.trim()).filter(Boolean),
        latestHandshake: Number(p[5]) || 0,
        transferRx: Number(p[6]) || 0,
        transferTx: Number(p[7]) || 0,
        persistentKeepalive: Number(p[8]) || 0,
      });
    }
  }
  res.json({ available: true, interfaces: Object.values(rebuilt) });
}));

router.post('/:iface/peers', wrap(async (req, res) => {
  const iface = ifaceName(req.params.iface);
  if (!(await host.has('wg'))) throw bad('wg not available', 501);
  let pub = String(req.body.publicKey || '').trim();
  let priv = null;
  if (!pub) {
    // generate keypair on host
    const g = await host.run('wg', ['genkey'], { timeout: 5000 });
    if (g.code !== 0) throw fail(g, 'wg genkey');
    priv = g.stdout.trim();
    const p = await host.run('wg', ['pubkey'], { input: priv + '\n', timeout: 5000 });
    if (p.code !== 0) throw fail(p, 'wg pubkey');
    pub = p.stdout.trim();
  }
  if (!/^[A-Za-z0-9+/]{42,44}=*$/.test(pub)) throw bad('Bad public key');
  const allowed = String(req.body.allowedIps || '0.0.0.0/0').trim();
  if (!allowed || /\s{2,}|\n/.test(allowed)) throw bad('Bad allowedIps');
  const args = ['set', iface, 'peer', pub, 'allowed-ips', allowed];
  if (req.body.endpoint) args.push('endpoint', String(req.body.endpoint));
  if (req.body.keepalive) args.push('persistent-keepalive', String(Number(req.body.keepalive) || 25));
  const r = await host.run('wg', args, { timeout: 10000 });
  if (r.code !== 0) throw fail(r, 'wg set');
  // try save if wg-quick conf exists
  if (await host.has('wg-quick')) {
    await host.run('wg-quick', ['save', iface], { timeout: 10000 }).catch(() => {});
  }
  audit.write({ user: req.session.username, action: 'wireguard.peer.add', details: { iface, publicKey: pub.slice(0, 8) + '…', allowedIps: allowed } });
  // private key returned once if we generated it — caller must store; not audited
  res.json({ ok: true, publicKey: pub, privateKey: priv || undefined });
}));

router.delete('/:iface/peers/:pub', wrap(async (req, res) => {
  const iface = ifaceName(req.params.iface);
  const pub = decodeURIComponent(req.params.pub);
  if (!/^[A-Za-z0-9+/]{42,44}=*$/.test(pub)) throw bad('Bad public key');
  const r = await host.run('wg', ['set', iface, 'peer', pub, 'remove'], { timeout: 10000 });
  if (r.code !== 0) throw fail(r, 'wg set remove');
  if (await host.has('wg-quick')) await host.run('wg-quick', ['save', iface], { timeout: 10000 }).catch(() => {});
  audit.write({ user: req.session.username, action: 'wireguard.peer.remove', details: { iface, publicKey: pub.slice(0, 8) + '…' } });
  res.json({ ok: true });
}));


router.post('/:iface/up', wrap(async (req, res) => {
  const iface = ifaceName(req.params.iface);
  if (!(await host.has('wg-quick'))) throw bad('wg-quick not available', 501);
  // Bring up from /etc/wireguard/<iface>.conf if present
  const r = await host.run('wg-quick', ['up', iface], { timeout: 30000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'wg-quick up failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'wireguard.up', details: { iface } });
  res.json({ ok: true, stdout: (r.stdout || '').trim() });
}));

router.post('/:iface/down', wrap(async (req, res) => {
  const iface = ifaceName(req.params.iface);
  if (!(await host.has('wg-quick'))) throw bad('wg-quick not available', 501);
  const r = await host.run('wg-quick', ['down', iface], { timeout: 30000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'wg-quick down failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'wireguard.down', details: { iface } });
  res.json({ ok: true });
}));

/** Client config + QR. Body may include client private key (shown once at peer create) and address. */
router.post('/:iface/peers/:pub/config', wrap(async (req, res) => {
  const iface = ifaceName(req.params.iface);
  const pub = decodeURIComponent(req.params.pub);
  if (!/^[A-Za-z0-9+/]{42,44}=*$/.test(pub)) throw bad('Bad public key');
  const b = req.body || {};
  const clientPriv = b.privateKey ? String(b.privateKey).trim() : '';
  const address = String(b.address || (b.allowedIps || '').split(',')[0] || '').trim();
  const dns = String(b.dns || '1.1.1.1').trim();
  const endpoint = String(b.serverEndpoint || '').trim();
  if (!endpoint) throw bad('serverEndpoint required (host:port)');
  // server public key from wg show
  const show = await host.run('wg', ['show', iface, 'public-key'], { timeout: 5000 });
  if (show.code !== 0) throw fail(show, 'wg show public-key');
  const serverPub = show.stdout.trim();
  // allowed ips for this peer
  const dump = await host.run('wg', ['show', iface, 'dump'], { timeout: 10000 });
  let allowed = '0.0.0.0/0, ::/0';
  for (const line of dump.stdout.split('\n')) {
    const p = line.split('\t');
    if (p.length >= 9 && p[1] === pub) {
      allowed = p[4] || allowed;
      break;
    }
  }
  const addrLine = address || (allowed.split(',')[0] || '10.0.0.2/32');
  const conf = [
    '[Interface]',
    clientPriv ? ('PrivateKey = ' + clientPriv) : '# PrivateKey = <paste client private key>',
    'Address = ' + addrLine,
    'DNS = ' + dns,
    '',
    '[Peer]',
    'PublicKey = ' + serverPub,
    'Endpoint = ' + endpoint,
    'AllowedIPs = ' + (b.clientAllowedIps || '0.0.0.0/0, ::/0'),
    'PersistentKeepalive = ' + String(Number(b.keepalive) || 25),
    '',
  ].join('\n');
  let qrDataUrl = null;
  try {
    const QR = require('qrcode');
    qrDataUrl = await QR.toDataURL(conf, { margin: 1, width: 320 });
  } catch (e) {
    qrDataUrl = null;
  }
  audit.write({ user: req.session.username, action: 'wireguard.peer.config', details: { iface, publicKey: pub.slice(0, 8) + '…' } });
  res.json({ ok: true, config: conf, qrDataUrl, filename: iface + '-' + pub.slice(0, 8) + '.conf' });
}));

module.exports = router;

