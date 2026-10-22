'use strict';
// One-shot, startup-only data migration. Runs synchronously before anything
// reads DATA_DIR. If DATA_DIR has no accounts yet, look for an older Uiable
// data directory and copy it in (never moves or deletes the source).
//
// Why: before v-fixed-volume, the compose volume was project-scoped
// (<folder>_uiable-data), so starting Uiable from a different folder or with a
// different project name silently created a fresh, empty volume.
const fs = require('fs');
const path = require('path');

const hasUsers = (dir) => {
  try { const c = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8')); return Array.isArray(c.users) && c.users.length > 0; } catch (_) { return false; }
};

function candidates() {
  const hostRoot = process.env.UIABLE_HOST_ROOT || '/host';
  const out = [];
  // Explicit override: UIABLE_MIGRATE_FROM=/host/some/path (or a volume name)
  const extra = (process.env.UIABLE_MIGRATE_FROM || '').split(',').map((s) => s.trim()).filter(Boolean);
  const volRoots = [process.env.UIABLE_DOCKER_VOLUMES || '/var/lib/docker/volumes', '/var/snap/docker/common/var-lib-docker/volumes']
    .map((r) => path.join(hostRoot, r));
  for (const e of extra) {
    if (e.startsWith('/')) out.push(e);
    else for (const r of volRoots) out.push(path.join(r, e, '_data'));
  }
  for (const r of volRoots) {
    let names = [];
    try { names = fs.readdirSync(r); } catch (_) { continue; }
    // uiable_uiable-data, opt_uiable-data, uiable-main_uiable-data, ... and anonymous volumes are skipped
    for (const n of names) if (/uiable.*data/i.test(n) && n !== 'uiable-data') out.push(path.join(r, n, '_data'));
  }
  // Legacy bind-mounted ./data folders
  for (const p of ['/opt/uiable/data', '/var/lib/uiable/data']) out.push(path.join(hostRoot, p));
  return out;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) { fs.copyFileSync(s, d); try { fs.chmodSync(d, fs.statSync(s).mode & 0o777); } catch (_) {} }
  }
}

function run(dataDir) {
  if (process.env.UIABLE_NO_MIGRATE === '1') return null;
  if (hasUsers(dataDir)) return null;
  const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };
  const self = real(dataDir);
  const found = candidates()
    .filter((p) => real(p) !== self && hasUsers(p))
    .map((p) => ({ p, m: fs.statSync(path.join(p, 'config.json')).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!found.length) return null;
  const src = found[0].p;
  try {
    copyDir(src, dataDir);
    const note = { migratedFrom: src, at: new Date().toISOString(), others: found.slice(1).map((f) => f.p) };
    fs.writeFileSync(path.join(dataDir, 'MIGRATED.json'), JSON.stringify(note, null, 2), { mode: 0o600 });
    console.log(`[uiable] Data directory was empty: copied existing data from ${src}` + (note.others.length ? ` (also found: ${note.others.join(', ')})` : ''));
    return note;
  } catch (e) {
    console.error(`[uiable] Found old data at ${src} but could not copy it: ${e.message}`);
    return null;
  }
}

module.exports = { run, candidates, hasUsers };
