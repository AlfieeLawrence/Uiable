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
  assert.equal(n.find((x) => x.ssid === 'Six').security, 'WPA3 WPA2');
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
function fakeHost(responses, root) {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = [cmd, ...args].join(' ');
    for (const [re, r] of responses) if (re.test(key)) return Object.assign({ code: 0, stdout: '', stderr: '' }, typeof r === 'function' ? r(args) : r);
    return { code: 127, stdout: '', stderr: 'not found' };
  };
  return { calls, netb: nb.create({ run, root }) };
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

test('wifiConnect via wpa_supplicant never puts the plaintext password in argv', async () => {
  const pw = 'Sup3rSecretPass';
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c /, { stdout: 'bin:wpa_cli\nbin:ip\nproc:wpa_supplicant\nwifi:wlan0\n' }],
    [/add_network/, { stdout: '3\n' }],
    [/save_config/, { stdout: 'OK\n' }],
    [/^wpa_cli /, { stdout: 'OK\n' }],
  ], os.tmpdir());
  const d = await netb.detect(true);
  const out = await netb.wifiConnect(d, { ssid: 'Home', password: pw, device: 'wlan0' });
  assert.equal(out.persisted, true);
  assert.ok(!JSON.stringify(calls).includes(pw));
  assert.ok(calls.some((c) => c.includes('psk') && c.includes(nb.wpaPsk('Home', pw))));
  assert.ok(calls.some((c) => c.includes('ssid') && c.includes(Buffer.from('Home').toString('hex'))));
});

test('wifiConnect error text is scrubbed (iwd)', async () => {
  const pw = 'Sup3rSecretPass';
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c /, { stdout: 'bin:iwctl\nbin:ip\nunit:iwd:active\nwifi:wlan0\n' }],
    [/^iwctl --passphrase/, { code: 1, stderr: `Operation failed for passphrase ${pw}` }],
  ], os.tmpdir());
  const d = await netb.detect(true);
  await assert.rejects(netb.wifiConnect(d, { ssid: 'Home', password: pw, device: 'wlan0' }), (e) => !e.message.includes(pw) && /••••/.test(e.message));
});

test('setIpConfig via systemd-networkd writes unit and reloads', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c /, { stdout: 'bin:networkctl\nbin:ip\nunit:systemd-networkd:active\n' }],
    [/^networkctl /, {}],
  ], root);
  const d = await netb.detect(true);
  const r = await netb.setIpConfig(d, { device: 'eth0', mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: '1.1.1.1' });
  assert.equal(r.backend, 'systemd-networkd');
  const t = fs.readFileSync(path.join(root, 'etc/systemd/network/10-uiable-eth0.network'), 'utf8');
  assert.match(t, /Address=10\.0\.0\.2\/24/);
  assert.ok(calls.some((c) => c.join(' ') === 'networkctl reload'));
  assert.deepEqual(await netb.getIpConfig(d, 'eth0'), { managed: true, mode: 'static', address: '10.0.0.2/24', gateway: '10.0.0.1', dns: '1.1.1.1' });
});

test('setIpConfig via netplan rolls back when netplan generate fails', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const { netb } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c /, { stdout: 'bin:netplan\nbin:ip\ndir:netplan\n' }],
    [/^netplan generate/, { code: 1, stderr: 'bad yaml' }],
  ], root);
  const d = await netb.detect(true);
  await assert.rejects(netb.setIpConfig(d, { device: 'eth0', mode: 'dhcp' }), /netplan rejected/);
  assert.equal(fs.existsSync(path.join(root, 'etc/netplan/90-uiable.yaml')), false);
});

test('deviceAction without NM uses ip link / iwctl', async () => {
  const { netb, calls } = fakeHost([
    [/^nmcli /, { code: 127 }],
    [/^sh -c /, { stdout: 'bin:iwctl\nbin:ip\nunit:iwd:active\nwifi:wlan0\n' }],
    [/^(ip|iwctl) /, {}],
  ], os.tmpdir());
  const d = await netb.detect(true);
  await netb.deviceAction(d, 'eth0', 'disconnect');
  await netb.deviceAction(d, 'wlan0', 'disconnect');
  assert.deepEqual(calls.slice(-2), [['ip', 'link', 'set', 'dev', 'eth0', 'down'], ['iwctl', 'station', 'wlan0', 'disconnect']]);
  await assert.rejects(netb.deviceAction(d, 'eth0;reboot', 'connect'), /Bad device/);
});
