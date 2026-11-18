'use strict';
// Network management backends.
//
// NetworkManager (nmcli) is always the first choice. When the host doesn't run it,
// Uiable falls back to whatever the host does have:
//   Wi-Fi:       iwd (iwctl) -> wpa_supplicant (wpa_cli) -> netplan "wifis" (+ `iw` for scanning)
//   IP settings: netplan -> systemd-networkd (.network files)
//   Link up/down: `ip link`
// Everything runs on the HOST through host.run (nsenter -t 1 inside Docker).
// Wi-Fi passwords are never logged and are scrubbed from any error text.
//
// Pure parsers/builders are exported for unit tests (test/netbackends.test.js).
const crypto = require('crypto');
const net = require('net');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const yaml = require('js-yaml');

// ---------------------------------------------------------------- pure helpers
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const stripAnsi = (s) => String(s || '').replace(ANSI, '');
const DEV_RE = /^[\w.\-]{1,15}$/;
const validDev = (d) => DEV_RE.test(String(d || ''));

/** nmcli -t escapes ':' as '\:' inside values. */
function splitTerse(line) {
  const out = []; let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; continue; }
    if (c === ':') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** Keep the best entry per SSID (connected first, then strongest). */
function dedupeNetworks(list) {
  const best = {};
  list.forEach((n) => {
    if (!n || !n.ssid) return;
    const b = best[n.ssid];
    if (!b || (n.inUse && !b.inUse) || (n.signal > b.signal && !b.inUse)) best[n.ssid] = n;
  });
  return Object.values(best).sort((a, b) => (b.inUse - a.inUse) || b.signal - a.signal);
}

function parseNmcliWifi(stdout) {
  return dedupeNetworks(String(stdout || '').split('\n').filter(Boolean).map((l) => {
    const p = splitTerse(l);
    return { inUse: p[0] === '*', ssid: p[1], bssid: p[2], signal: +p[3] || 0, security: p[4] || '', channel: p[5], device: p[6] };
  }));
}

const dbmToPercent = (dbm) => Math.max(0, Math.min(100, Math.round(2 * (Number(dbm) + 100))));
function freqToChannel(f) {
  f = Math.round(Number(f));
  if (!f) return '';
  if (f === 2484) return '14';
  if (f >= 2412 && f < 2484) return String((f - 2407) / 5);
  if (f >= 5955 && f <= 7115) return String((f - 5950) / 5);
  if (f >= 5000 && f < 5925) return String((f - 5000) / 5);
  return '';
}

/** `iwctl station list` */
const IWD_STATES = /^(connected|disconnected|connecting|disconnecting|roaming)$/i;
function parseIwctlStations(out) {
  const res = [];
  stripAnsi(out).split('\n').forEach((l) => {
    const p = l.trim().split(/\s+/);
    if (p.length >= 2 && validDev(p[0]) && IWD_STATES.test(p[1])) res.push({ device: p[0], state: p[1].toLowerCase(), scanning: /scanning/i.test(p.slice(2).join(' ')) });
  });
  return res;
}

/** `iwctl station <dev> show` -> { state, connectedNetwork } */
function parseIwctlShow(out) {
  const o = {};
  stripAnsi(out).split('\n').forEach((l) => {
    const m = l.match(/^\s*(State|Connected network|ConnectedNetwork)\s{2,}(.+?)\s*$/);
    if (m) o[/^State$/.test(m[1]) ? 'state' : 'connectedNetwork'] = m[2];
  });
  return o;
}

/**
 * `iwctl station <dev> get-networks [rssi-dbms]`. Signal is either dBm (rssi-dbms,
 * value is in 1/100 dBm on some versions) or 0-4 stars, where unlit stars are
 * wrapped in a dim ANSI colour (\x1b[1;90m).
 */
function parseIwctlNetworks(out, device) {
  const nets = [];
  String(out || '').split('\n').forEach((raw) => {
    const lit = raw.replace(/\x1b\[1;90m[^\x1b]*\x1b\[0m/g, ''); // drop dimmed (unlit) stars
    const l = stripAnsi(lit);
    if (!l.trim() || /^\s*-{5,}/.test(l) || /Available networks|Network name\s+Security/i.test(l) || /No networks/i.test(l)) return;
    const m = l.match(/^\s*(>)?\s*(.+?)\s{2,}(psk|open|8021x|wep|sae|owe|\S+)\s+(-?\d+|\*{0,4})\s*$/i);
    if (!m) return;
    let signal;
    if (/^-?\d+$/.test(m[4])) { let d = Number(m[4]); if (d < -200) d /= 100; signal = dbmToPercent(d); } else signal = m[4].length * 25;
    const sec = m[3].toLowerCase();
    nets.push({ inUse: !!m[1], ssid: m[2], bssid: '', signal, security: sec === 'open' ? '' : sec.toUpperCase(), channel: '', device: device || '' });
  });
  return dedupeNetworks(nets);
}

/** wpa_cli / iw print non-printable SSID bytes as \xNN. */
function unescapeSsid(s) {
  const bytes = [];
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\' && str[i + 1] === 'x' && /^[0-9a-f]{2}$/i.test(str.substr(i + 2, 2))) { bytes.push(parseInt(str.substr(i + 2, 2), 16)); i += 3; continue; }
    if (str[i] === '\\' && (str[i + 1] === '\\' || str[i + 1] === '"')) { bytes.push(str.charCodeAt(i + 1)); i += 1; continue; }
    bytes.push(...Buffer.from(str[i], 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function wpaSecurity(flags) {
  // Groups look like [WPA2-PSK+SAE-CCMP], [RSN-SAE-CCMP], [WPA-PSK-TKIP], [WPA2-EAP-CCMP], [WEP]
  const groups = String(flags || '').match(/\[[^\]]+\]/g) || [];
  let sae = false, psk2 = false, psk1 = false, eap = false, wep = false;
  for (const g of groups) {
    const m = g.slice(1, -1).match(/^(WPA2|RSN|WPA)-(.+?)(?:-(CCMP|TKIP|GCMP|CCMP-256|GCMP-256|TKIP\+CCMP|CCMP\+TKIP)(?:-preauth)?)?$/);
    if (!m) { if (/^WEP$/.test(g.slice(1, -1))) wep = true; continue; }
    const akm = m[2].split('+');
    if (akm.some((a) => /SAE/.test(a))) sae = true;
    if (akm.some((a) => /PSK/.test(a))) { if (m[1] === 'WPA') psk1 = true; else psk2 = true; }
    if (akm.some((a) => /EAP/.test(a))) eap = true;
  }
  const out = [];
  if (sae) out.push('WPA3');
  if (psk2 || (eap && !psk1)) out.push('WPA2'); else if (psk1) out.push('WPA');
  if (eap) out.push('802.1X');
  if (!out.length && wep) out.push('WEP');
  return out.join(' ');
}

/** `wpa_cli -i dev scan_results`: bssid \t freq \t dBm \t flags \t ssid */
function parseWpaScanResults(out, device, currentBssid) {
  const cur = String(currentBssid || '').toLowerCase();
  return dedupeNetworks(String(out || '').split('\n').map((l) => {
    const p = l.split('\t');
    if (p.length < 4 || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(p[0])) return null;
    return { inUse: !!cur && p[0].toLowerCase() === cur, ssid: unescapeSsid(p.slice(4).join('\t')), bssid: p[0], signal: dbmToPercent(p[2]), security: wpaSecurity(p[3]), channel: freqToChannel(p[1]), device: device || '' };
  }));
}

/** key=value lines (wpa_cli status, os-release). */
function parseKv(out) {
  const o = {};
  String(out || '').split('\n').forEach((l) => {
    const i = l.indexOf('=');
    if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  });
  return o;
}

/** `iw dev <dev> scan` */
function parseIwScan(out, device) {
  const nets = [];
  let n = null;
  const push = () => { if (n) nets.push(n); };
  String(out || '').split('\n').forEach((l) => {
    const b = l.match(/^BSS ([0-9a-f:]{17})/i);
    if (b) { push(); n = { inUse: /associated/.test(l), ssid: '', bssid: b[1], signal: 0, security: '', channel: '', device: device || '', _sec: [] }; return; }
    if (!n) return;
    let m;
    if ((m = l.match(/^\s*freq:\s*([\d.]+)/))) n.channel = freqToChannel(m[1]);
    else if ((m = l.match(/^\s*signal:\s*(-?[\d.]+)\s*dBm/))) n.signal = dbmToPercent(m[1]);
    else if ((m = l.match(/^\s*SSID:\s?(.*)$/))) n.ssid = unescapeSsid(m[1]);
    else if (/^\s*RSN:/.test(l)) { n._sec.push('WPA2'); n._rsn = true; }
    else if (/^\s*WPA:/.test(l)) { n._sec.push('WPA'); n._rsn = false; }
    else if ((m = l.match(/^\s*\*\s*Authentication suites:\s*(.*)$/)) && n._rsn) {
      const akm = m[1].split(/\s+/);
      if (akm.some((a) => /^(SAE|FT\/SAE|SAE-EXT-KEY)$/.test(a))) n._sec.unshift('WPA3');
      if (!akm.some((a) => /^(PSK|FT\/PSK|PSK\/SHA-256)$/.test(a))) n._sec = n._sec.filter((x) => x !== 'WPA2' || akm.some((a) => /802\.1X/.test(a)));
      if (akm.some((a) => /802\.1X/.test(a))) n._sec.push('802.1X');
    }
    else if (/^\s*capability:.*Privacy/.test(l)) n._priv = true;
  });
  push();
  return dedupeNetworks(nets.map((x) => {
    const security = x._sec.length ? [...new Set(x._sec)].join(' ') : (x._priv ? 'WEP' : '');
    const { _sec, _priv, _rsn, ...rest } = x;
    return Object.assign(rest, { security });
  }));
}

/** WPA-PSK key = PBKDF2-SHA1(passphrase, ssid, 4096, 32). Lets us hand wpa_supplicant a hex key, never the plaintext. */
function wpaPsk(ssid, passphrase) {
  return crypto.pbkdf2Sync(Buffer.from(String(passphrase), 'utf8'), Buffer.from(String(ssid), 'utf8'), 4096, 32, 'sha1').toString('hex');
}

function validatePassphrase(p) {
  if (!p) return;
  if (/^[0-9a-f]{64}$/i.test(p)) return;
  if (p.length < 8 || p.length > 63) throw Object.assign(new Error('Wi-Fi password must be 8-63 characters'), { status: 400 });
}

/** Remove secrets from any text that may reach the UI or a log. */
function scrub(text, secrets) {
  let t = String(text || '');
  (secrets || []).filter((s) => s && String(s).length >= 3).forEach((s) => { t = t.split(String(s)).join('••••'); });
  return t;
}

/** Validate a static/DHCP request. Returns a normalised config. */
function validateIpConfig(body) {
  const err = (m) => Object.assign(new Error(m), { status: 400 });
  const b = body || {};
  const device = String(b.device || '');
  if (!validDev(device) || device === 'lo') throw err('Bad interface name');
  const mode = String(b.mode || '').toLowerCase();
  if (mode !== 'dhcp' && mode !== 'static') throw err('Mode must be dhcp or static');
  if (mode === 'dhcp') return { device, mode };
  const address = String(b.address || '').trim();
  const [ip, prefix] = address.split('/');
  const fam = net.isIP(ip || '');
  const max = fam === 6 ? 128 : 32;
  if (!fam || !/^\d{1,3}$/.test(prefix || '') || +prefix < 1 || +prefix > max) throw err('Address must be in CIDR form, e.g. 192.168.1.50/24');
  const gateway = String(b.gateway || '').trim();
  if (gateway && net.isIP(gateway) !== fam) throw err('Gateway must be an IP address of the same family as the address');
  const dnsIn = Array.isArray(b.dns) ? b.dns : String(b.dns || '').split(/[\s,]+/);
  const dns = dnsIn.map((x) => String(x).trim()).filter(Boolean);
  if (dns.length > 4 || dns.some((d) => !net.isIP(d))) throw err('DNS must be up to 4 IP addresses');
  return { device, mode, address: `${ip}/${+prefix}`, gateway, dns, family: fam };
}

/** systemd-networkd .network unit for one interface. */
function buildNetworkdUnit(cfg) {
  const lines = ['# Managed by Uiable. Edit in Uiable or delete this file to fall back to your own config.', '[Match]', `Name=${cfg.device}`, '', '[Network]'];
  if (cfg.mode === 'dhcp') lines.push('DHCP=yes');
  else {
    lines.push(`Address=${cfg.address}`);
    if (cfg.gateway) lines.push(`Gateway=${cfg.gateway}`);
    (cfg.dns || []).forEach((d) => lines.push(`DNS=${d}`));
  }
  // Wi-Fi shouldn't hold up boot (systemd-networkd-wait-online) when the cable is the main link.
  if (cfg.wifi) lines.push('', '[Link]', 'RequiredForOnline=no');
  return lines.join('\n') + '\n';
}

/**
 * Merge an interface's IP config (and/or Wi-Fi access point) into Uiable's own
 * netplan document (/etc/netplan/90-uiable.yaml). Other netplan files are left alone.
 */
function buildNetplanDoc(existing, { device, wireless, ip, wifi }) {
  const doc = existing && typeof existing === 'object' ? JSON.parse(JSON.stringify(existing)) : {};
  doc.network = doc.network && typeof doc.network === 'object' ? doc.network : {};
  doc.network.version = 2;
  const sect = wireless ? 'wifis' : 'ethernets';
  doc.network[sect] = doc.network[sect] || {};
  const e = doc.network[sect][device] = doc.network[sect][device] || {};
  if (wifi) {
    const ap = {};
    // WPA3-only (SAE) needs key-management sae + the passphrase; WPA2 / WPA2+WPA3 transition gets a
    // pre-derived 64-hex PSK so no quoting/escaping of the passphrase is involved anywhere.
    if (wifi.password && wifi.keyMgmt === 'sae') ap.auth = { 'key-management': 'sae', password: String(wifi.password) };
    else if (wifi.password) ap.password = String(wifi.psk || wifi.password);
    if (wifi.hidden) ap.hidden = true;
    e['access-points'] = { [wifi.ssid]: ap }; // replace: connect to this one network
    if (wifi.renderer) e.renderer = wifi.renderer;
    if (e.dhcp4 === undefined && !e.addresses) e.dhcp4 = true;
  }
  if (ip) {
    delete e.addresses; delete e.routes; delete e.nameservers; delete e.dhcp4; delete e.dhcp6; delete e.gateway4;
    if (ip.mode === 'dhcp') e.dhcp4 = true;
    else {
      if (ip.family === 4) e.dhcp4 = false; else e.dhcp6 = false;
      e.addresses = [ip.address];
      if (ip.gateway) e.routes = [{ to: 'default', via: ip.gateway }];
      if (ip.dns && ip.dns.length) e.nameservers = { addresses: ip.dns };
    }
  }
  return doc;
}

/** Parse the one-shot host probe script output. */
function parseProbe(out) {
  const caps = { bins: new Set(), units: {}, procs: new Set(), wifiIfaces: [], netplanDir: false, ifupdown: false };
  String(out || '').split('\n').forEach((l) => {
    const [k, ...rest] = l.trim().split(':');
    const v = rest.join(':');
    if (k === 'bin' && v) caps.bins.add(v);
    else if (k === 'unit' && v) { const [u, st] = v.split(':'); caps.units[u] = (st || '').trim() || 'unknown'; }
    else if (k === 'proc' && v) caps.procs.add(v);
    else if (k === 'wifi' && validDev(v)) caps.wifiIfaces.push(v);
    else if (k === 'dir' && v === 'netplan') caps.netplanDir = true;
    else if (k === 'ifupdown') caps.ifupdown = true;
  });
  return caps;
}

const active = (caps, unit, proc) => caps.units[unit] === 'active' || caps.procs.has(proc || unit);

/**
 * Pick backends from probe caps + nmcli status. Pure, so it's unit-tested.
 * nm: { installed, running, message }
 */
function chooseBackends(caps, nm) {
  const hasWifi = caps.wifiIfaces.length > 0;
  let wifi = null, config = null;
  if (nm.running) { wifi = 'networkmanager'; config = 'networkmanager'; }
  else {
    const netplan = caps.bins.has('netplan') && caps.netplanDir;
    const networkd = caps.bins.has('networkctl') && active(caps, 'systemd-networkd', 'systemd-networkd');
    config = netplan ? 'netplan' : networkd ? 'systemd-networkd' : null;
    if (hasWifi) {
      if (caps.bins.has('iwctl') && active(caps, 'iwd')) wifi = 'iwd';
      else if (caps.bins.has('wpa_cli') && caps.procs.has('wpa_supplicant')) wifi = 'wpa_supplicant';
      else if (netplan) wifi = 'netplan';
    }
  }
  const link = nm.running ? 'networkmanager' : caps.bins.has('ip') ? 'ip' : null;
  const scan = wifi === 'netplan' ? (caps.bins.has('iw') ? 'iw' : null) : wifi;
  // Used for interfaces NetworkManager leaves unmanaged (e.g. after a Wi-Fi-only NM install).
  const fallbackConfig = caps.bins.has('netplan') && caps.netplanDir ? 'netplan' : (caps.bins.has('networkctl') && active(caps, 'systemd-networkd', 'systemd-networkd')) ? 'systemd-networkd' : null;
  return { wifi, config, link, scan, hasWifi, fallbackConfig };
}

const NAMES = { networkmanager: 'NetworkManager', iwd: 'iwd (iwctl)', wpa_supplicant: 'wpa_supplicant (wpa_cli)', netplan: 'netplan', 'systemd-networkd': 'systemd-networkd', ip: 'ip link', iw: 'iw' };

/** Human summary + list of unsupported features for the UI. */
function describe(b, nm) {
  const unsupported = [];
  if (!b.hasWifi) unsupported.push('Wi-Fi (no wireless adapter found)');
  else if (!b.wifi) unsupported.push('Wi-Fi (no iwd, wpa_supplicant or netplan on this host)');
  else if (!b.scan) unsupported.push('Wi-Fi scanning (install `iw` to list networks; you can still join by name)');
  if (!b.config) unsupported.push('Static IP / DHCP settings (needs netplan or systemd-networkd)');
  if (!b.link) unsupported.push('Bringing interfaces up/down (`ip` not found)');
  if (b.wifi && b.wifi !== 'networkmanager' && b.wifi !== 'netplan' && b.config !== 'netplan') unsupported.push('Saved Wi-Fi may not survive a reboot unless the backend is configured to save networks');
  const parts = [];
  if (b.wifi) parts.push(`${NAMES[b.wifi]} for Wi-Fi`);
  if (b.config && b.config !== b.wifi) parts.push(`${NAMES[b.config]} for IP settings`);
  else if (b.config && b.config === 'networkmanager') parts[0] = 'NetworkManager for Wi-Fi and connections';
  if (b.link && b.link !== 'networkmanager') parts.push(`${NAMES[b.link]} for up/down`);
  let summary;
  if (nm.running) summary = 'Using NetworkManager.';
  else {
    const why = nm.installed ? (nm.message || 'NetworkManager is installed but not running.') : 'NetworkManager (nmcli) is not installed on this host.';
    summary = parts.length ? `${why} Using ${parts.join(', ')}.` : `${why} No other supported network backend was found, so interfaces are read-only.`;
  }
  return { summary, unsupported, readOnly: !b.wifi && !b.config && !b.link };
}

// ---------------------------------------------------------------- interfaces / routes / status (pure)
const VIRT_KIND = /^(bridge|veth|vxlan|wireguard|tun|tap|dummy|macvlan|macvtap|ipvlan|bond|vlan|gre|gretap|ipip|sit|geneve|vrf|team|ip6tnl|nlmon)$/;
const VIRT_NAME = /^(docker|br-|veth|virbr|lxc|lxd|cni|flannel|cali|tailscale|wg|tun|tap|zt|vmnet|vboxnet|podman|kube|weave|cilium|nordlynx|ham)/;

/** `ip -j -d addr` */
function parseIpAddrJson(stdout) {
  let list;
  try { list = JSON.parse(stdout || '[]'); } catch (_) { return []; }
  return list.map((i) => {
    const addrs = i.addr_info || [];
    return {
      name: i.ifname, state: i.operstate || '', flags: i.flags || [], mac: i.address || '', mtu: i.mtu,
      kind: (i.linkinfo && i.linkinfo.info_kind) || '',
      addresses: addrs.map((a) => `${a.local}/${a.prefixlen}`),
      ipv4: addrs.filter((a) => a.family === 'inet' && a.scope !== 'host').map((a) => `${a.local}/${a.prefixlen}`),
      ipv6: addrs.filter((a) => a.family === 'inet6' && a.scope === 'global').map((a) => `${a.local}/${a.prefixlen}`),
      dynamic: addrs.some((a) => a.family === 'inet' && a.dynamic),
    };
  });
}

/** `ip -j route show default` (+ -6). Sorted best first (lowest metric). */
function parseDefaultRoutes(stdout, family = 4) {
  let list;
  try { list = JSON.parse(stdout || '[]'); } catch (_) { return []; }
  return list.filter((r) => r.dst === 'default' && r.dev).map((r) => ({ dev: r.dev, gateway: r.gateway || '', metric: Number(r.metric) || 0, proto: r.protocol || '', family, linkdown: (r.flags || []).includes('linkdown') }))
    .sort((a, b) => (a.linkdown - b.linkdown) || a.metric - b.metric);
}

/** `resolvectl dns` -> { global: [...], links: { dev: [...] } } */
function parseResolvectlDns(out) {
  const res = { global: [], links: {} };
  String(out || '').split('\n').forEach((l) => {
    const g = l.match(/^Global:\s*(.*)$/);
    const k = l.match(/^Link \d+ \(([^)]+)\):\s*(.*)$/);
    const ips = (s) => s.trim().split(/\s+/).filter(Boolean).map((x) => x.replace(/%.*$/, '').replace(/#.*$/, '')).filter((x) => net.isIP(x));
    if (g) res.global = ips(g[1]);
    else if (k) res.links[k[1]] = ips(k[2]);
  });
  return res;
}

/** `iw dev <dev> link` */
/** Names from `iwctl known-networks list` (table with ANSI colours and a header). */
function parseIwctlKnown(out) {
  const clean = String(out || '').replace(/\x1b\[[0-9;]*m/g, '');
  return clean.split('\n').map((l) => l.trim()).filter((l) => l && !/^-+$/.test(l) && !/^Known Networks/i.test(l) && !/^Name\s+Security/i.test(l) && !/^No known networks/i.test(l))
    .map((l) => l.replace(/^>\s*/, '').split(/\s{2,}/)[0]).filter(Boolean);
}
/** Rows from `wpa_cli list_networks`: [{ id, ssid, flags }]. */
function parseWpaNetworks(out) {
  return String(out || '').split('\n').filter((l) => /^\d+\t/.test(l)).map((l) => { const p = l.split('\t'); return { id: p[0], ssid: p[1] || '', flags: p[3] || '' }; });
}

function parseIwLink(out) {
  const t = String(out || '');
  if (!/^Connected to/m.test(t)) return { connected: false };
  const g = (re) => (t.match(re) || [])[1];
  const dbm = g(/signal:\s*(-?\d+)/);
  return { connected: true, bssid: g(/^Connected to ([0-9a-f:]{17})/mi) || '', ssid: unescapeSsid(g(/^\s*SSID:\s?(.*)$/m) || ''), signal: dbm != null ? dbmToPercent(dbm) : null, dbm: dbm != null ? Number(dbm) : null, channel: freqToChannel(g(/freq:\s*([\d.]+)/)) };
}

function ifaceType(i, wifiIfaces) {
  if (i.name === 'lo' || (i.flags || []).includes('LOOPBACK')) return 'loopback';
  if ((wifiIfaces || []).includes(i.name)) return 'wifi';
  if (VIRT_KIND.test(i.kind || '') || VIRT_NAME.test(i.name)) return 'virtual';
  return 'ethernet';
}

/**
 * Human state for one interface. wifi: { connected, ssid } from the Wi-Fi backend (or null).
 * Returns { state, label, canLink }: canLink=false for loopback/virtual (no Connect/Disconnect).
 */
function ifaceStatus(i, type, wifi) {
  const flags = i.flags || [];
  const adminUp = flags.includes('UP');
  const carrier = flags.includes('LOWER_UP') && !flags.includes('NO-CARRIER');
  const hasIp = (i.ipv4 || []).length > 0 || (i.ipv6 || []).length > 0;
  if (type === 'loopback') return { state: 'loopback', label: 'loopback', canLink: false };
  if (type === 'virtual') {
    if (!adminUp) return { state: 'down', label: 'down', canLink: false };
    return carrier ? { state: 'active', label: 'active', canLink: false } : { state: 'idle', label: 'idle (nothing attached)', canLink: false };
  }
  if (!adminUp) return { state: 'down', label: 'down', canLink: true };
  if (type === 'wifi') {
    if (wifi && wifi.connected) return hasIp ? { state: 'connected', label: `connected${wifi.ssid ? ' to ' + wifi.ssid : ''}`, canLink: true } : { state: 'no-ip', label: `joined ${wifi.ssid || 'Wi-Fi'}, no IP yet`, canLink: true };
    return { state: 'disconnected', label: 'not connected to Wi-Fi', canLink: true };
  }
  if (!carrier) return { state: 'no-cable', label: 'cable unplugged', canLink: true };
  return hasIp ? { state: 'connected', label: 'connected', canLink: true } : { state: 'no-ip', label: 'up, no IP address', canLink: true };
}

/** `/sys/class/rfkill` dump lines "name type soft hard" */
function parseRfkill(out) {
  return String(out || '').split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 4 && /^[01]$/.test(p[2]))
    .map((p) => ({ name: p[0], type: p[1], soft: p[2] === '1', hard: p[3] === '1' }));
}

/**
 * Turn a failed Wi-Fi attempt into one clear reason.
 * ctx: { log, rfkill:[...], associated, ip, supplicantMissing, regdom, nmError, backend }
 */
const PMF_FAIL_RE = /Failed to configure IGTK|key setting validation failed|Failed to set IGTK|BIP.*not supported/i;
function classifyWifiFailure(ctx) {
  const log = String(ctx.log || '') + '\n' + String(ctx.nmError || '');
  const wl = (ctx.rfkill || []).filter((r) => r.type === 'wlan');
  const sec = ctx.security ? ` Network security: ${ctx.security}.` : '';
  const excerpt = relevantLog(ctx.log, ctx.device);
  const withLog = (m) => m + sec + (excerpt ? `\n\nLog since this attempt:\n${excerpt}` : '');
  if (wl.some((r) => r.hard)) return { code: 'rfkill-hard', message: 'Wi-Fi is switched off in hardware (rfkill hard block): check the laptop Wi-Fi switch/Fn key or the BIOS setting.' };
  if (wl.some((r) => r.soft)) return { code: 'rfkill-soft', message: 'Wi-Fi is blocked by rfkill (soft block) and could not be unblocked. Run `rfkill unblock wifi` on the host.' };
  if (ctx.supplicantMissing) return { code: 'no-supplicant', message: 'netplan needs wpa_supplicant to join Wi-Fi, but it is not installed on the host. Install it (`sudo apt install wpasupplicant`) or use Install NetworkManager.' };
  // The driver refused the management-frame key (IGTK): the card/driver can't do PMF (802.11w) but the AP offers it.
  if (PMF_FAIL_RE.test(log)) return { code: 'no-pmf', message: withLog('This Wi-Fi card/driver does not support protected management frames (PMF, 802.11w): the driver refused the IGTK key ("Failed to configure IGTK") right after associating.') };
  // Only claim "wrong password" on explicit evidence from the supplicant / NetworkManager / iwd.
  // A bare 4-way handshake timeout (reason=15), auth_failures, or "Authentication failed" can equally
  // come from PMF/WPA3 mismatches, two supplicants fighting over the interface, band or driver issues.
  const strongKey = /reason=WRONG_KEY|pre-shared key may be incorrect|Secrets were required, but not provided|invalid passphrase|SAE: .*(confirm|commit).*(mismatch|failed)/i.test(log);
  if (strongKey && !ctx.keyMismatch) return { code: 'wrong-password', message: withLog('Wrong Wi-Fi password: the access point rejected the key.') };
  if (/NETWORK-NOT-FOUND|No network with SSID|Network not found|SSID.*not (found|available)/i.test(log) && !ctx.associated) return { code: 'not-found', message: withLog(`The network wasn't found from this host.${ctx.regdom === '00' ? ' The Wi-Fi regulatory domain is not set (country 00), so some 5 GHz channels are disabled; set it with `iw reg set GB` (or your country).' : ' Check it is in range, and that the name (SSID) is spelled exactly.'}`) };
  if (/ASSOC-REJECT|association rejected/i.test(log) && !ctx.associated) return { code: 'assoc-reject', message: withLog('The access point rejected the association. It may require WPA3 / protected management frames (PMF), or limit clients by MAC address.') };
  if (/4-Way Handshake failed|reason=15\b|auth_failures=\d|Authentication (failed|timed out)|CTRL-EVENT-AUTH-REJECT|reason=2 locally/i.test(log) || strongKey) return { code: 'handshake-failed', message: withLog('The Wi-Fi handshake failed. This can be a wrong password, but also a WPA2/WPA3 (SAE/PMF) mismatch or another Wi-Fi manager using the adapter at the same time — see the log below, or run Diagnostics.') };
  if (ctx.associated && !ctx.ip) return { code: 'no-dhcp', message: 'Joined the Wi-Fi network but did not get an IP address (DHCP timed out). Check the router\'s DHCP server or set a static IP with IP settings.' };
  return { code: 'timeout', message: withLog(`Wi-Fi did not connect within the time limit.${ctx.regdom === '00' ? ' Regulatory domain is unset (country 00).' : ''}`) };
}

/** Last relevant Wi-Fi log lines (already scrubbed by the caller), for error messages. */
function relevantLog(log, dev) {
  const lines = String(log || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const rel = lines.filter((l) => /CTRL-EVENT|WPA:|SAE|wpa_supplicant|Associat|Authenticat|handshake|reason=|status_code|deauth|disassoc|DHCP|carrier|iwd|NetworkManager|<(warn|error)>|Failed|failed/i.test(l) || (dev && l.includes(dev)));
  return rel.slice(-12).map((l) => l.slice(0, 240)).join('\n');
}

/** "WPA3 WPA2" / "WPA2" / "WPA3" … from scan results -> what to configure. */
function wifiSecurityPlan(security) {
  const s = String(security || '');
  if (/802\.1X|EAP|8021x/i.test(s)) return { keyMgmt: 'eap', label: 'Enterprise (802.1X)' };
  const sae = /WPA3|SAE/i.test(s), psk = /WPA2|WPA1|WPA(?!3)|PSK/i.test(s.replace(/WPA3/gi, ''));
  if (sae && !psk) return { keyMgmt: 'sae', label: 'WPA3 (SAE)' };
  if (sae && psk) return { keyMgmt: 'psk', transition: true, label: 'WPA2/WPA3 transition' };
  if (psk) return { keyMgmt: 'psk', label: /WPA2/.test(s) ? 'WPA2' : 'WPA' };
  return { keyMgmt: s ? 'psk' : 'unknown', label: s || 'unknown' };
}

/** Parse `journalctl -o short-unix` and keep lines at/after sinceMs (drops stale lines from earlier attempts). */
function filterJournalSince(out, sinceMs) {
  return String(out || '').split('\n').map((l) => {
    const m = l.match(/^(\d{9,11}(?:\.\d+)?)\s+(.*)$/);
    if (!m) return { t: null, l };
    return { t: Number(m[1]) * 1000, l: m[2] };
  }).filter((x) => x.l && (x.t == null || x.t >= sinceMs)).map((x) => x.l).join('\n');
}

/** Mask anything secret-looking in diagnostics output. */
function scrubDiagnostics(text, secrets) {
  let t = scrub(text, secrets);
  t = t.replace(/^(\s*(?:["']?(?:password|psk|sae_password|passphrase|wpa-psk|wep-key\d?|private-key-password|psk-flags)["']?)\s*[:=]\s*).+$/gim, '$1••••');
  t = t.replace(/\b[0-9a-f]{64}\b/gi, '••••(hex key)');
  return t;
}

// ---------------------------------------------------------------- PMF (802.11w) capability + Uiable-managed wpa_supplicant (pure)
/**
 * Does the Wi-Fi card/driver support PMF? Input: output of PMF_PROBE (iw phy ciphers, loaded driver modules)
 * and `wpa_cli get_capability group_mgmt`. BIP-CMAC-128 (cipher suite 00-0f-ac:6) is required for PMF.
 * Returns { pmf: true | false | null (unknown), source, driver }.
 */
function parsePmfProbe(out, groupMgmt) {
  const t = String(out || '');
  const driver = ((t.match(/^driver:(\S*)/m) || [])[1]) || '';
  const iwSec = t.split(/^### /m).find((x) => x.startsWith('ciphers'));
  if (/^iw:1/m.test(t) && iwSec && /\(00-0f-ac:\d+\)|\bCCMP\b/i.test(iwSec)) {
    const ok = /00-0f-ac:6|BIP-CMAC-128|\bCMAC\b|AES-128-CMAC/i.test(iwSec);
    return { pmf: ok, source: ok ? 'iw phy: BIP-CMAC-128 (00-0f-ac:6) supported' : 'iw phy: no BIP-CMAC-128 (00-0f-ac:6) cipher', driver };
  }
  // wpa_supplicant only lists group-management ciphers the driver has; an empty list is ambiguous (older builds).
  const gm = String(groupMgmt || '').trim();
  if (/AES-128-CMAC|BIP-CMAC-128/i.test(gm)) return { pmf: true, source: `wpa_supplicant group_mgmt: ${gm.split('\n')[0].slice(0, 80)}`, driver };
  // Intel iwldvm cards (Centrino Wireless-N / Advanced-N 1000-6000 series, 100/105/130/135/2200/2230) never do PMF.
  if (/^mod:iwldvm/m.test(t)) return { pmf: false, source: 'iwldvm driver (older Intel Centrino card) has no PMF support', driver: driver || 'iwlwifi' };
  return { pmf: null, source: 'unknown (install `iw` to check)', driver };
}
const PMF_PROBE = [
  'dev="$1"; phy=$(cat /sys/class/net/"$dev"/phy80211/name 2>/dev/null)',
  'echo "driver:$(basename "$(readlink /sys/class/net/"$dev"/device/driver 2>/dev/null)" 2>/dev/null)"',
  '[ -d /sys/module/iwldvm ] && echo "mod:iwldvm"',
  'if command -v iw >/dev/null 2>&1; then echo "iw:1"; echo "### ciphers"; iw phy "$phy" info 2>/dev/null | sed -n "/Supported Ciphers/,/Available Antennas\\|Supported interface modes/p"; fi',
  'true',
].join('\n');

/** wpa_supplicant config for Uiable's own per-device supplicant (PMF off: for cards that can't do 802.11w). */
function buildOwnWpaConf({ ssid, psk, hidden, open }) {
  const lines = [
    '# Managed by Uiable (Settings > Network > Wi-Fi). This Wi-Fi card cannot do PMF (802.11w), so PMF is off.',
    'ctrl_interface=/run/wpa_supplicant', 'update_config=0', 'pmf=0', '', 'network={',
    `\tssid=${Buffer.from(String(ssid), 'utf8').toString('hex')}`,
  ];
  if (hidden) lines.push('\tscan_ssid=1');
  if (open) lines.push('\tkey_mgmt=NONE');
  else lines.push('\tkey_mgmt=WPA-PSK', `\tpsk=${psk}`);
  lines.push('\tieee80211w=0', '}', '');
  return lines.join('\n');
}
/** SSID from a Uiable-written conf (hex or quoted). */
function ownWpaSsid(text) {
  const m = String(text || '').match(/^\s*ssid=(.+)$/m);
  if (!m) return '';
  const v = m[1].trim();
  if (/^"/.test(v)) return v.replace(/^"|"$/g, '');
  return /^[0-9a-f]+$/i.test(v) ? Buffer.from(v, 'hex').toString('utf8') : v;
}
const OWN_WPA_UNIT = `# Managed by Uiable: wpa_supplicant for Wi-Fi cards that need settings netplan can't express (PMF off).
[Unit]
Description=Uiable WPA supplicant for %I
Requires=sys-subsystem-net-devices-%i.device
After=sys-subsystem-net-devices-%i.device
Before=network.target
Wants=network.target

[Service]
Type=simple
ExecStart=/usr/sbin/wpa_supplicant -c /etc/wpa_supplicant/uiable-%I.conf -i%I -Dnl80211,wext
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

/** Set key=value inside [section] of an ini text (adds the section/key when missing). */
function setIniKey(text, section, key, value) {
  const lines = String(text || '').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let start = lines.findIndex((l) => l.trim() === `[${section}]`);
  if (start < 0) { if (lines.length) lines.push(''); lines.push(`[${section}]`, `${key}=${value}`); return lines.join('\n') + '\n'; }
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l)); if (end < 0) end = lines.length;
  const k = lines.findIndex((l, i) => i > start && i < end && new RegExp(`^\\s*${key}\\s*=`).test(l));
  if (k >= 0) lines[k] = `${key}=${value}`;
  else { let at = end; while (at > start + 1 && lines[at - 1].trim() === '') at--; lines.splice(at, 0, `${key}=${value}`); }
  return lines.join('\n') + '\n';
}

function wpa3NoPmfMessage(ssid, cap) {
  return `${ssid} is WPA3-only, and WPA3 always needs protected management frames (PMF, 802.11w), which this Wi-Fi card/driver${cap && cap.driver ? ` (${cap.driver})` : ''} does not support. ` +
    'Set the router\'s Wi-Fi security to "WPA2/WPA3 mixed" (transition) with PMF "optional"/"capable" (or WPA2-only), or use a newer Wi-Fi card / USB adapter.';
}

// ---------------------------------------------------------------- uplink preference (pure)
const UPLINK_MODES = ['prefer-wired', 'prefer-wifi', 'wired-only', 'wifi-only'];
const METRIC_PRIMARY = 100;
const METRIC_BACKUP = 600;
/** Route metric + whether the interface may carry the default route, per type. */
function planUplink(mode) {
  if (!UPLINK_MODES.includes(mode)) throw Object.assign(new Error('Mode must be one of ' + UPLINK_MODES.join(', ')), { status: 400 });
  const wifiFirst = mode === 'prefer-wifi' || mode === 'wifi-only';
  return {
    ethernet: { metric: wifiFirst ? METRIC_BACKUP : METRIC_PRIMARY, defaultRoute: mode !== 'wifi-only' },
    wifi: { metric: wifiFirst ? METRIC_PRIMARY : METRIC_BACKUP, defaultRoute: mode !== 'wired-only' },
  };
}

/** Guess the current mode from default routes (stored mode wins when present). */
function inferUplinkMode(routes, types) {
  const best = {};
  routes.filter((r) => r.family === 4).forEach((r) => { const t = types[r.dev]; if ((t === 'ethernet' || t === 'wifi') && best[t] == null) best[t] = r.metric; });
  if (best.ethernet != null && best.wifi != null) return best.wifi < best.ethernet ? 'prefer-wifi' : 'prefer-wired';
  if (best.wifi != null) return 'wifi-only';
  if (best.ethernet != null) return 'prefer-wired';
  return null;
}

/** Merged netplan definition of an interface -> does it use DHCP / a static default route? */
function netplanDefaultSource(def) {
  const d = def || {};
  const staticDefault = !!d.gateway4 || (d.routes || []).some((r) => r && (r.to === 'default' || r.to === '0.0.0.0/0'));
  return { dhcp4: d.dhcp4 === true || d.dhcp4 === 'yes' || d.dhcp4 === 'true', dhcp6: d.dhcp6 === true || d.dhcp6 === 'yes', staticDefault };
}

/**
 * Apply an uplink plan to Uiable's netplan document for one device.
 * merged: `netplan get` of that device (all files). savedGateway: gateway to restore for Uiable-managed static.
 * Returns { doc, warning, removedGateway }.
 */
function applyUplinkToNetplan(existing, { device, wireless, plan, merged, savedGateway }) {
  const doc = existing && typeof existing === 'object' ? JSON.parse(JSON.stringify(existing)) : {};
  doc.network = doc.network || {}; doc.network.version = 2;
  const sect = wireless ? 'wifis' : 'ethernets';
  doc.network[sect] = doc.network[sect] || {};
  const own = doc.network[sect][device] || {};
  const src = netplanDefaultSource(merged);
  let warning = null, removedGateway = null;
  const ownStatic = (own.routes || []).some((r) => r && r.to === 'default') || (own.addresses && own.dhcp4 === false);
  if (ownStatic) {
    const routes = (own.routes || []).filter((r) => !(r && r.to === 'default'));
    const gw = ((own.routes || []).find((r) => r && r.to === 'default') || {}).via || savedGateway;
    if (plan.defaultRoute && gw) routes.push({ to: 'default', via: gw, metric: plan.metric });
    if (!plan.defaultRoute && gw) removedGateway = gw;
    if (routes.length) own.routes = routes; else delete own.routes;
  } else if (src.staticDefault) {
    warning = `${device} has a fixed gateway in another netplan file, so Uiable can't change its priority. Use IP settings on ${device} to let Uiable manage it.`;
  }
  if (src.dhcp4 || own.dhcp4 === true) own['dhcp4-overrides'] = Object.assign({}, own['dhcp4-overrides'], { 'route-metric': plan.metric, 'use-routes': plan.defaultRoute });
  if (src.dhcp6 || own.dhcp6 === true) own['dhcp6-overrides'] = Object.assign({}, own['dhcp6-overrides'], { 'route-metric': plan.metric, 'use-routes': plan.defaultRoute });
  if (!src.dhcp4 && !own.dhcp4 && !ownStatic && !src.staticDefault && !merged) warning = `${device} isn't configured in netplan yet; connect it first.`;
  if (Object.keys(own).length) {
    // An interface with only overrides still needs dhcp4 declared or netplan rejects the overrides.
    if (own['dhcp4-overrides'] && own.dhcp4 === undefined && src.dhcp4) own.dhcp4 = true;
    if (own['dhcp6-overrides'] && own.dhcp6 === undefined && src.dhcp6) own.dhcp6 = true;
    doc.network[sect][device] = own;
  }
  return { doc, warning, removedGateway };
}

/** systemd-networkd drop-in for route priority. */
function buildNetworkdUplinkDropin(plan) {
  return ['# Managed by Uiable (Wired / Wi-Fi preference).', '[DHCPv4]', `RouteMetric=${plan.metric}`, `UseGateway=${plan.defaultRoute ? 'yes' : 'no'}`, '', '[IPv6AcceptRA]', `RouteMetric=${plan.metric}`, `UseGateway=${plan.defaultRoute ? 'yes' : 'no'}`, ''].join('\n');
}

/** nmcli args to apply an uplink plan to a connection. */
function nmUplinkArgs(con, plan) {
  return ['connection', 'modify', con,
    'ipv4.route-metric', String(plan.metric), 'ipv6.route-metric', String(plan.metric),
    'ipv4.never-default', plan.defaultRoute ? 'no' : 'yes', 'ipv6.never-default', plan.defaultRoute ? 'no' : 'yes',
    'connection.autoconnect-priority', String(plan.metric === METRIC_PRIMARY ? 20 : 10)];
}

// ---------------------------------------------------------------- NetworkManager installer (pure parts)
const IMMUTABLE_IDS = /umbrel|rugix|coreos|flatcar|bottlerocket|talos|silverblue|kinoite|ublue|steamos|ubuntu-core|haos|home ?assistant|balena|chromeos|nixos|clear-linux|microos|aeon|kalpa|endless/i;

/** Can we install packages on this host? info: { osRelease, rootRo, ostree, rugix, umbrel, pkg } */
function classifyHost(info) {
  const os = info.osRelease || {};
  const name = os.PRETTY_NAME || os.NAME || os.ID || 'this host';
  const ids = [os.ID, os.ID_LIKE, os.VARIANT_ID, os.NAME, os.PRETTY_NAME].filter(Boolean).join(' ');
  if (info.umbrel || /umbrel/i.test(ids)) return { installable: false, reason: `${name} is an appliance OS (umbrelOS) whose system image is replaced on update, so packages can't be installed on it.` };
  if (info.rugix) return { installable: false, reason: `${name} uses an image-based (rugix) root filesystem, so packages can't be installed on it.` };
  if (info.ostree) return { installable: false, reason: `${name} is an image-based (OSTree) system. Layer NetworkManager with rpm-ostree yourself if you need it.` };
  if (IMMUTABLE_IDS.test(ids)) return { installable: false, reason: `${name} is an immutable/appliance OS, so packages can't be installed from Uiable.` };
  if (info.rootRo) return { installable: false, reason: 'The host root filesystem is read-only, so packages can\'t be installed.' };
  if (!info.pkg) return { installable: false, reason: 'No supported package manager (apt, dnf, yum, pacman, zypper or apk) was found on the host.' };
  return { installable: true, pkg: info.pkg, reason: null };
}

const PKG_ORDER = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'];
const PKG_KIND = { 'apt-get': 'apt', dnf: 'dnf', yum: 'yum', pacman: 'pacman', zypper: 'zypper', apk: 'apk' };
function pickPkg(bins) { const b = PKG_ORDER.find((x) => bins.has(x)); return b ? PKG_KIND[b] : null; }

const NM_UIABLE_CONF = '/etc/NetworkManager/conf.d/90-uiable.conf';
/** NetworkManager config written before install when the user keeps existing config unmanaged. */
function nmUnmanagedConf({ iwd } = {}) {
  return ['# Written by Uiable: NetworkManager only manages Wi-Fi (and mobile) devices.',
    '# Wired interfaces stay with netplan / systemd-networkd / ifupdown. Delete this file to let NM manage everything.',
    '[keyfile]', 'unmanaged-devices=*,except:type:wifi,except:type:wwan', '',
    '[ifupdown]', 'managed=false', '',
    ...(iwd ? ['[device]', 'wifi.backend=iwd', ''] : [])].join('\n');
}

/** Shell script (run on host as root) that installs + starts NetworkManager. Args: $1 pkg kind, $2 mode (wifi-only|all), $3 iwd(1|0). */
const NM_INSTALL_SCRIPT = `set -e
PM="$1"; MODE="$2"; IWD="$3"; CONF=${NM_UIABLE_CONF}
echo "==> Package manager: $PM, mode: $MODE"
mkdir -p /etc/NetworkManager/conf.d
if [ "$MODE" = "wifi-only" ]; then
  echo "==> Writing $CONF (wired interfaces stay unmanaged)"
  cat > "$CONF" <<'UIABLE_EOF'
__CONF__
UIABLE_EOF
  if [ "$IWD" != "1" ]; then sed -i '/^\\[device\\]/,$d' "$CONF"; fi
else
  rm -f "$CONF"
  if [ "$IWD" = "1" ]; then printf '[device]\\nwifi.backend=iwd\\n' > "$CONF"; fi
fi
echo "==> Installing NetworkManager"
case "$PM" in
  apt) export DEBIAN_FRONTEND=noninteractive; apt-get update; apt-get install -y --no-install-recommends -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold network-manager ;;
  dnf) dnf -y install NetworkManager NetworkManager-wifi ;;
  yum) yum -y install NetworkManager NetworkManager-wifi ;;
  pacman) pacman -Sy --noconfirm --needed networkmanager ;;
  zypper) zypper --non-interactive install NetworkManager ;;
  apk) apk add networkmanager networkmanager-cli networkmanager-wifi ;;
  *) echo "Unsupported package manager: $PM"; exit 2 ;;
esac
echo "==> Enabling and starting NetworkManager"
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  systemctl enable NetworkManager >/dev/null 2>&1 || true
  systemctl restart NetworkManager
elif command -v rc-service >/dev/null 2>&1; then
  rc-update add networkmanager default || true
  rc-service networkmanager restart || rc-service networkmanager start
else
  echo "Could not find systemd or OpenRC to start NetworkManager"; exit 3
fi
i=0; while [ $i -lt 20 ]; do if nmcli -t -f RUNNING general 2>/dev/null | grep -qi running; then break; fi; i=$((i+1)); sleep 1; done
nmcli -t -f RUNNING general | grep -qi running || { echo "NetworkManager did not start"; exit 4; }
echo "==> NetworkManager is running"
nmcli device status || true
`.replace('__CONF__', nmUnmanagedConf({ iwd: true }).trimEnd());

// ---------------------------------------------------------------- probe script (host)
const PROBE = [
  'for b in nmcli iwctl wpa_cli wpa_supplicant iw rfkill resolvectl journalctl netplan networkctl ip ifup apt-get dnf yum pacman zypper apk rpm-ostree; do command -v "$b" >/dev/null 2>&1 && echo "bin:$b"; done',
  'for u in NetworkManager iwd systemd-networkd; do echo "unit:$u:$(systemctl is-active "$u" 2>/dev/null)"; done',
  'for p in iwd wpa_supplicant systemd-networkd NetworkManager; do pgrep -x "$p" >/dev/null 2>&1 && echo "proc:$p"; done',
  'for d in /sys/class/net/*; do { [ -e "$d/wireless" ] || [ -e "$d/phy80211" ]; } && echo "wifi:${d##*/}"; done',
  '[ -d /etc/netplan ] && echo dir:netplan',
  '[ -f /etc/network/interfaces ] && grep -qE "^\\s*(iface|auto|allow-hotplug)\\s+[^l]" /etc/network/interfaces 2>/dev/null && echo ifupdown:1',
  'true',
].join('\n');

// ---------------------------------------------------------------- runtime
function create({ run, root, dataDir, opts = {} }) {
  const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
  const hostFile = (p) => path.join(root, p);
  let cache = null;

  async function nmStatus() {
    const r = await run('nmcli', ['-t', '-f', 'RUNNING', 'general'], { timeout: 8000 });
    const missing = r.code === 127 || (r.code >= 126 && /No such file|not found/i.test(r.stderr));
    if (missing) return { installed: false, running: false, message: null };
    if (r.code !== 0) return { installed: true, running: false, message: /not running/i.test(r.stderr) ? 'NetworkManager is installed but not running.' : `NetworkManager is installed but not usable: ${(r.stderr || '').trim() || 'nmcli failed'}.` };
    if (!/running/i.test(r.stdout)) return { installed: true, running: false, message: 'NetworkManager is installed but not running.' };
    return { installed: true, running: true, message: null };
  }

  async function hostInfo(caps) {
    const osRelease = parseKv(await fsp.readFile(hostFile('etc/os-release'), 'utf8').catch(() => fsp.readFile(hostFile('usr/lib/os-release'), 'utf8').catch(() => '')));
    const mounts = await fsp.readFile('/proc/1/mounts', 'utf8').catch(() => '');
    const rootLine = mounts.split('\n').find((l) => l.split(' ')[1] === '/');
    const rootRo = !!rootLine && /(^|,)ro(,|$)/.test(rootLine.split(' ')[3] || '');
    const exists = (p) => fsp.access(hostFile(p)).then(() => true, () => false);
    const [ostree, rugix, umbrel] = await Promise.all([exists('run/ostree-booted'), exists('run/rugix'), exists('etc/umbrel').then((x) => x || exists('home/umbrel/umbrel'))]);
    return { osRelease, rootRo, ostree: ostree || caps.bins.has('rpm-ostree'), rugix, umbrel, pkg: pickPkg(caps.bins) };
  }

  async function detect(force) {
    if (!force && cache && Date.now() - cache.at < 15000) return cache.value;
    const [nm, probe] = await Promise.all([nmStatus(), run('sh', ['-c', PROBE], { timeout: 10000 })]);
    const caps = parseProbe(probe.stdout);
    const backends = chooseBackends(caps, nm);
    const desc = describe(backends, nm);
    let install = null;
    if (!nm.running) {
      const info = await hostInfo(caps);
      const cls = nm.installed ? { installable: false, reason: null } : classifyHost(info);
      install = {
        available: !nm.installed && cls.installable, pkg: cls.pkg || null, reason: cls.reason,
        osName: info.osRelease.PRETTY_NAME || info.osRelease.NAME || null,
        managedBy: [caps.netplanDir && caps.bins.has('netplan') && 'netplan', active(caps, 'systemd-networkd') && 'systemd-networkd', caps.ifupdown && 'ifupdown', active(caps, 'iwd') && 'iwd'].filter(Boolean),
        iwd: active(caps, 'iwd'),
      };
    }
    const value = { nm, caps, backends, install, ...desc };
    cache = { at: Date.now(), value };
    return value;
  }
  const invalidate = () => { cache = null; };

  // ---- Wi-Fi
  async function iwdDevices(d) { const r = await run('iwctl', ['station', 'list'], { timeout: 8000 }); return r.code === 0 ? parseIwctlStations(r.stdout) : d.caps.wifiIfaces.map((x) => ({ device: x, state: '' })); }

  async function scan(d, rescan, deviceHint) {
    const b = d.backends;
    const devs = d.caps.wifiIfaces.filter((x) => !deviceHint || x === deviceHint);
    if (b.scan === 'networkmanager') {
      const r = await run('nmcli', ['-t', '-f', 'IN-USE,SSID,BSSID,SIGNAL,SECURITY,CHAN,DEVICE', 'device', 'wifi', 'list', '--rescan', rescan ? 'yes' : 'auto'], { timeout: 30000 });
      if (r.code !== 0) throw bad((r.stderr || 'Wi-Fi scan failed').trim(), 500);
      return parseNmcliWifi(r.stdout);
    }
    let all = [];
    if (b.scan === 'iwd') {
      for (const s of await iwdDevices(d)) {
        if (rescan) { await run('iwctl', ['station', s.device, 'scan'], { timeout: 15000 }); await new Promise((r) => setTimeout(r, 3000)); }
        let r = await run('iwctl', ['station', s.device, 'get-networks', 'rssi-dbms'], { timeout: 15000 });
        if (r.code !== 0) r = await run('iwctl', ['station', s.device, 'get-networks'], { timeout: 15000 });
        all = all.concat(parseIwctlNetworks(r.stdout, s.device));
      }
    } else if (b.scan === 'wpa_supplicant') {
      for (const dev of devs) {
        const st = parseKv((await run('wpa_cli', ['-i', dev, 'status'], { timeout: 8000 })).stdout);
        if (rescan) { await run('wpa_cli', ['-i', dev, 'scan'], { timeout: 8000 }); await new Promise((r) => setTimeout(r, 4000)); }
        const r = await run('wpa_cli', ['-i', dev, 'scan_results'], { timeout: 10000 });
        all = all.concat(parseWpaScanResults(r.stdout, dev, st.wpa_state === 'COMPLETED' ? st.bssid : ''));
      }
    } else if (b.scan === 'iw') {
      for (const dev of devs) {
        await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 8000 });
        const r = await run('iw', ['dev', dev, 'scan'], { timeout: 30000 });
        if (r.code !== 0) throw bad(`iw scan failed: ${(r.stderr || '').trim()}`, 500);
        all = all.concat(parseIwScan(r.stdout, dev));
      }
    }
    return dedupeNetworks(all);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const errText = (r) => (r.stderr || r.stdout || 'exit ' + r.code).trim();
  const chk = (r, what) => { if (r.code !== 0) throw bad(`${what} failed: ${errText(r)}`, r.code === 127 ? 501 : 500); };

  // ---- host files with snapshot/restore (for rollback)
  async function snapshotFiles(rels) {
    const snap = [];
    for (const rel of rels) {
      const text = await fsp.readFile(hostFile(rel), 'utf8').catch(() => null);
      const mode = text == null ? null : ((await fsp.stat(hostFile(rel)).catch(() => null)) || { mode: 0o600 }).mode & 0o777;
      snap.push({ rel, text, mode });
    }
    return async () => {
      for (const s of snap) {
        if (s.text == null) await fsp.unlink(hostFile(s.rel)).catch(() => {});
        else { await fsp.mkdir(path.dirname(hostFile(s.rel)), { recursive: true }); await fsp.writeFile(hostFile(s.rel), s.text, { mode: s.mode }); await fsp.chmod(hostFile(s.rel), s.mode).catch(() => {}); }
      }
    };
  }

  const NETPLAN_OWN = 'etc/netplan/90-uiable.yaml';
  async function readNetplanOwn() {
    const f = hostFile(NETPLAN_OWN);
    const text = await fsp.readFile(f, 'utf8').catch(() => null);
    return { file: f, text, doc: text ? (yaml.load(text) || {}) : {} };
  }
  async function writeNetplanOwn(doc) {
    const f = hostFile(NETPLAN_OWN);
    const out = '# Managed by Uiable (Settings > Network). Other netplan files are left untouched.\n' + yaml.dump(doc, { lineWidth: -1 });
    await fsp.mkdir(path.dirname(f), { recursive: true });
    await fsp.writeFile(f, out, { mode: 0o600 });
    await fsp.chmod(f, 0o600).catch(() => {});
  }
  async function netplanApply() { chk(await run('netplan', ['apply'], { timeout: 90000 }), 'netplan apply'); }

  /** Mutate Uiable's netplan file, validate with `netplan generate` (restore on error), then apply. */
  async function applyNetplan(mutate) {
    const own = await readNetplanOwn();
    const restore = await snapshotFiles([NETPLAN_OWN]);
    await writeNetplanOwn(mutate(own.doc));
    const gen = await run('netplan', ['generate'], { timeout: 30000 });
    if (gen.code !== 0) { await restore(); throw bad(`netplan rejected the config: ${errText(gen)}`, 500); }
    await netplanApply();
    return restore;
  }
  async function netplanGet(key) {
    const r = await run('netplan', ['get', key], { timeout: 15000 });
    if (r.code !== 0) return null;
    try { const v = yaml.load(r.stdout); return v && typeof v === 'object' ? v : null; } catch (_) { return null; }
  }

  // ---- live interface state
  async function nmDeviceMap(d) {
    if (!d.nm.running) return {};
    const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'], { timeout: 8000 });
    const m = {};
    r.stdout.split('\n').filter(Boolean).forEach((l) => { const p = splitTerse(l); m[p[0]] = { type: p[1], state: p[2], connection: p[3] && p[3] !== '--' ? p[3] : '' }; });
    return m;
  }
  const nmManages = (nmMap, dev) => !!nmMap[dev] && !/unmanaged|unavailable/.test(nmMap[dev].state);

  /** Association info for one Wi-Fi interface, whatever the backend. */
  async function wifiLink(d, dev, nmMap) {
    if (d.nm.running && nmManages(nmMap || {}, dev)) {
      const r = await run('nmcli', ['-t', '-f', 'ACTIVE,SSID,SIGNAL,CHAN,DEVICE', 'device', 'wifi', 'list', '--rescan', 'no'], { timeout: 10000 });
      const row = r.stdout.split('\n').map(splitTerse).find((p) => p[0] === 'yes' && p[4] === dev);
      if (row) return { connected: true, ssid: row[1], signal: +row[2] || null, channel: row[3] };
      return { connected: false };
    }
    if (d.caps.bins.has('iw')) {
      const r = await run('iw', ['dev', dev, 'link'], { timeout: 8000 });
      if (r.code === 0) return parseIwLink(r.stdout);
    }
    if (d.backends.wifi === 'iwd') {
      const sh = parseIwctlShow((await run('iwctl', ['station', dev, 'show'], { timeout: 8000 })).stdout);
      return /connected/i.test(sh.state || '') && !/dis/i.test(sh.state) ? { connected: true, ssid: sh.connectedNetwork || '' } : { connected: false };
    }
    if (d.caps.bins.has('wpa_cli')) {
      const st = parseKv((await run('wpa_cli', ['-i', dev, 'status'], { timeout: 8000 })).stdout);
      if (st.wpa_state === 'COMPLETED') {
        const sp = parseKv((await run('wpa_cli', ['-i', dev, 'signal_poll'], { timeout: 8000 })).stdout);
        return { connected: true, ssid: st.ssid || '', bssid: st.bssid || '', signal: sp.RSSI ? dbmToPercent(sp.RSSI) : null, channel: freqToChannel(st.freq) };
      }
      if (st.wpa_state) return { connected: false, wpaState: st.wpa_state };
    }
    return { connected: false };
  }

  /** Full picture for the Network page: interfaces with type/state/IP/gateway/DNS/Wi-Fi + uplink. */
  async function overview(d) {
    const [addr, r4, r6, dnsR, nmMap] = await Promise.all([
      run('ip', ['-j', '-d', 'addr'], { timeout: 8000 }),
      run('ip', ['-j', 'route', 'show', 'default'], { timeout: 5000 }),
      run('ip', ['-j', '-6', 'route', 'show', 'default'], { timeout: 5000 }),
      d.caps.bins.has('resolvectl') ? run('resolvectl', ['dns'], { timeout: 5000 }) : Promise.resolve({ code: 1, stdout: '' }),
      nmDeviceMap(d),
    ]);
    const ifs = parseIpAddrJson(addr.stdout);
    const routes = parseDefaultRoutes(r4.stdout, 4).concat(parseDefaultRoutes(r6.stdout, 6));
    const dns = parseResolvectlDns(dnsR.stdout);
    const resolv = await fsp.readFile(hostFile('etc/resolv.conf'), 'utf8').catch(() => '');
    const globalDns = dns.global.length ? dns.global : resolv.split('\n').filter((l) => l.startsWith('nameserver')).map((l) => l.split(/\s+/)[1]).filter((x) => x && !/^127\.0\.0\.53$/.test(x));
    const types = {};
    const primary = routes.find((r) => r.family === 4 && !r.linkdown) || routes.find((r) => !r.linkdown) || null;
    const interfaces = [];
    for (const i of ifs) {
      const type = ifaceType(i, d.caps.wifiIfaces);
      types[i.name] = type;
      const wifi = type === 'wifi' ? await wifiLink(d, i.name, nmMap).catch(() => ({ connected: false })) : null;
      const st = ifaceStatus(i, type, wifi);
      const gw = routes.filter((r) => r.dev === i.name);
      const managedBy = type === 'loopback' || type === 'virtual' ? null : (d.nm.running && nmManages(nmMap, i.name)) ? 'networkmanager' : ownWpaActive(i.name) ? 'systemd-networkd' : (d.backends.fallbackConfig || d.backends.config || null);
      interfaces.push({
        name: i.name, type, state: st.state, label: st.label, canLink: st.canLink && !!d.backends.link,
        canConfig: !!managedBy && type !== 'virtual' && type !== 'loopback',
        mac: i.mac, mtu: i.mtu, flags: i.flags, addresses: i.addresses, ipv4: i.ipv4, ipv6: i.ipv6, dhcp: i.dynamic,
        gateway: (gw.find((r) => r.family === 4) || {}).gateway || '', gateway6: (gw.find((r) => r.family === 6) || {}).gateway || '',
        metric: gw.length ? gw[0].metric : null, dns: dns.links[i.name] || [],
        wifi: wifi && wifi.connected ? { ssid: wifi.ssid || '', signal: wifi.signal, channel: wifi.channel || '' } : null,
        connection: (nmMap[i.name] || {}).connection || (wifi && wifi.connected ? wifi.ssid : '') || '',
        managedBy, primary: !!primary && primary.dev === i.name,
      });
    }
    const prefs = await loadPrefs();
    return {
      interfaces, routes, dns: globalDns,
      uplink: {
        primary: primary ? { dev: primary.dev, type: types[primary.dev] || '', gateway: primary.gateway, metric: primary.metric, ip: ((interfaces.find((x) => x.name === primary.dev) || {}).ipv4 || [])[0] || '' } : null,
        mode: prefs.uplinkMode || inferUplinkMode(routes, types), modeStored: !!prefs.uplinkMode,
        wired: interfaces.filter((x) => x.type === 'ethernet').map((x) => x.name),
        wireless: interfaces.filter((x) => x.type === 'wifi').map((x) => x.name),
        canSet: !!(d.nm.running || d.backends.fallbackConfig),
      },
      defaultRoute: primary ? `default via ${primary.gateway} dev ${primary.dev}${primary.metric ? ' metric ' + primary.metric : ''}` : '',
    };
  }

  // ---- small persisted prefs (uplink mode, gateways parked by "X only")
  async function loadPrefs() {
    if (!dataDir) return {};
    try { return JSON.parse(await fsp.readFile(path.join(dataDir, 'network.json'), 'utf8')); } catch (_) { return {}; }
  }
  async function savePrefs(p) {
    if (!dataDir) return;
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'network.json'), JSON.stringify(p, null, 2), { mode: 0o600 });
  }

  // ---- guarded changes: auto-rollback unless confirmed (netplan try style)
  let pending = null;
  async function guarded(label, seconds, apply) {
    if (pending) throw bad(`Another network change ("${pending.label}") is waiting for confirmation. Keep or revert it first.`, 409);
    const secs = Math.max(15, Math.min(300, Number(seconds) || 60));
    const { restore, result } = await apply();
    const token = crypto.randomBytes(12).toString('hex');
    const p = { token, label, expires: Date.now() + secs * 1000, restore };
    p.timer = setTimeout(() => { if (pending === p) { pending = null; console.warn(`[network] "${label}" not confirmed within ${secs}s, rolling back`); restore().catch((e) => console.error('[network] rollback failed:', e.message)).finally(invalidate); } }, (opts.rollbackMs != null ? opts.rollbackMs : secs * 1000));
    if (p.timer.unref) p.timer.unref();
    pending = p;
    invalidate();
    return Object.assign({}, result, { pending: { token, seconds: secs, label } });
  }
  function confirmPending(token) {
    if (!pending || pending.token !== token) throw bad('Nothing to confirm (it may already have been rolled back).', 409);
    clearTimeout(pending.timer); const label = pending.label; pending = null;
    return { ok: true, kept: label };
  }
  async function revertPending(token) {
    if (!pending || pending.token !== token) throw bad('Nothing to revert.', 409);
    clearTimeout(pending.timer); const p = pending; pending = null;
    await p.restore(); invalidate();
    return { ok: true, reverted: p.label };
  }
  const pendingInfo = () => (pending ? { token: pending.token, label: pending.label, secondsLeft: Math.max(0, Math.round((pending.expires - Date.now()) / 1000)) } : null);

  // ---- Wi-Fi connect with verification
  async function rfkillState() {
    const r = await run('sh', ['-c', 'for r in /sys/class/rfkill/rfkill*; do [ -e "$r/type" ] && echo "$(cat $r/name) $(cat $r/type) $(cat $r/soft) $(cat $r/hard)"; done; true'], { timeout: 5000 });
    return parseRfkill(r.stdout);
  }
  async function ensureRadioOn() {
    let rf = (await rfkillState()).filter((x) => x.type === 'wlan');
    if (rf.some((x) => x.soft && !x.hard)) {
      await run('sh', ['-c', 'rfkill unblock wifi 2>/dev/null || for r in /sys/class/rfkill/rfkill*; do [ "$(cat $r/type)" = wlan ] && echo 0 > $r/soft; done; true'], { timeout: 8000 });
      await sleep(opts.fast ? 0 : 1500);
      rf = (await rfkillState()).filter((x) => x.type === 'wlan');
    }
    return rf;
  }
  async function hostIpv4(dev) {
    const r = await run('ip', ['-j', '-4', 'addr', 'show', 'dev', dev], { timeout: 5000 });
    return (parseIpAddrJson(r.stdout)[0] || {}).ipv4 || [];
  }
  async function wifiLog(d, dev, since) {
    if (!d.caps.bins.has('journalctl')) return '';
    const units = [`netplan-wpa-${dev}.service`, `uiable-wpa@${dev}.service`, 'wpa_supplicant.service', `wpa_supplicant@${dev}.service`, 'iwd.service', 'systemd-networkd.service', 'NetworkManager.service'];
    const r = await run('journalctl', ['--no-pager', '-o', 'short-unix', '-n', '200', '--since', `@${Math.floor(since / 1000)}`, ...units.flatMap((u) => ['-u', u])], { timeout: 10000 });
    return filterJournalSince(r.stdout || '', since);
  }

  /** Poll until dev is associated (to ssid) and has an IPv4 address. */
  async function waitForWifi(d, dev, ssid, ms) {
    const until = Date.now() + ms;
    let link = { connected: false }, ip = [];
    do {
      link = await wifiLink(d, dev, await nmDeviceMap(d)).catch(() => ({ connected: false }));
      ip = await hostIpv4(dev);
      if (link.connected && (!ssid || !link.ssid || link.ssid === ssid) && ip.length) return { ok: true, link, ip };
      if (Date.now() >= until) break;
      await sleep(opts.fast ? 0 : 2000);
    } while (Date.now() < until);
    return { ok: false, link, ip };
  }

  // ---- leftovers from a removed NetworkManager, and handing Wi-Fi to an installed one
  const NETPLAN_PARKED = 'etc/netplan/uiable-disabled';
  /** NetworkManager-written netplan files (90-NM-*.yaml) and Uiable's NM conf left behind after NM was removed. */
  async function staleNmFiles(d) {
    if (d.nm.installed) return [];
    const names = await fsp.readdir(hostFile('etc/netplan')).catch(() => []);
    const out = names.filter((n) => /^90-NM-.*\.ya?ml$/.test(n)).map((n) => `etc/netplan/${n}`);
    if (await fsp.access(hostFile(NM_UIABLE_CONF.slice(1))).then(() => true, () => false)) out.push(NM_UIABLE_CONF.slice(1));
    return out;
  }
  /** Park stale NM leftovers (restorable) so netplan doesn't hand the Wi-Fi to a NetworkManager that isn't there. */
  async function parkStaleNm(d) {
    const files = await staleNmFiles(d);
    if (!files.length) return { files: [], restore: async () => {} };
    const moved = [];
    for (const rel of files) {
      const dst = rel.startsWith('etc/netplan/') ? `${NETPLAN_PARKED}/${path.basename(rel)}` : `${NETPLAN_PARKED}/NetworkManager-${path.basename(rel)}`;
      await fsp.mkdir(path.dirname(hostFile(dst)), { recursive: true });
      await fsp.rename(hostFile(rel), hostFile(dst)).then(() => moved.push([rel, dst]), () => {});
    }
    return { files: moved.map((m) => '/' + m[0]), restore: async () => { for (const [rel, dst] of moved) await fsp.rename(hostFile(dst), hostFile(rel)).catch(() => {}); } };
  }
  /**
   * After NetworkManager is installed: netplan marks every interface it renders with networkd as
   * "unmanaged" for NM, so drop Uiable's own netplan Wi-Fi entries, re-apply netplan, then tell NM
   * to manage the Wi-Fi devices and switch the radio on.
   */
  async function nmAdopt(d, devs) {
    const log = [];
    const list = (devs && devs.length ? devs : d.caps.wifiIfaces).filter(validDev);
    const own = await readNetplanOwn();
    const wifis = (own.doc.network || {}).wifis || {};
    const drop = list.filter((x) => wifis[x]);
    if (drop.length) {
      drop.forEach((x) => delete wifis[x]);
      if (!Object.keys(wifis).length) delete own.doc.network.wifis;
      await writeNetplanOwn(own.doc);
      log.push(`Removed ${drop.join(', ')} from ${'/' + NETPLAN_OWN} so NetworkManager can manage it.`);
      if (d.caps.bins.has('netplan')) { await run('netplan', ['generate'], { timeout: 30000 }); await run('netplan', ['apply'], { timeout: 90000 }); }
    }
    for (const x of list) if (ownWpaActive(x)) { await ownWpaRemove(x); log.push(`Stopped Uiable's own wpa_supplicant (uiable-wpa@${x}) so NetworkManager is the only Wi-Fi manager.`); }
    await run('nmcli', ['radio', 'wifi', 'on'], { timeout: 10000 });
    for (const x of list) {
      const r = await run('nmcli', ['device', 'set', x, 'managed', 'yes'], { timeout: 10000 });
      log.push(r.code === 0 ? `NetworkManager now manages ${x}.` : `Could not hand ${x} to NetworkManager: ${errText(r)}`);
    }
    invalidate();
    return log;
  }
  /** Which Wi-Fi managers are running (two at once on one adapter break the handshake). */
  async function wifiManagers(dev, nmUnmanaged = []) {
    const d0nmUnmanaged = (x) => nmUnmanaged.includes(x);
    const r = await run('sh', ['-c', 'pgrep -a wpa_supplicant; pgrep -a iwd; pgrep -a NetworkManager; true'], { timeout: 5000 });
    const lines = String(r.stdout || '').split('\n').filter(Boolean);
    const wpaDev = lines.filter((l) => /wpa_supplicant/.test(l) && new RegExp(`-i\\s*${dev}\\b`).test(l));
    const iwd = lines.some((l) => /\biwd\b/.test(l) && !/wpa_supplicant/.test(l));
    const nm = lines.some((l) => /NetworkManager/.test(l));
    const conflicts = [];
    if (wpaDev.length > 1) conflicts.push(`${wpaDev.length} wpa_supplicant processes are running on ${dev}`);
    if (iwd && (wpaDev.length || nm)) conflicts.push(`iwd is running alongside ${nm ? 'NetworkManager' : 'wpa_supplicant'}`);
    if (nm && wpaDev.length && !d0nmUnmanaged(dev)) conflicts.push(`NetworkManager is running while a separate wpa_supplicant (netplan/networkd) also drives ${dev}`);
    return { lines, conflicts };
  }
  /** Security of ssid from a (cached) scan, or '' if unknown/hidden. */
  async function securityOf(d, dev, ssid) {
    try { const n = (await scan(d, false, dev)).find((x) => x.ssid === ssid); return n ? (n.security || 'open') : ''; } catch (_) { return ''; }
  }

  // ---- PMF (802.11w) capability per device, remembered once a card proves it can't do it
  const pmfCache = new Map();
  async function pmfCapability(d, dev) {
    if (pmfCache.has(dev)) return pmfCache.get(dev);
    const prefs = await loadPrefs();
    const known = (prefs.noPmf || {})[dev];
    const [probe, gm] = await Promise.all([
      run('sh', ['-c', PMF_PROBE, 'uiable-pmf', dev], { timeout: 8000 }).catch(() => ({ stdout: '' })),
      d.caps.bins.has('wpa_cli') ? run('wpa_cli', ['-i', dev, 'get_capability', 'group_mgmt'], { timeout: 5000 }).catch(() => ({ code: 1, stdout: '' })) : Promise.resolve({ code: 1, stdout: '' }),
    ]);
    let cap = parsePmfProbe(probe.stdout, gm.code === 0 ? gm.stdout : '');
    if (known && cap.pmf !== false) cap = Object.assign({}, cap, { pmf: false, source: `remembered: ${known.source || 'driver refused the IGTK key'}` });
    pmfCache.set(dev, cap);
    return cap;
  }
  async function rememberNoPmf(dev, source) {
    const prefs = await loadPrefs();
    prefs.noPmf = prefs.noPmf || {};
    prefs.noPmf[dev] = { source, at: new Date().toISOString() };
    await savePrefs(prefs);
    pmfCache.delete(dev);
  }

  // ---- Uiable-managed wpa_supplicant (uiable-wpa@<dev>) for cards netplan can't configure (PMF off)
  const OWN_UNIT_REL = 'etc/systemd/system/uiable-wpa@.service';
  const ownConfRel = (dev) => `etc/wpa_supplicant/uiable-${dev}.conf`;
  const ownNetRel = (dev) => `etc/systemd/network/10-uiable-${dev}.network`;
  const ownUplinkRel = (dev) => `${ownNetRel(dev)}.d/90-uiable-uplink.conf`;
  const ownWpaActive = (dev) => validDev(dev) && fs.existsSync(hostFile(ownConfRel(dev)));
  const writeHost = async (rel, text, mode) => { await fsp.mkdir(path.dirname(hostFile(rel)), { recursive: true }); await fsp.writeFile(hostFile(rel), text, { mode }); await fsp.chmod(hostFile(rel), mode).catch(() => {}); };
  const sysd = (args, t = 30000) => run('systemctl', args, { timeout: t });
  async function networkdReload(dev) {
    const rl = await run('networkctl', ['reload'], { timeout: 20000 });
    if (rl.code !== 0) await sysd(['restart', 'systemd-networkd']);
    if (dev) await run('networkctl', ['reconfigure', dev], { timeout: 20000 });
  }
  /** Netplan wifis entry for dev (Uiable's file first) -> networkd IP config to carry over. */
  function ipFromNetplan(e) {
    if (e && Array.isArray(e.addresses) && e.addresses.length && e.dhcp4 !== true) {
      const gw = (e.routes || []).find((r) => r && (r.to === 'default' || r.to === '0.0.0.0/0'));
      return { mode: 'static', address: String(e.addresses[0]), gateway: (gw || {}).via || e.gateway4 || '', dns: ((e.nameservers || {}).addresses || []).map(String) };
    }
    return { mode: 'dhcp' };
  }
  /**
   * Switch dev's Wi-Fi to uiable-wpa@dev: write the supplicant conf (PMF off), the unit and a networkd .network
   * (IP settings carried over from netplan, Wi-Fi route priority), drop dev from Uiable's netplan wifis so
   * netplan-wpa-<dev> stops (no second supplicant), then start + enable. Returns an undo function.
   */
  async function ownWpaApply(d, dev, { ssid, psk, hidden, open }) {
    const unit = `uiable-wpa@${dev}.service`;
    const restoreFiles = await snapshotFiles([ownConfRel(dev), OWN_UNIT_REL, ownNetRel(dev), ownUplinkRel(dev)]);
    const wasEnabled = /^enabled/.test(((await sysd(['is-enabled', unit], 10000)).stdout || '').trim());
    const own = await readNetplanOwn();
    const ownEntry = (((own.doc.network || {}).wifis) || {})[dev];
    const existingNet = await fsp.readFile(hostFile(ownNetRel(dev)), 'utf8').catch(() => null);
    const ip = existingNet ? null : ipFromNetplan(ownEntry);
    const wp = planUplink((await loadPrefs()).uplinkMode || 'prefer-wired').wifi;
    let restoreNetplan = null;
    const undo = async () => {
      await sysd(['stop', unit]);
      if (!wasEnabled) await sysd(['disable', unit]);
      await restoreFiles();
      await sysd(['daemon-reload']);
      if (restoreNetplan) { await restoreNetplan(); await run('netplan', ['apply'], { timeout: 90000 }); }
      await networkdReload(dev);
      if (wasEnabled) await sysd(['restart', unit]);
    };
    try {
      await writeHost(ownConfRel(dev), buildOwnWpaConf({ ssid, psk, hidden, open }), 0o600);
      await writeHost(OWN_UNIT_REL, OWN_WPA_UNIT, 0o644);
      if (ip) await writeHost(ownNetRel(dev), buildNetworkdUnit(Object.assign({ device: dev, wifi: true }, ip)), 0o644);
      if (!existingNet && ip.mode === 'dhcp') await writeHost(ownUplinkRel(dev), buildNetworkdUplinkDropin(wp), 0o644);
      if (ownEntry && d.caps.bins.has('netplan')) {
        restoreNetplan = await applyNetplan((doc) => {
          const w = (doc.network || {}).wifis || {};
          delete w[dev];
          if (doc.network && !Object.keys(w).length) delete doc.network.wifis;
          return doc;
        });
      }
      if (d.caps.bins.has('netplan')) {
        const other = await netplanGet(`network.wifis.${dev}`);
        if (other) throw bad(`${dev} is also set up as Wi-Fi in another netplan file in /etc/netplan, which would start a second wpa_supplicant on it. Remove that wifis entry (or run Diagnostics to see which file) and try again.`, 409);
      }
      await sysd(['stop', `netplan-wpa-${dev}.service`]);
      chk(await sysd(['daemon-reload']), 'systemctl daemon-reload');
      await sysd(['enable', unit]);
      chk(await sysd(['restart', unit]), `systemctl restart ${unit}`);
      await networkdReload(dev);
    } catch (e) { await undo().catch(() => {}); throw e; }
    return undo;
  }
  /** Stop and remove uiable-wpa@dev (e.g. when NetworkManager takes over). Returns a restore function. */
  async function ownWpaRemove(dev) {
    const unit = `uiable-wpa@${dev}.service`;
    const restoreFiles = await snapshotFiles([ownConfRel(dev), ownNetRel(dev), ownUplinkRel(dev)]);
    await sysd(['disable', '--now', unit]);
    for (const rel of [ownConfRel(dev), ownUplinkRel(dev), ownNetRel(dev)]) await fsp.unlink(hostFile(rel)).catch(() => {});
    await fsp.rmdir(path.dirname(hostFile(ownUplinkRel(dev)))).catch(() => {});
    await networkdReload(null);
    return async () => { await restoreFiles(); await sysd(['daemon-reload']); await sysd(['enable', '--now', unit]); await networkdReload(dev); };
  }
  /** iwd: [General] ManagementFrameProtection=0 in /etc/iwd/main.conf, then restart iwd. Returns undo. */
  async function iwdPmfOff() {
    const rel = 'etc/iwd/main.conf';
    const restore = await snapshotFiles([rel]);
    const cur = await fsp.readFile(hostFile(rel), 'utf8').catch(() => '');
    await writeHost(rel, setIniKey(cur, 'General', 'ManagementFrameProtection', '0'), 0o644);
    await sysd(['restart', 'iwd']);
    await sleep(opts.fast ? 0 : 3000);
    return async () => { await restore(); await sysd(['restart', 'iwd']); };
  }

  async function wifiConnect(d, { ssid, password, device, hidden }) {
    const b = d.backends;
    if (!b.wifi) throw bad(b.hasWifi ? d.summary : 'No Wi-Fi adapter was found on this host.', b.hasWifi ? 501 : 404);
    validatePassphrase(password);
    const dev = device && validDev(device) ? device : d.caps.wifiIfaces[0];
    if (!dev) throw bad('No Wi-Fi adapter was found on this host.', 404);
    const isHex = /^[0-9a-f]{64}$/i.test(password || '');
    const psk = password ? (isHex ? password.toLowerCase() : wpaPsk(ssid, password)) : '';
    const secrets = [password, psk];
    const fail = (r, what) => bad(`${what} failed: ${scrub(errText(r), secrets)}`, r.code === 127 ? 501 : 500);
    const waitMs = opts.wifiWaitMs != null ? opts.wifiWaitMs : 60000;
    const viaNetplan = b.wifi !== 'networkmanager' && (b.wifi === 'netplan' || (b.wifi === 'wpa_supplicant' && b.config === 'netplan'));

    // Pre-flight: radio on, supplicant present (netplan needs wpa_supplicant), link up.
    const rf = await ensureRadioOn();
    const supplicantMissing = viaNetplan && !d.caps.bins.has('wpa_supplicant');
    if (supplicantMissing || rf.some((x) => x.soft || x.hard)) {
      throw bad(classifyWifiFailure({ rfkill: rf, supplicantMissing }).message, 409);
    }
    const security = hidden ? '' : await securityOf(d, dev, ssid);
    const plan = wifiSecurityPlan(security);
    if (plan.keyMgmt === 'eap') throw bad(`${ssid} is an enterprise (802.1X) network; Uiable can only join personal (password) Wi-Fi.`, 400);
    if (plan.keyMgmt === 'sae' && isHex) throw bad(`${ssid} is WPA3-only (SAE), which needs the actual password, not a 64-digit hex key.`, 400);
    // PMF (802.11w): cards like the Intel Centrino Advanced-N 6205 (iwldvm) can't install the IGTK, so any AP that
    // offers PMF fails right after associating. Detect up front (iw phy ciphers / driver) or from a failed attempt.
    const cap = await pmfCapability(d, dev);
    // NetworkManager already negotiates WPA2 without PMF on such cards, so let it; only force PMF off after a failure.
    let noPmf = cap.pmf === false && !!password && b.wifi !== 'networkmanager';
    const nmTip = !d.nm.installed && d.install && d.install.available ? ' NetworkManager handles cards without PMF automatically, so Install NetworkManager (Settings → Network) is the recommended setup for this card.' : '';
    if (cap.pmf === false && password && plan.keyMgmt === 'sae') throw Object.assign(bad(wpa3NoPmfMessage(ssid, cap), 409), { code: 'no-pmf', reason: 'no-pmf' });
    if (b.wifi !== 'networkmanager') await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 8000 });
    if (b.wifi === 'networkmanager') {
      const nmMap = await nmDeviceMap(d);
      if (!nmManages(nmMap, dev)) await nmAdopt(d, [dev]);
    }

    /** One attempt with a given key management (+ PMF off); returns { res, undo, nmError, started }. */
    const attempt = async (keyMgmt, pmfOff) => {
      const started = Date.now();
      let undo = async () => {};
      let nmError = '';
      if (b.wifi === 'networkmanager') {
        let r;
        if (pmfOff && password) {
          // Own profile so PMF can be disabled (wifi-sec.pmf 1 = disable) and key-mgmt pinned to WPA-PSK.
          await run('nmcli', ['connection', 'delete', 'id', ssid], { timeout: 15000 });
          const add = ['connection', 'add', 'type', 'wifi', 'con-name', ssid, 'ifname', dev, 'ssid', ssid, 'wifi-sec.key-mgmt', 'wpa-psk', 'wifi-sec.psk', password, 'wifi-sec.pmf', '1'];
          if (hidden) add.push('802-11-wireless.hidden', 'yes');
          r = await run('nmcli', add, { timeout: 30000 });
          if (r.code === 0) r = await run('nmcli', ['--wait', '45', 'connection', 'up', 'id', ssid, 'ifname', dev], { timeout: 60000 });
        } else {
          // NM detects WPA2/WPA3 from the scan and sets wifi-sec.key-mgmt itself.
          const args = ['--wait', '45', 'device', 'wifi', 'connect', ssid];
          if (password) args.push('password', password);
          args.push('ifname', dev);
          if (hidden) args.push('hidden', 'yes');
          r = await run('nmcli', args, { timeout: 60000 });
        }
        if (r.code !== 0) nmError = scrub(errText(r), secrets);
        undo = async () => { await run('nmcli', ['connection', 'delete', 'id', ssid], { timeout: 15000 }); };
      } else if (viaNetplan && pmfOff) {
        // netplan can't turn PMF off for the networkd renderer: run Uiable's own supplicant for this device.
        const parked = await parkStaleNm(d);
        let un;
        try { un = await ownWpaApply(d, dev, { ssid, psk, hidden, open: !password }); } catch (e) { await parked.restore(); throw Object.assign(e, { message: scrub(e.message, secrets) }); }
        undo = async () => { await un(); await parked.restore(); };
      } else if (viaNetplan) {
        // Give Wi-Fi a route priority that matches the Wired / Wi-Fi preference (default: prefer wired),
        // so joining Wi-Fi never silently steals the default route from the cable.
        const wp = planUplink((await loadPrefs()).uplinkMode || 'prefer-wired').wifi;
        const parked = await parkStaleNm(d);
        let restoreFile, restoreOwn = null;
        try {
          if (ownWpaActive(dev)) restoreOwn = await ownWpaRemove(dev); // never two supplicants on one card
          restoreFile = await applyNetplan((doc) => {
            const out = buildNetplanDoc(doc, { device: dev, wireless: true, wifi: { ssid, password, psk, hidden, keyMgmt, renderer: d.nm.running ? null : 'networkd' } });
            const e = out.network.wifis[dev];
            if (e.dhcp4 === true && !e['dhcp4-overrides']) e['dhcp4-overrides'] = { 'route-metric': wp.metric, 'use-routes': wp.defaultRoute };
            return out;
          });
        } catch (e) { if (restoreOwn) await restoreOwn().catch(() => {}); await parked.restore(); throw Object.assign(e, { message: scrub(e.message, secrets) }); }
        undo = async () => { await restoreFile(); await parked.restore(); await run('netplan', ['apply'], { timeout: 90000 }); if (restoreOwn) await restoreOwn(); };
      } else if (b.wifi === 'iwd') {
        const pmfUndo = pmfOff ? await iwdPmfOff() : null;
        const args = password ? ['--passphrase', password] : [];
        args.push('station', dev, hidden ? 'connect-hidden' : 'connect', ssid);
        const r = await run('iwctl', args, { timeout: 60000 });
        if (r.code !== 0) nmError = scrub(errText(r), secrets);
        undo = async () => { await run('iwctl', ['known-networks', ssid, 'forget'], { timeout: 10000 }); if (pmfUndo) await pmfUndo(); };
      } else {
        // wpa_supplicant: hex SSID + derived PSK, so the plaintext password never reaches argv.
        // WPA3-only (SAE) can't use a derived PSK, so that one case passes the quoted passphrase.
        const w = (args, t = 10000) => run('wpa_cli', ['-i', dev, ...args], { timeout: t });
        const add = await w(['add_network']);
        const id = (add.stdout.trim().split('\n').pop() || '').trim();
        if (add.code !== 0 || !/^\d+$/.test(id)) throw fail(add, 'wpa_cli add_network');
        const steps = [['set_network', id, 'ssid', Buffer.from(ssid, 'utf8').toString('hex')]];
        if (!password) steps.push(['set_network', id, 'key_mgmt', 'NONE']);
        else if (keyMgmt === 'sae') steps.push(['set_network', id, 'key_mgmt', 'SAE'], ['set_network', id, 'ieee80211w', '2'], ['set_network', id, 'psk', `"${password}"`]);
        else if (pmfOff) steps.push(['set_network', id, 'key_mgmt', 'WPA-PSK'], ['set_network', id, 'psk', psk], ['set_network', id, 'ieee80211w', '0']);
        else {
          steps.push(['set_network', id, 'psk', psk]);
          if (plan.transition) steps.push(['set_network', id, 'ieee80211w', '1']);
        }
        if (hidden) steps.push(['set_network', id, 'scan_ssid', '1']);
        steps.push(['select_network', id]);
        for (const st of steps) {
          const r = await w(st);
          if (r.code !== 0 || /FAIL/.test(r.stdout)) { await w(['remove_network', id]); throw bad(`wpa_cli ${st[0]} ${st[2] || ''} failed`.trim(), 500); }
        }
        undo = async () => { await w(['remove_network', id]); await w(['save_config']); };
        if (b.config === 'systemd-networkd') await run('networkctl', ['reconfigure', dev], { timeout: 20000 });
      }
      const res = nmError && b.wifi === 'iwd' ? { ok: false, link: { connected: false }, ip: [] } : await waitForWifi(d, dev, ssid, nmError ? Math.min(waitMs, 3000) : waitMs);
      return { res, undo, nmError, started };
    };

    let nmUnmanagedList = [];
    if (d.nm.running) { try { const m = await nmDeviceMap(d); nmUnmanagedList = Object.keys(m).filter((k) => !nmManages(m, k)); } catch (_) { /* ignore */ } }
    const diagnose = async (x, km, pmfOff) => {
      const [log, reg, rf2, mg] = await Promise.all([
        wifiLog(d, dev, x.started - 500),
        d.caps.bins.has('iw') ? run('iw', ['reg', 'get'], { timeout: 5000 }) : Promise.resolve({ stdout: '' }),
        rfkillState(),
        wifiManagers(dev, d.nm.running ? nmUnmanagedList : []),
      ]);
      const label = plan.label + (km === 'sae' && plan.keyMgmt !== 'sae' ? ', tried SAE' : '') + (pmfOff ? ', PMF off' : '');
      const w = classifyWifiFailure({ keyMismatch: mg.conflicts.length > 0, log: scrub(log, secrets), nmError: x.nmError, rfkill: rf2, associated: x.res.link.connected, ip: x.res.ip.length > 0, regdom: ((reg.stdout || '').match(/country (\w\w)/) || [])[1], security: label, device: dev });
      if (mg.conflicts.length && w.code !== 'no-dhcp') w.message += `\n\nConflict: ${mg.conflicts.join('; ')}. Only one Wi-Fi manager should control ${dev}.`;
      return w;
    };

    let keyMgmt = plan.keyMgmt === 'sae' ? 'sae' : 'psk';
    const tried = new Set();
    let at, why = null;
    for (let i = 0; i < 3; i++) {
      tried.add(`${keyMgmt}/${noPmf}`);
      at = await attempt(keyMgmt, noPmf);
      if (at.res.ok) { why = null; break; }
      why = await diagnose(at, keyMgmt, noPmf);
      let next = null;
      if (why.code === 'no-pmf') {
        await rememberNoPmf(dev, 'driver refused the IGTK key ("Failed to configure IGTK")');
        if (plan.keyMgmt === 'sae') { why = { code: 'no-pmf', message: wpa3NoPmfMessage(ssid, await pmfCapability(d, dev)) + (why.message.includes('\n\n') ? why.message.slice(why.message.indexOf('\n\n')) : '') }; break; }
        // Same network again with PMF off (and plain WPA2-PSK).
        if (!noPmf) next = ['psk', true];
      } else if (!noPmf && keyMgmt === 'psk' && (plan.transition || (hidden && plan.keyMgmt === 'unknown' && password)) && (b.wifi === 'wpa_supplicant' || viaNetplan) && /handshake-failed|wrong-password|assoc-reject|timeout/.test(why.code) && !isHex) {
        // WPA2/WPA3 transition networks that reject WPA2-PSK (PMF/SAE-only in practice), and hidden networks
        // whose security we can't see: retry once with SAE.
        next = ['sae', false];
      }
      if (!next || tried.has(`${next[0]}/${next[1]}`)) break;
      await at.undo().catch(() => {});
      [keyMgmt, noPmf] = next;
    }
    if (why && why.code === 'no-pmf' && noPmf && plan.keyMgmt !== 'sae') {
      why.message = 'Still failing with PMF (802.11w) turned off. The router probably requires PMF ("PMF required", or WPA3-only on some bands). Set it to WPA2/WPA3 mixed with PMF optional, or WPA2-only.' + (why.message.includes('\n\n') ? why.message.slice(why.message.indexOf('\n\n')) : '');
    }
    if (why && why.code === 'no-pmf' && nmTip) why.message = why.message.replace(/^([^\n]*)/, (m) => m + nmTip);
    invalidate();
    if (!at.res.ok) {
      if (why.code !== 'no-dhcp') await at.undo().catch(() => {}); // keep the network when only DHCP is slow
      const msg = why.message.replace(/^([^\n]*?)(\.?)(\n|$)/, (m0, first, dot, nl) => `${first}${dot || '.'}${why.code !== 'no-dhcp' ? ' The Wi-Fi settings were rolled back.' : ''}${nl}`);
      throw Object.assign(bad(scrub(msg, secrets), 502), { code: why.code, reason: why.code });
    }
    const res = at.res;
    const via = (keyMgmt === 'sae' && b.wifi !== 'networkmanager' && b.wifi !== 'iwd' ? ' using WPA3 (SAE)' : '') +
      (noPmf ? ' with PMF (802.11w) off, because this Wi-Fi card doesn\'t support it' : '');
    const extra = (noPmf && viaNetplan ? ` Wi-Fi on ${dev} is now run by Uiable (uiable-wpa@${dev}) instead of netplan, and survives reboots.` : '') + (noPmf ? nmTip : '');
    if (b.wifi === 'wpa_supplicant' && !viaNetplan) {
      const save = await run('wpa_cli', ['-i', dev, 'save_config'], { timeout: 10000 });
      if (!(save.code === 0 && /OK/.test(save.stdout))) return { output: `Connected ${dev} to ${ssid}${via} (${res.ip[0]}). Note: wpa_supplicant isn't set to save networks (update_config=1), so this won't survive a reboot.`, ip: res.ip[0], signal: res.link.signal, persisted: false, security: plan.label, pmf: !noPmf };
    }
    return { output: `Connected ${dev} to ${ssid}${via}, IP ${res.ip[0]}${res.link.signal != null ? `, signal ${res.link.signal}%` : ''}.${extra}`, ip: res.ip[0], signal: res.link.signal, persisted: true, security: plan.label, pmf: !noPmf };
  }

  // ---- diagnostics (scrubbed) for the Wi-Fi card
  async function diagnostics(d, device) {
    const dev = device && validDev(device) ? device : (d.caps.wifiIfaces[0] || 'wlan0');
    const units = ['NetworkManager', 'wpa_supplicant', 'iwd', 'systemd-networkd', `netplan-wpa-${dev}`, `uiable-wpa@${dev}`];
    const script = [
      'sec() { printf "\\n### %s\\n" "$1"; }',
      'sec "rfkill"; (rfkill list 2>&1 || for r in /sys/class/rfkill/rfkill*; do [ -e "$r/type" ] && echo "$(cat $r/name) $(cat $r/type) soft=$(cat $r/soft) hard=$(cat $r/hard)"; done; true)',
      'sec "iw dev"; iw dev 2>&1', 'sec "iw reg get"; iw reg get 2>&1 | head -20',
      'sec "iw link"; iw dev "$1" link 2>&1',
      'sec "iw phy ciphers (PMF needs BIP-CMAC-128 / 00-0f-ac:6)"; phy=$(cat /sys/class/net/"$1"/phy80211/name 2>/dev/null); iw phy "$phy" info 2>&1 | sed -n "/Supported Ciphers/,/Available Antennas\\|Supported interface modes/p" | head -20; echo "driver: $(basename "$(readlink /sys/class/net/"$1"/device/driver 2>/dev/null)" 2>/dev/null) $( [ -d /sys/module/iwldvm ] && echo "(iwldvm loaded)")"',
      'sec "Uiable Wi-Fi supplicant"; printf "%-28s %s\\n" "uiable-wpa@$1" "$(systemctl is-active "uiable-wpa@$1" 2>&1)"; ls -l /etc/wpa_supplicant/uiable-"$1".conf /etc/systemd/network/10-uiable-"$1".network 2>&1',
      'sec "ip addr / routes"; ip -br addr 2>&1; ip route 2>&1',
      'sec "nmcli general"; nmcli general 2>&1', 'sec "nmcli device status"; nmcli device status 2>&1',
      `sec "services"; for u in ${units.join(' ')}; do printf "%-28s %s\\n" "$u" "$(systemctl is-active "$u" 2>&1)"; done`,
      'sec "Wi-Fi processes"; pgrep -a wpa_supplicant; pgrep -a iwd; pgrep -a NetworkManager; true',
      'sec "wpa_cli status"; wpa_cli -i "$1" status 2>&1 | grep -v "^passphrase"',
      'sec "netplan files"; ls -l /etc/netplan /etc/netplan/uiable-disabled /run/netplan 2>&1',
      'sec "netplan get"; netplan get 2>&1',
      'sec "NetworkManager conf.d"; ls -l /etc/NetworkManager/conf.d /run/NetworkManager/conf.d 2>&1; cat /run/NetworkManager/conf.d/*.conf 2>/dev/null',
      'sec "networkctl"; networkctl list 2>&1; networkctl status "$1" 2>&1 | head -40',
      `sec "journal (last 80 Wi-Fi lines)"; journalctl --no-pager -o short-iso -n 80 ${units.map((u) => `-u ${u}`).join(' ')} 2>&1`,
    ].join('\n');
    const r = await run('sh', ['-c', script, 'uiable-diag', dev], { timeout: 45000 });
    const head = `Uiable network diagnostics · ${new Date().toISOString()}\nDevice: ${dev}\nBackends: wifi=${d.backends.wifi || 'none'} config=${d.backends.config || 'none'} link=${d.backends.link || 'none'} · NetworkManager ${d.nm.running ? 'running' : d.nm.installed ? 'installed, not running' : 'not installed'}\n${d.summary || ''}`;
    const stale = await staleNmFiles(d);
    pmfCache.delete(dev);
    const cap = await pmfCapability(d, dev).catch(() => ({ pmf: null, source: 'check failed' }));
    const pkg = (d.install && d.install.pkg) || pickPkg(d.caps.bins);
    const missing = ['iw', 'rfkill'].filter((x) => !d.caps.bins.has(x));
    const inst = { apt: 'sudo apt install', dnf: 'sudo dnf install', yum: 'sudo yum install', zypper: 'sudo zypper install', apk: 'sudo apk add', pacman: 'sudo pacman -S' }[pkg];
    const hints = [];
    if (missing.length) hints.push(`Tip: ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not installed on the host, so some checks below are empty.${inst ? ` Install with: ${inst} ${pkg === 'pacman' ? missing.filter((x) => x !== 'rfkill').join(' ') || 'util-linux' : missing.join(' ')}` : ''}`);
    hints.push(`PMF (802.11w) support on ${dev}: ${cap.pmf === true ? 'yes' : cap.pmf === false ? 'NO' : 'unknown'} (${cap.source}).${cap.pmf === false ? ` Uiable joins WPA2 and WPA2/WPA3-mixed networks with PMF off on this card (as NetworkManager does); WPA3-only networks cannot work with it.${!d.nm.installed && d.install && d.install.available ? ' Recommended: Install NetworkManager, which handles this automatically.' : ''}` : ''}`);
    if (ownWpaActive(dev)) hints.push(`Wi-Fi on ${dev} is run by Uiable's own wpa_supplicant (uiable-wpa@${dev}, /etc/wpa_supplicant/uiable-${dev}.conf), not netplan.`);
    const extra = '\n\n### summary\n' + hints.join('\n') + (stale.length ? `\n\n### stale NetworkManager leftovers\n${stale.map((x) => '/' + x).join('\n')}\n(Uiable parks these in /etc/netplan/uiable-disabled when you connect.)` : '');
    return { text: scrubDiagnostics(head + extra + '\n' + (r.stdout || '') + (r.stderr ? '\n' + r.stderr : ''), []), device: dev };
  }

  // ---- saved Wi-Fi profiles (so "Connect" on an interface row never runs a bare `nmcli device connect`)
  /** The saved network a Wi-Fi interface can reconnect to, or null when one must be picked first. */
  async function savedWifi(d, dev, nmMap) {
    const b = d.backends;
    if (d.nm.running && nmManages(nmMap || {}, dev)) {
      const r = await run('nmcli', ['-t', '-f', 'NAME,UUID,TYPE,TIMESTAMP', 'connection', 'show'], { timeout: 10000 });
      const wl = r.code === 0 ? r.stdout.split('\n').filter(Boolean).map(splitTerse)
        .filter((p) => /^(802-11-wireless|wifi)$/.test(p[2] || '')).sort((x, y) => (+y[3] || 0) - (+x[3] || 0)) : [];
      for (const p of wl.slice(0, 25)) {
        const ifn = await run('nmcli', ['-g', 'connection.interface-name', 'connection', 'show', 'uuid', p[1]], { timeout: 8000 });
        const bound = ifn.code === 0 ? ifn.stdout.trim() : '';
        if (!bound || bound === dev) return { kind: 'networkmanager', name: p[0], uuid: p[1] };
      }
      return null;
    }
    if (ownWpaActive(dev)) {
      const name = ownWpaSsid(await fsp.readFile(hostFile(ownConfRel(dev)), 'utf8').catch(() => ''));
      if (name) return { kind: 'uiable-wpa', name };
    }
    const viaNetplan = b.wifi === 'netplan' || (b.wifi === 'wpa_supplicant' && b.config === 'netplan');
    if (viaNetplan) {
      const own = await readNetplanOwn();
      const aps = (((own.doc.network || {}).wifis || {})[dev] || {})['access-points'] || (d.caps.bins.has('netplan') ? await netplanGet(`network.wifis.${dev}.access-points`) : null);
      const names = aps && typeof aps === 'object' ? Object.keys(aps) : [];
      if (names.length) return { kind: 'netplan', name: names[0] };
      if (b.wifi === 'netplan') return null;
    }
    if (b.wifi === 'iwd') {
      const r = await run('iwctl', ['known-networks', 'list'], { timeout: 10000 });
      const rows = parseIwctlKnown(r.stdout);
      return rows.length ? { kind: 'iwd', name: rows[0] } : null;
    }
    if (b.wifi === 'wpa_supplicant') {
      const r = await run('wpa_cli', ['-i', dev, 'list_networks'], { timeout: 10000 });
      const rows = parseWpaNetworks(r.stdout);
      return rows.length ? { kind: 'wpa_supplicant', name: rows[0].ssid, id: rows[0].id } : null;
    }
    return null;
  }
  const needsSsid = (dev) => Object.assign(bad(`${dev} has no saved Wi-Fi network yet. Pick a network and enter its password to connect.`, 409), { reason: 'needs-ssid' });

  // ---- link up/down
  async function deviceAction(d, dev, action, { seconds } = {}) {
    const b = d.backends;
    if (!validDev(dev)) throw bad('Bad device');
    if (!['connect', 'disconnect'].includes(action)) throw bad('Bad action');
    const nmMap = await nmDeviceMap(d);
    const ifs = parseIpAddrJson((await run('ip', ['-j', '-d', 'addr', 'show', 'dev', dev], { timeout: 5000 })).stdout);
    const type = ifs[0] ? ifaceType(ifs[0], d.caps.wifiIfaces) : (d.caps.wifiIfaces.includes(dev) ? 'wifi' : 'ethernet');
    if (type === 'virtual' || type === 'loopback') throw bad(`${dev} is a ${type} interface (e.g. a Docker bridge); it's managed by its owner, not here.`, 400);
    const wifi = type === 'wifi';
    const doAct = async (act) => {
      if (wifi && act === 'connect') {
        // A bare `nmcli device connect wlan0` fails with "A 'wireless' setting is required if no AP path
        // was given" when there is no profile; bring up the saved one, or ask the UI for an SSID.
        const saved = await savedWifi(d, dev, nmMap);
        if (!saved) throw needsSsid(dev);
        if (saved.kind === 'networkmanager') return chk(await run('nmcli', ['--wait', '45', 'connection', 'up', 'uuid', saved.uuid, 'ifname', dev], { timeout: 60000 }), `nmcli connection up "${saved.name}"`);
        if (saved.kind === 'uiable-wpa') {
          chk(await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 10000 }), 'ip link set up');
          chk(await sysd(['start', `uiable-wpa@${dev}.service`]), `start uiable-wpa@${dev}`);
          await run('wpa_cli', ['-i', dev, 'reconnect'], { timeout: 10000 });
          await run('networkctl', ['reconfigure', dev], { timeout: 20000 });
          return;
        }
      }
      if (d.nm.running && nmManages(nmMap, dev)) return chk(await run('nmcli', ['device', act, dev], { timeout: 60000 }), `nmcli device ${act}`);
      if (!b.link) throw bad('Interface control is not supported on this host (`ip` not found).', 501);
      if (act === 'disconnect') {
        if (wifi && b.wifi === 'iwd') return chk(await run('iwctl', ['station', dev, 'disconnect'], { timeout: 20000 }), 'iwd disconnect');
        if (wifi && (b.wifi === 'wpa_supplicant' || ownWpaActive(dev))) return chk(await run('wpa_cli', ['-i', dev, 'disconnect'], { timeout: 10000 }), 'wpa_cli disconnect');
        return chk(await run('ip', ['link', 'set', 'dev', dev, 'down'], { timeout: 10000 }), 'ip link set down');
      }
      chk(await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 10000 }), 'ip link set up');
      if (wifi && b.wifi === 'wpa_supplicant') { await run('wpa_cli', ['-i', dev, 'enable_network', 'all'], { timeout: 10000 }); await run('wpa_cli', ['-i', dev, 'reconnect'], { timeout: 10000 }); }
      if (wifi && b.wifi === 'iwd') await run('iwctl', ['station', dev, 'scan'], { timeout: 10000 });
      if ((b.fallbackConfig || b.config) === 'systemd-networkd' || (b.fallbackConfig || b.config) === 'netplan') await run('networkctl', ['reconfigure', dev], { timeout: 20000 });
    };
    if (action === 'connect') { await doAct('connect'); invalidate(); return { ok: true }; }
    // Disconnecting can cut this session: guard it so it comes back on its own.
    return guarded(`Disconnect ${dev}`, seconds, async () => { await doAct('disconnect'); return { restore: () => doAct('connect'), result: { ok: true } }; });
  }

  // ---- IP settings
  function cfgBackendFor(d, nmMap, dev) {
    if (d.nm.running && nmManages(nmMap, dev)) return 'networkmanager';
    if (ownWpaActive(dev) && fs.existsSync(hostFile(ownNetRel(dev)))) return 'systemd-networkd'; // uiable-wpa@dev + its .network
    return d.backends.fallbackConfig || (d.backends.config !== 'networkmanager' ? d.backends.config : null);
  }

  async function getIpConfig(d, dev) {
    if (!validDev(dev)) throw bad('Bad device');
    const be = cfgBackendFor(d, await nmDeviceMap(d), dev);
    if (be === 'netplan') {
      const { doc } = await readNetplanOwn();
      const n = doc.network || {};
      const e = (n.ethernets || {})[dev] || (n.wifis || {})[dev];
      if (!e || (!e.addresses && e.dhcp4 === undefined)) return { backend: be, managed: false };
      const gw = (e.routes || []).find((r) => r && r.to === 'default');
      const prefs = await loadPrefs();
      return { backend: be, managed: true, mode: e.addresses ? 'static' : 'dhcp', address: (e.addresses || [])[0] || '', gateway: (gw || {}).via || ((prefs.parkedGateways || {})[dev] || ''), dns: ((e.nameservers || {}).addresses || []).join(', ') };
    }
    if (be === 'systemd-networkd') {
      const t = await fsp.readFile(hostFile(`etc/systemd/network/10-uiable-${dev}.network`), 'utf8').catch(() => null);
      if (!t) return { backend: be, managed: false };
      const get = (k) => (t.match(new RegExp(`^${k}=(.*)$`, 'gm')) || []).map((l) => l.split('=')[1]);
      return { backend: be, managed: true, mode: /DHCP=yes/.test(t) ? 'dhcp' : 'static', address: get('Address')[0] || '', gateway: get('Gateway')[0] || '', dns: get('DNS').join(', ') };
    }
    return { backend: be, managed: false };
  }

  async function nmSnapshot(con, keys) {
    const r = await run('nmcli', ['-g', keys.join(','), 'connection', 'show', con], { timeout: 10000 });
    const vals = r.stdout.replace(/\n$/, '').split('\n');
    return async () => {
      const args = ['connection', 'modify', con];
      keys.forEach((k, i) => args.push(k, (vals[i] || '').replace(/\\:/g, ':')));
      await run('nmcli', args, { timeout: 30000 });
      await run('nmcli', ['connection', 'up', con], { timeout: 60000 });
    };
  }

  async function setIpConfig(d, body, { seconds } = {}) {
    const cfg = validateIpConfig(body);
    const nmMap = await nmDeviceMap(d);
    const be = cfgBackendFor(d, nmMap, cfg.device);
    return guarded(`IP settings for ${cfg.device}`, seconds, async () => {
      if (be === 'networkmanager') {
        const con = (nmMap[cfg.device] || {}).connection;
        if (!con) throw bad('That interface has no NetworkManager connection to edit. Connect it first.', 409);
        const fam = cfg.family === 6 ? 'ipv6' : 'ipv4';
        const keys = [`${fam}.method`, `${fam}.addresses`, `${fam}.gateway`, `${fam}.dns`];
        const restore = await nmSnapshot(con, keys);
        const args = cfg.mode === 'dhcp'
          ? ['connection', 'modify', con, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']
          : ['connection', 'modify', con, `${fam}.method`, 'manual', `${fam}.addresses`, cfg.address, `${fam}.gateway`, cfg.gateway || '', `${fam}.dns`, (cfg.dns || []).join(' ')];
        chk(await run('nmcli', args, { timeout: 30000 }), 'nmcli connection modify');
        const up = await run('nmcli', ['connection', 'up', con], { timeout: 60000 });
        if (up.code !== 0) { await restore(); chk(up, 'nmcli connection up'); }
        return { restore, result: { backend: be } };
      }
      if (be === 'netplan') {
        const wireless = d.caps.wifiIfaces.includes(cfg.device);
        const restoreFile = await applyNetplan((doc) => buildNetplanDoc(doc, { device: cfg.device, wireless, ip: cfg }));
        return { restore: async () => { await restoreFile(); await run('netplan', ['apply'], { timeout: 90000 }); }, result: { backend: be, file: '/' + NETPLAN_OWN } };
      }
      if (be === 'systemd-networkd') {
        const rel = `etc/systemd/network/10-uiable-${cfg.device}.network`;
        const restoreFile = await snapshotFiles([rel]);
        await fsp.mkdir(path.dirname(hostFile(rel)), { recursive: true });
        await fsp.writeFile(hostFile(rel), buildNetworkdUnit(Object.assign({}, cfg, { wifi: d.caps.wifiIfaces.includes(cfg.device) })), { mode: 0o644 });
        const reload = async () => {
          const rl = await run('networkctl', ['reload'], { timeout: 20000 });
          if (rl.code !== 0) chk(await run('systemctl', ['restart', 'systemd-networkd'], { timeout: 30000 }), 'restart systemd-networkd');
          await run('networkctl', ['reconfigure', cfg.device], { timeout: 20000 });
        };
        await reload();
        return { restore: async () => { await restoreFile(); await reload(); }, result: { backend: be, file: '/' + rel } };
      }
      throw bad('Static IP / DHCP settings need NetworkManager, netplan or systemd-networkd on the host.', 501);
    });
  }

  // ---- Wired / Wi-Fi preference
  async function setUplink(d, { mode, seconds }) {
    const plan = planUplink(String(mode || ''));
    const ov = await overview(d);
    const nmMap = await nmDeviceMap(d);
    const targets = ov.interfaces.filter((i) => i.type === 'ethernet' || i.type === 'wifi');
    if (!targets.length) throw bad('No wired or Wi-Fi interfaces found.', 404);
    const warnings = [];
    return guarded(`Wired / Wi-Fi: ${mode}`, seconds, async () => {
      const restores = [];
      const prefsBefore = await loadPrefs();
      const prefs = JSON.parse(JSON.stringify(prefsBefore));
      prefs.parkedGateways = prefs.parkedGateways || {};
      const netplanDevs = [], networkdDevs = [];
      try {
        for (const i of targets) {
          const p = plan[i.type];
          const be = cfgBackendFor(d, nmMap, i.name);
          if (be === 'networkmanager') {
            const con = (nmMap[i.name] || {}).connection;
            if (!con) { warnings.push(`${i.name} has no active NetworkManager connection yet; it will use the default priority.`); continue; }
            restores.push(await nmSnapshot(con, ['ipv4.route-metric', 'ipv6.route-metric', 'ipv4.never-default', 'ipv6.never-default', 'connection.autoconnect-priority']));
            chk(await run('nmcli', nmUplinkArgs(con, p), { timeout: 30000 }), `nmcli modify ${con}`);
            const ra = await run('nmcli', ['device', 'reapply', i.name], { timeout: 30000 });
            if (ra.code !== 0) chk(await run('nmcli', ['connection', 'up', con], { timeout: 60000 }), `nmcli up ${con}`);
          } else if (be === 'netplan') netplanDevs.push([i, p]);
          else if (be === 'systemd-networkd') networkdDevs.push([i, p]);
          else warnings.push(`${i.name}: no backend can change its priority.`);
        }
        if (netplanDevs.length) {
          const merged = {};
          for (const [i] of netplanDevs) merged[i.name] = await netplanGet(`network.${i.type === 'wifi' ? 'wifis' : 'ethernets'}.${i.name}`);
          const restoreFile = await applyNetplan((doc) => {
            let out = doc;
            for (const [i, p] of netplanDevs) {
              const r = applyUplinkToNetplan(out, { device: i.name, wireless: i.type === 'wifi', plan: p, merged: merged[i.name], savedGateway: prefs.parkedGateways[i.name] });
              out = r.doc;
              if (r.warning) warnings.push(r.warning);
              if (r.removedGateway) prefs.parkedGateways[i.name] = r.removedGateway;
              else if (p.defaultRoute) delete prefs.parkedGateways[i.name];
            }
            return out;
          });
          restores.push(async () => { await restoreFile(); await run('netplan', ['apply'], { timeout: 90000 }); });
        }
        for (const [i, p] of networkdDevs) {
          const st = await run('networkctl', ['status', i.name, '--no-pager'], { timeout: 10000 });
          const file = ((st.stdout || '').match(/Network File:\s*(\S+)/) || [])[1];
          if (!file || file === 'n/a') { warnings.push(`${i.name} has no systemd-networkd config; skipped.`); continue; }
          const rel = `etc/systemd/network/${path.basename(file)}.d/90-uiable-uplink.conf`;
          const restoreFile = await snapshotFiles([rel]);
          await fsp.mkdir(path.dirname(hostFile(rel)), { recursive: true });
          await fsp.writeFile(hostFile(rel), buildNetworkdUplinkDropin(p), { mode: 0o644 });
          await run('networkctl', ['reload'], { timeout: 20000 });
          await run('networkctl', ['reconfigure', i.name], { timeout: 20000 });
          restores.push(async () => { await restoreFile(); await run('networkctl', ['reload'], { timeout: 20000 }); await run('networkctl', ['reconfigure', i.name], { timeout: 20000 }); });
        }
      } catch (e) {
        for (const r of restores.reverse()) await r().catch(() => {});
        throw e;
      }
      prefs.uplinkMode = mode;
      await savePrefs(prefs);
      const restore = async () => { for (const r of restores.slice().reverse()) await r().catch(() => {}); await savePrefs(prefsBefore); };
      const wired = targets.filter((t) => t.type === 'ethernet'), wl = targets.filter((t) => t.type === 'wifi');
      const ipOf = (l) => l.map((t) => `${t.name} ${(t.ipv4[0] || 'no IP').split('/')[0]}`).join(', ');
      const note = mode === 'prefer-wired' || mode === 'prefer-wifi'
        ? `Both stay up; if the ${mode === 'prefer-wired' ? 'cable is unplugged' : 'Wi-Fi drops'}, traffic fails over automatically. The server's address changes when it fails over (wired: ${ipOf(wired) || 'none'}; Wi-Fi: ${ipOf(wl) || 'none'}). Reserve both addresses on your router (DHCP reservation) or set static IPs so you always know them.`
        : `Only ${mode === 'wired-only' ? 'wired' : 'Wi-Fi'} carries internet traffic; the other keeps its local address (${ipOf(mode === 'wired-only' ? wl : wired) || 'none'}) but no default route, so there is no automatic failover.`;
      return { restore, result: { ok: true, mode, warnings, note } };
    });
  }

  return {
    detect, invalidate, scan, wifiConnect, pmfCapability, overview, deviceAction, savedWifi, diagnostics, nmAdopt, staleNmFiles, getIpConfig, setIpConfig, setUplink,
    confirmPending, revertPending, pendingInfo, NM_INSTALL_SCRIPT,
  };
}

module.exports = {
  create, splitTerse, stripAnsi, dedupeNetworks, parseNmcliWifi, parseIwctlStations, parseIwctlShow, parseIwctlNetworks,
  parseWpaScanResults, parseKv, parseIwScan, unescapeSsid, wpaSecurity, freqToChannel, dbmToPercent, wpaPsk, validatePassphrase,
  scrub, validateIpConfig, buildNetworkdUnit, buildNetplanDoc, parseProbe,
  parsePmfProbe, buildOwnWpaConf, ownWpaSsid, setIniKey, wpa3NoPmfMessage, OWN_WPA_UNIT, PMF_PROBE,
  parseIpAddrJson, parseDefaultRoutes, parseResolvectlDns, parseIwLink, parseIwctlKnown, parseWpaNetworks, relevantLog, wifiSecurityPlan, filterJournalSince, scrubDiagnostics, ifaceType, ifaceStatus, parseRfkill, classifyWifiFailure,
  planUplink, inferUplinkMode, netplanDefaultSource, applyUplinkToNetplan, buildNetworkdUplinkDropin, nmUplinkArgs, UPLINK_MODES, chooseBackends, describe, classifyHost, pickPkg,
  nmUnmanagedConf, NM_INSTALL_SCRIPT, NM_UIABLE_CONF, PROBE,
};
