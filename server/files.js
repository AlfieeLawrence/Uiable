'use strict';
// SFTP-style file manager over the host filesystem.
const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const Busboy = require('busboy');
const host = require('./host');

const MAX_EDIT = 5 * 1024 * 1024;
const router = express.Router();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function safeName(n) {
  n = String(n || '');
  if (!n || n === '.' || n === '..' || n.includes('/') || n.includes('\0')) throw bad('Invalid name');
  return n;
}

let passwd = { at: 0, users: {}, groups: {} };
async function idMaps() {
  if (Date.now() - passwd.at < 30000) return passwd;
  const users = {}; const groups = {};
  try { (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/passwd'), 'utf8')).split('\n').forEach((l) => { const p = l.split(':'); if (p.length > 2) users[p[2]] = p[0]; }); } catch (_) {}
  try { (await fsp.readFile(path.join(host.HOST_ROOT, 'etc/group'), 'utf8')).split('\n').forEach((l) => { const p = l.split(':'); if (p.length > 2) groups[p[2]] = p[0]; }); } catch (_) {}
  passwd = { at: Date.now(), users, groups };
  return passwd;
}

router.get('/list', wrap(async (req, res) => {
  const { host: hp, local } = host.hostPath(req.query.path || '/');
  const maps = await idMaps();
  const dirents = await fsp.readdir(local, { withFileTypes: true });
  const items = await Promise.all(dirents.map(async (d) => {
    const full = path.join(local, d.name);
    try {
      const st = await fsp.lstat(full);
      let target = null; let targetDir = false;
      if (st.isSymbolicLink()) {
        target = await fsp.readlink(full).catch(() => null);
        if (target) {
          const abs = target.startsWith('/') ? target : path.posix.join(hp, target);
          targetDir = await fsp.stat(host.hostPath(abs).local).then((s) => s.isDirectory()).catch(() => false);
        }
      }
      return {
        name: d.name,
        type: st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : 'other',
        targetDir, target,
        size: st.size, mtime: st.mtimeMs,
        mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
        owner: maps.users[st.uid] || String(st.uid), group: maps.groups[st.gid] || String(st.gid),
      };
    } catch (e) {
      return { name: d.name, type: 'other', size: 0, mtime: 0, mode: '0000', owner: '?', group: '?', error: e.code };
    }
  }));
  items.sort((a, b) => {
    const ad = a.type === 'dir' || a.targetDir; const bd = b.type === 'dir' || b.targetDir;
    return ad === bd ? a.name.localeCompare(b.name) : ad ? -1 : 1;
  });
  res.json({ path: hp, items });
}));

router.get('/download', wrap(async (req, res) => {
  const { host: hp, local } = host.hostPath(req.query.path);
  const st = await fsp.stat(local);
  const base = path.posix.basename(hp) || 'root';
  if (st.isDirectory()) {
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}.tar.gz`);
    const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(local), path.basename(local)]);
    tar.stdout.pipe(res);
    tar.stderr.resume();
    req.on('close', () => tar.kill());
    return;
  }
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}`);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Type', 'application/octet-stream');
  fs.createReadStream(local).on('error', (e) => res.destroy(e)).pipe(res);
}));

router.get('/read', wrap(async (req, res) => {
  const { local } = host.hostPath(req.query.path);
  const st = await fsp.stat(local);
  if (!st.isFile()) throw bad('Not a regular file');
  if (st.size > MAX_EDIT) throw bad('File is too large to edit in the browser (max 5 MB)');
  const buf = await fsp.readFile(local);
  if (buf.subarray(0, 8000).includes(0)) throw bad('This looks like a binary file');
  res.json({ content: buf.toString('utf8'), size: st.size, mtime: st.mtimeMs });
}));

router.post('/write', express.json({ limit: '8mb' }), wrap(async (req, res) => {
  const { local } = host.hostPath(req.body.path);
  if (typeof req.body.content !== 'string') throw bad('Missing content');
  // Resolve symlinks so we rewrite the *target* and leave the link itself alone.
  // Absolute symlink targets are host paths — map them through HOST_ROOT when containerised.
  let target = local;
  let st;
  try {
    const lst = await fsp.lstat(local);
    if (lst.isSymbolicLink()) {
      let dest = await fsp.readlink(local);
      if (!path.isAbsolute(dest)) dest = path.posix.join(path.posix.dirname(req.body.path || '/'), dest);
      // dest is a host path (e.g. /home/box/.bashrc); map into our view
      target = host.hostPath(dest).local;
    }
    st = await fsp.stat(target);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (st && !st.isFile()) throw bad('Not a regular file');
  // Prefer writing in place through the original path when it is a symlink: open follows the link.
  if (st && target !== local) {
    // Write via temp next to the real file, then rename onto the real file (symlink untouched).
    const tmp = target + '.uiable-tmp-' + process.pid;
    await fsp.writeFile(tmp, req.body.content);
    await fsp.chmod(tmp, st.mode & 0o7777);
    try { await fsp.chown(tmp, st.uid, st.gid); } catch (_) {}
    await fsp.rename(tmp, target);
  } else if (st) {
    // Regular file: temp + rename on the same path, preserving owner/mode.
    const tmp = local + '.uiable-tmp-' + process.pid;
    await fsp.writeFile(tmp, req.body.content);
    await fsp.chmod(tmp, st.mode & 0o7777);
    try { await fsp.chown(tmp, st.uid, st.gid); } catch (_) {}
    await fsp.rename(tmp, local);
  } else {
    await fsp.writeFile(local, req.body.content);
  }
  res.json({ ok: true, preserved: st ? { uid: st.uid, gid: st.gid, mode: (st.mode & 0o7777).toString(8) } : null });
}));

router.post('/mkdir', express.json(), wrap(async (req, res) => {
  const parts = req.body.recursive ? String(req.body.name || '').split('/').filter(Boolean).map(safeName) : [safeName(req.body.name)];
  if (!parts.length) throw bad('Invalid name');
  const { local } = host.hostPath(path.posix.join(req.body.path || '/', ...parts));
  await fsp.mkdir(local, { recursive: !!req.body.recursive });
  res.json({ ok: true });
}));

router.post('/touch', express.json(), wrap(async (req, res) => {
  const { local } = host.hostPath(path.posix.join(req.body.path || '/', safeName(req.body.name)));
  await fsp.writeFile(local, '', { flag: 'wx' });
  res.json({ ok: true });
}));

router.post('/rename', express.json(), wrap(async (req, res) => {
  const from = host.hostPath(req.body.from);
  const to = host.hostPath(req.body.to);
  if (from.host === '/') throw bad('Refusing to rename /');
  try { await fsp.access(to.local); throw bad('Destination already exists', 409); } catch (e) { if (e.status) throw e; }
  await fsp.rename(from.local, to.local);
  res.json({ ok: true });
}));

router.post('/delete', express.json(), wrap(async (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [req.body.path];
  for (const p of paths) {
    const { host: hp, local } = host.hostPath(p);
    if (hp === '/' || hp === '') throw bad('Refusing to delete /');
    await fsp.rm(local, { recursive: true, force: false });
  }
  res.json({ ok: true });
}));

router.post('/chmod', express.json(), wrap(async (req, res) => {
  const { local } = host.hostPath(req.body.path);
  const m = String(req.body.mode || '');
  if (!/^[0-7]{3,4}$/.test(m)) throw bad('Mode must be octal, e.g. 755 or 0644');
  const mode = parseInt(m, 8);
  if (req.body.recursive) {
    const walk = async (p) => {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) return;
      await fsp.chmod(p, mode);
      if (st.isDirectory()) for (const n of await fsp.readdir(p)) await walk(path.join(p, n));
    };
    await walk(local);
  } else {
    await fsp.chmod(local, mode);
  }
  res.json({ ok: true });
}));

// Multipart upload. Each file's "filename" may contain a relative path
// (e.g. "photos/2024/a.jpg") so whole folders can be dropped in.
router.post('/upload', (req, res, next) => {
  let target;
  try { target = host.hostPath(req.query.path || '/'); } catch (e) { return next(e); }
  let bb;
  try { bb = Busboy({ headers: req.headers, preservePath: true, limits: { fileSize: Number(process.env.UIABLE_MAX_UPLOAD || 0) || Infinity } }); } catch (e) { return next(bad(e.message)); }
  const pending = [];
  const saved = [];
  let failed = null;
  const overwrite = req.query.overwrite === '1';
  // Uploads inside the uploader's linked Linux user's home are owned by that user.
  const lu = require('./linuxusers');
  const bound = lu.boundOf(req.session);
  const ownerP = bound ? lu.get(bound).catch(() => null) : Promise.resolve(null);
  const chownTo = async (localFile, firstNewDir) => {
    const o = await ownerP;
    if (!o || o.uid === 0) return;
    const hp = localFile.slice(host.HOST_ROOT === '/' ? 0 : host.HOST_ROOT.length) || '/';
    if (!(hp === o.home || hp.startsWith(o.home.replace(/\/$/, '') + '/'))) return;
    const chain = [localFile];
    if (firstNewDir) for (let d = path.dirname(localFile); d.length >= firstNewDir.length; d = path.dirname(d)) chain.push(d);
    for (const p of chain) await fsp.chown(p, o.uid, o.gid).catch(() => {});
  };
  bb.on('file', (_field, stream, info) => {
    const rel = String(info.filename || '').replace(/\\/g, '/');
    const parts = rel.split('/').filter((x) => x && x !== '.');
    if (!parts.length || parts.some((x) => x === '..')) { stream.resume(); failed = failed || bad('Invalid file name: ' + rel); return; }
    let dest;
    try { dest = host.hostPath(path.posix.join(target.host, ...parts)); } catch (e) { stream.resume(); failed = e; return; }
    const p = (async () => {
      const firstNew = await fsp.mkdir(path.dirname(dest.local), { recursive: true });
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(dest.local, { flags: overwrite ? 'w' : 'wx' });
        ws.on('error', (e) => { stream.resume(); reject(e.code === 'EEXIST' ? bad(`${parts.join('/')} already exists`, 409) : e); });
        ws.on('finish', resolve);
        stream.on('limit', () => reject(bad('File too large', 413)));
        stream.pipe(ws);
      });
      await chownTo(dest.local, firstNew);
      saved.push(dest.host);
    })().catch((e) => { failed = failed || e; });
    pending.push(p);
  });
  bb.on('error', (e) => { failed = failed || e; });
  bb.on('close', async () => {
    await Promise.all(pending);
    if (failed) return next(Object.assign(failed, { saved }));
    res.json({ ok: true, saved });
  });
  req.pipe(bb);
});

module.exports = router;
