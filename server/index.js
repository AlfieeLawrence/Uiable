'use strict';
const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');

// Must run before auth loads config.json from DATA_DIR
require('./migrate').run(require('path').resolve(process.env.UIABLE_DATA_DIR || require('path').join(__dirname, '..', 'data')));
const auth = require('./auth');
const host = require('./host');
const stats = require('./stats');
const docker = require('./docker');
const audit = require('./audit');
const alerts = require('./alerts');
const metrics = require('./metrics');
const jobs = require('./jobs');
const backup = require('./backup');
const integrity = require('./integrity');
const secrets = require('./secrets');
const wireguard = require('./wireguard');

const PORT = Number(process.env.UIABLE_PORT || process.env.PORT || 8080);
const BIND = process.env.UIABLE_BIND || '127.0.0.1';
const VERSION = require('../package.json').version;
// BUILD_INFO.json is written when a release zip is made; fall back to file mtimes.
const BUILD_INFO = (() => {
  try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'BUILD_INFO.json'), 'utf8')); } catch (_) {}
  let newest = 0;
  const walk = (d) => { for (const e of require('fs').readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else newest = Math.max(newest, require('fs').statSync(p).mtimeMs); } };
  try { walk(path.join(__dirname)); walk(path.join(__dirname, '..', 'public')); } catch (_) {}
  return { version: VERSION, date: new Date(newest || Date.now()).toISOString() };
})();
const STATS_MS = Math.max(1000, Number(process.env.UIABLE_STATS_INTERVAL_MS) || 3000);

audit.init(auth.DATA_DIR);
alerts.init(auth.DATA_DIR);
metrics.init(auth.DATA_DIR);
secrets.init(auth.DATA_DIR);
backup.init(auth.DATA_DIR);
integrity.init(auth.DATA_DIR);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', false);

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

api.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ------------------------------------------------------------- public auth
app.get('/api/state', (req, res) => {
  const s = auth.getSession(req);
  res.json({
    setup: auth.needsSetup(), user: s ? s.username : null, role: s ? s.role : null,
    displayName: s ? ((auth.findUser(s.username) || {}).displayName || '') : null,
    linuxUser: s ? ((auth.findUser(s.username) || {}).linuxUser || '') : null,
    needsBinding: s ? !!((auth.listUsers().find((a) => a.username === s.username) || {}).needsBinding) : false,
    csrf: s ? s.csrf : null, version: VERSION, build: app.locals.BUILD, buildDate: BUILD_INFO.date, roles: auth.ROLE_NAMES,
  });
});

app.post('/api/setup', express.json(), wrap(async (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  if (!auth.needsSetup()) return res.status(409).json({ error: 'Setup has already been completed' });
  await auth.createUser(String(req.body.username || '').trim(), req.body.password, 'admin');
  const csrf = auth.createSession(res, String(req.body.username).trim());
  req.auditUser = String(req.body.username).trim();
  audit.write({ user: req.auditUser, action: 'auth.setup', ip: req.socket.remoteAddress });
  res.json({ ok: true, user: String(req.body.username).trim(), role: 'admin', csrf });
}));

app.post('/api/login', express.json(), wrap(async (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const ip = req.socket.remoteAddress;
  if (auth.rateLimited(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const u = await auth.verify(req.body.username, req.body.password);
  if (!u) {
    auth.recordFailure(ip);
    audit.write({ user: String(req.body.username || ''), action: 'auth.login.fail', ip, ok: false });
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  if (auth.has2fa(u)) {
    const ticket = auth.issueTicket(u.username);
    return res.json({ ok: true, twoFactor: true, ticket });
  }
  auth.clearFailures(ip);
  const csrf = auth.createSession(res, u.username);
  audit.write({ user: u.username, action: 'auth.login', ip, details: { role: u.role } });
  res.json({ ok: true, user: u.username, role: u.role, csrf });
}));

app.post('/api/login/2fa', express.json(), wrap(async (req, res) => {
  if (!auth.sameOrigin(req)) return res.status(403).json({ error: 'Bad origin' });
  const ip = req.socket.remoteAddress;
  if (auth.rateLimited(ip)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const pending = auth.takeTicket(req.body.ticket);
  if (!pending) return res.status(401).json({ error: 'Login expired. Sign in again.' });
  const u = auth.findUser(pending.username);
  if (!u) return res.status(401).json({ error: 'Account gone' });
  const v = auth.verifySecond(u, req.body.code);
  if (!v.ok) {
    auth.recordFailure(ip);
    audit.write({ user: u.username, action: 'auth.2fa.fail', ip, ok: false });
    return res.status(401).json({ error: 'Invalid code' });
  }
  auth.dropTicket(req.body.ticket);
  auth.clearFailures(ip);
  const csrf = auth.createSession(res, u.username);
  audit.write({ user: u.username, action: 'auth.login', ip, details: { role: u.role, method: v.method } });
  res.json({ ok: true, user: u.username, role: u.role, csrf, backupRemaining: v.remaining });
}));

app.post('/api/logout', (req, res) => {
  const s = auth.getSession(req);
  if (s) audit.write({ user: s.username, action: 'auth.logout', ip: req.socket.remoteAddress });
  auth.destroySession(req, res);
  res.json({ ok: true });
});

// ------------------------------------------------------------- authenticated API
const api = express.Router();
api.use(auth.requireAuth);
api.use(audit.middleware);

// Jobs (any authenticated user can watch a job they can see)
api.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'No such job' });
  // viewers can see job output for transparency of long ops they triggered indirectly
  res.json(jobs.view(j));
});

// Stats: any signed-in user
api.get('/stats', wrap(async (req, res) => res.json(await stats.snapshot())));

// -------- accounts (admin manages others; anyone manages own 2FA/password)
api.get('/accounts', auth.role('admin'), (req, res) => res.json({ accounts: auth.listUsers(), me: req.session.username }));
api.post('/accounts', auth.role('admin'), express.json(), wrap(async (req, res) => {
  await auth.createUser(String(req.body.username || '').trim(), req.body.password, req.body.role || 'viewer');
  res.json({ ok: true });
}));
api.post('/accounts/:name/password', express.json(), wrap(async (req, res) => {
  if (req.params.name !== req.session.username && !auth.atLeast(req.session.role, 'admin')) return res.status(403).json({ error: 'Admin only' });
  if (req.params.name === req.session.username) {
    if (!(await auth.verify(req.session.username, req.body.current))) return res.status(400).json({ error: 'Current password is wrong' });
  }
  await auth.setPassword(req.params.name, req.body.password);
  audit.write({
    user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress,
    action: 'account.password', ok: true,
    details: { target: req.params.name, self: req.params.name === req.session.username, secrets: 'omitted' },
  });
  res.json({ ok: true });
}));
api.post('/accounts/:name/role', auth.role('admin'), express.json(), wrap(async (req, res) => {
  auth.setRole(req.params.name, req.body.role);
  res.json({ ok: true });
}));
api.post('/accounts/:name/rename', express.json(), wrap(async (req, res) => {
  const self = auth.findUser(req.params.name) === auth.findUser(req.session.username);
  if (!self && !auth.atLeast(req.session.role, 'admin')) return res.status(403).json({ error: 'Only admins can rename other accounts' });
  const r = auth.renameUser(req.params.name, req.body.username);
  const moved = await require('./layout').renameUser(r.from, r.to).catch((e) => ({ error: e.message }));
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'account.rename', ok: true, details: { from: r.from, to: r.to, self } });
  res.json({ ok: true, username: r.to, self, moved });
}));
// -------- Linux account binding
const lu = require('./linuxusers');
const bindAudit = (req, account, r, extra) => audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'account.linux-bind', ok: true, details: Object.assign({ account, from: r.before, to: r.after }, extra) });
api.get('/account/linux-options', wrap(async (req, res) => {
  const isAdmin = auth.atLeast(req.session.role, 'admin');
  res.json({ users: (await lu.selectable(req.session)).map((u) => ({ name: u.name, uid: u.uid, home: u.home, admin: u.admin })), isAdmin, current: lu.boundOf(req.session), settings: auth.linuxSettings() });
}));
api.post('/account/linux-user', express.json(), wrap(async (req, res) => {
  if (req.body.skip) { auth.setLinuxUser(req.session.username, '', { skip: true }); return res.json({ ok: true, skipped: true }); }
  const name = String(req.body.linuxUser || '');
  if (name) {
    const ok = (await lu.selectable(req.session)).some((u) => u.name === name);
    if (!ok) return res.status(403).json({ error: 'You are not allowed to link to that Linux user. Ask an admin to add it to the allowed list.' });
  }
  const r = auth.setLinuxUser(req.session.username, name);
  bindAudit(req, req.session.username, r, { self: true });
  res.json({ ok: true, linuxUser: r.after });
}));
api.post('/accounts/:name/linux-user', auth.role('admin'), express.json(), wrap(async (req, res) => {
  const name = String(req.body.linuxUser || '');
  if (name) await lu.get(name);
  const acct = auth.findUser(req.params.name); if (!acct) return res.status(404).json({ error: 'No such account' });
  const r = auth.setLinuxUser(acct.username, name);
  bindAudit(req, acct.username, r, { self: false });
  res.json({ ok: true, linuxUser: r.after });
}));
api.get('/accounts-linux-settings', auth.role('admin'), wrap(async (req, res) => res.json(Object.assign({ users: await lu.list() }, auth.linuxSettings()))));
api.put('/accounts-linux-settings', auth.role('admin'), express.json(), wrap(async (req, res) => {
  if (req.body.defaultUser) await lu.get(req.body.defaultUser);
  for (const n of req.body.allowed || []) await lu.get(n);
  const out = auth.setLinuxSettings(req.body);
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'settings.linux-binding', ok: true, details: { defaultUser: out.defaultUser, allowed: out.allowed.join(',') } });
  res.json(out);
}));
api.get('/account/me', (req, res) => {
  const a = auth.listUsers().find((x) => x.username === req.session.username);
  res.json(Object.assign({}, a, { role: req.session.role }));
});
api.post('/account/profile', express.json(), wrap(async (req, res) => {
  res.json({ ok: true, displayName: auth.setDisplayName(req.session.username, req.body.displayName) });
}));
api.delete('/accounts/:name', auth.role('admin'), wrap(async (req, res) => {
  if (req.params.name === req.session.username) return res.status(400).json({ error: 'You cannot delete the account you are signed in with' });
  auth.deleteUser(req.params.name);
  res.json({ ok: true });
}));


// -------- API tokens (admin)
api.get('/tokens', auth.role('admin'), (req, res) => res.json({ tokens: auth.listTokens() }));
api.post('/tokens', auth.role('admin'), express.json(), wrap(async (req, res) => {
  const created = auth.createApiToken({
    name: req.body.name,
    role: req.body.role || 'viewer',
    scope: req.body.scope,
    expiresInDays: req.body.expiresInDays,
  });
  audit.write({ user: req.session.username, action: 'token.create', details: { id: created.id, name: created.name, role: created.role, scope: created.scope, expiresAt: created.expiresAt, prefix: created.prefix } });
  res.json(created);
}));
api.delete('/tokens', auth.role('admin'), wrap(async (req, res) => {
  const r = auth.revokeAllApiTokens();
  audit.write({ user: req.session.username, action: 'token.revoke_all', details: r });
  res.json(Object.assign({ ok: true }, r));
}));
api.delete('/tokens/:id', auth.role('admin'), wrap(async (req, res) => {
  auth.revokeApiToken(req.params.id);
  audit.write({ user: req.session.username, action: 'token.revoke', details: { id: req.params.id } });
  res.json({ ok: true });
}));

// 2FA (self-service)
api.get('/account/2fa', wrap(async (req, res) => {
  const u = auth.findUser(req.session.username);
  res.json({ enabled: auth.has2fa(u), backupRemaining: (u.backup || []).length });
}));
api.post('/account/2fa/begin', wrap(async (req, res) => {
  const hn = (await require('fs').promises.readFile('/proc/sys/kernel/hostname', 'utf8').catch(() => 'Uiable')).trim();
  res.json(await auth.totpBegin(req.session.username, `Uiable (${hn})`));
}));
api.post('/account/2fa/enable', express.json(), wrap(async (req, res) => {
  const codes = auth.totpEnable(req.session.username, req.body.code);
  res.json({ ok: true, backupCodes: codes });
}));
api.post('/account/2fa/disable', express.json(), wrap(async (req, res) => {
  if (!(await auth.verify(req.session.username, req.body.password))) return res.status(400).json({ error: 'Password is wrong' });
  auth.totpDisable(req.session.username);
  res.json({ ok: true });
}));
api.post('/account/2fa/backup', express.json(), wrap(async (req, res) => {
  if (!(await auth.verify(req.session.username, req.body.password))) return res.status(400).json({ error: 'Password is wrong' });
  res.json({ ok: true, backupCodes: auth.regenBackup(req.session.username) });
}));

// -------- docker: operator+ write, viewer read
api.use('/docker', auth.rw('viewer', 'operator'));
api.get('/docker/status', wrap(async (req, res) => {
  if (!docker.available()) return res.json({ available: false, message: `No Docker/Podman socket (tried docker.sock and podman.sock). Mount the engine socket into the container.` });
  try { const i = await docker.info(); res.json({ available: true, engine: docker.engine(), socket: docker.SOCK, version: i.ServerVersion, containers: i.Containers, running: i.ContainersRunning, images: i.Images }); }
  catch (e) { res.json({ available: false, message: e.message }); }
}));
api.get('/docker/containers', wrap(async (req, res) => res.json({ containers: await docker.containers(), self: process.env.HOSTNAME || '' })));
api.get('/docker/containers/:id/logs', wrap(async (req, res) => res.json({ logs: await docker.logs(req.params.id, Number(req.query.tail) || 500) })));
api.get('/docker/containers/:id/stats', wrap(async (req, res) => res.json(await docker.stats(req.params.id))));
api.get('/docker/containers/:id/inspect', wrap(async (req, res) => res.json(await docker.inspect(req.params.id))));
api.post('/docker/containers/:id/:action', wrap(async (req, res) => { await docker.action(req.params.id, req.params.action); res.json({ ok: true }); }));
api.delete('/docker/containers/:id', wrap(async (req, res) => { await docker.remove(req.params.id); res.json({ ok: true }); }));
api.get('/docker/images', wrap(async (req, res) => res.json({ images: await docker.images() })));
api.delete('/docker/images/:id', wrap(async (req, res) => { await docker.removeImage(req.params.id); res.json({ ok: true }); }));
api.get('/docker/volumes', wrap(async (req, res) => res.json(await docker.volumes())));
api.delete('/docker/volumes/:name', wrap(async (req, res) => { await docker.removeVolume(req.params.name); res.json({ ok: true }); }));
api.post('/docker/prune/:what', wrap(async (req, res) => res.json(await docker.prune(req.params.what))));

// Files: viewer can read/download; operator+ can write
const files = require('./files');
api.use('/files', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return auth.role('viewer')(req, res, next);
  return auth.role('operator')(req, res, next);
}, files);

// System: split by sensitivity
const system = require('./system');
api.use('/system', (req, res, next) => {
  const p = req.path;
  // Power, Linux users, hostname, timezone, wifi connect: admin only
  if (/^\/(power|users|hostname|timezone)/.test(p) || (p === '/primary-mount' && req.method !== 'GET') || (p.startsWith('/wifi') && req.method !== 'GET') || (p.startsWith('/network/device') && req.method !== 'GET')) {
    return auth.role('admin')(req, res, next);
  }
  // Services write: operator+; read: viewer
  if (p.startsWith('/services')) return auth.rw('viewer', 'operator')(req, res, next);
  // Processes kill: operator+; list: viewer
  if (p.startsWith('/processes') && req.method !== 'GET') return auth.role('operator')(req, res, next);
  return auth.role('viewer')(req, res, next);
}, system);

// New feature routers
api.use('/logs', auth.role('viewer'), require('./logs'));
api.use('/updates', auth.role('admin'), require('./updates'));

api.use('/metrics', auth.role('viewer'), metrics);
api.use('/secrets', auth.role('admin'), secrets);
api.use('/backup', auth.role('admin'), backup);
api.use('/integrity', auth.role('admin'), integrity);
api.use('/wireguard', auth.role('admin'), wireguard);

api.use('/alerts', auth.role('admin'), alerts);
api.use('/apps', auth.rw('viewer', 'operator'), require('./apps'));
api.use('/stacks', auth.rw('viewer', 'operator'), require('./compose'));
api.use('/storage', (req, res, next) => {
  if (['GET', 'HEAD'].includes(req.method)) return auth.role('viewer')(req, res, next);
  // format is particularly dangerous
  if (req.path === '/format') return auth.role('admin')(req, res, next);
  return auth.role('admin')(req, res, next);
}, require('./storage'));
api.use('/firewall', auth.role('admin'), require('./firewall'));
api.use('/cron', auth.role('admin'), require('./cron'));
api.use('/proxy', auth.role('admin'), require('./proxy'));
api.use('/nettools', auth.rw('viewer', 'operator'), require('./nettools'));
api.use('/scripts', auth.role('operator'), require('./scripts')); // writes are admin-only inside; operators run as their linked user
api.use('/layout', auth.role('viewer'), require('./layout').router);
api.post('/audit/scrub', auth.role('admin'), wrap(async (req, res) => res.json(await audit.scrubSecrets())));
api.get('/audit', auth.role('admin'), wrap(async (req, res) => res.json(await audit.search(req.query))));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ------------------------------------------------------------- static frontend
const nm = path.join(__dirname, '..', 'node_modules');
app.use('/vendor/xterm', express.static(path.join(nm, '@xterm/xterm'), { maxAge: '7d' }));
app.use('/vendor/xterm-fit', express.static(path.join(nm, '@xterm/addon-fit'), { maxAge: '7d' }));
// Cache busting. Every release gets a BUILD id (hash of version + public file
// sizes/mtimes, computed once at startup). index.html is never cached and
// references every asset as ?v=BUILD; lazy-loaded page JS uses the same id.
// Without this a browser could mix a cached old core.js with a new page script
// for up to an hour after an update (that broke the All apps launcher).
const PUBLIC = path.join(__dirname, '..', 'public');
const BUILD = (() => {
  const h = require('crypto').createHash('sha1').update(VERSION);
  const walk = (d) => { for (const e of require('fs').readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const st = require('fs').statSync(p); h.update(`${p}:${st.size}:${st.mtimeMs}`); } } };
  try { walk(PUBLIC); } catch (_) {}
  return h.digest('hex').slice(0, 10);
})();
app.locals.BUILD = BUILD;
const indexHtml = require('fs').readFileSync(path.join(PUBLIC, 'index.html'), 'utf8')
  .replace(/(src|href)="(\/(?:js\/[\w.-]+\.js|style\.css|theme\.js))"/g, `$1="$2?v=${BUILD}"`)
  .replace('<head>', `<head>\n  <meta name="uiable-build" content="${BUILD}">`); // meta, not inline script: CSP forbids inline JS
const sendIndex = (req, res) => { res.set('Cache-Control', 'no-cache, no-store, must-revalidate'); res.type('html').send(indexHtml); };
app.get(['/', '/index.html'], sendIndex);
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: (res, fp) => {
    const versioned = res.req && res.req.query && res.req.query.v === BUILD;
    if (versioned) res.set('Cache-Control', 'public, max-age=31536000, immutable');
    else if (/\.(js|css)$/.test(fp)) res.set('Cache-Control', 'no-cache'); // unversioned code: always revalidate
    else res.set('Cache-Control', 'public, max-age=3600');
  },
}));
app.get('*', sendIndex);

app.use((err, req, res, next) => {
  const codes = { ENOENT: 404, EACCES: 403, EPERM: 403, EEXIST: 409, ENOTEMPTY: 409, ENOTDIR: 400, EISDIR: 400, EXDEV: 400, EROFS: 403, EBUSY: 409 };
  const status = err.status || codes[err.code] || 500;
  const msgs = { ENOENT: 'No such file or directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted', EEXIST: 'Already exists', ENOTEMPTY: 'Directory not empty', EXDEV: 'Cannot move across filesystems', EROFS: 'Read-only filesystem' };
  if (status >= 500) console.error('[error]', req.method, req.path, err.message);
  if (res.headersSent) return res.destroy();
  let message = err.message;
  if (msgs[err.code]) {
    let p = err.path || '';
    if (host.HOST_ROOT !== '/' && p.startsWith(host.HOST_ROOT)) p = p.slice(host.HOST_ROOT.length) || '/';
    message = p ? `${msgs[err.code]}: ${p}` : msgs[err.code];
  }
  res.status(status).json({ error: message, saved: err.saved });
});

// ------------------------------------------------------------- websockets
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const s = auth.getSession(req);
  if (!s || !auth.sameOrigin(req) || !req.headers.origin) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  if (url.pathname === '/ws/stats') return wss.handleUpgrade(req, socket, head, (ws) => statsSocket(ws));
  if (url.pathname === '/ws/terminal') {
    if (!auth.atLeast(s.role, 'operator')) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); } // operators: linked user only (enforced in terminal.js)
    return wss.handleUpgrade(req, socket, head, (ws) => require('./terminal')(ws, url, s));
  }
  if (url.pathname === '/ws/logs') {
    return wss.handleUpgrade(req, socket, head, (ws) => require('./logs').follow(ws, url));
  }
  socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy();
});

const statClients = new Set();
let statTimer = null;
async function tick() {
  if (!statClients.size) { clearInterval(statTimer); statTimer = null; return; }
  try {
    const msg = JSON.stringify(await stats.snapshot());
    for (const ws of statClients) if (ws.readyState === 1) ws.send(msg);
  } catch (e) { console.error('[stats]', e.message); }
}
function statsSocket(ws) {
  statClients.add(ws);
  ws.on('close', () => { statClients.delete(ws); if (!statClients.size && statTimer) { clearInterval(statTimer); statTimer = null; } });
  if (!statTimer) { stats.snapshot().then(() => setTimeout(tick, 300)); statTimer = setInterval(tick, STATS_MS); } else tick();
}

server.listen(PORT, BIND, () => {
  console.log(`Uiable ${VERSION} listening on http://${BIND}:${PORT}  (host mode: ${host.MODE}, host root: ${host.HOST_ROOT}, data: ${auth.DATA_DIR})`);
  if (auth.needsSetup()) console.log('No accounts yet: open the UI to create the admin account.');
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(); process.exit(0); });
