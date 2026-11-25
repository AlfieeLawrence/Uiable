'use strict';
// Shared helper: start a real Uiable server on a free port against temp dirs.
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function startServer(t, { data, env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-host-'));
  fs.mkdirSync(path.join(root, 'etc'));
  fs.writeFileSync(path.join(root, 'etc/passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
  fs.writeFileSync(path.join(root, 'etc/group'), 'sudo:x:27:\n');
  fs.writeFileSync(path.join(root, 'etc/shadow'), 'root:*:20000::::::\n');
  data = data || fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-data-'));
  const port = await freePort();
  const child = spawn(process.execPath, ['server/index.js'], { cwd: path.join(__dirname, '..'), env: Object.assign({}, process.env, { UIABLE_HOST_MODE: 'local', UIABLE_HOST_ROOT: root, UIABLE_DATA_DIR: data, UIABLE_PORT: String(port), UIABLE_BIND: '127.0.0.1', UIABLE_STATS_INTERVAL_MS: '60000', DOCKER_SOCK: path.join(root, 'no-docker.sock'), PODMAN_SOCK: path.join(root, 'no-podman.sock') }, env), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  t.after(() => child.kill('SIGKILL'));
  await new Promise((res, rej) => { const to = setTimeout(() => rej(new Error('server did not start: ' + out)), 15000); const iv = setInterval(() => { if (/listening on/.test(out)) { clearInterval(iv); clearTimeout(to); res(); } }, 50); });
  const base = `http://127.0.0.1:${port}/api`;
  const client = () => {
    let cookie = ''; let csrf = '';
    const call = async (method, url, body) => {
      const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': csrf }, body: body ? JSON.stringify(body) : undefined });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      const data = await r.json().catch(() => null);
      if (data && data.csrf) csrf = data.csrf;
      return { status: r.status, data };
    };
    return call;
  };
  return { base, port, data, client, output: () => out };
}
module.exports = { startServer, freePort };
