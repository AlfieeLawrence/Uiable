'use strict';
// Unit tests for server/netbackends.js. Run: npm test  (node --test)
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const yaml = require('js-yaml');
const nb = require('../server/netbackends');

test('splitTerse handles escaped colons', () => {
  assert.deepEqual(nb.splitTerse('*:My\\:Net:aa\\:bb:70'), ['*', 'My:Net', 'aa:bb', '70']);
});

test('parseNmcliWifi dedupes by SSID, connected first', () => {
  const out = ' :Home:AA\\:01:40:WPA2:6:wlan0\n*:Home:AA\\:02:30:WPA2:11:wlan0\n :Cafe:AA\\:03:80::1:wlan0\n';
  const n = nb.parseNmcliWifi(out);
  assert.equal(n[0].ssid, 'Home'); assert.equal(n[0].inUse, true);
  assert.equal(n.length, 2);
});

test('parseIwctlStations', () => {
  const out = '                            Devices in Station Mode\n--------------------------------------------------\n  Name                  State            Scanning\n--------------------------------------------------\n  \x1b[0mwlan0                 connected                 \n  wlan1                 disconnected     scanning\n';
  assert.deepEqual(nb.parseIwctlStations(out), [
    { device: 'wlan0', state: 'connected', scanning: false },
    { device: 'wlan1', state: 'disconnected', scanning: true },
  ]);
});

test('parseIwctlNetworks: stars with dim ANSI + connected marker', () => {
  const out = [
    '                               Available networks',
    '--------------------------------------------------------------------------------',
    '      Network name                      Security            Signal',
    '--------------------------------------------------------------------------------',
    '  \x1b[0m>\x1b[0m   \x1b[1;37mMy Home\x1b[0m                           psk                 ***\x1b[1;90m*\x1b[0m',
    '      Cafe Wifi                         open                **\x1b[1;90m**\x1b[0m',
    '',
  ].join('\n');
  const n = nb.parseIwctlNetworks(out, 'wlan0');
  assert.equal(n.length, 2);
  assert.deepEqual(n[0], { inUse: true, ssid: 'My Home', bssid: '', signal: 75, security: 'PSK', channel: '', device: 'wlan0' });
  assert.equal(n[1].signal, 50); assert.equal(n[1].security, '');
});

test('parseIwctlNetworks: rssi-dbms (1/100 dBm)', () => {
  const out = '      Network name     Security   Signal\n----------\n  >   Net1              psk        -5200\n      Net2              sae        -80\n';
  const n = nb.parseIwctlNetworks(out, 'wlan0');
  assert.equal(n.find((x) => x.ssid === 'Net1').signal, 96);
  assert.equal(n.find((x) => x.ssid === 'Net2').signal, 40);
});

test('parseWpaScanResults + status', () => {
  const out = 'bssid / frequency / signal level / flags / ssid\n' +
    'aa:bb:cc:dd:ee:01\t2437\t-45\t[WPA2-PSK-CCMP][ESS]\tHome\n' +
    'aa:bb:cc:dd:ee:02\t5180\t-70\t[ESS]\tCaf\\xc3\\xa9\n' +
    'aa:bb:cc:dd:ee:03\t5955\t-60\t[RSN-SAE-CCMP][ESS]\tSix\n';
  const st = nb.parseKv('bssid=aa:bb:cc:dd:ee:01\nssid=Home\nwpa_state=COMPLETED\n');
  const n = nb.parseWpaScanResults(out, 'wlan0', st.bssid);
  const home = n.find((x) => x.ssid === 'Home');
  assert.equal(home.inUse, true); assert.equal(home.channel, '6'); assert.equal(home.signal, 100); assert.equal(home.security, 'WPA2');
  const cafe = n.find((x) => x.ssid === 'Café');
  assert.ok(cafe); assert.equal(cafe.channel, '36'); assert.equal(cafe.security, '');
  assert.equal(n.find((x) => x.ssid === 'Six').security, 'WPA3');
  assert.equal(n.find((x) => x.ssid === 'Six').channel, '1');
});

test('parseIwScan', () => {
  const out = 'BSS aa:bb:cc:dd:ee:01(on wlan0) -- associated\n\tfreq: 2412\n\tsignal: -50.00 dBm\n\tSSID: Home\n\tcapability: ESS Privacy (0x0411)\n\tRSN:\t * Version: 1\n' +
    'BSS aa:bb:cc:dd:ee:02(on wlan0)\n\tfreq: 5745.0\n\tsignal: -85.00 dBm\n\tSSID: Old\n\tcapability: ESS Privacy (0x0011)\n' +
    'BSS aa:bb:cc:dd:ee:03(on wlan0)\n\tfreq: 2462\n\tsignal: -60.00 dBm\n\tSSID: Open\n\tcapability: ESS (0x0401)\n';
  const n = nb.parseIwScan(out, 'wlan0');
  assert.deepEqual(n.map((x) => [x.ssid, x.inUse, x.security, x.channel, x.signal]), [
    ['Home', true, 'WPA2', '1', 100], ['Open', false, '', '11', 80], ['Old', false, 'WEP', '149', 30],
  ]);
});

test('wpaPsk matches IEEE 802.11i test vector', () => {
  assert.equal(nb.wpaPsk('IEEE', 'password'), 'f42c6fc52df0ebef9ebb4b90b38a5f902e83fe1b135a70e23aed762e9710a12e');
});

test('validatePassphrase + scrub never leak the password', () => {
  assert.throws(() => nb.validatePassphrase('short'), /8-63/);
  nb.validatePassphrase('longenough');
  nb.validatePassphrase('a'.repeat(64).replace(/a/g, 'f'));
  assert.equal(nb.scrub('Error: secret hunter2pw rejected', ['hunter2pw']), 'Error: secret •••• rejected');
});

test('validateIpConfig', () => {
  assert.deepEqual(nb.validateIpConfig({ device: 'eth0', mode: 'dhcp' }), { device: 'eth0', mode: 'dhcp' });
  const c = nb.validateIpConfig({ device: 'eth0', mode: 'static', address: '192.168.1.50/24', gateway: '192.168.1.1', dns: '1.1.1.1, 9.9.9.9' });
  assert.deepEqual(c.dns, ['1.1.1.1', '9.9.9.9']); assert.equal(c.family, 4);
  assert.throws(() => nb.validateIpConfig({ device: 'eth0', mode: 'static', address: '192.168.1.50' }), /CIDR/);
  assert.throws(() => nb.validateIpConfig({ device: 'eth0;rm', mode: 'dhcp' }), /interface/);
  assert.throws(() => nb.validateIpConfig({ device: 'lo', mode: 'dhcp' }), /interface/);
  assert.throws(() => nb.validateIpConfig({ device: 'eth0', mode: 'static', address: '10.0.0.2/8', gateway: 'fe80::1' }), /Gateway/);
  assert.throws(() => nb.validateIpConfig({ device: 'eth0', mode: 'static', address: '10.0.0.2/8', dns: 'evil' }), /DNS/);
});

test('buildNetworkdUnit', () => {
  assert.match(nb.buildNetworkdUnit({ device: 'eth0', mode: 'dhcp' }), /\[Match\]\nName=eth0\n\n\[Network\]\nDHCP=yes\n/);
  const s = nb.buildNetworkdUnit({ device: 'eth0', mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: ['1.1.1.1', '8.8.8.8'] });
  assert.match(s, /Address=10\.0\.0\.2\/24\nGateway=10\.0\.0\.1\nDNS=1\.1\.1\.1\nDNS=8\.8\.8\.8/);
});

test('buildNetplanDoc: static ethernet, then back to dhcp; wifi keeps ip', () => {
  let d = nb.buildNetplanDoc({}, { device: 'eth0', ip: nb.validateIpConfig({ device: 'eth0', mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: '1.1.1.1' }) });
  assert.deepEqual(d.network.ethernets.eth0, { dhcp4: false, addresses: ['10.0.0.2/24'], routes: [{ to: 'default', via: '10.0.0.1' }], nameservers: { addresses: ['1.1.1.1'] } });
  d = nb.buildNetplanDoc(yaml.load(yaml.dump(d)), { device: 'eth0', ip: { mode: 'dhcp' } });
  assert.deepEqual(d.network.ethernets.eth0, { dhcp4: true });
  d = nb.buildNetplanDoc(d, { device: 'wlan0', wireless: true, wifi: { ssid: 'Home', password: 'longenough' } });
  assert.deepEqual(d.network.wifis.wlan0, { 'access-points': { Home: { password: 'longenough' } }, dhcp4: true });
  d = nb.buildNetplanDoc(d, { device: 'wlan0', wireless: true, wifi: { ssid: 'Other', hidden: true } });
  assert.deepEqual(Object.keys(d.network.wifis.wlan0['access-points']), ['Other']);
  assert.equal(d.network.version, 2);
});

const probe = (lines) => nb.parseProbe(lines.join('\n'));

test('chooseBackends: NetworkManager wins when running', () => {
  const caps = probe(['bin:nmcli', 'bin:iwctl', 'bin:ip', 'unit:iwd:active', 'wifi:wlan0']);
  const b = nb.chooseBackends(caps, { installed: true, running: true });
  assert.deepEqual([b.wifi, b.config, b.link, b.scan], ['networkmanager', 'networkmanager', 'networkmanager', 'networkmanager']);
});

test('chooseBackends: Ubuntu server (netplan + networkd, no NM, no wifi)', () => {
  const caps = probe(['bin:netplan', 'bin:networkctl', 'bin:ip', 'unit:NetworkManager:inactive', 'unit:systemd-networkd:active', 'dir:netplan']);
  const nm = { installed: false, running: false };
  const b = nb.chooseBackends(caps, nm);
  assert.deepEqual([b.wifi, b.config, b.link], [null, 'netplan', 'ip']);
  const d = nb.describe(b, nm);
  assert.match(d.summary, /not installed/); assert.match(d.summary, /netplan for IP settings/);
  assert.ok(d.unsupported.some((u) => /no wireless adapter/.test(u)));
  assert.equal(d.readOnly, false);
});

test('chooseBackends: iwd preferred over wpa_supplicant', () => {
  const caps = probe(['bin:iwctl', 'bin:wpa_cli', 'bin:ip', 'bin:networkctl', 'unit:iwd:active', 'unit:systemd-networkd:active', 'proc:wpa_supplicant', 'wifi:wlan0']);
  const b = nb.chooseBackends(caps, { installed: false, running: false });
  assert.deepEqual([b.wifi, b.config, b.scan], ['iwd', 'systemd-networkd', 'iwd']);
});

test('chooseBackends: wpa_supplicant when iwd is not running', () => {
  const caps = probe(['bin:iwctl', 'bin:wpa_cli', 'bin:ip', 'unit:iwd:inactive', 'proc:wpa_supplicant', 'wifi:wlp2s0']);
  const b = nb.chooseBackends(caps, { installed: true, running: false, message: 'NetworkManager is installed but not running.' });
  assert.deepEqual([b.wifi, b.config, b.scan], ['wpa_supplicant', null, 'wpa_supplicant']);
  const d = nb.describe(b, { installed: true, running: false, message: 'NetworkManager is installed but not running.' });
  assert.match(d.summary, /installed but not running/);
  assert.ok(d.unsupported.some((u) => /Static IP/.test(u)));
});

test('chooseBackends: netplan wifi with/without iw for scanning', () => {
  const base = ['bin:netplan', 'bin:ip', 'dir:netplan', 'wifi:wlan0'];
  assert.equal(nb.chooseBackends(probe(base), { running: false }).scan, null);
  const b = nb.chooseBackends(probe([...base, 'bin:iw']), { running: false });
  assert.deepEqual([b.wifi, b.scan], ['netplan', 'iw']);
});

test('chooseBackends: nothing available -> read-only', () => {
  const b = nb.chooseBackends(probe([]), { installed: false, running: false });
  const d = nb.describe(b, { installed: false, running: false });
  assert.equal(d.readOnly, true); assert.match(d.summary, /read-only/);
});

test('classifyHost: appliances hidden, normal distros installable', () => {
  assert.equal(nb.classifyHost({ osRelease: { ID: 'umbrelos', PRETTY_NAME: 'umbrelOS 1.2' }, pkg: 'apt' }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'debian' }, umbrel: true, pkg: 'apt' }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'debian' }, rugix: true, pkg: 'apt' }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'fedora', VARIANT_ID: 'silverblue' }, ostree: true, pkg: 'dnf' }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'nixos' }, pkg: null }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'ubuntu' }, rootRo: true, pkg: 'apt' }).installable, false);
  assert.equal(nb.classifyHost({ osRelease: { ID: 'ubuntu' }, pkg: null }).installable, false);
  assert.deepEqual(nb.classifyHost({ osRelease: { ID: 'ubuntu', PRETTY_NAME: 'Ubuntu 24.04 LTS' }, pkg: 'apt' }), { installable: true, pkg: 'apt', reason: null });
});

test('pickPkg order', () => {
  assert.equal(nb.pickPkg(new Set(['dnf', 'yum'])), 'dnf');
  assert.equal(nb.pickPkg(new Set(['apt-get'])), 'apt');
  assert.equal(nb.pickPkg(new Set(['zypper'])), 'zypper');
  assert.equal(nb.pickPkg(new Set()), null);
});

test('NM install script is valid sh and writes Wi-Fi-only conf', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nmi-'));
  const f = path.join(tmp, 's.sh');
  fs.writeFileSync(f, nb.NM_INSTALL_SCRIPT);
  execFileSync('sh', ['-n', f]);
  // Dry-run only the config-writing part against a temp dir.
  const head = nb.NM_INSTALL_SCRIPT.split('echo "==> Installing NetworkManager"')[0]
    .replace(/\/etc\/NetworkManager\/conf\.d/g, path.join(tmp, 'conf.d'));
  for (const [iwd, wantDevice] of [['0', false], ['1', true]]) {
    execFileSync('sh', ['-c', head, 'x', 'apt', 'wifi-only', iwd]);
    const conf = fs.readFileSync(path.join(tmp, 'conf.d', '90-uiable.conf'), 'utf8');
    assert.match(conf, /unmanaged-devices=\*,except:type:wifi,except:type:wwan/);
    assert.match(conf, /\[ifupdown\]\nmanaged=false/);
    assert.equal(/wifi\.backend=iwd/.test(conf), wantDevice);
  }
  execFileSync('sh', ['-c', head, 'x', 'apt', 'all', '0']);
  assert.equal(fs.existsSync(path.join(tmp, 'conf.d', '90-uiable.conf')), false);
});

test('PROBE script parses with sh -n', () => {
  execFileSync('sh', ['-n', '-c', nb.PROBE]);
});

// ---- runtime with a fake host
function fakeHost(responses, root, opts) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [re, r] of responses) if (re.test(key)) return Object.assign({ code: 0, stdout: '', stderr: '' }, typeof r === 'function' ? r(args) : r);
    return { code: 127, stdout: '', stderr: 'not found' };
  };
  return { calls, netb: nb.create({ run, root, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'data-')), opts: Object.assign({ fast: true, wifiWaitMs: 0 }, opts) }) };
}

test('detect: nmcli missing on host -> fallback + install offer', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/os-release'), 'ID=ubuntu\nPRETTY_NAME="Ubuntu 24.04 LTS"\n');
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127, stderr: 'nsenter: failed to execute nmcli: No such file or directory' }],
    [/^sh -c /, { stdout: 'bin:netplan\nbin:ip\nbin:apt-get\nbin:networkctl\nunit:systemd-networkd:active\ndir:netplan\n' }],
  ], root);
  const d = await netb.detect(true);
  assert.equal(d.nm.installed, false);
  assert.equal(d.backends.config, 'netplan');
  assert.equal(d.install.available, true); assert.equal(d.install.pkg, 'apt');
  assert.deepEqual(d.install.managedBy, ['netplan', 'systemd-networkd']);
});

test('detect: NM installed but stopped -> no install button', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli /, { code: 8, stderr: 'Error: NetworkManager is not running.' }],
    [/^sh -c /, { stdout: 'bin:nmcli\nbin:ip\nbin:apt-get\n' }],
  ], root);
  const d = await netb.detect(true);
  assert.equal(d.nm.installed, true); assert.equal(d.nm.running, false);
  assert.equal(d.install.available, false);
  assert.match(d.summary, /not running/);
});


// ip -j addr fixtures
const ipAddr = (name, { up = true, carrier = true, v4 = null, kind = '', dynamic = true } = {}) => ({
  ifname: name, operstate: up && carrier ? 'UP' : 'DOWN', address: '00:11:22:33:44:55', mtu: 1500,
  flags: [...(up ? ['UP'] : []), ...(up && carrier ? ['LOWER_UP'] : []), ...(up && !carrier ? ['NO-CARRIER'] : []), 'BROADCAST', 'MULTICAST'],
  ...(kind ? { linkinfo: { info_kind: kind } } : {}),
  addr_info: v4 ? [{ family: 'inet', local: v4.split('/')[0], prefixlen: +v4.split('/')[1], scope: 'global', dynamic }] : [],
});
const json = (x) => ({ stdout: JSON.stringify(x) });

test('parseIpAddrJson + ifaceType + ifaceStatus (docker bridge is idle, not "disconnected")', () => {
  const ifs = nb.parseIpAddrJson(JSON.stringify([
    { ifname: 'lo', flags: ['LOOPBACK', 'UP', 'LOWER_UP'], operstate: 'UNKNOWN', addr_info: [{ family: 'inet', local: '127.0.0.1', prefixlen: 8, scope: 'host' }] },
    ipAddr('enp0s25', { v4: '192.168.1.200/24' }),
    ipAddr('wlp3s0', { carrier: false }),
    ipAddr('docker0', { carrier: false, v4: '172.17.0.1/16', kind: 'bridge', dynamic: false }),
    ipAddr('enp1s0', { carrier: false }),
  ]));
  const wl = ['wlp3s0'];
  const t = Object.fromEntries(ifs.map((i) => [i.name, nb.ifaceType(i, wl)]));
  assert.deepEqual(t, { lo: 'loopback', enp0s25: 'ethernet', wlp3s0: 'wifi', docker0: 'virtual', enp1s0: 'ethernet' });
  const st = (n, w) => nb.ifaceStatus(ifs.find((i) => i.name === n), t[n], w);
  assert.deepEqual(st('docker0'), { state: 'idle', label: 'idle (nothing attached)', canLink: false });
  assert.equal(st('lo').canLink, false);
  assert.equal(st('enp0s25').state, 'connected');
  assert.equal(st('enp1s0').state, 'no-cable');
  assert.equal(st('wlp3s0', { connected: false }).state, 'disconnected');
  assert.equal(st('wlp3s0', { connected: true, ssid: 'Home' }).state, 'no-ip');
  assert.equal(ifs.find((i) => i.name === 'enp0s25').dynamic, true);
  assert.deepEqual(ifs.find((i) => i.name === 'lo').ipv4, []);
});

test('parseDefaultRoutes sorts by metric, linkdown last', () => {
  const r = nb.parseDefaultRoutes(JSON.stringify([
    { dst: 'default', gateway: '192.168.1.1', dev: 'wlp3s0', protocol: 'dhcp', metric: 600 },
    { dst: 'default', gateway: '192.168.1.1', dev: 'enp1s0', metric: 50, flags: ['linkdown'] },
    { dst: 'default', gateway: '192.168.1.1', dev: 'enp0s25', protocol: 'dhcp', metric: 100 },
  ]));
  assert.deepEqual(r.map((x) => x.dev), ['enp0s25', 'wlp3s0', 'enp1s0']);
});

test('parseResolvectlDns + parseIwLink + parseRfkill', () => {
  const d = nb.parseResolvectlDns('Global: 1.1.1.1\nLink 2 (enp0s25): 192.168.1.1 fe80::1%enp0s25\nLink 3 (wlp3s0):\nLink 4 (docker0):\n');
  assert.deepEqual(d, { global: ['1.1.1.1'], links: { enp0s25: ['192.168.1.1', 'fe80::1'], wlp3s0: [], docker0: [] } });
  assert.deepEqual(nb.parseIwLink('Not connected.\n'), { connected: false });
  const l = nb.parseIwLink('Connected to aa:bb:cc:dd:ee:ff (on wlp3s0)\n\tSSID: Home Net\n\tfreq: 5180\n\tsignal: -55 dBm\n');
  assert.deepEqual(l, { connected: true, bssid: 'aa:bb:cc:dd:ee:ff', ssid: 'Home Net', signal: 90, dbm: -55, channel: '36' });
  assert.deepEqual(nb.parseRfkill('phy0 wlan 1 0\nhci0 bluetooth 0 0\n'), [{ name: 'phy0', type: 'wlan', soft: true, hard: false }, { name: 'hci0', type: 'bluetooth', soft: false, hard: false }]);
});

test('classifyWifiFailure picks the real reason', () => {
  const c = (x) => nb.classifyWifiFailure(x).code;
  assert.equal(c({ rfkill: [{ type: 'wlan', soft: false, hard: true }] }), 'rfkill-hard');
  assert.equal(c({ rfkill: [{ type: 'wlan', soft: true, hard: false }] }), 'rfkill-soft');
  assert.equal(c({ supplicantMissing: true }), 'no-supplicant');
  assert.equal(c({ log: 'wlp3s0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect' }), 'wrong-password');
  assert.equal(c({ log: 'CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="Home" auth_failures=1 duration=10 reason=WRONG_KEY' }), 'wrong-password');
  assert.equal(c({ nmError: 'Error: Connection activation failed: Secrets were required, but not provided.' }), 'wrong-password');
  assert.equal(c({ log: 'CTRL-EVENT-NETWORK-NOT-FOUND', regdom: '00' }), 'not-found');
  assert.match(nb.classifyWifiFailure({ log: 'CTRL-EVENT-NETWORK-NOT-FOUND', regdom: '00' }).message, /iw reg set/);
  assert.equal(c({ log: 'CTRL-EVENT-ASSOC-REJECT bssid=aa status_code=17' }), 'assoc-reject');
  assert.equal(c({ associated: true, ip: false }), 'no-dhcp');
  assert.equal(c({}), 'timeout');
});

test('planUplink + inferUplinkMode', () => {
  assert.deepEqual(nb.planUplink('prefer-wired'), { ethernet: { metric: 100, defaultRoute: true }, wifi: { metric: 600, defaultRoute: true } });
  assert.deepEqual(nb.planUplink('prefer-wifi'), { ethernet: { metric: 600, defaultRoute: true }, wifi: { metric: 100, defaultRoute: true } });
  assert.equal(nb.planUplink('wired-only').wifi.defaultRoute, false);
  assert.equal(nb.planUplink('wifi-only').ethernet.defaultRoute, false);
  assert.throws(() => nb.planUplink('bogus'), /Mode must be/);
  const types = { enp0s25: 'ethernet', wlp3s0: 'wifi' };
  assert.equal(nb.inferUplinkMode([{ dev: 'enp0s25', metric: 100, family: 4 }, { dev: 'wlp3s0', metric: 600, family: 4 }], types), 'prefer-wired');
  assert.equal(nb.inferUplinkMode([{ dev: 'wlp3s0', metric: 100, family: 4 }, { dev: 'enp0s25', metric: 600, family: 4 }], types), 'prefer-wifi');
  assert.equal(nb.inferUplinkMode([{ dev: 'wlp3s0', metric: 600, family: 4 }], types), 'wifi-only');
});

test('applyUplinkToNetplan: DHCP gets dhcp4-overrides; own static keeps/parks gateway; foreign static warns', () => {
  let r = nb.applyUplinkToNetplan({}, { device: 'enp0s25', plan: { metric: 100, defaultRoute: true }, merged: { dhcp4: true } });
  assert.deepEqual(r.doc.network.ethernets.enp0s25, { 'dhcp4-overrides': { 'route-metric': 100, 'use-routes': true }, dhcp4: true });
  r = nb.applyUplinkToNetplan(r.doc, { device: 'wlp3s0', wireless: true, plan: { metric: 600, defaultRoute: false }, merged: { dhcp4: true, 'access-points': { Home: {} } } });
  assert.deepEqual(r.doc.network.wifis.wlp3s0['dhcp4-overrides'], { 'route-metric': 600, 'use-routes': false });
  const own = { network: { version: 2, ethernets: { enp0s25: { dhcp4: false, addresses: ['192.168.1.200/24'], routes: [{ to: 'default', via: '192.168.1.1' }] } } } };
  r = nb.applyUplinkToNetplan(own, { device: 'enp0s25', plan: { metric: 600, defaultRoute: true }, merged: own.network.ethernets.enp0s25 });
  assert.deepEqual(r.doc.network.ethernets.enp0s25.routes, [{ to: 'default', via: '192.168.1.1', metric: 600 }]);
  r = nb.applyUplinkToNetplan(r.doc, { device: 'enp0s25', plan: { metric: 600, defaultRoute: false }, merged: r.doc.network.ethernets.enp0s25 });
  assert.equal(r.removedGateway, '192.168.1.1'); assert.equal(r.doc.network.ethernets.enp0s25.routes, undefined);
  r = nb.applyUplinkToNetplan(r.doc, { device: 'enp0s25', plan: { metric: 100, defaultRoute: true }, merged: r.doc.network.ethernets.enp0s25, savedGateway: '192.168.1.1' });
  assert.deepEqual(r.doc.network.ethernets.enp0s25.routes, [{ to: 'default', via: '192.168.1.1', metric: 100 }]);
  r = nb.applyUplinkToNetplan({}, { device: 'enp0s25', plan: { metric: 600, defaultRoute: true }, merged: { addresses: ['10.0.0.2/24'], routes: [{ to: 'default', via: '10.0.0.1' }] } });
  assert.match(r.warning, /fixed gateway/);
});

test('networkd drop-in + nmcli uplink args', () => {
  assert.match(nb.buildNetworkdUplinkDropin({ metric: 600, defaultRoute: false }), /\[DHCPv4\]\nRouteMetric=600\nUseGateway=no/);
  assert.deepEqual(nb.nmUplinkArgs('Wired 1', { metric: 100, defaultRoute: true }).slice(0, 5), ['connection', 'modify', 'Wired 1', 'ipv4.route-metric', '100']);
  assert.ok(nb.nmUplinkArgs('Home', { metric: 600, defaultRoute: false }).includes('yes'));
});

// ---- runtime: Alfie's host (Ubuntu Server: netplan + networkd, no NM, iw present)
const ALFIE_PROBE = 'bin:netplan\nbin:networkctl\nbin:ip\nbin:iw\nbin:journalctl\nbin:resolvectl\nunit:systemd-networkd:active\ndir:netplan\nwifi:wlp3s0\n';
const alfieAddrs = (wifiIp) => json([ipAddr('enp0s25', { v4: '192.168.1.200/24' }), ipAddr('wlp3s0', { v4: wifiIp }), ipAddr('docker0', { carrier: false, v4: '172.17.0.1/16', kind: 'bridge', dynamic: false })]);

test('netplan Wi-Fi without wpa_supplicant fails fast with the real reason (Alfie 1.2.4 case)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE }],
    [/^sh -c for r in/, { stdout: 'phy0 wlan 0 0\n' }],
  ], root);
  const d = await netb.detect(true);
  assert.equal(d.backends.wifi, 'netplan');
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Home', password: 'longenough1', device: 'wlp3s0' }), /wpasupplicant/);
  assert.ok(!calls.some((c) => c[0] === 'netplan' && c[1] === 'apply'), 'nothing applied');
});

test('netplan Wi-Fi: wrong password is detected, config rolled back', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^sh -c for r in/, { stdout: 'phy0 wlan 0 0\n' }],
    [/^netplan /, {}],
    [/^iw dev wlp3s0 link/, { stdout: 'Not connected.\n' }],
    [/^iw reg get/, { stdout: 'global\ncountry GB: DFS-ETSI\n' }],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0')])],
    [/^ip /, {}],
    [/^journalctl /, { stdout: 'wlp3s0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect\nCTRL-EVENT-SSID-TEMP-DISABLED reason=WRONG_KEY\n' }],
  ], root);
  const d = await netb.detect(true);
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Home', password: 'wrongpass1', device: 'wlp3s0' }), (e) => /Wrong Wi-Fi password/.test(e.message) && /rolled back/.test(e.message) && !e.message.includes('wrongpass1'));
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')), false, 'own netplan file removed again');
  assert.equal(calls.filter((c) => c[0] === 'netplan' && c[1] === 'apply').length, 2, 'applied, then re-applied after rollback');
});

test('netplan Wi-Fi: success only once associated with an IP', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^sh -c for r in/, { stdout: 'phy0 wlan 0 0\n' }],
    [/^netplan /, {}],
    [/^iw dev wlp3s0 link/, { stdout: 'Connected to aa:bb:cc:dd:ee:ff (on wlp3s0)\n\tSSID: Home\n\tsignal: -60 dBm\n' }],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0', { v4: '192.168.1.201/24' })])],
    [/^ip /, {}],
  ], root);
  const d = await netb.detect(true);
  const out = await netb.wifiConnect(d, { ssid: 'Home', password: 'rightpass1', device: 'wlp3s0' });
  assert.equal(out.ip, '192.168.1.201/24'); assert.equal(out.signal, 80);
  const y = yaml.load(fs.readFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), 'utf8'));
  assert.deepEqual(Object.keys(y.network.wifis.wlp3s0['access-points']), ['Home']);
});

test('soft rfkill is unblocked automatically; hard block is reported', async () => {
  let blocked = true;
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^sh -c for r in/, () => ({ stdout: `phy0 wlan ${blocked ? 1 : 0} 0\n` })],
    [/^sh -c rfkill unblock/, () => { blocked = false; return {}; }],
    [/^netplan /, {}],
    [/^iw dev wlp3s0 link/, { stdout: 'Connected to aa:bb:cc:dd:ee:ff (on wlp3s0)\n\tSSID: Home\n' }],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0', { v4: '192.168.1.201/24' })])],
    [/^ip /, {}],
  ], fs.mkdtempSync(path.join(os.tmpdir(), 'root-')));
  const d = await netb.detect(true);
  await netb.wifiConnect(d, { ssid: 'Home', password: 'rightpass1', device: 'wlp3s0' });
  assert.equal(blocked, false);
  const h = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^sh -c for r in/, { stdout: 'phy0 wlan 0 1\n' }],
    [/^sh -c rfkill/, {}],
  ], os.tmpdir());
  await assert.rejects(h.netb.wifiConnect(await h.netb.detect(true), { ssid: 'Home', password: 'rightpass1', device: 'wlp3s0' }), /hardware/);
});

test('wifiConnect via wpa_supplicant never puts the plaintext password in argv', async () => {
  const pw = 'Sup3rSecretPass';
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: 'bin:wpa_cli\nbin:ip\nproc:wpa_supplicant\nwifi:wlan0\n' }],
    [/^sh -c for r in/, { stdout: '' }],
    [/add_network/, { stdout: '3\n' }],
    [/save_config/, { stdout: 'OK\n' }],
    [/wpa_cli -i wlan0 status/, { stdout: 'wpa_state=COMPLETED\nssid=Home\n' }],
    [/signal_poll/, { stdout: 'RSSI=-50\n' }],
    [/^wpa_cli /, { stdout: 'OK\n' }],
    [/^ip -j -4 addr show dev wlan0/, json([ipAddr('wlan0', { v4: '10.0.0.9/24' })])],
    [/^ip /, {}],
  ], os.tmpdir());
  const d = await netb.detect(true);
  const out = await netb.wifiConnect(d, { ssid: 'Home', password: pw, device: 'wlan0' });
  assert.equal(out.persisted, true); assert.equal(out.ip, '10.0.0.9/24');
  assert.ok(!JSON.stringify(calls).includes(pw));
  assert.ok(calls.some((c) => c.includes('psk') && c.includes(nb.wpaPsk('Home', pw))));
  assert.ok(calls.some((c) => c.includes('ssid') && c.includes(Buffer.from('Home').toString('hex'))));
});

test('wifiConnect error text is scrubbed (iwd) and network forgotten', async () => {
  const pw = 'Sup3rSecretPass';
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: 'bin:iwctl\nbin:ip\nunit:iwd:active\nwifi:wlan0\n' }],
    [/^sh -c for r in/, { stdout: '' }],
    [/^iwctl --passphrase/, { code: 1, stderr: `Operation failed: invalid passphrase ${pw}` }],
    [/^iwctl /, {}],
    [/^ip /, {}],
  ], os.tmpdir());
  const d = await netb.detect(true);
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Home', password: pw, device: 'wlan0' }), (e) => !e.message.includes(pw) && /Wrong Wi-Fi password/.test(e.message));
  assert.ok(calls.some((c) => c.join(' ') === 'iwctl known-networks Home forget'));
});

test('NetworkManager path: nmcli error classified, IP verified', async () => {
  const { netb } = fakeHost([
    [/^nmcli -t -f RUNNING/, { stdout: 'running\n' }],
    [/^sh -c for b in/, { stdout: 'bin:nmcli\nbin:ip\nwifi:wlp3s0\n' }],
    [/^sh -c for r in/, { stdout: '' }],
    [/^nmcli --wait 45 device wifi connect/, { code: 4, stderr: 'Error: Connection activation failed: Secrets were required, but not provided.' }],
    [/^nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device/, { stdout: 'wlp3s0:wifi:disconnected:--\nenp0s25:ethernet:unmanaged:--\n' }],
    [/^nmcli /, {}],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0')])],
  ], os.tmpdir());
  const d = await netb.detect(true);
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Home', password: 'badpass12', device: 'wlp3s0' }), /Wrong Wi-Fi password/);
});

test('overview: Alfie host shows primary uplink, docker0 idle without link buttons', async () => {
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE }],
    [/^ip -j -d addr/, alfieAddrs(null)],
    [/^ip -j route show default/, json([{ dst: 'default', gateway: '192.168.1.1', dev: 'enp0s25', protocol: 'dhcp', metric: 100 }])],
    [/^ip -j -6 route/, json([])],
    [/^resolvectl dns/, { stdout: 'Global:\nLink 2 (enp0s25): 192.168.1.1\n' }],
    [/^iw dev wlp3s0 link/, { stdout: 'Not connected.\n' }],
  ], os.tmpdir());
  const ov = await netb.overview(await netb.detect(true));
  const by = Object.fromEntries(ov.interfaces.map((i) => [i.name, i]));
  assert.deepEqual(ov.uplink.primary, { dev: 'enp0s25', type: 'ethernet', gateway: '192.168.1.1', metric: 100, ip: '192.168.1.200/24' });
  assert.equal(by.enp0s25.primary, true); assert.deepEqual(by.enp0s25.dns, ['192.168.1.1']); assert.equal(by.enp0s25.gateway, '192.168.1.1');
  assert.equal(by.docker0.canLink, false); assert.equal(by.docker0.state, 'idle'); assert.equal(by.docker0.canConfig, false);
  assert.equal(by.wlp3s0.state, 'disconnected'); assert.equal(by.wlp3s0.canLink, true);
  assert.equal(ov.uplink.mode, 'prefer-wired'); assert.equal(ov.uplink.canSet, true);
  assert.deepEqual([ov.uplink.wired, ov.uplink.wireless], [['enp0s25'], ['wlp3s0']]);
});

test('deviceAction refuses docker bridges; disconnect is guarded and auto-reverts', async () => {
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE }],
    [/^ip -j -d addr show dev docker0/, json([ipAddr('docker0', { kind: 'bridge', carrier: false })])],
    [/^ip -j -d addr show dev enp0s25/, json([ipAddr('enp0s25', { v4: '192.168.1.200/24' })])],
    [/^(ip|networkctl) /, {}],
  ], os.tmpdir(), { rollbackMs: 30 });
  const d = await netb.detect(true);
  await assert.rejects(netb.deviceAction(d, 'docker0', 'connect'), /virtual/);
  const r = await netb.deviceAction(d, 'enp0s25', 'disconnect');
  assert.ok(r.pending && r.pending.token);
  assert.equal(netb.pendingInfo().label, 'Disconnect enp0s25');
  await assert.rejects(netb.deviceAction(d, 'enp0s25', 'disconnect'), /waiting for confirmation/);
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(netb.pendingInfo(), null);
  assert.ok(calls.some((c) => c.join(' ') === 'ip link set dev enp0s25 up'), 'brought back up after timeout');
});

test('setUplink via netplan writes metrics, confirm keeps it; revert restores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const resp = [
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^ip -j -d addr/, alfieAddrs('192.168.1.201/24')],
    [/^ip -j route show default/, json([{ dst: 'default', gateway: '192.168.1.1', dev: 'enp0s25', metric: 100 }, { dst: 'default', gateway: '192.168.1.1', dev: 'wlp3s0', metric: 600 }])],
    [/^ip -j -6 route/, json([])],
    [/^iw dev wlp3s0 link/, { stdout: 'Connected to aa:bb:cc:dd:ee:ff (on wlp3s0)\n\tSSID: Home\n' }],
    [/^netplan get network.ethernets.enp0s25/, { stdout: 'dhcp4: true\n' }],
    [/^netplan get network.wifis.wlp3s0/, { stdout: 'dhcp4: true\naccess-points:\n  Home: {}\n' }],
    [/^netplan /, {}],
  ];
  const { netb } = fakeHost(resp, root, { rollbackMs: 10000 });
  const d = await netb.detect(true);
  const out = await netb.setUplink(d, { mode: 'prefer-wifi' });
  assert.match(out.note, /fails over/); assert.match(out.note, /192\.168\.1\.201/);
  const y = yaml.load(fs.readFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), 'utf8'));
  assert.equal(y.network.wifis.wlp3s0['dhcp4-overrides']['route-metric'], 100);
  assert.equal(y.network.ethernets.enp0s25['dhcp4-overrides']['route-metric'], 600);
  const ov = await netb.overview(d);
  assert.equal(ov.uplink.mode, 'prefer-wifi'); assert.equal(ov.uplink.modeStored, true);
  await netb.revertPending(out.pending.token);
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')), false);
  const out2 = await netb.setUplink(d, { mode: 'prefer-wired' });
  assert.deepEqual(netb.confirmPending(out2.pending.token), { ok: true, kept: 'Wired / Wi-Fi: prefer-wired' });
  assert.ok(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')));
});

test('setIpConfig via systemd-networkd writes unit, is guarded, rollback restores', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: 'bin:networkctl\nbin:ip\nunit:systemd-networkd:active\n' }],
    [/^networkctl /, {}],
  ], root, { rollbackMs: 30 });
  const d = await netb.detect(true);
  const r = await netb.setIpConfig(d, { device: 'eth0', mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: '1.1.1.1' });
  assert.equal(r.backend, 'systemd-networkd'); assert.ok(r.pending);
  const f = path.join(root, 'etc/systemd/network/10-uiable-eth0.network');
  assert.match(fs.readFileSync(f, 'utf8'), /Address=10\.0\.0\.2\/24/);
  assert.ok(calls.some((c) => c.join(' ') === 'networkctl reload'));
  assert.deepEqual(await netb.getIpConfig(d, 'eth0'), { backend: 'systemd-networkd', managed: true, mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: '1.1.1.1' });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(fs.existsSync(f), false, 'unconfirmed change rolled back');
});

test('setIpConfig via netplan rolls back when netplan generate fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: 'bin:netplan\nbin:ip\ndir:netplan\n' }],
    [/^netplan generate/, { code: 1, stderr: 'bad yaml' }],
  ], root);
  const d = await netb.detect(true);
  await assert.rejects(netb.setIpConfig(d, { device: 'eth0', mode: 'dhcp' }), /netplan rejected/);
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')), false);
  assert.equal(netb.pendingInfo(), null);
});

test('NM wifi-only install: unmanaged wired falls back to netplan for IP settings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli -t -f RUNNING/, { stdout: 'running\n' }],
    [/^sh -c for b in/, { stdout: 'bin:nmcli\nbin:netplan\nbin:ip\ndir:netplan\nwifi:wlp3s0\n' }],
    [/^nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device/, { stdout: 'wlp3s0:wifi:connected:Home\nenp0s25:ethernet:unmanaged:--\n' }],
    [/^netplan /, {}],
  ], root);
  const d = await netb.detect(true);
  assert.equal(d.backends.fallbackConfig, 'netplan');
  const r = await netb.setIpConfig(d, { device: 'enp0s25', mode: 'dhcp' });
  assert.equal(r.backend, 'netplan');
  netb.confirmPending(r.pending.token);
});

// ---- Wi-Fi row "Connect": saved profile or ask for an SSID (never a bare `nmcli device connect`)
const NM_PROBE = 'bin:nmcli\nbin:ip\nbin:iw\nunit:NetworkManager:active\nproc:NetworkManager\nwifi:wlp3s0\n';
const nmBase = (extra) => [
  [/^nmcli -t -f RUNNING general/, { stdout: 'running\n' }],
  [/^sh -c for b in/, { stdout: NM_PROBE }],
  [/^nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device/, { stdout: 'wlp3s0:wifi:disconnected:--\nenp0s25:ethernet:connected:Wired connection 1\n' }],
  [/^ip -j -d addr show dev wlp3s0/, json([ipAddr('wlp3s0', { carrier: false })])],
  ...extra,
];

test('parseIwctlKnown + parseWpaNetworks', () => {
  const iw = '\x1b[1;90m                     Known Networks\x1b[0m\n--------------------------------------------------------------------------------\n  Name                              Security          Hidden  Last connected\n--------------------------------------------------------------------------------\n  BT-Hub-5G                         psk                       Nov 18, 5:01 PM\n  Cafe Wifi                         open\n';
  assert.deepEqual(nb.parseIwctlKnown(iw), ['BT-Hub-5G', 'Cafe Wifi']);
  assert.deepEqual(nb.parseIwctlKnown('  No known networks\n'), []);
  assert.deepEqual(nb.parseWpaNetworks('network id / ssid / bssid / flags\n0\tHome\tany\t[DISABLED]\n'), [{ id: '0', ssid: 'Home', flags: '[DISABLED]' }]);
  assert.deepEqual(nb.parseWpaNetworks('network id / ssid / bssid / flags\n'), []);
});

test('deviceAction connect wifi (NM, no saved profile) -> needs-ssid, no `nmcli device connect`', async () => {
  const { netb, calls } = fakeHost(nmBase([[/^nmcli -t -f NAME,UUID,TYPE,TIMESTAMP connection show/, { stdout: 'Wired connection 1:aaaa:802-3-ethernet:1763480000\n' }]]), os.tmpdir());
  const d = await netb.detect(true);
  await assert.rejects(netb.deviceAction(d, 'wlp3s0', 'connect'), (e) => e.status === 409 && e.reason === 'needs-ssid' && /Pick a network/.test(e.message));
  assert.ok(!calls.some((c) => c.join(' ').startsWith('nmcli device connect')));
});

test('deviceAction connect wifi (NM, saved profile) -> nmcli connection up uuid, newest matching device', async () => {
  const { netb, calls } = fakeHost(nmBase([
    [/^nmcli -t -f NAME,UUID,TYPE,TIMESTAMP connection show/, { stdout: 'Old:u-old:802-11-wireless:100\nOther dev:u-other:802-11-wireless:300\nHome:u-home:802-11-wireless:200\n' }],
    [/^nmcli -g connection.interface-name connection show uuid u-other/, { stdout: 'wlx0011\n' }],
    [/^nmcli -g connection.interface-name connection show uuid/, { stdout: '\n' }],
    [/^nmcli --wait 45 connection up/, {}],
  ]), os.tmpdir());
  const d = await netb.detect(true);
  const r = await netb.deviceAction(d, 'wlp3s0', 'connect');
  assert.equal(r.ok, true);
  assert.ok(calls.some((c) => c.join(' ') === 'nmcli --wait 45 connection up uuid u-home ifname wlp3s0'));
  assert.ok(!calls.some((c) => c.join(' ').startsWith('nmcli device connect')));
});

test('deviceAction connect ethernet (NM) still uses nmcli device connect', async () => {
  const { netb, calls } = fakeHost(nmBase([
    [/^ip -j -d addr show dev enp0s25/, json([ipAddr('enp0s25', { v4: '192.168.1.200/24' })])],
    [/^nmcli device connect/, {}],
  ]), os.tmpdir());
  const d = await netb.detect(true);
  await netb.deviceAction(d, 'enp0s25', 'connect');
  assert.ok(calls.some((c) => c.join(' ') === 'nmcli device connect enp0s25'));
});

test('deviceAction connect wifi via wpa_supplicant / iwd / netplan: saved -> reconnect, none -> needs-ssid', async () => {
  const wpaProbe = 'bin:wpa_cli\nbin:ip\nproc:wpa_supplicant\nwifi:wlp3s0\n';
  const base = (probe, extra) => [[/^nmcli /, { code: 127 }], [/^sh -c for b in/, { stdout: probe }], [/^ip -j -d addr show dev wlp3s0/, json([ipAddr('wlp3s0', { carrier: false })])], ...extra, [/^(ip|networkctl|wpa_cli|iwctl) /, {}]];
  let h = fakeHost(base(wpaProbe, [[/^wpa_cli -i wlp3s0 list_networks/, { stdout: 'network id / ssid / bssid / flags\n' }]]), os.tmpdir());
  let d = await h.netb.detect(true);
  assert.equal(d.backends.wifi, 'wpa_supplicant');
  await assert.rejects(h.netb.deviceAction(d, 'wlp3s0', 'connect'), (e) => e.reason === 'needs-ssid');
  h = fakeHost(base(wpaProbe, [[/^wpa_cli -i wlp3s0 list_networks/, { stdout: 'network id / ssid / bssid / flags\n0\tHome\tany\t[DISABLED]\n' }]]), os.tmpdir());
  d = await h.netb.detect(true);
  await h.netb.deviceAction(d, 'wlp3s0', 'connect');
  assert.ok(h.calls.some((c) => c.join(' ') === 'wpa_cli -i wlp3s0 enable_network all'));
  assert.ok(h.calls.some((c) => c.join(' ') === 'wpa_cli -i wlp3s0 reconnect'));

  const iwdProbe = 'bin:iwctl\nbin:ip\nunit:iwd:active\nproc:iwd\nwifi:wlp3s0\n';
  h = fakeHost(base(iwdProbe, [[/^iwctl known-networks list/, { stdout: '  No known networks\n' }]]), os.tmpdir());
  d = await h.netb.detect(true);
  assert.equal(d.backends.wifi, 'iwd');
  await assert.rejects(h.netb.deviceAction(d, 'wlp3s0', 'connect'), (e) => e.reason === 'needs-ssid');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), 'network:\n  version: 2\n  wifis:\n    wlp3s0:\n      dhcp4: true\n      access-points:\n        Home: {password: secret123}\n');
  h = fakeHost(base(ALFIE_PROBE, []), root);
  d = await h.netb.detect(true);
  assert.deepEqual(await h.netb.savedWifi(d, 'wlp3s0', {}), { kind: 'netplan', name: 'Home' });
  await h.netb.deviceAction(d, 'wlp3s0', 'connect');
  assert.ok(h.calls.some((c) => c.join(' ') === 'ip link set dev wlp3s0 up'));
});

// ---- 1.2.6: WPA3/SAE, conservative failure reasons, NM leftovers, diagnostics
const iwBss = (mac, ssid, suites, assoc) => `BSS ${mac}(on wlp3s0)${assoc ? ' -- associated' : ''}\n\tfreq: 2437\n\tsignal: -50.00 dBm\n\tSSID: ${ssid}\n\tcapability: ESS Privacy (0x0411)\n` +
  (suites ? `\tRSN:\t * Version: 1\n\t\t * Group cipher: CCMP\n\t\t * Pairwise ciphers: CCMP\n\t\t * Authentication suites: ${suites}\n\t\t * Capabilities: 16-PTKSA-RC 1-GTKSA-RC MFP-capable (0x008c)\n` : '');

test('security parsing: SAE-only, transition, enterprise (wpa_cli flags + iw scan)', () => {
  const w = 'bssid / frequency / signal level / flags / ssid\n' +
    'aa:bb:cc:dd:ee:01\t2437\t-45\t[WPA2-PSK+SAE-CCMP][ESS]\tMixed\n' +
    'aa:bb:cc:dd:ee:02\t2437\t-45\t[RSN-SAE-CCMP][ESS]\tW3\n' +
    'aa:bb:cc:dd:ee:03\t2437\t-45\t[WPA2-EAP-CCMP][ESS]\tCorp\n';
  const n = nb.parseWpaScanResults(w, 'wlan0', '');
  assert.equal(n.find((x) => x.ssid === 'Mixed').security, 'WPA3 WPA2');
  assert.equal(n.find((x) => x.ssid === 'W3').security, 'WPA3');
  assert.match(n.find((x) => x.ssid === 'Corp').security, /802\.1X/);
  const i = nb.parseIwScan(iwBss('aa:00:00:00:00:01', 'W3', 'SAE') + iwBss('aa:00:00:00:00:02', 'Mixed', 'PSK SAE') + iwBss('aa:00:00:00:00:03', 'Home', 'PSK'), 'wlp3s0');
  assert.deepEqual(i.map((x) => [x.ssid, x.security]).sort(), [['Home', 'WPA2'], ['Mixed', 'WPA3 WPA2'], ['W3', 'WPA3']]);
  assert.ok(i.every((x) => !('_rsn' in x)));
});

test('wifiSecurityPlan', () => {
  assert.deepEqual(nb.wifiSecurityPlan('WPA3'), { keyMgmt: 'sae', label: 'WPA3 (SAE)' });
  assert.equal(nb.wifiSecurityPlan('WPA3 WPA2').transition, true);
  assert.equal(nb.wifiSecurityPlan('WPA2 WPA3').keyMgmt, 'psk');
  assert.equal(nb.wifiSecurityPlan('WPA2').label, 'WPA2');
  assert.equal(nb.wifiSecurityPlan('WPA2 802.1X').keyMgmt, 'eap');
  assert.equal(nb.wifiSecurityPlan('').keyMgmt, 'unknown');
});

test('buildNetplanDoc: SAE auth block, hex PSK, explicit networkd renderer', () => {
  const psk = nb.wpaPsk('Home', 'right pass "#: x');
  const a = nb.buildNetplanDoc(null, { device: 'wlp3s0', wireless: true, wifi: { ssid: 'Home', password: 'right pass "#: x', psk, renderer: 'networkd' } });
  assert.equal(a.network.wifis.wlp3s0.renderer, 'networkd');
  assert.equal(a.network.wifis.wlp3s0['access-points'].Home.password, psk);
  const b = nb.buildNetplanDoc(null, { device: 'wlp3s0', wireless: true, wifi: { ssid: 'W3', password: 'right pass "#: x', psk, keyMgmt: 'sae' } });
  assert.deepEqual(b.network.wifis.wlp3s0['access-points'].W3.auth, { 'key-management': 'sae', password: 'right pass "#: x' });
  assert.equal(b.network.wifis.wlp3s0['access-points'].W3.password, undefined);
  // round-trips through YAML unchanged (quotes, #, colon)
  assert.equal(yaml.load(yaml.dump(b)).network.wifis.wlp3s0['access-points'].W3.auth.password, 'right pass "#: x');
});

test('classifier is conservative: only explicit evidence means "wrong password"', () => {
  const weak = nb.classifyWifiFailure({ log: 'wlp3s0: CTRL-EVENT-DISCONNECTED bssid=aa reason=15\nwlp3s0: CTRL-EVENT-SSID-TEMP-DISABLED id=0 ssid="Home" auth_failures=1 duration=10 reason=CONN_FAILED\n', security: 'WPA2', device: 'wlp3s0' });
  assert.equal(weak.code, 'handshake-failed');
  assert.match(weak.message, /Network security: WPA2/);
  assert.match(weak.message, /Log since this attempt:\n.*reason=15/);
  const strong = nb.classifyWifiFailure({ log: 'CTRL-EVENT-SSID-TEMP-DISABLED reason=WRONG_KEY\n', security: 'WPA2' });
  assert.equal(strong.code, 'wrong-password');
  const conflict = nb.classifyWifiFailure({ log: 'CTRL-EVENT-SSID-TEMP-DISABLED reason=WRONG_KEY\n', keyMismatch: true });
  assert.equal(conflict.code, 'handshake-failed');
  assert.equal(nb.classifyWifiFailure({ log: 'Authentication failed\n' }).code, 'handshake-failed');
  assert.equal(nb.classifyWifiFailure({ log: '' }).code, 'timeout');
});

test('filterJournalSince drops lines from earlier attempts; scrubDiagnostics masks secrets', () => {
  const out = '1700000000.100000 host wpa_supplicant[1]: old WRONG_KEY\n1700000010.500000 host wpa_supplicant[1]: new line\nno-timestamp line\n';
  assert.equal(nb.filterJournalSince(out, 1700000005000), 'host wpa_supplicant[1]: new line\nno-timestamp line');
  const hex = nb.wpaPsk('Home', 'hunter2hunter2');
  const t = nb.scrubDiagnostics(`network:\n  wifis:\n    wlp3s0:\n      access-points:\n        "Home":\n          password: "hunter2hunter2"\n  psk=${hex}\nkey: ${hex}\nsae_password="hunter2hunter2"\n`, ['hunter2hunter2']);
  assert.ok(!t.includes('hunter2hunter2') && !t.includes(hex));
  assert.match(t, /password: ••••/);
});

const netplanHost = (root, extra) => fakeHost([
  [/^nmcli /, { code: 127 }],
  [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
  [/^sh -c for r in/, { stdout: 'phy0 wlan 0 0\n' }],
  [/^sh -c pgrep/, { stdout: '901 /sbin/wpa_supplicant -c /run/netplan/wpa-wlp3s0.conf -iwlp3s0 -Dnl80211,wext\n' }],
  ...extra,
  [/^netplan /, {}],
  [/^iw reg get/, { stdout: 'country GB: DFS-ETSI\n' }],
  [/^ip /, {}],
], root);

test('netplan WPA3-only: writes key-management sae + renderer networkd, parks stale NM files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.mkdirSync(path.join(root, 'etc/NetworkManager/conf.d'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/90-NM-1234.yaml'), 'network:\n  version: 2\n  wifis:\n    NM-1234:\n      renderer: NetworkManager\n      match: {name: wlp3s0}\n');
  fs.writeFileSync(path.join(root, 'etc/NetworkManager/conf.d/90-uiable.conf'), '[device]\nwifi.backend=wpa_supplicant\n');
  let applied = 0;
  const { netb, calls } = netplanHost(root, [
    [/^iw dev wlp3s0 scan/, { stdout: iwBss('aa:00:00:00:00:01', 'HomeWifi', 'SAE') }],
    [/^netplan apply/, () => { applied++; return {}; }],
    [/^iw dev wlp3s0 link/, () => ({ stdout: applied ? 'Connected to aa:00:00:00:00:01 (on wlp3s0)\n\tSSID: HomeWifi\n\tsignal: -50 dBm\n' : 'Not connected.\n' })],
    [/^ip -j -4 addr show dev wlp3s0/, () => json([ipAddr('wlp3s0', applied ? { v4: '192.168.1.201/24' } : {})])],
  ]);
  const d = await netb.detect(true);
  assert.deepEqual((await netb.staleNmFiles(d)).sort(), ['etc/NetworkManager/conf.d/90-uiable.conf', 'etc/netplan/90-NM-1234.yaml']);
  const out = await netb.wifiConnect(d, { ssid: 'HomeWifi', password: 'correct horse 1', device: 'wlp3s0' });
  assert.match(out.output, /WPA3 \(SAE\)/); assert.equal(out.security, 'WPA3 (SAE)');
  const e = yaml.load(fs.readFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), 'utf8')).network.wifis.wlp3s0;
  assert.equal(e.renderer, 'networkd');
  assert.deepEqual(e['access-points'].HomeWifi.auth, { 'key-management': 'sae', password: 'correct horse 1' });
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-NM-1234.yaml')), false, 'stale NM netplan file parked');
  assert.ok(fs.existsSync(path.join(root, 'etc/netplan/uiable-disabled/90-NM-1234.yaml')));
  assert.ok(fs.existsSync(path.join(root, 'etc/netplan/uiable-disabled/NetworkManager-90-uiable.conf')));
  assert.ok(!calls.some((c) => c[0] === 'nmcli' && c[1] !== '-t' && c.includes('managed')));
});

test('netplan transition network: WPA2 handshake fails -> retries with SAE; failure restores everything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/90-NM-abcd.yaml'), 'network: {version: 2}\n');
  const written = [];
  const { netb } = netplanHost(root, [
    [/^iw dev wlp3s0 scan/, { stdout: iwBss('aa:00:00:00:00:01', 'Mixed', 'PSK SAE') }],
    [/^netplan apply/, () => { const f = path.join(root, 'etc/netplan/90-uiable.yaml'); written.push(fs.existsSync(f) ? yaml.load(fs.readFileSync(f, 'utf8')) : null); return {}; }],
    [/^iw dev wlp3s0 link/, { stdout: 'Not connected.\n' }],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0')])],
    [/^journalctl /, { stdout: 'wlp3s0: CTRL-EVENT-DISCONNECTED bssid=aa reason=15\n' }],
  ]);
  const d = await netb.detect(true);
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Mixed', password: 'rightpass1', device: 'wlp3s0' }), (e) => {
    assert.equal(e.code, 'handshake-failed');
    assert.doesNotMatch(e.message, /Wrong Wi-Fi password/);
    assert.match(e.message, /rolled back/); assert.match(e.message, /WPA2\/WPA3 transition, tried SAE/); assert.match(e.message, /reason=15/);
    assert.ok(!e.message.includes('rightpass1'));
    return true;
  });
  const aps = written.filter(Boolean).map((y) => y.network.wifis.wlp3s0['access-points'].Mixed);
  assert.equal(aps.length, 2);
  assert.equal(aps[0].password, nb.wpaPsk('Mixed', 'rightpass1'), 'first: WPA2 with hex PSK');
  assert.equal(aps[1].auth['key-management'], 'sae', 'second: SAE');
  assert.ok(fs.existsSync(path.join(root, 'etc/netplan/90-NM-abcd.yaml')), 'parked file restored on failure');
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')), false);
});

test('wpa_cli WPA3-only: key_mgmt SAE + ieee80211w 2; transition gets PMF optional', async () => {
  const mk = (flags) => fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: 'bin:wpa_cli\nbin:ip\nproc:wpa_supplicant\nwifi:wlan0\n' }],
    [/^sh -c for r in/, { stdout: '' }],
    [/scan_results/, { stdout: `bssid / frequency / signal level / flags / ssid\naa:bb:cc:dd:ee:01\t2437\t-45\t${flags}\tHome\n` }],
    [/add_network/, { stdout: '0\n' }],
    [/save_config/, { stdout: 'OK\n' }],
    [/wpa_cli -i wlan0 status/, { stdout: 'wpa_state=COMPLETED\nssid=Home\n' }],
    [/signal_poll/, { stdout: 'RSSI=-50\n' }],
    [/^wpa_cli /, { stdout: 'OK\n' }],
    [/^ip -j -4 addr show dev wlan0/, json([ipAddr('wlan0', { v4: '10.0.0.9/24' })])],
    [/^ip /, {}],
  ], os.tmpdir());
  const a = mk('[RSN-SAE-CCMP][ESS]');
  await a.netb.wifiConnect(await a.netb.detect(true), { ssid: 'Home', password: 'pass phrase"1', device: 'wlan0' });
  const set = (calls, k) => calls.filter((c) => c[3] === 'set_network' && c[5] === k).map((c) => c[6]);
  assert.deepEqual(set(a.calls, 'key_mgmt'), ['SAE']); assert.deepEqual(set(a.calls, 'ieee80211w'), ['2']);
  assert.deepEqual(set(a.calls, 'psk'), ['"pass phrase"1"']);
  const b = mk('[WPA2-PSK+SAE-CCMP][ESS]');
  await b.netb.wifiConnect(await b.netb.detect(true), { ssid: 'Home', password: 'pass phrase"1', device: 'wlan0' });
  assert.deepEqual(set(b.calls, 'psk'), [nb.wpaPsk('Home', 'pass phrase"1')]); assert.deepEqual(set(b.calls, 'ieee80211w'), ['1']);
  await assert.rejects(a.netb.wifiConnect(await a.netb.detect(true), { ssid: 'Home', password: 'a'.repeat(64), device: 'wlan0' }), /WPA3-only/);
});

test('two supplicants on one adapter: no "wrong password" claim, conflict reported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c for b in/, { stdout: ALFIE_PROBE + 'bin:wpa_supplicant\n' }],
    [/^sh -c for r in/, { stdout: 'phy0 wlan 0 0\n' }],
    [/^sh -c pgrep/, { stdout: '901 /sbin/wpa_supplicant -c /run/netplan/wpa-wlp3s0.conf -iwlp3s0\n902 wpa_supplicant -B -i wlp3s0 -c /etc/wpa_supplicant/wpa_supplicant.conf\n' }],
    [/^iw dev wlp3s0 scan/, { stdout: iwBss('aa:00:00:00:00:01', 'Home', 'PSK') }],
    [/^netplan /, {}],
    [/^iw dev wlp3s0 link/, { stdout: 'Not connected.\n' }],
    [/^iw reg get/, { stdout: 'country GB\n' }],
    [/^ip -j -4 addr show dev wlp3s0/, json([ipAddr('wlp3s0')])],
    [/^ip /, {}],
    [/^journalctl /, { stdout: 'wlp3s0: WPA: 4-Way Handshake failed - pre-shared key may be incorrect\n' }],
  ], root);
  await assert.rejects(netb.wifiConnect(await netb.detect(true), { ssid: 'Home', password: 'rightpass1', device: 'wlp3s0' }), (e) => e.code === 'handshake-failed' && /2 wpa_supplicant processes/.test(e.message));
});

test('nmAdopt: drops Uiable netplan Wi-Fi, re-applies, radio on, device managed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), yaml.dump({ network: { version: 2, wifis: { wlp3s0: { dhcp4: true, 'access-points': { Home: { password: 'x'.repeat(64) } } } } } }));
  const { netb, calls } = fakeHost([
    [/^sh -c for b in/, { stdout: NM_PROBE + 'bin:netplan\n' }],
    [/^sh -c for r in/, { stdout: '' }],
    [/^nmcli /, {}],
    [/^netplan /, {}],
  ], root);
  const d = await netb.detect(true);
  const log = await netb.nmAdopt(d, ['wlp3s0']);
  const y = yaml.load(fs.readFileSync(path.join(root, 'etc/netplan/90-uiable.yaml'), 'utf8'));
  assert.equal((y.network.wifis || {}).wlp3s0, undefined);
  const k = calls.map((c) => c.join(' '));
  assert.ok(k.includes('netplan apply')); assert.ok(k.includes('nmcli radio wifi on')); assert.ok(k.includes('nmcli device set wlp3s0 managed yes'));
  assert.match(log.join('\n'), /now manages wlp3s0/);
});

test('diagnostics: one read-only script, output scrubbed, stale NM leftovers listed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  fs.mkdirSync(path.join(root, 'etc/netplan'), { recursive: true });
  fs.writeFileSync(path.join(root, 'etc/netplan/90-NM-1.yaml'), 'network: {version: 2}\n');
  const hex = nb.wpaPsk('Home', 'hunter2hunter2');
  const { netb, calls } = netplanHost(root, [
    [/^sh -c .*uiable-diag|^sh -c [\s\S]*rfkill list/, { stdout: `### rfkill\n0: phy0: Wireless LAN\n### netplan get\nwifis:\n  wlp3s0:\n    access-points:\n      Home:\n        password: "hunter2hunter2"\n### wpa\npsk=${hex}\n` }],
  ]);
  const d = await netb.detect(true);
  const out = await netb.diagnostics(d, 'wlp3s0');
  assert.equal(out.device, 'wlp3s0');
  assert.ok(!out.text.includes('hunter2hunter2') && !out.text.includes(hex));
  assert.match(out.text, /rfkill/); assert.match(out.text, /90-NM-1\.yaml/);
  const diag = calls.find((c) => c[0] === 'sh' && /rfkill list/.test(c[2] || ''));
  assert.ok(diag, 'ran the diagnostics script');
  for (const bad of [/netplan apply/, /nmcli .*connect/, /systemctl (start|stop|restart)/, /rm -/]) assert.doesNotMatch(diag[2], bad);
});
