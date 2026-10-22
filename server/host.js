'use strict';
// Helpers for running commands and touching files on the *host*.
//
// Modes:
//   nsenter  - running inside the privileged container (pid: host). Commands are
//              executed in the host's PID 1 namespaces via `nsenter`, and the host
//              filesystem is reached through HOST_ROOT (default /host bind mount).
//   local    - running directly on the machine (no container). Commands run as-is
//              and HOST_ROOT is "/".
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function detectMode() {
  const env = (process.env.UIABLE_HOST_MODE || '').toLowerCase();
  if (env === 'nsenter' || env === 'local') return env;
  return fs.existsSync('/.dockerenv') ? 'nsenter' : 'local';
}

const MODE = detectMode();
const HOST_ROOT = path.resolve(process.env.UIABLE_HOST_ROOT || (MODE === 'nsenter' ? '/host' : '/'));
const HOST_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// No --wd: nsenter opens that path before entering the host mount namespace.
function hostSpawnArgs(cmd, args) {
  if (MODE === 'nsenter') {
    return ['nsenter', ['-t', '1', '-m', '-u', '-i', '-n', '-p', '-C', '--', cmd, ...args]];
  }
  return [cmd, args];
}

function hostEnv(extra) {
  return Object.assign({}, process.env, { PATH: HOST_PATH, LC_ALL: 'C', LANG: 'C' }, extra || {});
}

/**
 * Run a command on the host. Never uses a shell, arguments are passed verbatim.
 * Resolves {code, stdout, stderr}; never rejects (code 127 when not found).
 */
function run(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    const [c, a] = hostSpawnArgs(cmd, args);
    let stdout = '';
    let stderr = '';
    let done = false;
    let child;
    try {
      child = spawn(c, a, { env: hostEnv(opts.env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: 127, stdout: '', stderr: String(e.message || e) });
    }
    const timer = setTimeout(() => {
      if (!done) { try { child.kill('SIGKILL'); } catch (_) {} }
    }, opts.timeout || 30000);
    child.stdout.on('data', (d) => { if (stdout.length < 8e6) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(e.message || e) });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      // nsenter/exec reports "No such file or directory" with 127/126
      resolve({ code: code === null ? 137 : code, stdout, stderr });
    });
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  });
}

/** Does a binary exist on the host? */
async function has(bin) {
  const r = await run('sh', ['-c', 'command -v "$0" >/dev/null 2>&1', bin], { timeout: 5000 });
  return r.code === 0;
}

/** Map an absolute host path to the path we can access from this process. */
function hostPath(p) {
  const norm = path.posix.normalize('/' + String(p || '/')).replace(/\/+$/, '') || '/';
  const full = path.join(HOST_ROOT, norm);
  if (HOST_ROOT !== '/' && full !== HOST_ROOT && !full.startsWith(HOST_ROOT + path.sep)) {
    throw Object.assign(new Error('Path escapes host root'), { status: 400 });
  }
  return { host: norm, local: full };
}

/** /proc of the host. With pid: host, /proc/1/net reflects host network ns. */
const PROC = '/proc';
const NET_DEV = fs.existsSync('/proc/1/net/dev') && MODE === 'nsenter' ? '/proc/1/net/dev' : '/proc/net/dev';

module.exports = { MODE, HOST_ROOT, HOST_PATH, run, has, hostPath, hostSpawnArgs, hostEnv, PROC, NET_DEV };
