'use strict';
// Proves that whoever links a dashboard account to a Linux user knows that Linux
// user's password. The password is checked against the host's /etc/shadow and is
// never logged, stored, returned, or put on a command line / in the environment.
//
// 1) Read the account's hash from HOST_ROOT/etc/shadow (locked, passwordless and
//    expired accounts are refused before anything runs).
// 2) Hash the typed password with the host's own crypt(3) (libxcrypt: yescrypt
//    $y$, gost-yescrypt $gy$, scrypt $7$, bcrypt $2b$, sha512 $6$, sha256 $5$, md5 $1$)
//    via `perl -e`, run on the host (nsenter) so the formats match exactly what
//    `passwd` wrote. The hash and password go in on stdin; perl prints the result,
//    which is compared here in constant time.
// 3) If perl is missing or its crypt can't handle the format, fall back to PAM's
//    `unix_chkpwd <user> nonull` (password on stdin, NUL-terminated).
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const host = require('./host');

const MAX_PW = 1024;
const TIMEOUT = 20000;

// argv only ever holds this fixed script; the secret arrives on stdin as "<hash>\0<password>".
const PERL_CRYPT = [
  'binmode STDIN; binmode STDOUT; local $/; my $in = <STDIN>;',
  'my $i = index($in, "\\0"); exit 3 if $i < 0;',
  'my $c = crypt(substr($in, $i + 1), substr($in, 0, $i));',
  'exit 2 if !defined($c) || $c eq "" || substr($c, 0, 1) eq "*";',
  'print $c; exit 0;',
].join(' ');

/** Shadow entry for a user: { hash, expire } or null when there is no line for them. */
async function shadowEntry(name, { shadowFile } = {}) {
  const file = shadowFile || path.join(host.HOST_ROOT, 'etc/shadow');
  const text = await fsp.readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    const p = line.split(':');
    if (p[0] === name && p.length >= 2) return { hash: p[1] || '', expire: p[7] || '' };
  }
  return null;
}

/** Can this shadow entry be verified at all? Returns null if yes, else { reason, message }. */
function accountProblem(name, entry, now = Date.now()) {
  if (!entry) return { reason: 'nopass', message: `Linux user ${name} has no password entry in /etc/shadow, so it can't be verified.` };
  const h = entry.hash;
  if (!h) return { reason: 'nopass', message: `Linux user ${name} has no password set. Set one on the server (sudo passwd ${name}) and try again.` };
  if (h[0] === '!' || h[0] === '*') {
    return { reason: 'locked', message: `Linux user ${name} is locked or has no password${name === 'root' ? ' (root is locked by default on Ubuntu; admins already run as root when no Linux user is linked)' : ''}. Unlock it or set a password on the server first.` };
  }
  if (/^\d+$/.test(entry.expire) && Number(entry.expire) * 86400000 <= now) {
    return { reason: 'expired', message: `Linux user ${name} has expired on the server (chage), so it can't be linked.` };
  }
  return null;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** true / false, or null when crypt here can't handle that hash format. */
async function cryptMatches(password, hash, { run = host.run } = {}) {
  const r = await run('perl', ['-e', PERL_CRYPT], { input: Buffer.concat([Buffer.from(hash), Buffer.from([0]), Buffer.from(password, 'utf8')]), timeout: TIMEOUT });
  if (r.code !== 0) return null;
  return safeEqual(r.stdout, hash);
}

/** PAM fallback. true / false, or null when unix_chkpwd isn't available. */
async function chkpwdMatches(name, password, { run = host.run } = {}) {
  const r = await run('unix_chkpwd', [name, 'nonull'], { input: Buffer.concat([Buffer.from(password, 'utf8'), Buffer.from([0])]), timeout: TIMEOUT });
  if (r.code === 0) return true;
  if (r.code === 126 || r.code === 127) return null;
  return false;
}

/**
 * Verify `password` for Linux user `name`.
 * Resolves { ok: true, method } or { ok: false, reason, message }.
 * reason: wrong | locked | nopass | expired | invalid | unavailable
 */
async function verify(name, password, opts = {}) {
  if (typeof password !== 'string' || !password) return { ok: false, reason: 'invalid', message: 'Type the Linux password for that user.' };
  if (password.length > MAX_PW || password.includes('\0')) return { ok: false, reason: 'invalid', message: 'That password is not valid.' };
  let entry;
  try { entry = await shadowEntry(name, opts); } catch (_) {
    return { ok: false, reason: 'unavailable', message: "Couldn't read the server's /etc/shadow to verify the password." };
  }
  const problem = accountProblem(name, entry, opts.now);
  if (problem) return Object.assign({ ok: false }, problem);
  let m = await cryptMatches(password, entry.hash, opts);
  let method = 'crypt';
  if (m === null) { m = await chkpwdMatches(name, password, opts); method = 'unix_chkpwd'; }
  if (m === null) return { ok: false, reason: 'unavailable', message: "Couldn't verify the password: the server has neither perl nor unix_chkpwd for this hash type." };
  if (!m) return { ok: false, reason: 'wrong', message: `Wrong password for Linux user ${name}.` };
  return { ok: true, method };
}

/**
 * Failed-attempt limiter: `max` failures per (actor, Linux user) and `globalMax`
 * failures per actor across all Linux users, both in a sliding `windowMs`.
 * A success clears that (actor, Linux user) pair.
 */
function createLimiter({ max = 5, globalMax = 15, windowMs = 15 * 60 * 1000, now = () => Date.now() } = {}) {
  const fails = new Map(); // key -> [timestamps]
  const recent = (k) => { const t = now(); const a = (fails.get(k) || []).filter((x) => t - x < windowMs); if (a.length) fails.set(k, a); else fails.delete(k); return a; };
  const pairKey = (actor, target) => `p\0${String(actor).toLowerCase()}\0${target}`;
  const actorKey = (actor) => `a\0${String(actor).toLowerCase()}`;
  return {
    /** null when allowed, else { retryAfter } seconds. */
    check(actor, target) {
      for (const [k, lim] of [[pairKey(actor, target), max], [actorKey(actor), globalMax]]) {
        const a = recent(k);
        if (a.length >= lim) return { retryAfter: Math.max(1, Math.ceil((a[0] + windowMs - now()) / 1000)) };
      }
      return null;
    },
    fail(actor, target) {
      for (const k of [pairKey(actor, target), actorKey(actor)]) { const a = recent(k); a.push(now()); fails.set(k, a); }
      return Math.max(0, max - recent(pairKey(actor, target)).length);
    },
    success(actor, target) { fails.delete(pairKey(actor, target)); },
    reset() { fails.clear(); },
  };
}

module.exports = { verify, shadowEntry, accountProblem, cryptMatches, chkpwdMatches, createLimiter, PERL_CRYPT, MAX_PW };
