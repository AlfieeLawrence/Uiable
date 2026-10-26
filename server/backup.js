'use strict';
// Backup orchestration: restic (preferred) or rsync profiles in DATA_DIR/backups.json.
// Secrets (restic password, S3/B2 keys) live in encrypted secrets.env.enc — never in backups.json.
const express = require('express');
const fs = require('fs');
const path = require('path');
const host = require('./host');
const jobs = require('./jobs');
const audit = require('./audit');
const secrets = require('./secrets');

const router = express.Router();
router.use(express.json({ limit: '1mb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

let FILE = null;
let state = { profiles: [] };

function init(dataDir) {
  FILE = path.join(dataDir, 'backups.json');
  try { state = Object.assign({ profiles: [] }, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (_) {}
  // Migrate any leftover plaintext passwords out of backups.json when secrets can unlock
  const hadPlain = (state.profiles || []).some((p) => p.password || p.awsSecretAccessKey || p.b2Key);
  if (hadPlain) {
    secrets.migrateFromBackupProfiles(state.profiles, null).then((r) => {
      if (r.moved) { save(); console.log('[backup] migrated', r.moved, 'secret(s) → secrets.env.enc'); }
    }).catch((e) => {
      console.error('[backup] secrets migrate deferred:', e.message);
      // Strip plaintext from disk even if encrypt failed — require re-entry via UI
      let stripped = 0;
      for (const p of state.profiles) {
        if (p.password || p.awsSecretAccessKey || p.b2Key) {
          delete p.password; delete p.awsSecretAccessKey; delete p.b2Key;
          stripped += 1;
        }
      }
      if (stripped) {
        save();
        console.error('[backup] stripped', stripped, 'plaintext secret(s) from backups.json — re-enter via UI after secrets unlock');
      }
    });
  }
}
function save() {
  // Never persist password fields
  for (const p of state.profiles || []) {
    delete p.password; delete p.awsSecretAccessKey; delete p.b2Key;
  }
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
function publicProfiles() {
  return (state.profiles || []).map((p) => ({
    id: p.id, name: p.name, kind: p.kind, source: p.source, dest: p.dest,
    schedule: p.schedule || null, exclude: p.exclude || [],
    passwordEnv: p.passwordEnv || null,
    secrets: secrets.configuredFlags(p.id),
    hasPassword: !!(secrets.configuredFlags(p.id).resticPassword || p.passwordEnv),
    lastRun: p.lastRun || null, lastStatus: p.lastStatus || null,
  }));
}
function find(id) { return state.profiles.find((p) => p.id === id); }

router.get('/', wrap(async (req, res) => {
  const restic = await host.has('restic');
  const rsync = await host.has('rsync');
  res.json({
    available: restic || rsync, restic, rsync, profiles: publicProfiles(),
    secrets: secrets.status(),
  });
}));

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  const kind = b.kind === 'rsync' ? 'rsync' : 'restic';
  if (!(await host.has(kind))) throw bad(kind + ' is not installed on the host', 501);
  const name = String(b.name || '').trim().slice(0, 64) || 'backup';
  const source = String(b.source || '').trim();
  const dest = String(b.dest || '').trim();
  if (!source || !dest) throw bad('source and dest required');
  if (/\n|\0/.test(source + dest)) throw bad('Invalid path');
  const id = 'bk_' + Date.now().toString(36);
  const profile = {
    id, name, kind, source, dest,
    exclude: Array.isArray(b.exclude) ? b.exclude.map(String).slice(0, 50) : [],
    passwordEnv: kind === 'restic' ? String(b.passwordEnv || '') : '',
    schedule: b.schedule || null,
    created: new Date().toISOString(),
  };
  state.profiles.push(profile);
  save();
  // Store restic password / cloud keys in encrypted secrets — never in backups.json
  if (kind === 'restic' && b.password) {
    const key = secrets.backupSecretKey(id, 'restic');
    try {
      await secrets.setMany({ [key]: String(b.password) }, b.passphrase || null);
    } catch (e) {
      // Profile kept; operator must unlock secrets and set password
      audit.write({ user: req.session.username, action: 'backup.create', details: { id, name, kind, secretsDeferred: e.message } });
      return res.status(201).json({
        ok: true, profile: publicProfiles().find((p) => p.id === id),
        warning: 'Profile saved but password not stored: ' + e.message + '. Unlock secrets then set password.',
      });
    }
  }
  if (b.awsSecretAccessKey) {
    await secrets.setMany({ [secrets.backupSecretKey(id, 'aws')]: String(b.awsSecretAccessKey) }, b.passphrase || null).catch(() => {});
  }
  audit.write({ user: req.session.username, action: 'backup.create', details: { id, name, kind } });
  res.json({ ok: true, profile: publicProfiles().find((p) => p.id === id) });
}));

router.put('/:id/secrets', wrap(async (req, res) => {
  const p = find(req.params.id);
  if (!p) throw bad('No such profile', 404);
  const b = req.body || {};
  const updates = {};
  if (b.password != null) updates[secrets.backupSecretKey(p.id, 'restic')] = b.password;
  if (b.awsSecretAccessKey != null) updates[secrets.backupSecretKey(p.id, 'aws')] = b.awsSecretAccessKey;
  if (b.b2Key != null) updates[secrets.backupSecretKey(p.id, 'b2')] = b.b2Key;
  if (!Object.keys(updates).length) throw bad('No secrets provided');
  await secrets.setMany(updates, b.passphrase || null);
  audit.write({ user: req.session.username, action: 'backup.secrets.set', details: { id: p.id, keys: Object.keys(updates).map((k) => k.replace(/_[A-Z0-9]+$/, '_…')) } });
  res.json({ ok: true, profile: publicProfiles().find((x) => x.id === p.id) });
}));

router.delete('/:id', wrap(async (req, res) => {
  const i = state.profiles.findIndex((p) => p.id === req.params.id);
  if (i < 0) throw bad('No such profile', 404);
  const [gone] = state.profiles.splice(i, 1);
  save();
  // Clear associated secrets
  try {
    await secrets.setMany({
      [secrets.backupSecretKey(gone.id, 'restic')]: '',
      [secrets.backupSecretKey(gone.id, 'aws')]: '',
      [secrets.backupSecretKey(gone.id, 'b2')]: '',
    }, null);
  } catch (_) {}
  audit.write({ user: req.session.username, action: 'backup.delete', details: { id: gone.id, name: gone.name } });
  res.json({ ok: true });
}));

router.post('/:id/run', wrap(async (req, res) => {
  const p = find(req.params.id);
  if (!p) throw bad('No such profile', 404);
  const job = jobs.runFn('Backup ' + p.name, req.session.username, async (append) => {
    append('Starting ' + p.kind + ' backup: ' + p.source + ' -> ' + p.dest + '\n');
    let r;
    if (p.kind === 'restic') {
      const env = secrets.envForBackup(p);
      if (!env.RESTIC_PASSWORD && !p.passwordEnv) {
        throw new Error('Restic password not configured — unlock secrets and set password for this profile');
      }
      const args = ['backup', p.source, '-r', p.dest];
      for (const ex of p.exclude || []) args.push('--exclude', ex);
      r = await host.run('restic', args, { timeout: 60 * 60 * 1000, env });
    } else {
      const args = ['-aH', '--delete', '--info'];
      for (const ex of p.exclude || []) args.push('--exclude', ex);
      args.push(p.source.endsWith('/') ? p.source : p.source + '/', p.dest);
      r = await host.run('rsync', args, { timeout: 60 * 60 * 1000 });
    }
    append((r.stdout || '') + (r.stderr || ''));
    if (r.code !== 0) throw new Error(p.kind + ' exited ' + r.code);
    p.lastRun = new Date().toISOString();
    p.lastStatus = 'ok';
    save();
  });
  audit.write({ user: req.session.username, action: 'backup.run', details: { id: p.id, name: p.name, job: job.id } });
  res.json({ ok: true, job: jobs.view(job) });
}));

router.get('/:id/snapshots', wrap(async (req, res) => {
  const p = find(req.params.id);
  if (!p) throw bad('No such profile', 404);
  if (p.kind !== 'restic') return res.json({ available: false, message: 'Snapshots only for restic profiles', snapshots: [] });
  const env = secrets.envForBackup(p);
  const r = await host.run('restic', ['snapshots', '-r', p.dest, '--json'], { timeout: 120000, env });
  if (r.code !== 0) throw bad((r.stderr || r.stdout || 'restic failed').trim(), 500);
  let snapshots = [];
  try { snapshots = JSON.parse(r.stdout || '[]'); } catch (_) {}
  res.json({ available: true, snapshots });
}));

module.exports = Object.assign(router, { init });
