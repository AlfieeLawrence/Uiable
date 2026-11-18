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
const fsp = require('fs').promises;
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
  const f = String(flags || '');
  const out = [];
  if (/SAE/.test(f)) out.push('WPA3');
  if (/WPA2|RSN/.test(f)) out.push('WPA2');
  else if (/WPA-/.test(f)) out.push('WPA');
  if (/EAP/.test(f)) out.push('802.1X');
  if (!out.length && /WEP/.test(f)) out.push('WEP');
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
    else if (/^\s*RSN:/.test(l)) n._sec.push('WPA2');
    else if (/^\s*WPA:/.test(l)) n._sec.push('WPA');
    else if (/^\s*capability:.*Privacy/.test(l)) n._priv = true;
  });
  push();
  return dedupeNetworks(nets.map((x) => {
    const security = x._sec.length ? [...new Set(x._sec)].join(' ') : (x._priv ? 'WEP' : '');
    const { _sec, _priv, ...rest } = x;
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
    if (wifi.password) ap.password = String(wifi.password);
    if (wifi.hidden) ap.hidden = true;
    e['access-points'] = { [wifi.ssid]: ap }; // replace: connect to this one network
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
  return { wifi, config, link, scan, hasWifi };
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
  'for b in nmcli iwctl wpa_cli iw netplan networkctl ip ifup apt-get dnf yum pacman zypper apk rpm-ostree; do command -v "$b" >/dev/null 2>&1 && echo "bin:$b"; done',
  'for u in NetworkManager iwd systemd-networkd; do echo "unit:$u:$(systemctl is-active "$u" 2>/dev/null)"; done',
  'for p in iwd wpa_supplicant systemd-networkd NetworkManager; do pgrep -x "$p" >/dev/null 2>&1 && echo "proc:$p"; done',
  'for d in /sys/class/net/*; do { [ -e "$d/wireless" ] || [ -e "$d/phy80211" ]; } && echo "wifi:${d##*/}"; done',
  '[ -d /etc/netplan ] && echo dir:netplan',
  '[ -f /etc/network/interfaces ] && grep -qE "^\\s*(iface|auto|allow-hotplug)\\s+[^l]" /etc/network/interfaces 2>/dev/null && echo ifupdown:1',
  'true',
].join('\n');

// ---------------------------------------------------------------- runtime
function create({ run, root }) {
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

  async function readNetplanOwn() {
    const f = hostFile('etc/netplan/90-uiable.yaml');
    const text = await fsp.readFile(f, 'utf8').catch(() => null);
    return { file: f, text, doc: text ? (yaml.load(text) || {}) : {} };
  }

  async function applyNetplan(mutate) {
    const own = await readNetplanOwn();
    const doc = mutate(own.doc);
    const out = '# Managed by Uiable (Settings > Network). Other netplan files are left untouched.\n' + yaml.dump(doc, { lineWidth: -1 });
    await fsp.mkdir(path.dirname(own.file), { recursive: true });
    await fsp.writeFile(own.file, out, { mode: 0o600 });
    await fsp.chmod(own.file, 0o600).catch(() => {});
    const gen = await run('netplan', ['generate'], { timeout: 30000 });
    if (gen.code !== 0) {
      if (own.text == null) await fsp.unlink(own.file).catch(() => {}); else await fsp.writeFile(own.file, own.text, { mode: 0o600 });
      throw bad(`netplan rejected the config: ${(gen.stderr || gen.stdout).trim()}`, 500);
    }
    const ap = await run('netplan', ['apply'], { timeout: 90000 });
    if (ap.code !== 0) throw bad(`netplan apply failed: ${(ap.stderr || ap.stdout).trim()}`, 500);
  }

  async function wifiConnect(d, { ssid, password, device, hidden }) {
    const b = d.backends;
    if (!b.wifi) throw bad(b.hasWifi ? d.summary : 'No Wi-Fi adapter was found on this host.', b.hasWifi ? 501 : 404);
    validatePassphrase(password);
    const secrets = [password];
    const fail = (r, what) => bad(`${what} failed: ${scrub((r.stderr || r.stdout || 'exit ' + r.code).trim(), secrets)}`, r.code === 127 ? 501 : 500);
    const dev = device && validDev(device) ? device : d.caps.wifiIfaces[0];
    if (b.wifi === 'networkmanager') {
      const args = ['device', 'wifi', 'connect', ssid];
      if (password) args.push('password', password);
      if (device && validDev(device)) args.push('ifname', device);
      if (hidden) args.push('hidden', 'yes');
      const r = await run('nmcli', args, { timeout: 60000 });
      if (r.code !== 0) throw fail(r, 'Wi-Fi connect');
      return { output: scrub(r.stdout.trim(), secrets) };
    }
    if (!dev) throw bad('No Wi-Fi adapter was found on this host.', 404);
    // Ubuntu-style hosts: netplan owns wpa_supplicant, so write it there (persists across reboots).
    if (b.wifi === 'netplan' || (b.wifi === 'wpa_supplicant' && b.config === 'netplan')) {
      await applyNetplan((doc) => buildNetplanDoc(doc, { device: dev, wireless: true, wifi: { ssid, password, hidden } }));
      return { output: `Saved ${ssid} for ${dev} in netplan and applied.`, persisted: true };
    }
    if (b.wifi === 'iwd') {
      const args = password ? ['--passphrase', password] : [];
      args.push('station', dev, hidden ? 'connect-hidden' : 'connect', ssid);
      const r = await run('iwctl', args, { timeout: 60000 });
      if (r.code !== 0) throw fail(r, 'iwd connect');
      return { output: `Connected ${dev} to ${ssid} (iwd remembers it).`, persisted: true };
    }
    // wpa_supplicant: hex SSID + derived PSK, so the plaintext password never reaches argv.
    const w = (args, t = 10000) => run('wpa_cli', ['-i', dev, ...args], { timeout: t });
    const add = await w(['add_network']);
    const id = (add.stdout.trim().split('\n').pop() || '').trim();
    if (add.code !== 0 || !/^\d+$/.test(id)) throw fail(add, 'wpa_cli add_network');
    const steps = [['set_network', id, 'ssid', Buffer.from(ssid, 'utf8').toString('hex')]];
    if (password) steps.push(['set_network', id, 'psk', /^[0-9a-f]{64}$/i.test(password) ? password.toLowerCase() : wpaPsk(ssid, password)]);
    else steps.push(['set_network', id, 'key_mgmt', 'NONE']);
    if (hidden) steps.push(['set_network', id, 'scan_ssid', '1']);
    steps.push(['select_network', id]);
    for (const s of steps) {
      const r = await w(s);
      if (r.code !== 0 || /FAIL/.test(r.stdout)) { await w(['remove_network', id]); throw bad(`wpa_cli ${s[0]} ${s[2] || ''} failed`.trim(), 500); }
    }
    const save = await w(['save_config']);
    const persisted = save.code === 0 && /OK/.test(save.stdout);
    return { output: `Connecting ${dev} to ${ssid} via wpa_supplicant.${persisted ? '' : ' Note: wpa_supplicant is not set to save networks (update_config=1), so this will not survive a reboot.'}`, persisted };
  }

  // ---- devices / link control
  async function devices(d, interfaces) {
    const b = d.backends;
    if (b.config === 'networkmanager') {
      const r = await run('nmcli', ['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'device'], { timeout: 8000 });
      return r.stdout.split('\n').filter(Boolean).map((l) => { const p = splitTerse(l); return { device: p[0], type: p[1], state: p[2], connection: p[3] }; });
    }
    const wifiState = {};
    if (b.wifi === 'iwd') {
      for (const s of await iwdDevices(d)) {
        const sh = parseIwctlShow((await run('iwctl', ['station', s.device, 'show'], { timeout: 8000 })).stdout);
        wifiState[s.device] = { state: s.state || sh.state, connection: sh.connectedNetwork || '' };
      }
    } else if (b.wifi === 'wpa_supplicant') {
      for (const dev of d.caps.wifiIfaces) {
        const st = parseKv((await run('wpa_cli', ['-i', dev, 'status'], { timeout: 8000 })).stdout);
        if (st.wpa_state) wifiState[dev] = { state: st.wpa_state === 'COMPLETED' ? 'connected' : 'disconnected', connection: st.wpa_state === 'COMPLETED' ? (st.ssid || '') : '' };
      }
    }
    return interfaces.map((i) => {
      const wifi = d.caps.wifiIfaces.includes(i.name);
      const type = i.name === 'lo' ? 'loopback' : wifi ? 'wifi' : /^(wg|tun|tap|docker|br-|veth|virbr|tailscale|zt)/.test(i.name) ? 'virtual' : 'ethernet';
      const ws = wifiState[i.name];
      const up = /^(up|unknown)$/i.test(i.state || '');
      const state = ws ? ws.state : (up && (i.addresses || []).length ? 'connected' : up ? 'up' : 'disconnected');
      return { device: i.name, type, state, connection: ws ? ws.connection : '' };
    });
  }

  async function deviceAction(d, dev, action) {
    const b = d.backends;
    if (!validDev(dev)) throw bad('Bad device');
    if (!['connect', 'disconnect'].includes(action)) throw bad('Bad action');
    const chk = (r, what) => { if (r.code !== 0) throw bad(`${what} failed: ${(r.stderr || r.stdout || 'exit ' + r.code).trim()}`, r.code === 127 ? 501 : 500); };
    if (b.link === 'networkmanager') return chk(await run('nmcli', ['device', action, dev], { timeout: 60000 }), `nmcli device ${action}`);
    if (!b.link) throw bad('Interface control is not supported on this host (`ip` not found).', 501);
    const wifi = d.caps.wifiIfaces.includes(dev);
    if (action === 'disconnect') {
      if (wifi && b.wifi === 'iwd') return chk(await run('iwctl', ['station', dev, 'disconnect'], { timeout: 20000 }), 'iwd disconnect');
      if (wifi && b.wifi === 'wpa_supplicant') return chk(await run('wpa_cli', ['-i', dev, 'disconnect'], { timeout: 10000 }), 'wpa_cli disconnect');
      return chk(await run('ip', ['link', 'set', 'dev', dev, 'down'], { timeout: 10000 }), 'ip link set down');
    }
    chk(await run('ip', ['link', 'set', 'dev', dev, 'up'], { timeout: 10000 }), 'ip link set up');
    if (wifi && b.wifi === 'wpa_supplicant') await run('wpa_cli', ['-i', dev, 'reconnect'], { timeout: 10000 });
    if (wifi && b.wifi === 'iwd') await run('iwctl', ['station', dev, 'scan'], { timeout: 10000 }); // iwd auto-joins known networks
    if (b.config === 'systemd-networkd') await run('networkctl', ['reconfigure', dev], { timeout: 20000 });
  }

  // ---- IP settings
  async function getIpConfig(d, dev) {
    if (!validDev(dev)) throw bad('Bad device');
    const b = d.backends;
    if (b.config === 'netplan') {
      const { doc } = await readNetplanOwn();
      const n = doc.network || {};
      const e = (n.ethernets || {})[dev] || (n.wifis || {})[dev];
      if (!e) return { managed: false };
      return { managed: true, mode: e.addresses ? 'static' : 'dhcp', address: (e.addresses || [])[0] || '', gateway: ((e.routes || [])[0] || {}).via || '', dns: ((e.nameservers || {}).addresses || []).join(', ') };
    }
    if (b.config === 'systemd-networkd') {
      const t = await fsp.readFile(hostFile(`etc/systemd/network/10-uiable-${dev}.network`), 'utf8').catch(() => null);
      if (!t) return { managed: false };
      const get = (k) => (t.match(new RegExp(`^${k}=(.*)$`, 'gm')) || []).map((l) => l.split('=')[1]);
      return { managed: true, mode: /DHCP=yes/.test(t) ? 'dhcp' : 'static', address: get('Address')[0] || '', gateway: get('Gateway')[0] || '', dns: get('DNS').join(', ') };
    }
    return { managed: false };
  }

  async function setIpConfig(d, body) {
    const cfg = validateIpConfig(body);
    const b = d.backends;
    const chk = (r, what) => { if (r.code !== 0) throw bad(`${what} failed: ${(r.stderr || r.stdout || 'exit ' + r.code).trim()}`, 500); };
    if (b.config === 'networkmanager') {
      const devs = await devices(d, []);
      const con = (devs.find((x) => x.device === cfg.device) || {}).connection;
      if (!con || con === '--') throw bad('That interface has no NetworkManager connection to edit. Connect it first.', 409);
      const fam = cfg.family === 6 ? 'ipv6' : 'ipv4';
      const args = cfg.mode === 'dhcp'
        ? ['connection', 'modify', con, 'ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '']
        : ['connection', 'modify', con, `${fam}.method`, 'manual', `${fam}.addresses`, cfg.address, `${fam}.gateway`, cfg.gateway || '', `${fam}.dns`, (cfg.dns || []).join(' ')];
      chk(await run('nmcli', args, { timeout: 30000 }), 'nmcli connection modify');
      chk(await run('nmcli', ['connection', 'up', con], { timeout: 60000 }), 'nmcli connection up');
      return { backend: 'networkmanager' };
    }
    if (b.config === 'netplan') {
      const wireless = d.caps.wifiIfaces.includes(cfg.device);
      await applyNetplan((doc) => buildNetplanDoc(doc, { device: cfg.device, wireless, ip: cfg }));
      return { backend: 'netplan', file: '/etc/netplan/90-uiable.yaml' };
    }
    if (b.config === 'systemd-networkd') {
      const rel = `etc/systemd/network/10-uiable-${cfg.device}.network`;
      await fsp.mkdir(path.dirname(hostFile(rel)), { recursive: true });
      await fsp.writeFile(hostFile(rel), buildNetworkdUnit(cfg), { mode: 0o644 });
      const rl = await run('networkctl', ['reload'], { timeout: 20000 });
      if (rl.code !== 0) chk(await run('systemctl', ['restart', 'systemd-networkd'], { timeout: 30000 }), 'restart systemd-networkd');
      await run('networkctl', ['reconfigure', cfg.device], { timeout: 20000 });
      return { backend: 'systemd-networkd', file: '/' + rel };
    }
    throw bad('Static IP / DHCP settings need NetworkManager, netplan or systemd-networkd on the host.', 501);
  }

  return { detect, invalidate, scan, wifiConnect, devices, deviceAction, getIpConfig, setIpConfig, NM_INSTALL_SCRIPT };
}

module.exports = {
  create, splitTerse, stripAnsi, dedupeNetworks, parseNmcliWifi, parseIwctlStations, parseIwctlShow, parseIwctlNetworks,
  parseWpaScanResults, parseKv, parseIwScan, unescapeSsid, wpaSecurity, freqToChannel, dbmToPercent, wpaPsk, validatePassphrase,
  scrub, validateIpConfig, buildNetworkdUnit, buildNetplanDoc, parseProbe, chooseBackends, describe, classifyHost, pickPkg,
  nmUnmanagedConf, NM_INSTALL_SCRIPT, NM_UIABLE_CONF, PROBE,
};
