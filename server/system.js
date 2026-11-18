'use strict';
// Processes, systemd services and host settings (network, hostname, timezone,
// users, power). Every host command goes through host.run (nsenter in Docker).
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const audit = require('./audit');
const stats = require('./stats');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fail = (r, what) => bad(`${what} failed: ${(r.stderr || r.stdout || 'exit ' + r.code).trim()}`, r.code === 127 ? 501 : 500);
const notFound = (r) => r.code === 127 || /No such file|not found/i.test(r.stderr) && r.code >= 126;

// ---------------------------------------------------------------- processes
// Process list straight from /proc (no `ps` spawn). With pid: host this is the host's process table.
const NCPU = require('os').cpus().length || 1;
const CLK_TCK = 100; // USER_HZ is 100 on every mainstream Linux build
let prevProcs = { at: 0, ticks: new Map() };
let passwdCache = { at: 0, map: {} };
async function uidMap() {
  if (Date.now() - passwdCache.at < 60000) return passwdCache.map;
  const map = {};
  (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/passwd'), 'utf8').catch(() => '')).split('\n').forEach((l) => { const p = l.split(':'); if (p.length > 2) map[p[2]] = p[0]; });
  passwdCache = { at: Date.now(), map };
  return map;
}
router.get('/processes', wrap(async (req, res) => {
  const users = await uidMap();
  const uptime = Number((await fsp.readFile('/proc/uptime', 'utf8')).split(' ')[0]);
  const memTotal = Number(((await fsp.readFile('/proc/meminfo', 'utf8')).match(/MemTotal:\s+(\d+)/) || [])[1] || 1) * 1024;
  const now = Date.now();
  const dt = prevProcs.at ? (now - prevProcs.at) / 1000 : 0;
  const ticks = new Map();
  const pids = (await fsp.readdir('/proc')).filter((n) => /^\d+$/.test(n));
  const procs = (await Promise.all(pids.map(async (pid) => {
    try {
      const [stat, status, cmdline] = await Promise.all([
        fsp.readFile(`/proc/${pid}/stat`, 'utf8'), fsp.readFile(`/proc/${pid}/status`, 'utf8'), fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => ''),
      ]);
      const rp = stat.lastIndexOf(')');
      const name = stat.slice(stat.indexOf('(') + 1, rp);
      const f = stat.slice(rp + 2).split(' ');
      const t = Number(f[11]) + Number(f[12]);
      const start = Number(f[19]) / CLK_TCK;
      const key = `${pid}:${f[19]}`;
      ticks.set(key, t);
      const prev = prevProcs.ticks.get(key);
      const elapsed = Math.max(0, uptime - start);
      const raw = prev != null && dt > 0 ? ((t - prev) / CLK_TCK / dt) * 100 : elapsed >= 1 ? (t / CLK_TCK / elapsed) * 100 : 0;
      const cpu = Math.min(raw, NCPU * 100);
      const rss = Number((status.match(/VmRSS:\s+(\d+)/) || [])[1] || 0) * 1024;
      const uid = (status.match(/Uid:\s+(\d+)/) || [])[1];
      const cmd = cmdline.replace(/\0+$/, '').replace(/\0/g, ' ') || `[${name}]`;
      return { pid: +pid, ppid: +f[1], user: users[uid] || uid, cpu: Math.round(cpu * 10) / 10, mem: Math.round((rss / memTotal) * 1000) / 10, rss, elapsed: Math.round(elapsed), stat: f[0], name, cmd };
    } catch (_) { return null; } // process exited mid-scan
  }))).filter(Boolean);
  prevProcs = { at: now, ticks };
  procs.sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  res.json({ processes: procs });
}));

router.post('/processes/:pid/kill', wrap(async (req, res) => {
  const pid = parseInt(req.params.pid, 10);
  const sig = String(req.body.signal || 'SIGTERM').toUpperCase();
  if (!(pid > 1)) throw bad('Refusing to signal that PID');
  if (!['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGSTOP', 'SIGCONT'].includes(sig)) throw bad('Unsupported signal');
  if (pid === process.pid) throw bad('That is the Uiable process itself');
  try { process.kill(pid, sig); } catch (e) { throw bad(e.code === 'ESRCH' ? 'No such process' : `kill failed: ${e.message}`, e.code === 'ESRCH' ? 404 : 500); }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- services
const unitName = (n) => { if (!/^[\w@.\-:\\]+$/.test(String(n))) throw bad('Bad unit name'); return String(n); };

router.get('/services', wrap(async (req, res) => {
  const r = await host.run('systemctl', ['list-units', '--type=service', '--all', '--no-pager', '--plain', '--no-legend'], { timeout: 15000 });
  if (r.code !== 0) {
    return res.json({ available: false, message: notFound(r) ? 'systemd (systemctl) was not found on this host.' : (r.stderr || 'systemctl failed').trim(), services: [] });
  }
  const files = await host.run('systemctl', ['list-unit-files', '--type=service', '--no-pager', '--plain', '--no-legend'], { timeout: 15000 });
  const enabled = {};
  files.stdout.split('\n').forEach((l) => { const p = l.trim().split(/\s+/); if (p[0]) enabled[p[0]] = p[1]; });
  const seen = new Set();
  const services = r.stdout.split('\n').map((l) => l.replace(/^[●*\s]+/, '').trim()).filter(Boolean).map((l) => {
    const p = l.split(/\s+/);
    seen.add(p[0]);
    return { name: p[0], load: p[1], active: p[2], sub: p[3], description: p.slice(4).join(' '), enabled: enabled[p[0]] || '' };
  });
  // include installed-but-never-loaded units
  Object.entries(enabled).forEach(([n, st]) => {
    if (!seen.has(n) && !n.includes('@.')) services.push({ name: n, load: 'not-loaded', active: 'inactive', sub: 'dead', description: '', enabled: st });
  });
  services.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ available: true, services });
}));

router.get('/services/:name/status', wrap(async (req, res) => {
  const r = await host.run('systemctl', ['status', unitName(req.params.name), '--no-pager', '-n', '40', '-l'], { timeout: 10000 });
  res.json({ output: (r.stdout + r.stderr).trim() });
}));

router.post('/services/:name/:action', wrap(async (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw bad('Bad action');
  const r = await host.run('systemctl', [action, unitName(req.params.name)], { timeout: 60000 });
  if (r.code !== 0) throw fail(r, `systemctl ${action}`);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- network
// Backends live in netbackends.js: NetworkManager first, then iwd / wpa_supplicant /
// netplan / systemd-networkd / ip. All detection and commands run on the HOST (nsenter).
const netb = require('./netbackends').create({ run: host.run, root: host.HOST_ROOT, dataDir: require('./auth').DATA_DIR });
const jobs = require('./jobs');

router.get('/network', wrap(async (req, res) => {
  const d = await netb.detect(req.query.refresh === '1');
  const ov = await netb.overview(d);
  const b = d.backends;
  res.json({
    networkManager: d.nm.running,
    message: d.nm.running ? null : d.summary,
    backend: { wifi: b.wifi, config: b.config, fallbackConfig: b.fallbackConfig, link: b.link, scan: b.scan, summary: d.summary, unsupported: d.unsupported, readOnly: d.readOnly },
    nmInstall: d.install,
    interfaces: ov.interfaces,
    devices: ov.interfaces.map((i) => ({ device: i.name, type: i.type, state: i.state, connection: i.connection })), // pre-1.2.5 clients
    uplink: ov.uplink, routes: ov.routes,
    defaultRoute: ov.defaultRoute,
    dns: ov.dns,
    pending: netb.pendingInfo(),
  });
}));

router.get('/wifi', wrap(async (req, res) => {
  const d = await netb.detect();
  const b = d.backends;
  if (!b.hasWifi) return res.json({ available: false, backend: b.wifi, message: 'No Wi-Fi adapter was found on this host.', networks: [] });
  if (!b.wifi) return res.json({ available: false, backend: null, message: d.summary, networks: [] });
  if (!b.scan) return res.json({ available: true, canScan: false, backend: b.wifi, message: 'Scanning needs `iw` on this host; you can still join a network by name.', networks: [] });
  let networks;
  try { networks = await netb.scan(d, req.query.rescan === '1'); } catch (e) { return res.json({ available: false, backend: b.wifi, message: e.message, networks: [] }); }
  res.json({ available: true, canScan: true, backend: b.wifi, networks });
}));

// Body contains the Wi-Fi password: this path is in audit.js SECRET_PATH, and
// netbackends scrubs it from any error text. Never log req.body here.
router.post('/wifi/connect', wrap(async (req, res) => {
  const ssid = String(req.body.ssid || '');
  if (!ssid || Buffer.byteLength(ssid) > 32) throw bad('SSID required (max 32 bytes)');
  const d = await netb.detect();
  const out = await netb.wifiConnect(d, { ssid, password: req.body.password ? String(req.body.password) : '', device: req.body.device ? String(req.body.device).replace(/[^\w.\-]/g, '') : '', hidden: !!req.body.hidden });
  netb.invalidate();
  res.json(Object.assign({ ok: true }, out));
}));

router.post('/network/device/:dev/:action', wrap(async (req, res) => {
  const d = await netb.detect();
  res.json(await netb.deviceAction(d, String(req.params.dev), req.params.action, { seconds: req.body && req.body.seconds }));
}));

// Wired / Wi-Fi preference (route metrics). Guarded: auto-reverts unless confirmed.
router.post('/network/uplink', wrap(async (req, res) => {
  const d = await netb.detect(true);
  const out = await netb.setUplink(d, { mode: req.body.mode, seconds: req.body.seconds });
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'network.uplink', ok: true, details: { kind: String(req.body.mode || '') } });
  res.json(out);
}));

// Confirm or revert a guarded change (IP settings, uplink, disconnect).
router.post('/network/pending/confirm', wrap(async (req, res) => res.json(netb.confirmPending(String(req.body.token || '')))));
router.post('/network/pending/revert', wrap(async (req, res) => res.json(await netb.revertPending(String(req.body.token || '')))));

router.get('/network/config/:dev', wrap(async (req, res) => {
  const d = await netb.detect();
  res.json(Object.assign({ backend: d.backends.config }, await netb.getIpConfig(d, String(req.params.dev))));
}));

router.post('/network/config', wrap(async (req, res) => {
  const d = await netb.detect();
  const out = await netb.setIpConfig(d, req.body || {}, { seconds: req.body && req.body.seconds });
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'network.ipconfig', ok: true, details: { iface: String(req.body.device || ''), kind: String(req.body.mode || ''), target: out.backend } });
  res.json(Object.assign({ ok: true }, out));
}));

// One-click NetworkManager install (only offered when nmcli is missing and the host can take packages).
router.post('/network/nm-install', wrap(async (req, res) => {
  const d = await netb.detect(true);
  if (d.nm.installed) throw bad('NetworkManager is already installed.', 409);
  if (!d.install || !d.install.available) throw bad((d.install && d.install.reason) || 'NetworkManager cannot be installed on this host.', 501);
  const mode = req.body.mode === 'all' ? 'all' : 'wifi-only';
  const job = jobs.runHost('Install NetworkManager', req.session.username, 'sh', ['-c', netb.NM_INSTALL_SCRIPT, 'uiable-nm-install', d.install.pkg, mode, d.install.iwd ? '1' : '0'], {
    banner: `$ install NetworkManager (${d.install.pkg}, ${mode === 'all' ? 'manage all interfaces' : 'Wi-Fi only, existing config left unmanaged'})\n`,
    timeout: 30 * 60 * 1000,
    onDone: () => netb.invalidate(),
  });
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'network.nm.install', ok: true, details: { kind: d.install.pkg, spec: mode, job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));

// ---------------------------------------------------------------- hostname / timezone

router.get('/primary-mount', wrap(async (req, res) => {
  const info = await stats.disks();
  res.json({ primaryMount: stats.loadPrimaryPref(), disks: info.disks.map((d) => ({ mount: d.mount, fs: d.fs, size: d.size, avail: d.avail })) });
}));

router.post('/primary-mount', wrap(async (req, res) => {
  const mount = req.body.mount == null || req.body.mount === '' ? null : String(req.body.mount);
  if (mount && !mount.startsWith('/')) throw bad('Mount must be an absolute path');
  if (mount) {
    const info = await stats.disks();
    if (!info.disks.some((d) => d.mount === mount)) throw bad('That mount is not currently available', 404);
  }
  stats.savePrimaryPref(mount);
  res.json({ ok: true, primaryMount: mount });
}));

router.get('/general', wrap(async (req, res) => {
  const hn = { stdout: await fsp.readFile('/proc/sys/kernel/hostname', 'utf8').catch(() => '') };
  let tz = (await host.run('timedatectl', ['show', '-p', 'Timezone', '--value'], { timeout: 8000 })).stdout.trim();
  if (!tz) tz = (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/timezone'), 'utf8').catch(() => '')).trim();
  if (!tz) {
    const l = await host.run('readlink', ['-f', '/etc/localtime'], { timeout: 5000 });
    tz = (l.stdout.trim().split('/zoneinfo/')[1] || '').trim();
  }
  const date = await host.run('date', ['-R'], { timeout: 5000 });
  res.json({ hostname: hn.stdout.trim(), timezone: tz || 'UTC', time: date.stdout.trim(), primaryMount: stats.loadPrimaryPref() });
}));

let tzCache = null;
router.get('/timezones', wrap(async (req, res) => {
  if (!tzCache) {
    const r = await host.run('timedatectl', ['list-timezones', '--no-pager'], { timeout: 10000 });
    let list = r.code === 0 ? r.stdout.split('\n').filter(Boolean) : [];
    if (!list.length) {
      const f = await host.run('sh', ['-c', 'cd /usr/share/zoneinfo 2>/dev/null && find . -type f | sed "s|^\\./||" | grep -E "^(Africa|America|Antarctica|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)/|^UTC$" | sort'], { timeout: 10000 });
      list = f.stdout.split('\n').filter(Boolean);
    }
    tzCache = list.length ? list : ['UTC'];
  }
  res.json({ timezones: tzCache });
}));

router.post('/hostname', wrap(async (req, res) => {
  const name = String(req.body.hostname || '').trim();
  if (!/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(name)) throw bad('Invalid hostname');
  let r = await host.run('hostnamectl', ['set-hostname', name], { timeout: 15000 });
  if (r.code !== 0) {
    await fsp.writeFile(path.join(host.HOST_ROOT, 'etc/hostname'), name + '\n');
    r = await host.run('hostname', [name], { timeout: 5000 });
    if (r.code !== 0) throw fail(r, 'hostname');
  }
  stats.invalidateInfo();
  res.json({ ok: true });
}));

router.post('/timezone', wrap(async (req, res) => {
  const tz = String(req.body.timezone || '');
  if (!/^[A-Za-z0-9_+\-]+(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) throw bad('Invalid timezone');
  let r = await host.run('timedatectl', ['set-timezone', tz], { timeout: 15000 });
  if (r.code !== 0) {
    r = await host.run('sh', ['-c', 'test -f "/usr/share/zoneinfo/$0" && ln -sf "/usr/share/zoneinfo/$0" /etc/localtime && echo "$0" > /etc/timezone', tz], { timeout: 5000 });
    if (r.code !== 0) throw bad('Could not set timezone (unknown zone, or no timedatectl/zoneinfo on host)', 500);
  }
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- users
const userName = (n) => { if (!/^[a-z_][a-z0-9_-]{0,31}\$?$/.test(String(n))) throw bad('Invalid username (lowercase letters, digits, - and _; max 32 chars)'); return String(n); };

async function readUsers() {
  const passwd = await fsp.readFile(path.join(host.HOST_ROOT, 'etc/passwd'), 'utf8').catch(() => '');
  const group = await fsp.readFile(path.join(host.HOST_ROOT, 'etc/group'), 'utf8').catch(() => '');
  const groups = group.split('\n').filter(Boolean).map((l) => { const p = l.split(':'); return { name: p[0], gid: +p[2], members: (p[3] || '').split(',').filter(Boolean) }; });
  const adminGroup = groups.find((g) => g.name === 'sudo') ? 'sudo' : groups.find((g) => g.name === 'wheel') ? 'wheel' : null;
  const users = passwd.split('\n').filter(Boolean).map((l) => { const p = l.split(':'); return { name: p[0], uid: +p[2], gid: +p[3], gecos: p[4], home: p[5], shell: p[6] }; })
    .map((u) => {
      const ug = groups.filter((g) => g.members.includes(u.name) || g.gid === u.gid).map((g) => g.name);
      return Object.assign(u, { groups: ug, admin: u.uid === 0 || (adminGroup && ug.includes(adminGroup)) || false, system: u.uid !== 0 && (u.uid < 1000 || u.uid >= 60000) });
    });
  return { users, adminGroup };
}

router.get('/users', wrap(async (req, res) => {
  const { users, adminGroup } = await readUsers();
  res.json({ adminGroup, users });
}));

async function setPassword(name, password) {
  if (typeof password !== 'string' || password.length < 1 || /[\n:]/.test(password)) throw bad('Password required (no newlines or colons)');
  const r = await host.run('chpasswd', [], { input: `${name}:${password}\n`, timeout: 15000 });
  if (r.code !== 0) throw fail(r, 'chpasswd');
}

async function setAdmin(name, on) {
  const { adminGroup } = await readUsers();
  if (!adminGroup) throw bad('No sudo or wheel group exists on this host', 501);
  let r = on ? await host.run('usermod', ['-aG', adminGroup, name]) : await host.run('gpasswd', ['-d', name, adminGroup]);
  if (r.code === 127) r = on ? await host.run('addgroup', [name, adminGroup]) : await host.run('delgroup', [name, adminGroup]);
  if (r.code !== 0) throw fail(r, on ? 'add to ' + adminGroup : 'remove from ' + adminGroup);
}

router.post('/users', wrap(async (req, res) => {
  const name = userName(req.body.username);
  const shell = String(req.body.shell || '/bin/bash');
  if (!/^\/[\w/.\-]+$/.test(shell)) throw bad('Bad shell');
  let r = await host.run('useradd', ['-m', '-s', shell, name], { timeout: 20000 });
  if (r.code === 127) r = await host.run('adduser', ['-D', '-s', shell, name], { timeout: 20000 }); // busybox / alpine
  if (r.code !== 0) throw fail(r, 'useradd');
  if (req.body.password) await setPassword(name, req.body.password);
  if (req.body.admin) await setAdmin(name, true);
  res.json({ ok: true });
}));

router.post('/users/:name/password', wrap(async (req, res) => {
  const name = userName(req.params.name);
  await setPassword(name, req.body.password);
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'linux.user.password', ok: true, details: { target: name, secrets: 'omitted' } });
  res.json({ ok: true });
}));

router.post('/users/:name/admin', wrap(async (req, res) => {
  const name = userName(req.params.name);
  if (name === 'root') throw bad('root is always an administrator');
  await setAdmin(name, !!req.body.admin);
  res.json({ ok: true });
}));

router.delete('/users/:name', wrap(async (req, res) => {
  const name = userName(req.params.name);
  if (name === 'root') throw bad('Refusing to delete root');
  const args = req.query.removeHome === '1' ? ['-r', name] : [name];
  let r = await host.run('userdel', args, { timeout: 20000 });
  if (r.code === 127) r = await host.run('deluser', req.query.removeHome === '1' ? ['--remove-home', name] : [name], { timeout: 20000 });
  if (r.code !== 0 && r.code !== 12) throw fail(r, 'userdel'); // 12 = could not remove home
  res.json({ ok: true });
}));

// Users Uiable itself depends on: the account it runs as, plus anything listed
// in UIABLE_PROTECTED_USERS (comma separated). These can never be renamed here.
function protectedUsers() {
  const set = new Set(['root']);
  try { set.add(require('os').userInfo().username); } catch (_) {}
  for (const n of [process.env.SUDO_USER, process.env.UIABLE_RUN_USER, ...(process.env.UIABLE_PROTECTED_USERS || '').split(',')]) if (n && n.trim()) set.add(n.trim());
  return set;
}

async function activity(name) {
  const who = await host.run('who', [], { timeout: 5000 });
  const sessions = (who.stdout || '').split('\n').filter((l) => l.split(/\s+/)[0] === name).length;
  const ps = await host.run('pgrep', ['-u', name], { timeout: 5000 });
  const procs = (ps.stdout || '').split('\n').filter(Boolean).length;
  return { sessions, procs };
}

// Preflight so the UI can warn before renaming
router.get('/users/:name/rename-check', wrap(async (req, res) => {
  const name = userName(req.params.name);
  const { users } = await readUsers();
  const u = users.find((x) => x.name === name);
  if (!u) throw bad('No such user', 404);
  const blocked = u.uid < 1000 || u.uid >= 60000 ? 'System accounts (uid below 1000) cannot be renamed' : protectedUsers().has(name) ? 'Uiable runs as or depends on this user' : null;
  const grp = (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/group'), 'utf8').catch(() => '')).split('\n').map((l) => l.split(':')).find((g) => g[0] === name && +g[2] === u.gid);
  res.json(Object.assign({ name, uid: u.uid, home: u.home, blocked, primaryGroup: grp ? grp[0] : null }, await activity(name)));
}));

router.post('/users/:name/rename', wrap(async (req, res) => {
  const name = userName(req.params.name);
  const to = userName(req.body.newName);
  if (to === name) throw bad('That is already the username');
  const { users } = await readUsers();
  const u = users.find((x) => x.name === name);
  if (!u) throw bad('No such user', 404);
  if (u.uid === 0 || u.uid < 1000 || u.uid >= 60000) throw bad('Refusing to rename root or system accounts (uid below 1000)', 403);
  if (protectedUsers().has(name)) throw bad('Refusing to rename a user Uiable runs as or depends on', 403);
  if (users.some((x) => x.name === to)) throw bad('A user with that name already exists', 409);
  const act = await activity(name);
  if ((act.sessions || act.procs) && !req.body.force) {
    return res.status(409).json({ error: `${name} is logged in (${act.sessions} sessions) or has ${act.procs} running processes. Log them out first or confirm to try anyway.`, needsConfirm: true, ...act });
  }
  const steps = [];
  let r = await host.run('usermod', ['-l', to, name], { timeout: 20000 });
  if (r.code !== 0) throw fail(r, 'usermod -l');
  steps.push('login');
  if (req.body.renameGroup) {
    const grp = (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/group'), 'utf8').catch(() => '')).split('\n').map((l) => l.split(':')).find((g) => g[0] === name && +g[2] === u.gid);
    if (grp) { r = await host.run('groupmod', ['-n', to, name], { timeout: 20000 }); if (r.code !== 0) throw fail(r, 'groupmod -n (login was renamed)'); steps.push('group'); }
  }
  let home = u.home;
  if (req.body.moveHome && u.home && u.home !== '/' ) {
    home = path.posix.join(path.posix.dirname(u.home), to);
    r = await host.run('usermod', ['-d', home, '-m', to], { timeout: 120000 });
    if (r.code !== 0) throw fail(r, 'usermod -d -m (login was renamed)');
    steps.push('home');
  }
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'linux.user.rename', ok: true, details: { from: name, to, steps: steps.join(','), home, forced: !!req.body.force } });
  res.json({ ok: true, name: to, home, steps });
}));

// ---------------------------------------------------------------- power
router.post('/power/:action', wrap(async (req, res) => {
  const a = req.params.action;
  if (!['reboot', 'shutdown'].includes(a)) throw bad('Bad action');
  res.json({ ok: true });
  setTimeout(async () => {
    const r = await host.run('systemctl', [a === 'reboot' ? 'reboot' : 'poweroff'], { timeout: 15000 });
    if (r.code !== 0) await host.run(a === 'reboot' ? 'reboot' : 'poweroff', [], { timeout: 15000 });
  }, 800);
}));

module.exports = router;
