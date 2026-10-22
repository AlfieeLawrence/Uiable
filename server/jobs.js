'use strict';
// Tiny in-memory job runner for long operations (image pulls, apt upgrade, compose up).
// The browser polls a job only while its dialog is open; nothing runs when idle.
const crypto = require('crypto');
const { spawn } = require('child_process');
const host = require('./host');

const jobs = new Map();
const MAX_OUTPUT = 400 * 1024;

function create(title, user) {
  const id = crypto.randomBytes(8).toString('hex');
  const job = { id, title, user, state: 'running', output: '', started: Date.now(), ended: null, code: null };
  jobs.set(id, job);
  // keep the 30 most recent
  if (jobs.size > 30) for (const k of [...jobs.keys()].slice(0, jobs.size - 30)) { if (jobs.get(k).state !== 'running') jobs.delete(k); }
  return job;
}
const append = (job, text) => { job.output += text; if (job.output.length > MAX_OUTPUT) job.output = '…(trimmed)\n' + job.output.slice(-MAX_OUTPUT); };
function finish(job, code, err) {
  job.state = code === 0 ? 'done' : 'failed';
  job.code = code; job.ended = Date.now();
  if (err) append(job, `\n${err}\n`);
}

/** Run a host command as a job. Returns the job immediately. */
function runHost(title, user, cmd, args, opts = {}) {
  const job = create(title, user);
  append(job, opts.banner || `$ ${[cmd, ...args].join(' ')}\n`);
  const [c, a] = host.hostSpawnArgs(cmd, args);
  let child;
  try {
    child = spawn(c, a, { env: opts.cleanEnv ? opts.env : host.hostEnv(opts.env) });
    if (opts.input != null) child.stdin.end(opts.input); else child.stdin.end();
  } catch (e) { finish(job, 127, e.message); return job; }
  child.stdout.on('data', (d) => append(job, d.toString()));
  child.stderr.on('data', (d) => append(job, d.toString()));
  child.on('error', (e) => finish(job, 127, e.message));
  child.on('close', (code) => { if (job.state === 'running') finish(job, code === null ? 137 : code); if (opts.onDone) opts.onDone(job); });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, opts.timeout || 30 * 60 * 1000);
  child.on('close', () => clearTimeout(timer));
  return job;
}

/** Run an async JS function as a job; it gets a log(text) callback. */
function runFn(title, user, fn) {
  const job = create(title, user);
  Promise.resolve().then(() => fn((t) => append(job, t)))
    .then(() => finish(job, 0))
    .catch((e) => finish(job, 1, `Error: ${e.message}`));
  return job;
}

const get = (id) => jobs.get(id) || null;
const view = (j) => j && ({ id: j.id, title: j.title, state: j.state, output: j.output, started: j.started, ended: j.ended, code: j.code });

module.exports = { runHost, runFn, get, view, create, append, finish };
