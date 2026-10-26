'use strict';
// Disks, SMART, mount/unmount, format (typed confirm), and folder usage (du).
const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const jobs = require('./jobs');
const audit = require('./audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fail = (r, what) => bad(`${what}: ${(r.stderr || r.stdout || 'exit ' + r.code).trim()}`, 500);

router.get('/disks', wrap(async (req, res) => {
  // Prefer lsblk JSON; fall back to /sys/block.
  let disks = [];
  const r = await host.run('lsblk', ['-J', '-b', '-o', 'NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINT,MODEL,SERIAL,TRAN,ROTA,UUID,LABEL'], { timeout: 10000 });
  if (r.code === 0) {
    try {
      const j = JSON.parse(r.stdout);
      const flat = (arr, parent) => (arr || []).flatMap((d) => {
        const node = {
          name: d.name, path: d.path || '/dev/' + d.name, size: Number(d.size) || 0, type: d.type, fstype: d.fstype || '',
          mount: d.mountpoint || '', model: d.model || parent?.model || '', serial: d.serial || parent?.serial || '',
          tran: d.tran || parent?.tran || '', rotational: d.rota === '1' || d.rota === true, uuid: d.uuid || '', label: d.label || '',
          children: [],
        };
        node.children = flat(d.children, node);
        return [node];
      });
      disks = flat(j.blockdevices);
    } catch (_) {}
  }
  res.json({ disks });
}));

router.get('/smart/:dev', wrap(async (req, res) => {
  const dev = String(req.params.dev).replace(/[^a-zA-Z0-9\/_\-]/g, '');
  if (!dev.startsWith('/dev/')) throw bad('Device must be under /dev');
  if (!(await host.has('smartctl'))) return res.json({ available: false, message: 'smartctl (smartmontools) is not installed on the host.' });
  const health = await host.run('smartctl', ['-H', '-j', dev], { timeout: 30000 });
  const info = await host.run('smartctl', ['-i', '-A', '-j', dev], { timeout: 30000 });
  let healthJ = {}, infoJ = {};
  try { healthJ = JSON.parse(health.stdout); } catch (_) {}
  try { infoJ = JSON.parse(info.stdout); } catch (_) {}
  res.json({
    available: true,
    healthy: healthJ.smart_status?.passed ?? null,
    model: infoJ.model_name || infoJ.device?.model_name,
    serial: infoJ.serial_number,
    temp: infoJ.temperature?.current,
    attributes: (infoJ.ata_smart_attributes?.table || []).map((a) => ({ id: a.id, name: a.name, value: a.value, worst: a.worst, raw: a.raw?.value, whenFailed: a.when_failed })),
    raw: { health: health.stdout.slice(0, 2000), info: info.stdout.slice(0, 4000) },
  });
}));

router.get('/usage', wrap(async (req, res) => {
  const { host: hp, local } = host.hostPath(req.query.path || '/');
  // Prefer native readdir+stat (no du spawn) for one level; fall back to du -x -d 1 for huge dirs if needed.
  const ents = await fsp.readdir(local, { withFileTypes: true });
  const items = await Promise.all(ents.slice(0, 500).map(async (e) => {
    const full = path.join(local, e.name);
    try {
      if (e.isDirectory() && !e.isSymbolicLink()) {
        // shallow size: sum immediate children only for speed; for a proper total use du below
        return { name: e.name, type: 'dir', size: null };
      }
      const st = await fsp.lstat(full);
      return { name: e.name, type: e.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : 'file', size: st.size };
    } catch (_) { return { name: e.name, type: 'other', size: 0 }; }
  }));
  // Fill directory totals with one `du` call (single spawn for the whole listing).
  const du = await host.run('du', ['-x', '-B1', '-d', '1', hp], { timeout: 120000 });
  const sizes = {};
  du.stdout.split('\n').forEach((l) => {
    const m = l.match(/^(\d+)\s+(.+)$/);
    if (!m) return;
    const p = m[2].replace(/\/$/, '');
    const base = p === hp ? '.' : p.slice(hp.length).replace(/^\//, '');
    if (base && !base.includes('/')) sizes[base] = Number(m[1]);
    if (base === '.') sizes['.'] = Number(m[1]);
  });
  items.forEach((i) => { if (i.type === 'dir' && sizes[i.name] != null) i.size = sizes[i.name]; });
  items.sort((a, b) => (b.size || 0) - (a.size || 0));
  res.json({ path: hp, total: sizes['.'] || null, items });
}));

router.get('/fstab', wrap(async (req, res) => {
  const text = await fsp.readFile(path.join(host.HOST_ROOT, 'etc/fstab'), 'utf8').catch(() => '');
  res.json({ text });
}));

router.post('/mount', wrap(async (req, res) => {
  const device = String(req.body.device || '');
  const target = String(req.body.target || '');
  const fstype = String(req.body.fstype || '');
  if (!device.startsWith('/dev/') || !target.startsWith('/')) throw bad('device and target required');
  await fsp.mkdir(host.hostPath(target).local, { recursive: true });
  const args = [device, target];
  if (fstype) args.unshift('-t', fstype);
  const r = await host.run('mount', args, { timeout: 60000 });
  if (r.code !== 0) throw fail(r, 'mount');
  if (req.body.fstab) {
    const opts = String(req.body.opts || 'defaults');
    const line = `${device}\t${target}\t${fstype || 'auto'}\t${opts}\t0\t2\n`;
    const fstab = path.join(host.HOST_ROOT, 'etc/fstab');
    const cur = await fsp.readFile(fstab, 'utf8').catch(() => '');
    if (!cur.split('\n').some((l) => l.trim().startsWith(device) && l.includes(target))) {
      await fsp.appendFile(fstab, (cur.endsWith('\n') || !cur ? '' : '\n') + line);
    }
  }
  audit.write({ user: req.session.username, action: 'storage.mount', details: { device, target } });
  res.json({ ok: true });
}));

router.post('/unmount', wrap(async (req, res) => {
  const target = String(req.body.target || '');
  if (!target.startsWith('/') || target === '/') throw bad('Refusing to unmount /');
  const r = await host.run('umount', [target], { timeout: 60000 });
  if (r.code !== 0) throw fail(r, 'umount');
  audit.write({ user: req.session.username, action: 'storage.unmount', details: { target } });
  res.json({ ok: true });
}));

router.post('/format', wrap(async (req, res) => {
  const device = String(req.body.device || '');
  const fstype = String(req.body.fstype || 'ext4');
  const confirm = String(req.body.confirm || '');
  if (!device.startsWith('/dev/')) throw bad('Device must be under /dev');
  if (!['ext4', 'ext3', 'xfs', 'btrfs', 'vfat', 'ntfs'].includes(fstype)) throw bad('Unsupported filesystem');
  // Typed confirmation must match the device path exactly.
  if (confirm !== device) throw bad(`Type the device path exactly (${device}) to confirm`);
  // Refuse if mounted
  const mounts = await fsp.readFile(host.MODE === 'nsenter' ? '/proc/1/mounts' : '/proc/self/mounts', 'utf8');
  if (mounts.split('\n').some((l) => l.startsWith(device + ' '))) throw bad('Device is mounted. Unmount it first.');
  const mkfs = fstype === 'vfat' ? 'mkfs.vfat' : fstype === 'ntfs' ? 'mkfs.ntfs' : `mkfs.${fstype}`;
  const job = jobs.runHost(`Format ${device} as ${fstype}`, req.session.username, mkfs, fstype === 'ext4' || fstype === 'ext3' ? ['-F', device] : [device], { timeout: 60 * 60 * 1000 });
  audit.write({ user: req.session.username, action: 'storage.format', details: { device, fstype, job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));


router.get('/raid', wrap(async (req, res) => {
  const out = { mdadm: { available: false, arrays: [] }, zfs: { available: false, pools: [], datasets: [] } };
  if (await host.has('mdadm')) {
    out.mdadm.available = true;
    const d = await host.run('mdadm', ['--detail', '--scan'], { timeout: 15000 });
    const detail = await host.run('cat', ['/proc/mdstat'], { timeout: 5000 });
    out.mdadm.scan = (d.stdout || '').trim();
    out.mdadm.mdstat = (detail.stdout || '').trim();
    const arrays = [];
    for (const line of (detail.stdout || '').split('\n')) {
      const m = line.match(/^(md\d+)\s*:\s*(\w+)\s+(\w+)\s*(.*)$/);
      if (m) arrays.push({ name: m[1], status: m[2], level: m[3], devices: m[4].trim() });
    }
    out.mdadm.arrays = arrays;
  }
  if (await host.has('zpool')) {
    out.zfs.available = true;
    const pools = await host.run('zpool', ['list', '-H', '-o', 'name,size,alloc,free,health,frag'], { timeout: 15000 });
    out.zfs.pools = (pools.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
      const p = l.split('\t');
      return { name: p[0], size: p[1], alloc: p[2], free: p[3], health: p[4], frag: p[5] };
    });
    if (await host.has('zfs')) {
      const ds = await host.run('zfs', ['list', '-H', '-o', 'name,used,avail,refer,mountpoint'], { timeout: 15000 });
      out.zfs.datasets = (ds.stdout || '').trim().split('\n').filter(Boolean).map((l) => {
        const p = l.split('\t');
        return { name: p[0], used: p[1], avail: p[2], refer: p[3], mountpoint: p[4] };
      });
    }
  }
  res.json(out);
}));



// Safe RAID/ZFS actions only — no create/destroy.
router.post('/raid/mdadm/:name/start', wrap(async (req, res) => {
  const name = String(req.params.name || '');
  if (!/^md\d+$/.test(name)) throw bad('Bad array name');
  if (!(await host.has('mdadm'))) throw bad('mdadm not available', 501);
  const dev = '/dev/' + name;
  const r = await host.run('mdadm', ['--run', dev], { timeout: 60000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'mdadm --run failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'storage.raid.start', details: { name } });
  res.json({ ok: true, stdout: (r.stdout || '').trim() });
}));

router.post('/raid/mdadm/:name/stop', wrap(async (req, res) => {
  const name = String(req.params.name || '');
  if (!/^md\d+$/.test(name)) throw bad('Bad array name');
  if (!(await host.has('mdadm'))) throw bad('mdadm not available', 501);
  const confirm = String((req.body && req.body.confirm) || '');
  if (confirm !== name) throw bad('Confirm by sending { "confirm": "' + name + '" }', 400);
  const dev = '/dev/' + name;
  const r = await host.run('mdadm', ['--stop', dev], { timeout: 60000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'mdadm --stop failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'storage.raid.stop', details: { name } });
  res.json({ ok: true, stdout: (r.stdout || '').trim() });
}));

router.post('/raid/zfs/:pool/scrub', wrap(async (req, res) => {
  const pool = String(req.params.pool || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pool)) throw bad('Bad pool name');
  if (!(await host.has('zpool'))) throw bad('zpool not available', 501);
  const r = await host.run('zpool', ['scrub', pool], { timeout: 60000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'zpool scrub failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'storage.zfs.scrub', details: { pool } });
  res.json({ ok: true, stdout: (r.stdout || '').trim() });
}));

router.post('/raid/zfs/:pool/scrub-stop', wrap(async (req, res) => {
  const pool = String(req.params.pool || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(pool)) throw bad('Bad pool name');
  if (!(await host.has('zpool'))) throw bad('zpool not available', 501);
  const r = await host.run('zpool', ['scrub', '-s', pool], { timeout: 60000 });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'zpool scrub -s failed').trim(), 500);
  audit.write({ user: req.session.username, action: 'storage.zfs.scrub_stop', details: { pool } });
  res.json({ ok: true });
}));

module.exports = router;

