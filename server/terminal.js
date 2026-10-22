'use strict';
// Web terminal: a real PTY running a login shell in the host's namespaces.
const pty = require('node-pty');
const host = require('./host');


const lu = require('./linuxusers');

module.exports = async function terminal(ws, url, session) {
  let target;
  try { target = await lu.resolveRunAs(session, url.searchParams.get('user') || ''); }
  catch (e) { try { ws.send(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`); ws.close(1008, 'run-as'); } catch (_) {} return; }
  const cols = Math.max(20, Math.min(500, Number(url.searchParams.get('cols')) || 100));
  const rows = Math.max(5, Math.min(200, Number(url.searchParams.get('rows')) || 30));
  // Login shell as that user; cd to $HOME happens inside the host shell (see linuxusers.asUser)
  const [cmd, args] = lu.asUser(target, ['/bin/sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash -l; else exec sh -l; fi'], { TERM: 'xterm-256color', COLORTERM: 'truecolor' });
  const [c, a] = host.hostSpawnArgs(cmd, args);
  let proc;
  try {
    proc = pty.spawn(c, a, {
      name: 'xterm-256color', cols, rows, cwd: '/',
      env: { PATH: host.HOST_PATH, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: process.env.LANG || 'C.UTF-8', HOME: target.home, USER: target.name, LOGNAME: target.name, SHELL: target.shell },
    });
  } catch (e) {
    ws.send(`\r\n\x1b[31mFailed to start shell: ${e.message}\x1b[0m\r\n`);
    ws.close();
    return;
  }
  console.log(`[terminal] ${session.username} opened shell as ${target.name} pid ${proc.pid}`);
  require('./audit').write({ user: session.username, role: session.role, action: 'terminal.open', ok: true, details: { as: target.name } });
  proc.onData((d) => { if (ws.readyState === 1) ws.send(d); });
  proc.onExit(({ exitCode }) => {
    if (ws.readyState === 1) { ws.send(`\r\n\x1b[90m[process exited with code ${exitCode}]\x1b[0m\r\n`); ws.close(1000); }
  });
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (_) { return; }
    if (m.t === 'i' && typeof m.d === 'string') proc.write(m.d);
    else if (m.t === 'r') { try { proc.resize(Math.max(20, Math.min(500, m.c | 0)), Math.max(5, Math.min(200, m.r | 0))); } catch (_) {} }
  });
  const ping = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 25000);
  ws.on('close', () => { clearInterval(ping); try { proc.kill('SIGHUP'); } catch (_) {} });
};
