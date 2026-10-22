'use strict';
// Saved shell scripts on the host (admin only). Run via jobs with live output.
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const jobs = require('./jobs');
const audit = require('./audit');
const auth = require('./auth');
const lu = require('./linuxusers');
const fs = require('fs');
const adminOnly = (req) => { if (!auth.atLeast(req.session.role, 'admin')) throw bad('Only admins can create, edit, rename or delete scripts', 403); };

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

const preferredRoot = () => {
  const env = process.env.UIABLE_SCRIPTS_DIR;
  if (env) return env.startsWith(host.HOST_ROOT) || host.HOST_ROOT === '/' ? env : path.join(host.HOST_ROOT, env.replace(/^\//, ''));
  return path.join(host.HOST_ROOT, 'var/lib/uiable/scripts');
};
const dataFallback = () => path.join(process.env.UIABLE_DATA_DIR || '/data', 'scripts');

let activeRoot = null;
async function ensure() {
  if (activeRoot) return activeRoot;
  const preferred = preferredRoot();
  try {
    await fsp.mkdir(preferred, { recursive: true, mode: 0o700 });
    await fsp.writeFile(path.join(preferred, '.write-test'), 'ok', { flag: 'w' });
    await fsp.unlink(path.join(preferred, '.write-test'));
    activeRoot = preferred;
    // 0711: other users may traverse to a known script path (cron lines run as
    // that user), but cannot list the folder. Files stay root-owned and 0755.
    try { await fsp.chmod(preferred, 0o711); await fsp.chmod(path.dirname(preferred), 0o711); } catch (_) {}
  } catch (_) {
    const fb = dataFallback();
    await fsp.mkdir(fb, { recursive: true, mode: 0o700 });
    activeRoot = fb;
  }
  return activeRoot;
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const nameOk = (n) => { if (!NAME_RE.test(String(n || '').replace(/\.sh$/, ''))) throw bad('Name: letters, digits, . _ - ; max 64'); return String(n).replace(/\.sh$/, ''); };
const displayPath = (id, root) => {
  const pref = preferredRoot();
  const hostDefault = path.join(host.HOST_ROOT, 'var/lib/uiable/scripts');
  if (root === hostDefault || root.endsWith('/var/lib/uiable/scripts')) return `/var/lib/uiable/scripts/${id}.sh`;
  return path.join(root, `${id}.sh`);
};
const hostPathForRun = (id, root) => {
  if (host.MODE === 'nsenter' && (root === preferredRoot() || String(root).includes('/var/lib/uiable/scripts'))) {
    return `/var/lib/uiable/scripts/${id}.sh`;
  }
  // Local / data-dir: path is already host-visible
  return path.join(root, id + '.sh');
};

async function list() {
  const root = await ensure();
  const names = (await fsp.readdir(root).catch(() => [])).filter((n) => n.endsWith('.sh')).sort();
  const out = [];
  for (const n of names) {
    const id = n.replace(/\.sh$/, '');
    let meta = {};
    try { meta = JSON.parse(await fsp.readFile(path.join(root, id + '.json'), 'utf8')); } catch (_) {}
    const st = await fsp.stat(path.join(root, n)).catch(() => null);
    out.push({
      id, name: id, path: displayPath(id, root),
      description: meta.description || '', runAs: meta.runAs || 'root', login: !!meta.login,
      updated: st ? st.mtimeMs : null, bytes: st ? st.size : 0,
    });
  }
  return out;
}

router.get('/', wrap(async (req, res) => {
  const root = await ensure();
  res.json({ scripts: await list(), root: displayPath('…', root).replace('/….sh', '') });
}));

router.get('/:name', wrap(async (req, res) => {
  const id = nameOk(req.params.name);
  const root = await ensure();
  const content = await fsp.readFile(path.join(root, id + '.sh'), 'utf8');
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(root, id + '.json'), 'utf8')); } catch (_) {}
  res.json({ id, content, description: meta.description || '', runAs: meta.runAs || 'root', login: !!meta.login, path: displayPath(id, root) });
}));

router.put('/:name', wrap(async (req, res) => {
  adminOnly(req);
  const id = nameOk(req.params.name);
  const root = await ensure();
  let body = String(req.body.content ?? '');
  if (!body.startsWith('#!')) body = '#!/bin/bash\n' + body;
  await fsp.writeFile(path.join(root, id + '.sh'), body, { mode: 0o755 });
  const runAs = String(req.body.runAs || 'root');
  await lu.get(runAs); // must be a real user (uid >= 1000) or root
  const meta = { description: String(req.body.description || ''), runAs, login: !!req.body.login, updated: new Date().toISOString() };
  await fsp.writeFile(path.join(root, id + '.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
  audit.write({ user: req.session.username, action: 'scripts.save', details: { id } });
  res.json({ ok: true, id, path: displayPath(id, root) });
}));

router.delete('/:name', wrap(async (req, res) => {
  adminOnly(req);
  const id = nameOk(req.params.name);
  const root = await ensure();
  await fsp.unlink(path.join(root, id + '.sh')).catch(() => {});
  await fsp.unlink(path.join(root, id + '.json')).catch(() => {});
  audit.write({ user: req.session.username, action: 'scripts.delete', details: { id } });
  res.json({ ok: true });
}));

// Rename: moves <id>.sh/.json, rewrites cron entries that call the old path
// and home/dock tiles that point at it. run-as and description are kept.
router.post('/:name/rename', wrap(async (req, res) => {
  adminOnly(req);
  const id = nameOk(req.params.name);
  const to = nameOk(String(req.body.newName || '').trim());
  if (to === id) throw bad('That is already the name');
  const root = await ensure();
  await fsp.access(path.join(root, id + '.sh')).catch(() => { throw bad('No such script', 404); });
  if (await fsp.access(path.join(root, to + '.sh')).then(() => true, () => false)) throw bad('A script with that name already exists', 409);
  await fsp.rename(path.join(root, id + '.sh'), path.join(root, to + '.sh'));
  await fsp.rename(path.join(root, id + '.json'), path.join(root, to + '.json')).catch(() => {});
  const oldP = hostPathForRun(id, root), newP = hostPathForRun(to, root);
  const fixed = { cronFiles: [], crontabs: [], layouts: 0 };
  const re = new RegExp(oldP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w.-])', 'g');
  // /etc/cron.d
  const cd = path.join(host.HOST_ROOT, 'etc/cron.d');
  for (const f of await fsp.readdir(cd).catch(() => [])) {
    const fp = path.join(cd, f);
    const t = await fsp.readFile(fp, 'utf8').catch(() => null);
    if (t && re.test(t)) { re.lastIndex = 0; await fsp.writeFile(fp, t.replace(re, newP)); fixed.cronFiles.push(f); }
    re.lastIndex = 0;
  }
  // user crontabs (root + real users)
  for (const u of await lu.list()) {
    const r = await host.run('crontab', ['-u', u.name, '-l'], { timeout: 10000 });
    if (r.code !== 0 || !re.test(r.stdout)) { re.lastIndex = 0; continue; }
    re.lastIndex = 0;
    const w = await host.run('crontab', ['-u', u.name, '-'], { input: r.stdout.replace(re, newP), timeout: 10000 });
    if (w.code === 0) fixed.crontabs.push(u.name);
  }
  // home tiles + dock items of every dashboard user
  const ldir = path.join(auth.DATA_DIR, 'layouts');
  for (const f of await fsp.readdir(ldir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    const fp = path.join(ldir, f);
    try {
      const L = JSON.parse(await fsp.readFile(fp, 'utf8'));
      let n = 0;
      for (const t of [...(L.tiles || []), ...(L.dock || [])]) if (t && t.type === 'script' && t.ref === id) { t.ref = to; if (!t.name || t.name === id) t.name = to; n++; }
      if (n) { await fsp.writeFile(fp, JSON.stringify(L, null, 2), { mode: 0o600 }); fixed.layouts += n; }
    } catch (_) {}
  }
  audit.write({ user: req.session.username, role: req.session.role, ip: req.socket.remoteAddress, action: 'scripts.rename', ok: true, details: { from: id, to, cron: fixed.cronFiles.concat(fixed.crontabs).join(','), tiles: fixed.layouts } });
  res.json({ ok: true, id: to, path: displayPath(to, root), fixed });
}));

// Run: the content is handed to bash directly (bash -c), so the target user never needs
// read/execute access to the scripts folder (root-only 0700 dirs were the
// cause of "Permission denied" for non-root run-as). Clean env, cwd = home (cd inside the host shell).
router.post('/:name/run', wrap(async (req, res) => {
  const id = nameOk(req.params.name);
  const root = await ensure();
  const content = await fsp.readFile(path.join(root, id + '.sh'), 'utf8').catch(() => { throw bad('No such script', 404); });
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(root, id + '.json'), 'utf8')); } catch (_) {}
  const isAdmin = auth.atLeast(req.session.role, 'admin');
  const u = await lu.resolveRunAs(req.session, isAdmin ? String(req.body.runAs || meta.runAs || '') : '');
  // Behave like an SSH session: the user's own shell (bash/zsh, else bash) as an
  // interactive login shell, so ~/.profile, ~/.bash_profile AND ~/.bashrc (nvm,
  // pnpm, conda, ~/.local/bin, aliases) are all loaded. stdin is not a tty; the
  // two "no job control" warnings bash prints for that are filtered out.
  const login = true;
  const sh = /\/(bash|zsh)$/.test(u.shell || '') ? u.shell : '/bin/bash';
  const big = Buffer.byteLength(content) > 100 * 1024;
  const wrap = 'exec 2> >(grep -v -e "cannot set terminal process group" -e "no job control in this shell" -e "^logout$" >&2); exec "$@"';
  const bashArgs = ['/bin/bash', '-c', wrap, 'uiable-run', sh, '-lic', big ? 'eval "$(cat)"' : content, id + '.sh'];
  const [cmd, args] = lu.asUser(u, bashArgs, { UIABLE_SCRIPT: id, TERM: 'xterm-256color' });
  const job = jobs.runHost(`script:${id}`, req.session.username, cmd, args, {
    timeout: 30 * 60 * 1000, input: big ? content : '', cleanEnv: true, env: { PATH: host.HOST_PATH },
    banner: `$ ${id}.sh as ${u.name} (in ${u.home}, ${sh} login shell)\n`,
  });
  audit.write({ user: req.session.username, role: req.session.role, action: 'scripts.run', ok: true, details: { id, runAs: u.name, job: job.id } });
  res.json({ ok: true, job: jobs.view(job), runAs: u.name });
}));

module.exports = router;
