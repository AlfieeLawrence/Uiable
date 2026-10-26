'use strict';
// Firewall: prefer UFW, else nftables, else iptables. Safeguard SSH (22) and the Uiable port.
const express = require('express');
const host = require('./host');
const ports = require('./ports');
const audit = require('./audit');

const router = express.Router();
router.use(express.json());
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const fail = (r, what) => bad(`${what}: ${(r.stderr || r.stdout || 'exit ' + r.code).trim()}`, 500);

const UIABLE_PORT = () => Number(process.env.UIABLE_PORT || 8080);

function touchesProtected(spec) {
  // Returns a reason string if the rule would block SSH or Uiable, else null.
  const s = String(spec).toLowerCase();
  const ui = UIABLE_PORT();
  // deny/drop/reject involving port 22 or uiable port, without an explicit allow elsewhere in the same rule
  const isDeny = /\b(deny|drop|reject)\b/.test(s) || (!/\b(allow|accept)\b/.test(s) && /\bdelete\b/.test(s));
  if (!isDeny && !/\b(deny|drop|reject|delete)\b/.test(s)) {
    // ufw delete <num> handled separately
  }
  const portMatch = (p) => new RegExp(`(?:^|[\\s:,/])${p}(?:$|[\\s:,/])`).test(s) || s.includes(`port ${p}`) || s.endsWith(`/${p}`) || s.includes(`:${p}`);
  if (/\b(deny|drop|reject)\b/.test(s) || /\bdelete\b/.test(s)) {
    if (portMatch(22) || /\bssh\b/.test(s)) return 'This would block SSH (port 22) and could lock you out.';
    if (portMatch(ui)) return `This would block Uiable (port ${ui}) and lock you out of this dashboard.`;
  }
  return null;
}

async function backend() {
  if (await host.has('ufw')) {
    const s = await host.run('ufw', ['status'], { timeout: 8000 });
    if (s.code === 0 || /Status:/.test(s.stdout)) return 'ufw';
  }
  if (await host.has('nft')) {
    const s = await host.run('nft', ['list', 'ruleset'], { timeout: 8000 });
    if (s.code === 0) return 'nft';
  }
  if (await host.has('iptables')) return 'iptables';
  return null;
}

router.get('/', wrap(async (req, res) => {
  const kind = await backend();
  const listening = await ports.listening();
  if (!kind) return res.json({ available: false, message: 'No UFW, nftables or iptables found on this host.', listening, protected: { ssh: 22, uiable: UIABLE_PORT() } });
  let status = '', rules = [], active = false;
  if (kind === 'ufw') {
    const r = await host.run('ufw', ['status', 'numbered'], { timeout: 10000 });
    status = r.stdout;
    active = /Status:\s*active/i.test(status);
    rules = status.split('\n').map((l) => {
      const m = l.match(/^\[\s*(\d+)\]\s+(.+)/);
      return m ? { id: m[1], text: m[2].trim() } : null;
    }).filter(Boolean);
  } else if (kind === 'nft') {
    const r = await host.run('nft', ['-a', 'list', 'ruleset'], { timeout: 15000 });
    status = r.stdout;
    active = /hook (input|forward)/i.test(status);
    rules = status.split('\n').filter((l) => /\b(accept|drop|reject)\b/.test(l)).map((l, i) => ({ id: String(i + 1), text: l.trim() }));
  } else {
    const r = await host.run('iptables', ['-L', '-n', '-v', '--line-numbers'], { timeout: 15000 });
    status = r.stdout;
    active = /Chain INPUT/.test(status);
    rules = status.split('\n').filter((l) => /^\d+\s/.test(l.trim())).map((l) => {
      const p = l.trim().split(/\s+/);
      return { id: p[0], text: l.trim() };
    });
  }
  res.json({ available: true, backend: kind, active, rules, status, listening, protected: { ssh: 22, uiable: UIABLE_PORT() } });
}));

router.post('/enable', wrap(async (req, res) => {
  const kind = await backend();
  if (kind !== 'ufw') throw bad('Enable/disable is only supported with UFW. Manage nft/iptables rules individually.', 501);
  // Make sure SSH and Uiable are allowed before enabling.
  await host.run('ufw', ['allow', '22/tcp'], { timeout: 10000 });
  await host.run('ufw', ['allow', `${UIABLE_PORT()}/tcp`], { timeout: 10000 });
  const r = await host.run('ufw', ['--force', 'enable'], { timeout: 15000 });
  if (r.code !== 0) throw fail(r, 'ufw enable');
  audit.write({ user: req.session.username, action: 'firewall.enable' });
  res.json({ ok: true, output: r.stdout });
}));

router.post('/disable', wrap(async (req, res) => {
  const kind = await backend();
  if (kind !== 'ufw') throw bad('Enable/disable is only supported with UFW.', 501);
  const r = await host.run('ufw', ['--force', 'disable'], { timeout: 15000 });
  if (r.code !== 0) throw fail(r, 'ufw disable');
  audit.write({ user: req.session.username, action: 'firewall.disable' });
  res.json({ ok: true });
}));

router.post('/rule', wrap(async (req, res) => {
  const kind = await backend();
  const action = String(req.body.action || ''); // allow|deny|delete
  const spec = String(req.body.spec || ''); // e.g. "80/tcp" or "from 1.2.3.4 to any port 22"
  if (!['allow', 'deny', 'delete', 'reject'].includes(action)) throw bad('action must be allow, deny, reject or delete');
  // Safeguard
  if (action === 'delete') {
    // Look up the rule text for UFW numbered deletes
    if (kind === 'ufw' && /^\d+$/.test(spec)) {
      const cur = await host.run('ufw', ['status', 'numbered'], { timeout: 10000 });
      const line = cur.stdout.split('\n').find((l) => l.match(new RegExp(`^\\[\\s*${spec}\\]`)));
      if (line) {
        const reason = touchesProtected('delete ' + line);
        if (reason) throw bad(reason, 403);
      }
    }
  } else {
    const reason = touchesProtected(`${action} ${spec}`);
    if (reason) throw bad(reason, 403);
  }
  // Also block deny of bare "22" or uiable port via structured fields
  const port = Number(req.body.port);
  if (port === 22 || port === UIABLE_PORT()) {
    if (action === 'deny' || action === 'reject') throw bad(port === 22 ? 'Refusing to block SSH (port 22).' : `Refusing to block Uiable (port ${port}).`, 403);
  }

  let r;
  if (kind === 'ufw') {
    if (action === 'delete') r = await host.run('ufw', ['--force', 'delete', spec], { timeout: 15000 });
    else {
      const args = [action];
      if (req.body.direction === 'out') args.push('out');
      if (spec) args.push(...spec.split(/\s+/));
      else if (port) args.push(`${port}/${req.body.proto || 'tcp'}`);
      else throw bad('spec or port required');
      r = await host.run('ufw', args, { timeout: 15000 });
    }
  } else if (kind === 'iptables') {
    if (action === 'delete') r = await host.run('iptables', ['-D', 'INPUT', spec], { timeout: 15000 });
    else {
      const chain = req.body.chain || 'INPUT';
      const jump = action === 'allow' ? 'ACCEPT' : action === 'reject' ? 'REJECT' : 'DROP';
      const args = ['-A', chain];
      if (port) args.push('-p', req.body.proto || 'tcp', '--dport', String(port));
      if (req.body.source) args.push('-s', String(req.body.source));
      args.push('-j', jump);
      r = await host.run('iptables', args, { timeout: 15000 });
    }
  } else {
    throw bad('Adding rules via the UI is only supported for UFW and iptables. Use the terminal for nftables.', 501);
  }
  if (r.code !== 0) throw fail(r, 'firewall');
  audit.write({ user: req.session.username, action: 'firewall.rule', details: { action, spec, port } });
  res.json({ ok: true, output: r.stdout });
}));


// ---- fail2ban ----
async function fail2banAvailable() {
  return host.has('fail2ban-client');
}

router.get('/fail2ban', wrap(async (req, res) => {
  if (!(await fail2banAvailable())) {
    return res.json({ available: false, message: 'fail2ban-client not found on this host.', jails: [] });
  }
  const st = await host.run('fail2ban-client', ['status'], { timeout: 10000 });
  if (st.code !== 0) throw fail(st, 'fail2ban-client status');
  const jails = [];
  const m = st.stdout.match(/Jail list:\s*(.*)/i);
  const names = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
  for (const name of names) {
    const j = await host.run('fail2ban-client', ['status', name], { timeout: 10000 });
    const banned = [];
    const bm = j.stdout.match(/Banned IP list:\s*(.*)/i);
    if (bm) banned.push(...bm[1].split(/\s+/).map((s) => s.trim()).filter(Boolean));
    const fc = (j.stdout.match(/Currently failed:\s*(\d+)/i) || [])[1];
    const bc = (j.stdout.match(/Currently banned:\s*(\d+)/i) || [])[1];
    jails.push({ name, failed: Number(fc) || 0, bannedCount: Number(bc) || banned.length, banned });
  }
  res.json({ available: true, jails, raw: st.stdout.trim() });
}));

router.post('/fail2ban/unban', wrap(async (req, res) => {
  if (!(await fail2banAvailable())) throw bad('fail2ban not available', 501);
  const jail = String(req.body.jail || '').trim();
  const ip = String(req.body.ip || '').trim();
  if (!/^[\w.-]+$/.test(jail)) throw bad('Bad jail');
  if (!/^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+$/i.test(ip)) throw bad('Bad IP');
  const r = await host.run('fail2ban-client', ['set', jail, 'unbanip', ip], { timeout: 10000 });
  if (r.code !== 0) throw fail(r, 'unban');
  audit.write({ user: req.session.username, action: 'fail2ban.unban', details: { jail, ip } });
  res.json({ ok: true, output: r.stdout.trim() });
}));

router.post('/fail2ban/ban', wrap(async (req, res) => {
  if (!(await fail2banAvailable())) throw bad('fail2ban not available', 501);
  const jail = String(req.body.jail || '').trim();
  const ip = String(req.body.ip || '').trim();
  if (!/^[\w.-]+$/.test(jail)) throw bad('Bad jail');
  if (!/^\d{1,3}(\.\d{1,3}){3}$|^[0-9a-f:]+$/i.test(ip)) throw bad('Bad IP');
  const r = await host.run('fail2ban-client', ['set', jail, 'banip', ip], { timeout: 10000 });
  if (r.code !== 0) throw fail(r, 'ban');
  audit.write({ user: req.session.username, action: 'fail2ban.ban', details: { jail, ip } });
  res.json({ ok: true, output: r.stdout.trim() });
}));


module.exports = router;
