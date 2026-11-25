'use strict';
// Linux password verification for account linking (server/linuxauth.js) and the
// /account/linux-user + /accounts/:name/linux-user routes. Run: npm test
// Real hashes are made with the box's crypt(3) via perl; tests that need a
// format the local libcrypt lacks are skipped.
process.env.UIABLE_HOST_MODE = 'local';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const la = require('../server/linuxauth');
const audit = require('../server/audit');

const PW = 'S3cret-Pass word!£';
const mkHash = (prefix, pw = PW) => {
  try { const h = execFileSync('perl', ['-e', 'binmode STDIN; local $/; my $p = <STDIN>; print crypt($p, $ARGV[0])', prefix], { input: Buffer.from(pw, 'utf8') }).toString(); return h && h[0] !== '*' ? h : null; } catch (_) { return null; }
};
const HASHES = { yescrypt: mkHash('$y$j9T$F5Jx5fExrKuPp53xLKQ..1$'), sha512: mkHash('$6$saltsaltsalt$'), sha256: mkHash('$5$saltsaltsalt$') };

function shadowDir(lines) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-shadow-'));
  fs.writeFileSync(path.join(d, 'shadow'), lines.join('\n') + '\n', { mode: 0o600 });
  return path.join(d, 'shadow');
}

for (const [kind, hash] of Object.entries(HASHES)) {
  test(`verify: correct password succeeds (${kind})`, { skip: !hash && `local crypt has no ${kind}` }, async () => {
    const f = shadowDir([`alfie:${hash}:20000:0:99999:7:::`]);
    assert.deepEqual(await la.verify('alfie', PW, { shadowFile: f }), { ok: true, method: 'crypt' });
  });
  test(`verify: wrong password fails (${kind})`, { skip: !hash && `local crypt has no ${kind}` }, async () => {
    const f = shadowDir([`alfie:${hash}:20000:0:99999:7:::`]);
    const r = await la.verify('alfie', PW + 'x', { shadowFile: f });
    assert.equal(r.ok, false); assert.equal(r.reason, 'wrong');
    assert.ok(!JSON.stringify(r).includes(PW));
  });
}

test('verify: locked, passwordless, missing and expired accounts are refused without running crypt', async () => {
  const h = HASHES.sha512 || '$6$x$y';
  const f = shadowDir([`locked:!${h}:20000::::::`, 'star:*:20000::::::', 'nopw::20000::::::', 'dbl:!!:20000::::::', `old:${h}:20000:0:99999:7::1:`]);
  const run = async () => { throw new Error('crypt must not run'); };
  for (const [u, reason] of [['locked', 'locked'], ['star', 'locked'], ['dbl', 'locked'], ['nopw', 'nopass'], ['ghost', 'nopass'], ['old', 'expired']]) {
    const r = await la.verify(u, PW, { shadowFile: f, run });
    assert.equal(r.ok, false, u); assert.equal(r.reason, reason, u);
  }
});

test('verify: empty / oversized / NUL passwords are rejected', async () => {
  const f = shadowDir(['alfie:$6$a$b:20000::::::']);
  for (const p of ['', undefined, 'a'.repeat(la.MAX_PW + 1), 'a\0b']) assert.equal((await la.verify('alfie', p, { shadowFile: f })).reason, 'invalid');
});

test('verify: password only ever travels on stdin (never argv/env)', async () => {
  const f = shadowDir(['alfie:$6$saltsaltsalt$abc:20000::::::']);
  const calls = [];
  const run = async (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { code: 0, stdout: 'nope', stderr: '' }; };
  await la.verify('alfie', PW, { shadowFile: f, run });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'perl');
  assert.ok(!JSON.stringify(calls[0].args).includes(PW));
  assert.ok(!calls[0].opts.env || !JSON.stringify(calls[0].opts.env).includes(PW));
  assert.ok(Buffer.from(calls[0].opts.input).includes(Buffer.from(PW, 'utf8')));
});

test('verify: falls back to unix_chkpwd when perl/crypt cannot handle the hash', async () => {
  const f = shadowDir(['alfie:$y$j9T$salt$hash:20000::::::']);
  const seen = [];
  const mk = (chk) => async (cmd, args, opts) => { seen.push(cmd); if (cmd === 'perl') return { code: 127, stdout: '', stderr: '' }; assert.deepEqual(args, ['alfie', 'nonull']); assert.ok(!args.join(' ').includes(PW)); assert.equal(Buffer.from(opts.input).toString('utf8'), PW + '\0'); return { code: chk, stdout: '', stderr: '' }; };
  assert.deepEqual(await la.verify('alfie', PW, { shadowFile: f, run: mk(0) }), { ok: true, method: 'unix_chkpwd' });
  assert.equal((await la.verify('alfie', PW, { shadowFile: f, run: mk(7) })).reason, 'wrong');
  assert.equal((await la.verify('alfie', PW, { shadowFile: f, run: mk(127) })).reason, 'unavailable');
  assert.deepEqual(seen.slice(0, 2), ['perl', 'unix_chkpwd']);
});

test('limiter: 5 failures per actor+account in 15 min, global cap, success resets, window expires', () => {
  let t = 1_000_000;
  const L = la.createLimiter({ now: () => t });
  for (let i = 0; i < 5; i++) { assert.equal(L.check('alice', 'bob'), null); L.fail('alice', 'bob'); }
  const blocked = L.check('alice', 'bob');
  assert.ok(blocked && blocked.retryAfter > 0 && blocked.retryAfter <= 900);
  assert.equal(L.check('ALICE', 'bob') !== null, true, 'actor is case-insensitive');
  assert.equal(L.check('carol', 'bob'), null, 'other actors unaffected');
  assert.equal(L.check('alice', 'dave'), null, 'other Linux users unaffected (below global cap)');
  t += 15 * 60 * 1000 + 1;
  assert.equal(L.check('alice', 'bob'), null, 'window expired');
  for (let i = 0; i < 4; i++) L.fail('alice', 'bob');
  L.success('alice', 'bob');
  for (let i = 0; i < 4; i++) L.fail('alice', 'bob');
  assert.equal(L.check('alice', 'bob'), null, 'success cleared the pair');
  const G = la.createLimiter({ now: () => t });
  for (let i = 0; i < 15; i++) G.fail('mallory', 'u' + i);
  assert.ok(G.check('mallory', 'fresh'), 'global cap across Linux users');
});

test('audit redaction: link request bodies and verify entries never keep the password', () => {
  const body = { linuxUser: 'alfie', password: PW };
  const s = audit.sanitize(body, { pathHint: '/api/account/linux-user' });
  assert.deepEqual(s, { secrets: 'omitted', linuxUser: 'alfie' });
  assert.ok(!JSON.stringify(audit.sanitize(body, { pathHint: '/api/accounts/bob/linux-user' })).includes(PW));
  assert.ok(!JSON.stringify(audit.sanitize(body)).includes(PW), 'even without the path hint');
});

// ---------------------------------------------------------------- HTTP routes
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

test('routes: link needs the right Linux password; rate limit; nothing leaks to audit/stdout', { skip: !HASHES.sha512 && 'no sha512 crypt' }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-host-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-data-'));
  fs.mkdirSync(path.join(root, 'etc'));
  fs.writeFileSync(path.join(root, 'etc/passwd'), ['root:x:0:0:root:/root:/bin/bash', 'alfie:x:1000:1000::/home/alfie:/bin/bash', 'bob:x:1001:1001::/home/bob:/bin/bash', 'lockd:x:1002:1002::/home/lockd:/bin/bash'].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'etc/group'), 'sudo:x:27:alfie\n');
  fs.writeFileSync(path.join(root, 'etc/shadow'), [`root:*:20000::::::`, `alfie:${HASHES.yescrypt || HASHES.sha512}:20000:0:99999:7:::`, `bob:${HASHES.sha512}:20000:0:99999:7:::`, `lockd:!${HASHES.sha512}:20000::::::`].join('\n') + '\n');
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { UIABLE_HOST_MODE: 'local', UIABLE_HOST_ROOT: root, UIABLE_DATA_DIR: data, UIABLE_PORT: String(port), UIABLE_BIND: '127.0.0.1', UIABLE_STATS_INTERVAL_MS: '60000' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000); const iv = setInterval(() => { if (/listening on/.test(out)) { clearInterval(iv); clearTimeout(to); res(); } }, 50); });
  const base = `http://127.0.0.1:${port}/api`;
  let cookie = ''; let csrf = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, headers: r.headers, data: await r.json().catch(() => null) };
  };
  const setup = await call('POST', '/setup', { username: 'admin', password: 'adminpass1' });
  assert.equal(setup.status, 200); csrf = setup.data.csrf;

  // No password / wrong password: refused, nothing saved
  let r = await call('POST', '/account/linux-user', { linuxUser: 'alfie' });
  assert.equal(r.status, 400); assert.equal(r.data.reason, 'invalid');
  r = await call('POST', '/account/linux-user', { linuxUser: 'alfie', password: 'wrong-one' });
  assert.equal(r.status, 403); assert.equal(r.data.reason, 'wrong');
  assert.ok(!JSON.stringify(r.data).includes('wrong-one'));
  assert.equal((await call('GET', '/state')).data.linuxUser, '');

  // Locked account and locked root: refused
  r = await call('POST', '/account/linux-user', { linuxUser: 'lockd', password: PW });
  assert.equal(r.status, 400); assert.equal(r.data.reason, 'locked');
  r = await call('POST', '/account/linux-user', { linuxUser: 'root', password: PW });
  assert.equal(r.data.reason, 'locked');

  // Correct password links
  r = await call('POST', '/account/linux-user', { linuxUser: 'alfie', password: PW });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.linuxUser, 'alfie');
  // Re-saving the same user needs no password; changing it does
  assert.equal((await call('POST', '/account/linux-user', { linuxUser: 'alfie' })).status, 200);
  assert.equal((await call('POST', '/account/linux-user', { linuxUser: 'bob' })).status, 400);
  assert.equal((await call('GET', '/state')).data.linuxUser, 'alfie');

  // Admin linking another account still needs the target Linux password
  assert.equal((await call('POST', '/accounts', { username: 'viewer1', password: 'viewerpass1', role: 'viewer' })).status, 200);
  assert.equal((await call('POST', '/accounts/viewer1/linux-user', { linuxUser: 'bob', password: 'nope' })).status, 403);
  assert.equal((await call('POST', '/accounts/viewer1/linux-user', { linuxUser: 'bob', password: PW })).status, 200);
  // Unlink needs no password
  assert.equal((await call('POST', '/accounts/viewer1/linux-user', { linuxUser: '' })).status, 200);

  // Rate limit: 5 wrong tries for (admin, bob) -> 429, even with the right password
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/accounts/viewer1/linux-user', { linuxUser: 'bob', password: 'bad' + i })).status, 403);
  r = await call('POST', '/accounts/viewer1/linux-user', { linuxUser: 'bob', password: PW });
  assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);

  await new Promise((res) => setTimeout(res, 200));
  const log = fs.readFileSync(path.join(data, 'audit.log'), 'utf8');
  assert.ok(!log.includes(PW) && !log.includes('wrong-one') && !log.includes('bad0'), 'audit log has no passwords');
  assert.match(log, /"action":"account\.linux-verify"[^\n]*"ok":true/);
  assert.match(log, /"action":"account\.linux-verify"[^\n]*"reason":"wrong"/);
  assert.match(log, /"reason":"rate-limited"/);
  assert.match(log, /"action":"account\.linux-bind"[^\n]*"verified":true/);
  assert.ok(!out.includes(PW), 'server output has no passwords');
  const cfg = fs.readdirSync(data).map((f) => { try { return fs.readFileSync(path.join(data, f), 'utf8'); } catch (_) { return ''; } }).join('\n');
  assert.ok(!cfg.includes(PW), 'nothing in the data dir stores the password');
});
