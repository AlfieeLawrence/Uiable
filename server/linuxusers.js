'use strict';
// Real Linux users (uid 1000-59999 plus root) and the run-as policy that
// scripts, the terminal and uploads share.
const fsp = require('fs').promises;
const path = require('path');
const host = require('./host');
const auth = require('./auth');

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const NAME_RE = /^[a-z_][a-z0-9_-]{0,31}\$?$/;

async function list() {
  const passwd = await fsp.readFile(path.join(host.HOST_ROOT, 'etc/passwd'), 'utf8').catch(() => '');
  const group = await fsp.readFile(path.join(host.HOST_ROOT, 'etc/group'), 'utf8').catch(() => '');
  const adminG = group.split('\n').map((l) => l.split(':')).filter((g) => g[0] === 'sudo' || g[0] === 'wheel');
  return passwd.split('\n').filter(Boolean).map((l) => {
    const p = l.split(':');
    return { name: p[0], uid: +p[2], gid: +p[3], home: p[5] || '/', shell: p[6] || '/bin/sh' };
  }).filter((u) => u.uid === 0 || (u.uid >= 1000 && u.uid < 60000))
    .map((u) => Object.assign(u, { admin: u.uid === 0 || adminG.some((g) => (g[3] || '').split(',').includes(u.name) || +g[2] === u.gid) }));
}

async function get(name) {
  if (!NAME_RE.test(String(name || ''))) throw bad('Bad Linux user name');
  const u = (await list()).find((x) => x.name === name);
  if (!u) throw bad(`Linux user ${name} does not exist (or is a system account)`, 404);
  return u;
}

/** Which Linux users may this dashboard session bind itself to? */
async function selectable(session) {
  const all = await list();
  if (auth.atLeast(session.role, 'admin')) return all;
  const allowed = auth.linuxSettings().allowed;
  return all.filter((u) => u.uid !== 0 && allowed.includes(u.name));
}

const boundOf = (session) => (auth.findUser(session.username) || {}).linuxUser || '';

/**
 * Resolve the Linux user to run something as. Admins may pick anyone (default:
 * bound user, else root). Everyone else always runs as their bound user.
 */
async function resolveRunAs(session, requested) {
  const bound = boundOf(session);
  if (auth.atLeast(session.role, 'admin')) return get(requested || bound || 'root');
  if (!bound) throw bad('Your dashboard account is not linked to a Linux user. Set one in Settings → My account.', 403);
  if (requested && requested !== bound) throw bad(`You can only run as your linked Linux user (${bound})`, 403);
  const u = await get(bound);
  if (u.uid === 0) throw bad('Only admins can run as root', 403);
  return u;
}

// cd happens INSIDE the host shell, after nsenter has entered the host mount
// namespace. (nsenter --wd opens the directory before switching namespaces, so
// inside the container /home/<user> did not exist: "nsenter: cannot open".)
const CD_WRAP = 'cd -- "$HOME" 2>/dev/null || { printf "uiable: home directory %s does not exist, running in /\\n" "$HOME" >&2; cd /; }; exec "$@"';

/**
 * Build [cmd, args] that runs `argv` on the host as Linux user `u` with a clean
 * env (HOME/USER/LOGNAME/SHELL/PATH from the host's /etc/passwd) and cwd = home.
 * Pass the result to host.hostSpawnArgs / jobs.runHost. Never uses nsenter --wd.
 */
// Runs as root on the host before dropping to the user: moves this process out of
// the container's 256M memory cgroup so scripts/terminals get normal host memory.
// 1) systemd-run --scope (host transient scope)  2) cgroup v2 /uiable-jobs or v1
// memory root  3) stay put with a warning. exec keeps the PID/process group, so
// kill/stop and PTY resize behave exactly as before.
const ESCAPE = [
  'w() { printf "uiable: %s\\n" "$1" >&2; }',
  'if [ -d /run/systemd/system ] && command -v systemd-run >/dev/null 2>&1 && systemd-run --scope --quiet --collect true >/dev/null 2>&1; then exec systemd-run --scope --quiet --collect -- "$@"; fi',
  'C=/sys/fs/cgroup',
  'if [ -f $C/cgroup.controllers ]; then mkdir -p $C/uiable-jobs 2>/dev/null; echo $$ > $C/uiable-jobs/cgroup.procs 2>/dev/null || echo $$ > $C/cgroup.procs 2>/dev/null || w "could not leave the dashboard memory limit (256M); big jobs may be killed";',
  'elif [ -d $C/memory ]; then echo $$ > $C/memory/cgroup.procs 2>/dev/null || w "could not leave the dashboard memory limit (256M); big jobs may be killed";',
  'else w "no cgroup fs found; running inside the dashboard memory limit"; fi',
  'exec "$@"',
].join('\n');

function asUser(u, argv, extraEnv = {}) {
  const env = Object.assign({ HOME: u.home || '/', USER: u.name, LOGNAME: u.name, SHELL: u.shell || '/bin/sh', PATH: host.HOST_PATH, LANG: process.env.LANG || 'C.UTF-8' }, extraEnv);
  const inner = ['env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), '/bin/sh', '-c', CD_WRAP, 'uiable-cd', ...argv];
  const run = u.uid === 0 ? inner : ['runuser', '-u', u.name, '--', ...inner];
  return host.MODE === 'nsenter' ? ['/bin/sh', ['-c', ESCAPE, 'uiable-escape', ...run]] : [run[0], run.slice(1)];
}

module.exports = { asUser, ESCAPE, CD_WRAP, list, get, selectable, resolveRunAs, boundOf, NAME_RE };
