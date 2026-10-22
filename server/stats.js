'use strict';
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const host = require('./host');

const read = (p) => fsp.readFile(p, 'utf8').catch(() => '');

let lastCpu = null;
let lastNet = null;
let staticInfo = null;
let staticAt = 0;
let diskCache = { at: 0, data: null };

function parseCpu(text) {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  const cores = text.split('\n').filter((l) => /^cpu\d+ /.test(l)).map((l) => l.trim().split(/\s+/).slice(1).map(Number));
  const tot = line ? line.trim().split(/\s+/).slice(1).map(Number) : [];
  return { tot, cores };
}
function cpuPct(a, b) {
  if (!a || !b || !a.length) return 0;
  const idle = (v) => (v[3] || 0) + (v[4] || 0);
  const sum = (v) => v.slice(0, 8).reduce((x, y) => x + y, 0);
  const dt = sum(b) - sum(a);
  const di = idle(b) - idle(a);
  return dt > 0 ? Math.max(0, Math.min(100, ((dt - di) / dt) * 100)) : 0;
}

async function cpu() {
  const now = parseCpu(await read(path.join(host.PROC, 'stat')));
  const prev = lastCpu;
  lastCpu = now;
  return {
    usage: prev ? cpuPct(prev.tot, now.tot) : 0,
    cores: now.cores.map((c, i) => (prev && prev.cores[i] ? cpuPct(prev.cores[i], c) : 0)),
  };
}

async function memory() {
  const t = await read(path.join(host.PROC, 'meminfo'));
  const m = {};
  t.split('\n').forEach((l) => { const r = l.match(/^(\w+):\s+(\d+)/); if (r) m[r[1]] = Number(r[2]) * 1024; });
  const total = m.MemTotal || 0;
  const avail = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Cached || 0) + (m.Buffers || 0);
  return {
    total, used: total - avail, available: avail,
    free: m.MemFree || 0, cached: m.Cached || 0, buffers: m.Buffers || 0,
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0),
  };
}

async function network() {
  const t = await read(host.NET_DEV);
  const now = Date.now();
  const ifs = {};
  t.split('\n').slice(2).forEach((l) => {
    const [name, rest] = l.split(':');
    if (!rest) return;
    const v = rest.trim().split(/\s+/).map(Number);
    ifs[name.trim()] = { rx: v[0], tx: v[8] };
  });
  const prev = lastNet;
  lastNet = { at: now, ifs };
  const dt = prev ? (now - prev.at) / 1000 : 0;
  const list = Object.entries(ifs)
    .filter(([n]) => n !== 'lo' && !n.startsWith('veth'))
    .map(([name, v]) => {
      const p = prev && prev.ifs[name];
      return {
        name, rxBytes: v.rx, txBytes: v.tx,
        rxRate: p && dt > 0 ? Math.max(0, (v.rx - p.rx) / dt) : 0,
        txRate: p && dt > 0 ? Math.max(0, (v.tx - p.tx) / dt) : 0,
      };
    });
  const rxRate = list.reduce((a, i) => a + i.rxRate, 0);
  const txRate = list.reduce((a, i) => a + i.txRate, 0);
  return { interfaces: list, rxRate, txRate };
}

async function temps() {
  const out = [];
  const hw = path.join('/sys/class/hwmon');
  try {
    for (const d of await fsp.readdir(hw)) {
      const dir = path.join(hw, d);
      const name = (await read(path.join(dir, 'name'))).trim() || d;
      let files = [];
      try { files = await fsp.readdir(dir); } catch (_) {}
      for (const f of files.filter((x) => /^temp\d+_input$/.test(x))) {
        const v = Number((await read(path.join(dir, f))).trim());
        if (!Number.isFinite(v) || v === 0) continue;
        const label = (await read(path.join(dir, f.replace('_input', '_label')))).trim();
        out.push({ sensor: name, label: label || f.replace('_input', ''), celsius: v / 1000 });
      }
    }
  } catch (_) {}
  if (!out.length) {
    try {
      for (const z of await fsp.readdir('/sys/class/thermal')) {
        if (!z.startsWith('thermal_zone')) continue;
        const v = Number((await read(`/sys/class/thermal/${z}/temp`)).trim());
        if (!Number.isFinite(v) || v === 0) continue;
        const type = (await read(`/sys/class/thermal/${z}/type`)).trim();
        out.push({ sensor: type || z, label: z, celsius: v / 1000 });
      }
    } catch (_) {}
  }
  return out.slice(0, 24);
}

// Disks via /proc/<pid>/mounts + statfs (no `df` process).
// Umbrel/rugix keeps the big user-data disk under /run/rugix/mounts/data while
// / and /run/rugix/mounts/config are tiny — so we must NOT skip /run wholesale,
// and the dashboard card should prefer the largest real block device (or a
// user-chosen primary mount from settings).
const MOUNTS = host.MODE === 'nsenter' ? '/proc/1/mounts' : '/proc/self/mounts';
const MROOT = host.MODE === 'nsenter' ? '/proc/1/root' : '';
const SKIP_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup2?|devpts|mqueue|shm|nsfs|tracefs|debugfs|securityfs|pstore|bpf|configfs|fusectl|hugetlbfs|efivarfs|binfmt_misc|rpc_pipefs|autofs|ramfs|fuse\.lxcfs|fuse\.portal|nfsd|selinuxfs|zram|iso9660)$/;
const SKIP_PATH = /^(?:\/proc|\/sys|\/dev|\/snap|\/var\/lib\/docker|\/var\/lib\/containers|\/boot\/efi)(\/|$)/;
const unescapeMount = (m) => m.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));

/** Prefer real block devices. Allow /run/rugix/mounts/* even if the device string is unusual. */
function isRealDiskMount(dev, mount, type) {
  if (!mount || SKIP_FS.test(type)) return false;
  if (SKIP_PATH.test(mount)) return false;
  // Always keep classic roots and rugix data/config mounts.
  if (mount === '/' || mount.startsWith('/run/rugix/mounts/')) return !SKIP_FS.test(type);
  // Other /run mounts are usually ephemeral — only keep them if they sit on a block device.
  if (mount === '/run' || mount.startsWith('/run/')) {
    return /^\/dev\//.test(dev) && !SKIP_FS.test(type);
  }
  // Prefer mounts backed by a block device (/dev/sdX, /dev/nvme, /dev/mapper, /dev/disk/...).
  if (/^\/dev\//.test(dev)) return true;
  // Bind-mounts of directories sometimes show the source path; keep sized filesystems under /mnt /media /home /data.
  if (/^\/(mnt|media|data|home)(\/|$)/.test(mount)) return true;
  return false;
}

function dataDir() {
  return path.resolve(process.env.UIABLE_DATA_DIR || path.join(__dirname, '..', 'data'));
}
function loadPrimaryPref() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    return cfg.primaryMount || null;
  } catch (_) { return null; }
}
function savePrimaryPref(mount) {
  const file = path.join(dataDir(), 'config.json');
  let cfg = { users: [] };
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  if (mount) cfg.primaryMount = mount; else delete cfg.primaryMount;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  invalidateDisks();
}

/**
 * Collect real disks. `opts` is for tests: { mountsText, statfsFn, primaryMount }.
 * Returns { disks, primary, total: { size, used, avail } }.
 */
async function disks(opts = {}) {
  if (!opts.mountsText && !opts.statfsFn && Date.now() - diskCache.at < 15000 && diskCache.data) {
    return diskCache.data;
  }
  const text = opts.mountsText != null ? opts.mountsText : await read(MOUNTS);
  const statfsFn = opts.statfsFn || ((p) => fsp.statfs(p));
  const byDev = new Map(); // device -> best entry (prefer shorter/more useful mount path)
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [dev, mnt0, type] = line.split(' ');
    if (!mnt0) continue;
    const mount = unescapeMount(mnt0);
    if (!isRealDiskMount(dev, mount, type)) continue;
    try {
      const st = await statfsFn((opts.mountsText != null ? '' : MROOT) + mount);
      const size = Number(st.blocks) * Number(st.bsize);
      if (!size || !Number.isFinite(size)) continue;
      const entry = {
        fs: dev, type, size,
        used: (Number(st.blocks) - Number(st.bfree)) * Number(st.bsize),
        avail: Number(st.bavail) * Number(st.bsize),
        mount,
      };
      const prev = byDev.get(dev);
      // Prefer the "nicer" mount path for the same device: shorter, or /run/rugix/mounts/data, or /.
      if (!prev || scoreMount(entry) > scoreMount(prev)) byDev.set(dev, entry);
    } catch (_) {}
  }
  const disks = [...byDev.values()].sort((a, b) => b.size - a.size || a.mount.localeCompare(b.mount));
  const pref = opts.primaryMount !== undefined ? opts.primaryMount : loadPrimaryPref();
  let primary = (pref && disks.find((d) => d.mount === pref)) || null;
  if (!primary) primary = disks[0] || null; // already largest-first
  // Totals across distinct devices (byDev already deduped).
  const total = disks.reduce((acc, d) => ({
    size: acc.size + d.size, used: acc.used + d.used, avail: acc.avail + d.avail, count: acc.count + 1,
  }), { size: 0, used: 0, avail: 0, count: 0 });
  const result = { disks, primary, total };
  if (!opts.mountsText && !opts.statfsFn) diskCache = { at: Date.now(), data: result };
  return result;
}

function scoreMount(e) {
  let s = 0;
  if (e.mount === '/') s += 50;
  if (e.mount === '/home') s += 40;
  if (/\/run\/rugix\/mounts\/data$/.test(e.mount) || e.mount.endsWith('/data')) s += 80;
  if (/\/run\/rugix\/mounts\/config$/.test(e.mount)) s -= 40; // never prefer config over data for the same pick-path
  // Prefer shorter paths as the "canonical" label for a device.
  s += Math.max(0, 30 - e.mount.length);
  return s;
}

function invalidateDisks() { diskCache = { at: 0, data: null }; }

async function info() {
  if (staticInfo && Date.now() - staticAt < 60000) return staticInfo;
  const osr = await read(path.join(host.HOST_ROOT, 'etc/os-release'));
  const pretty = (osr.match(/^PRETTY_NAME="?([^"\n]*)"?/m) || [])[1] || 'Linux';
  const kernel = (await read('/proc/sys/kernel/osrelease')).trim();
  const cpuinfo = await read('/proc/cpuinfo');
  const model = ((cpuinfo.match(/^(model name|Hardware|Model)\s*:\s*(.+)$/m) || [])[2] || '').trim();
  const arch = require('os').machine ? require('os').machine() : process.arch;
  staticInfo = {
    // compose uses `uts: host`, so this is the host's live hostname
    hostname: (await read('/proc/sys/kernel/hostname')).trim(),
    os: pretty, kernel, arch, cpuModel: model || 'Unknown CPU',
    cpuCount: (cpuinfo.match(/^processor\s*:/gm) || []).length || require('os').cpus().length,
    mode: host.MODE,
  };
  staticAt = Date.now();
  return staticInfo;
}


let lastDiskIo = null;
async function diskIo() {
  const t = await read(path.join(host.PROC, 'diskstats'));
  const now = Date.now();
  const cur = {};
  t.split('\n').forEach((l) => {
    const p = l.trim().split(/\s+/);
    if (p.length < 14) return;
    const name = p[2];
    // Skip partitions (contain digits after letters) and loop/ram
    if (/\d$/.test(name) || name.startsWith('loop') || name.startsWith('ram') || name.startsWith('dm-')) return;
    const readSectors = Number(p[5]) || 0, writeSectors = Number(p[9]) || 0;
    cur[name] = { readBytes: readSectors * 512, writeBytes: writeSectors * 512 };
  });
  const prev = lastDiskIo;
  lastDiskIo = { at: now, disks: cur };
  const dt = prev ? (now - prev.at) / 1000 : 0;
  const list = Object.entries(cur).map(([name, v]) => {
    const p = prev && prev.disks[name];
    return {
      name, readBytes: v.readBytes, writeBytes: v.writeBytes,
      readRate: p && dt > 0 ? Math.max(0, (v.readBytes - p.readBytes) / dt) : 0,
      writeRate: p && dt > 0 ? Math.max(0, (v.writeBytes - p.writeBytes) / dt) : 0,
    };
  });
  return {
    disks: list,
    readRate: list.reduce((a, d) => a + d.readRate, 0),
    writeRate: list.reduce((a, d) => a + d.writeRate, 0),
  };
}

async function snapshot() {
  const [c, m, n, t, diskInfo, i, up, load, dio] = await Promise.all([
    cpu(), memory(), network(), temps(), disks(), info(),
    read('/proc/uptime'), read('/proc/loadavg'), diskIo(),
  ]);
  const la = load.trim().split(/\s+/);
  return {
    time: Date.now(), cpu: c, memory: m, network: n, temps: t,
    disks: diskInfo.disks, primaryDisk: diskInfo.primary, diskTotal: diskInfo.total, diskIo: dio, info: i,
    uptime: Number(up.split(' ')[0]) || 0,
    load: [Number(la[0]) || 0, Number(la[1]) || 0, Number(la[2]) || 0],
    procs: la[3] || '',
  };
}

function invalidateInfo() { staticInfo = null; }

module.exports = { snapshot, invalidateInfo, invalidateDisks, disks, isRealDiskMount, loadPrimaryPref, savePrimaryPref };
