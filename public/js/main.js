'use strict';
/* Auth screens, home (app grid + widgets) and the dashboard. */

function authScreen(setup) {
  let ticket = null;
  const paint = (mode) => {
    $('#app').innerHTML = `<div class="auth-wrap"><div class="card auth">
      <img class="logo" src="/favicon.svg" alt="">
      <h1>${setup ? 'Welcome to Uiable' : mode === '2fa' ? 'Two-factor code' : 'Sign in'}</h1>
      <p class="muted">${setup ? 'Create the admin account for this server.' : mode === '2fa' ? 'Enter the 6-digit code from your authenticator app, or a backup code.' : 'Sign in to manage this server.'}</p>
      <form autocomplete="on">
        ${mode === '2fa' ? `<label class="field"><span>Authentication code</span><input name="code" inputmode="numeric" autocomplete="one-time-code" required autofocus></label>`
          : `<label class="field"><span>Username</span><input name="username" autocomplete="username" required value="${setup ? 'admin' : ''}"></label>
             <label class="field"><span>Password</span><input name="password" type="password" autocomplete="${setup ? 'new-password' : 'current-password'}" required minlength="${setup ? 8 : 1}"></label>
             ${setup ? '<label class="field"><span>Confirm password</span><input name="confirm" type="password" autocomplete="new-password" required></label>' : ''}`}
        <div class="error-text"></div>
        <button class="primary" type="submit">${setup ? 'Create account' : mode === '2fa' ? 'Verify' : 'Sign in'}</button>
        ${mode === '2fa' ? '<button type="button" data-back style="margin-top:8px;width:100%;justify-content:center">Back</button>' : ''}
      </form>
      <p class="muted small" style="margin-top:16px">Uiable ${esc(State.version)}</p>
    </div></div>`;
    const f = $('form');
    const back = $('[data-back]'); if (back) back.onclick = () => { ticket = null; paint('login'); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const err = $('.error-text'); err.textContent = '';
      const btn = $('button[type=submit]', f); btn.disabled = true;
      try {
        if (mode === '2fa') {
          const r = await api('POST', '/login/2fa', { ticket, code: f.code.value.trim() });
          State.user = r.user; State.role = r.role; State.csrf = r.csrf;
          if (r.backupRemaining != null && r.backupRemaining < 3) toast(`Only ${r.backupRemaining} backup codes left`, true);
        } else {
          if (setup && f.password.value !== f.confirm.value) { err.textContent = 'Passwords do not match'; btn.disabled = false; return; }
          const r = await api('POST', setup ? '/setup' : '/login', { username: f.username.value.trim(), password: f.password.value });
          if (r.twoFactor) { ticket = r.ticket; paint('2fa'); return; }
          State.user = r.user; State.role = r.role; State.csrf = r.csrf;
        }
        const st = await GET('/state'); State.displayName = st.displayName || ''; State.linuxUser = st.linuxUser || '';
        // Ask before routing: a hash change would route() and close the dialog
        if (st.needsBinding) { $('#app').innerHTML = '<div class="auth-wrap"></div>'; await linuxBindDlg({ firstLogin: true }); }
        if (!location.hash) location.hash = '#/'; else route();
      } catch (e2) { err.textContent = e2.message; btn.disabled = false; }
    };
  };
  paint(setup ? 'setup' : 'login');
}

async function boot() {
  try {
    const s = await GET('/state');
    // Server was updated since this page loaded: reload once to get matching code
    if (s.build && window.UIABLE_BUILD && s.build !== window.UIABLE_BUILD && !sessionStorage.getItem('uiable-reload-' + s.build)) {
      sessionStorage.setItem('uiable-reload-' + s.build, '1'); location.reload(); return;
    }
    State.version = s.version; State.build = s.build || ''; State.buildDate = s.buildDate || ''; State.user = s.user; State.role = s.role; State.csrf = s.csrf; State.displayName = s.displayName || ''; State.linuxUser = s.linuxUser || '';
    if (s.setup) return authScreen(true);
    if (!s.user) return authScreen(false);
    if (s.needsBinding) await linuxBindDlg({ firstLogin: true });
    route();
  } catch (e) {
    $('#app').innerHTML = `<div class="auth-wrap"><div class="card auth"><h2>Cannot reach Uiable</h2><p class="muted">${esc(e.message)}</p><button data-retry>Retry</button></div></div>`;
    $("[data-retry]").onclick = () => location.reload();
  }
}

function greeting() { const h = new Date().getHours(); return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }

function widgetsHtml() {
  const val = (key, unitKey) => `<div class="widget-value"><span class="num" data-w="${key}">–</span><span class="unit" data-w="${unitKey}"> </span></div>`;
  return `<div class="grid widgets-row">
    <button type="button" class="card widget widget-click" data-expand="cpu" title="Expand CPU">
      <div class="widget-top"><div class="label">CPU</div><div class="widget-ring" data-w="cpuring"></div></div>
      ${val('cpu', 'cpuu')}
      <div class="widget-sub muted small ellipsis" data-w="load"></div>
      <canvas class="spark" data-w="cpuspark"></canvas>
    </button>
    <button type="button" class="card widget widget-click" data-expand="mem" title="Expand Memory">
      <div class="widget-top"><div class="label">Memory</div><div class="widget-ring" data-w="memring"></div></div>
      ${val('mem', 'memu')}
      <div class="widget-sub muted small ellipsis" data-w="memsub"></div>
      <canvas class="spark" data-w="memspark"></canvas>
    </button>
    <button type="button" class="card widget widget-click" data-expand="disk" title="Expand Disk">
      <div class="widget-top"><div class="label">Storage</div></div>
      ${val('disk', 'disku')}
      <div class="widget-sub muted small ellipsis" data-w="disksub"></div>
      <div data-w="diskbar"></div>
    </button>
    <button type="button" class="card widget widget-click" data-expand="net" title="Expand Network">
      <div class="widget-top"><div class="label">Network</div></div>
      <div class="widget-net">
        <div class="widget-net-row"><span class="dir">↓ down</span>${val('rx', 'rxu')}</div>
        <div class="widget-net-row"><span class="dir">↑ up</span>${val('tx', 'txu')}</div>
      </div>
      <canvas class="spark" data-w="netspark"></canvas>
    </button>
  </div>`;
}
function updateWidgets(root, d) {
  const w = (k) => root.querySelector(`[data-w="${k}"]`);
  if (!w('cpu')) return;
  const memPct = d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0;
  setVal(root, 'cpu', fmtNum(d.cpu.usage, 0) + '%', '');
  w('load').textContent = `load ${d.load.map((x) => fmtNum(x, 2)).join(' ')}`;
  w('cpuring').innerHTML = ring(d.cpu.usage, d.info.cpuCount + 'c');
  const mem = splitBytes(d.memory.used, 1);
  setVal(root, 'mem', mem.num, mem.unit);
  w('memsub').textContent = `of ${fmtBytes(d.memory.total, 1)} · ${fmtPct(memPct, 0)}`;
  w('memring').innerHTML = ring(memPct, fmtPct(memPct, 0));
  const root0 = d.primaryDisk || d.disks.find((x) => x.mount === '/') || d.disks[0];
  if (root0) {
    const p = (root0.used / root0.size) * 100;
    const disk = splitBytes(root0.used, 1);
    setVal(root, 'disk', disk.num, disk.unit);
    const freeBits = d.diskTotal && d.diskTotal.count > 1
      ? `${fmtBytes(d.diskTotal.avail, 1)} free · ${d.diskTotal.count} disks`
      : `${fmtBytes(root0.avail, 1)} free`;
    w('disksub').textContent = `of ${fmtBytes(root0.size, 1)} on ${root0.mount} · ${freeBits}`;
    w('diskbar').innerHTML = bar(p);
  } else { setVal(root, 'disk', 'n/a', ''); w('disksub').textContent = ''; }
  const rx = splitRate(d.network.rxRate), tx = splitRate(d.network.txRate);
  setVal(root, 'rx', rx.num, rx.unit);
  setVal(root, 'tx', tx.num, tx.unit);
  sparkline(w('cpuspark'), [Stats.history.cpu], { max: 100 });
  sparkline(w('memspark'), [Stats.history.mem], { max: 100, colors: ['#22c1c3'] });
  sparkline(w('netspark'), [Stats.history.rx, Stats.history.tx], { colors: ['#7c5cff', '#f472b6'] });
}

/** Expanded live view for a home/dashboard widget. History is held in-browser only while open. */
function openStatExpand(kind) {
  const titles = { cpu: 'CPU', mem: 'Memory', disk: 'Storage', net: 'Network' };
  const hist = { cpu: [], mem: [], rx: [], tx: [] };
  const cap = 100; // ~5 min at 3s
  let unsub = null, timer = null, procs = [];

  const seed = () => {
    const h = Stats.history;
    if (kind === 'cpu') hist.cpu = h.cpu.slice(-cap);
    if (kind === 'mem') hist.mem = h.mem.slice(-cap);
    if (kind === 'net') { hist.rx = h.rx.slice(-cap); hist.tx = h.tx.slice(-cap); }
  };
  seed();

  const loadProcs = async () => {
    if (kind !== 'mem') return;
    try {
      const r = await GET('/system/processes');
      procs = (r.processes || []).slice().sort((a, b) => b.rss - a.rss).slice(0, 8);
    } catch (_) { procs = []; }
  };

  const paint = (m, d) => {
    if (!d) return;
    const body = $('[data-exp]', m);
    if (!body) return;
    if (kind === 'cpu') {
      hist.cpu.push(d.cpu.usage); while (hist.cpu.length > cap) hist.cpu.shift();
      body.innerHTML = `
        <div class="row wrap" style="gap:16px;margin-bottom:12px">
          <div><div class="label">Usage</div><div class="big num">${fmtPct(d.cpu.usage, 1)}</div></div>
          <div class="grow"><div class="label">Load average</div><div class="num">${d.load.map((x) => fmtNum(x, 2)).join(' · ')}</div>
            <div class="muted small">1 / 5 / 15 min</div></div>
        </div>
        <div class="cores" style="margin-bottom:12px">${d.cpu.cores.map((c, i) => `<div class="core" title="CPU ${i}"><i style="height:${c.toFixed(0)}%"></i><span>${fmtNum(c, 0)}</span></div>`).join('')}</div>
        <div class="muted small" style="margin-bottom:6px">${esc(d.info.cpuModel)} · ${d.info.cpuCount} threads · last ~5 min (in-browser)</div>
        <canvas class="spark expand-chart" data-chart height="120"></canvas>`;
      sparkline($('[data-chart]', body), [hist.cpu], { max: 100 });
    } else if (kind === 'mem') {
      hist.mem.push(d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0);
      while (hist.mem.length > cap) hist.mem.shift();
      const m0 = d.memory;
      body.innerHTML = `
        <div class="grid cols-2" style="margin-bottom:12px">
          <div><div class="label">Used</div><div class="big num">${fmtBytes(m0.used)}</div></div>
          <div><div class="label">Available</div><div class="big num">${fmtBytes(m0.available)}</div></div>
        </div>
        <div class="kv" style="margin-bottom:14px">
          <div>Total</div><div class="num">${fmtBytes(m0.total)}</div>
          <div>Free</div><div class="num">${fmtBytes(m0.free || 0)}</div>
          <div>Cached</div><div class="num">${fmtBytes(m0.cached || 0)}</div>
          <div>Buffers</div><div class="num">${fmtBytes(m0.buffers || 0)}</div>
          <div>Swap</div><div class="num">${m0.swapTotal ? `${fmtBytes(m0.swapUsed)} / ${fmtBytes(m0.swapTotal)}` : 'none'}</div>
        </div>
        <canvas class="spark expand-chart" data-chart height="100" style="margin-bottom:14px"></canvas>
        <div class="card-title" style="margin-bottom:8px">Top memory processes</div>
        ${procs.length ? `<table><thead><tr><th>PID</th><th>User</th><th>Name</th><th class="right">RSS</th><th class="right">%</th></tr></thead><tbody>
          ${procs.map((p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td class="ellipsis">${esc(p.name)}</td><td class="right num">${fmtBytes(p.rss)}</td><td class="right num">${fmtNum(p.mem, 1)}</td></tr>`).join('')}
        </tbody></table>` : '<div class="muted small">Loading processes…</div>'}`;
      sparkline($('[data-chart]', body), [hist.mem], { max: 100, colors: ['#22c1c3'] });
    } else if (kind === 'disk') {
      const dio = d.diskIo || { disks: [], readRate: 0, writeRate: 0 };
      const primaryMount = d.primaryDisk && d.primaryDisk.mount;
      body.innerHTML = `
        <div class="row wrap" style="gap:20px;margin-bottom:14px">
          <div><div class="label">Read</div><div class="big num" style="font-size:22px">${fmtRate(dio.readRate)}</div></div>
          <div><div class="label">Write</div><div class="big num" style="font-size:22px">${fmtRate(dio.writeRate)}</div></div>
        </div>
        ${d.disks.map((x) => {
          const p = (x.used / x.size) * 100;
          const isP = x.mount === primaryMount;
          return `<div style="margin-bottom:14px"><div class="row small"><b class="ellipsis">${esc(x.mount)}</b>${isP ? '<span class="chip ok">primary</span>' : ''}
            <span class="muted ellipsis grow">${esc(x.fs)} · ${esc(x.type)}</span>
            <span class="num">${fmtBytes(x.used)} / ${fmtBytes(x.size)}</span></div>
            <div style="margin-top:6px">${bar(p)}</div>
            <div class="muted small">${fmtBytes(x.avail)} free</div></div>`;
        }).join('') || '<div class="muted">No mounts</div>'}
        ${dio.disks.length ? `<div class="card-title" style="margin:16px 0 8px">Disk IO</div>
          <table><thead><tr><th>Device</th><th class="right">↓ Read</th><th class="right">↑ Write</th><th class="right">Total</th></tr></thead><tbody>
          ${dio.disks.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td class="right num">${fmtRate(x.readRate)}</td><td class="right num">${fmtRate(x.writeRate)}</td>
            <td class="right muted num">${fmtBytes(x.readBytes)} / ${fmtBytes(x.writeBytes)}</td></tr>`).join('')}
          </tbody></table>` : ''}`;
    } else if (kind === 'net') {
      hist.rx.push(d.network.rxRate); hist.tx.push(d.network.txRate);
      while (hist.rx.length > cap) hist.rx.shift(); while (hist.tx.length > cap) hist.tx.shift();
      body.innerHTML = `
        <div class="row wrap" style="gap:20px;margin-bottom:12px">
          <div><div class="label">↓ Download</div><div class="big num" style="font-size:22px">${fmtRate(d.network.rxRate)}</div></div>
          <div><div class="label">↑ Upload</div><div class="big num" style="font-size:22px">${fmtRate(d.network.txRate)}</div></div>
        </div>
        <div class="muted small" style="margin-bottom:6px">Last ~5 min (in-browser only)</div>
        <canvas class="spark expand-chart" data-chart height="120" style="margin-bottom:14px"></canvas>
        <table><thead><tr><th>Interface</th><th class="right">↓ Rate</th><th class="right">↑ Rate</th><th class="right">Total ↓/↑</th></tr></thead><tbody>
          ${d.network.interfaces.map((i) => `<tr><td class="mono">${esc(i.name)}</td><td class="right num">${fmtRate(i.rxRate)}</td><td class="right num">${fmtRate(i.txRate)}</td>
            <td class="right muted num">${fmtBytes(i.rxBytes)} / ${fmtBytes(i.txBytes)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No interfaces</td></tr>'}
        </tbody></table>`;
      sparkline($('[data-chart]', body), [hist.rx, hist.tx], { colors: ['#7c5cff', '#f472b6'] });
    }
  };

  modal({
    title: titles[kind] || kind, wide: true,
    body: `<div data-exp><div class="empty"><span class="spinner"></span></div></div>`,
    buttons: [{ label: 'Close', value: null }],
    onOpen: (m) => {
      loadProcs().then(() => { if (Stats.last) paint(m, Stats.last); });
      unsub = Stats.subscribe((d) => paint(m, d));
      if (kind === 'mem') timer = setInterval(loadProcs, 8000);
      return () => { if (unsub) unsub(); clearInterval(timer); };
    },
  });
}

function bindWidgetClicks(root) {
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-expand]');
    if (b) openStatExpand(b.dataset.expand);
  });
}

Pages.dashboard = (el) => {
  el.innerHTML = `${widgetsHtml()}
  <div class="grid cols-2" style="margin-top:16px">
    <div class="card"><div class="card-title">${ICON.info} System</div><div class="kv" data-k="sys"></div></div>
    <div class="card"><div class="card-title">${ICON.cpu} CPU cores</div><div class="cores" data-k="cores"></div><div class="muted small" style="margin-top:12px" data-k="cpumodel"></div></div>
    <div class="card"><div class="card-title">${ICON.disk} Disks</div><div data-k="disks"></div></div>
    <div class="card"><div class="card-title">${ICON.globe} Network interfaces</div><div data-k="net"></div></div>
    <div class="card"><div class="card-title">🌡️ Temperatures</div><div data-k="temps"></div></div>
    <div class="card"><div class="card-title">${ICON.disk} Memory &amp; swap</div><div data-k="mem"></div></div>
  </div>`;
  bindWidgetClicks(el);
  const k = (n) => $(`[data-k="${n}"]`, el);
  const unsub = Stats.subscribe((d) => {
    updateWidgets(el, d);
    k('sys').innerHTML = [['Hostname', d.info.hostname], ['OS', d.info.os], ['Kernel', d.info.kernel], ['Architecture', d.info.arch], ['Uptime', fmtDur(d.uptime)], ['Load average', d.load.map((x) => fmtNum(x, 2)).join('  ')], ['Processes', d.procs], ['Uiable mode', d.info.mode === 'nsenter' ? 'Container → host (nsenter)' : 'Running directly']]
      .map(([a, b]) => `<div>${esc(a)}</div><div>${esc(b)}</div>`).join('');
    k('cores').innerHTML = d.cpu.cores.map((c, i) => `<div class="core" title="CPU ${i}: ${fmtNum(c, 0)}%"><i style="height:${fmtNum(c, 0)}%"></i><span>${fmtNum(c, 0)}</span></div>`).join('');
    k('cpumodel').textContent = `${d.info.cpuModel} · ${d.info.cpuCount} threads`;
    const primaryMount = d.primaryDisk && d.primaryDisk.mount;
    const tot = d.diskTotal;
    k('disks').innerHTML = d.disks.length ? `${tot && tot.count ? `<div class="row small" style="margin-bottom:12px"><span class="grow muted">Total across ${tot.count} disk${tot.count===1?'':'s'}</span><b>${fmtBytes(tot.used)} / ${fmtBytes(tot.size)}</b><span class="muted"> · ${fmtBytes(tot.avail)} free</span></div>` : ''}${d.disks.map((x) => { const p = (x.used / x.size) * 100; const isP = x.mount === primaryMount; return `<div style="margin-bottom:14px"><div class="row small"><b class="ellipsis">${esc(x.mount)}</b>${isP ? '<span class="chip ok">primary</span>' : ''}<span class="muted ellipsis grow">${esc(x.fs)} · ${esc(x.type)}</span><span>${fmtBytes(x.used)} / ${fmtBytes(x.size)}</span></div><div style="margin-top:6px">${bar(p)}</div><div class="muted small">${fmtBytes(x.avail)} free</div></div>`; }).join('')}` : '<div class="muted">No disks reported</div>';
    k('net').innerHTML = d.network.interfaces.length ? `<table><thead><tr><th>Interface</th><th class="right">↓ Rate</th><th class="right">↑ Rate</th><th class="right">Total ↓/↑</th></tr></thead><tbody>${d.network.interfaces.map((i) => `<tr><td class="mono">${esc(i.name)}</td><td class="right num">${fmtRate(i.rxRate)}</td><td class="right num">${fmtRate(i.txRate)}</td><td class="right muted num">${fmtBytes(i.rxBytes)} / ${fmtBytes(i.txBytes)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">No interfaces</div>';
    k('temps').innerHTML = d.temps.length ? d.temps.map((t) => { const p = Math.min(100, t.celsius); return `<div style="margin-bottom:12px"><div class="row small"><span class="grow ellipsis">${esc(t.sensor)} <span class="muted">${esc(t.label)}</span></span><b class="num">${fmtNum(t.celsius, 1)} °C</b></div><div style="margin-top:5px" class="bar ${t.celsius >= 85 ? 'crit' : t.celsius >= 70 ? 'warn' : ''}"><i style="width:${p}%"></i></div></div>`; }).join('') : '<div class="muted">No temperature sensors are exposed on this host (common on VPS / cloud servers).</div>';
    const m = d.memory;
    k('mem').innerHTML = `<div class="row small"><span class="grow">RAM</span><span class="num">${fmtBytes(m.used)} / ${fmtBytes(m.total)}</span></div><div style="margin:6px 0 16px">${bar(m.total ? (m.used / m.total) * 100 : 0)}</div>
      <div class="kv small" style="margin-bottom:12px"><div>Cached</div><div class="num">${fmtBytes(m.cached||0)}</div><div>Buffers</div><div class="num">${fmtBytes(m.buffers||0)}</div><div>Free</div><div class="num">${fmtBytes(m.free||0)}</div></div>
      <div class="row small"><span class="grow">Swap</span><span class="num">${m.swapTotal ? `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}` : 'none'}</span></div><div style="margin-top:6px">${bar(m.swapTotal ? (m.swapUsed / m.swapTotal) * 100 : 0)}</div>
      <div class="muted small" style="margin-top:12px">${fmtBytes(m.available)} available</div>`;
  });
  return unsub;
};

document.addEventListener('DOMContentLoaded', boot);
