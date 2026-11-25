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
        const st = await GET('/state'); State.displayName = st.displayName || ''; State.linuxUser = st.linuxUser || ''; State.features = st.features || { store: true };
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
    State.version = s.version; State.build = s.build || ''; State.buildDate = s.buildDate || ''; State.user = s.user; State.role = s.role; State.csrf = s.csrf; State.displayName = s.displayName || ''; State.linuxUser = s.linuxUser || ''; State.features = s.features || { store: true };
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
      <div class="widget-sub muted small ellipsis" data-w="diskio" style="margin-top:6px"></div>
    </button>
    <button type="button" class="card widget widget-click" data-expand="net" title="Expand Network">
      <div class="widget-top"><div class="label">Network</div></div>
      <div class="widget-net">
        <div class="widget-net-row"><span class="dir">↓ down</span>${val('rx', 'rxu')}</div>
        <div class="widget-net-row"><span class="dir">↑ up</span>${val('tx', 'txu')}</div>
      </div>
      <canvas class="spark" data-w="netspark"></canvas>
    </button>
    <button type="button" class="card widget widget-click hidden" data-expand="gpu" data-gpu-widget title="Expand GPU">
      <div class="widget-top"><div class="label">GPU</div><div class="widget-ring" data-w="gpuring"></div></div>
      ${val('gpu', 'gpuu')}
      <div class="widget-sub muted small ellipsis" data-w="gpusub"></div>
      <canvas class="spark" data-w="gpuspark"></canvas>
    </button>
  </div>`;
}
function updateWidgets(root, d) {
  const w = (k) => root.querySelector(`[data-w="${k}"]`);
  if (!w('cpu')) return;
  const memPct = d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0;
  setVal(root, 'cpu', fmtNum(d.cpu.usage, 0) + '%', '');
  const cpuTemp = d.cpuTemp != null ? ` · ${fmtNum(d.cpuTemp, 0)}°C` : '';
  w('load').textContent = `load ${d.load.map((x) => fmtNum(x, 2)).join(' ')}${cpuTemp}`;
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
  const dio = d.diskIo || {};
  const dioEl = w('diskio');
  if (dioEl) dioEl.textContent = (dio.readRate != null || dio.writeRate != null)
    ? `IO ↓ ${fmtRate(dio.readRate || 0)} · ↑ ${fmtRate(dio.writeRate || 0)}` : '';
  const rx = splitRate(d.network.rxRate), tx = splitRate(d.network.txRate);
  setVal(root, 'rx', rx.num, rx.unit);
  setVal(root, 'tx', tx.num, tx.unit);
  const gpuW = root.querySelector('[data-gpu-widget]');
  if (gpuW) {
    if (d.gpu) {
      gpuW.classList.remove('hidden');
      setVal(root, 'gpu', d.gpu.util == null ? '–' : fmtNum(d.gpu.util, 0) + '%', '');
      const bits = [d.gpu.name];
      if (d.gpu.memTotal) bits.push(`${fmtBytes(d.gpu.memUsed)} / ${fmtBytes(d.gpu.memTotal)}`);
      if (d.gpu.temp != null) bits.push(`${fmtNum(d.gpu.temp, 0)}°C`);
      w('gpusub').textContent = bits.filter(Boolean).join(' · ');
      w('gpuring').innerHTML = ring(d.gpu.util || 0, d.gpu.count > 1 ? d.gpu.count + '×' : 'GPU');
      sparkline(w('gpuspark'), [Stats.history.gpu], { max: 100, colors: ['#a78bfa'] });
    } else {
      gpuW.classList.add('hidden');
    }
  }
  sparkline(w('cpuspark'), [Stats.history.cpu], { max: 100 });
  sparkline(w('memspark'), [Stats.history.mem], { max: 100, colors: ['#22c1c3'] });
  sparkline(w('netspark'), [Stats.history.rx, Stats.history.tx], { colors: ['#7c5cff', '#f472b6'] });
}

/**
 * Full-detail view for a stat card (home tiles and the Dashboard widgets): time range
 * (Live / 1h / 6h / 24h / 7d from the stored metrics history, clamped to retention),
 * min / avg / max / current, hover tooltip, and a live per-core / per-device breakdown.
 * Uses the shared modal (Esc / ✕ to close, background scroll locked).
 */
const STAT_META = {
  cpu: { title: 'CPU', metric: 'cpu', icon: 'cpu', series: [['cpu', 'CPU', '#7c5cff']], max: 100, fmt: (v) => fmtPct(v, v < 10 ? 1 : 0), live: (d) => ({ cpu: d.cpu.usage }) },
  mem: { title: 'Memory', metric: 'mem', icon: 'disk', series: [['mem', 'Memory used', '#22c1c3']], max: 100, fmt: (v) => fmtPct(v, 0), live: (d) => ({ mem: d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0 }) },
  disk: { title: 'Storage', metric: 'disk', icon: 'disk', series: [['dr', 'Read', '#7c5cff'], ['dw', 'Write', '#f472b6']], fmt: (v) => fmtRate(v), extraKey: ['disk', 'Root usage', (v) => fmtPct(v, 0)], live: (d) => { const p = d.primaryDisk || d.disks[0]; return { dr: (d.diskIo || {}).readRate || 0, dw: (d.diskIo || {}).writeRate || 0, disk: p ? (p.used / p.size) * 100 : null }; } },
  net: { title: 'Network', metric: 'net', icon: 'globe', series: [['rx', 'Download', '#7c5cff'], ['tx', 'Upload', '#f472b6']], fmt: (v) => fmtRate(v), live: (d) => ({ rx: d.network.rxRate, tx: d.network.txRate }) },
  temp: { title: 'Temperature', metric: 'temp', icon: 'thermo', series: [['temp', 'CPU temperature', '#f59e0b']], fmt: (v) => fmtNum(v, 0) + ' °C', live: (d) => ({ temp: d.cpuTemp }) },
  gpu: { title: 'GPU', metric: 'gpu', icon: 'chart', series: [['gpu', 'GPU utilisation', '#a78bfa']], max: 100, fmt: (v) => fmtPct(v, 0), live: (d) => ({ gpu: d.gpu ? d.gpu.util : null }) },
};
const STAT_RANGES = [['live', 'Live'], ['1h', '1h'], ['6h', '6h'], ['24h', '24h'], ['7d', '7d']];

function statBreakdownHtml(kind, d, procs) {
  if (kind === 'cpu') return `<h3 class="sub-h">Per core <span class="muted small">${esc(d.info.cpuModel)} · ${d.info.cpuCount} threads</span></h3>
    <div class="cores">${d.cpu.cores.map((c, i) => `<div class="core" title="CPU ${i}: ${fmtNum(c, 0)}%" role="img" aria-label="Core ${i} ${fmtNum(c, 0)} percent"><i style="height:${Math.min(100, c).toFixed(0)}%"></i><span>${fmtNum(c, 0)}</span></div>`).join('')}</div>
    <div class="kv" style="margin-top:14px"><div>Load average (1 / 5 / 15 min)</div><div class="num">${d.load.map((x) => fmtNum(x, 2)).join(' · ')}</div><div>Temperature</div><div class="num">${d.cpuTemp != null ? fmtNum(d.cpuTemp, 0) + ' °C' : '–'}</div><div>Processes</div><div class="num">${esc(d.procs)}</div></div>`;
  if (kind === 'mem') { const m0 = d.memory; return `<div class="kv"><div>Used</div><div class="num">${fmtBytes(m0.used)}</div><div>Available</div><div class="num">${fmtBytes(m0.available)}</div><div>Total</div><div class="num">${fmtBytes(m0.total)}</div><div>Cached</div><div class="num">${fmtBytes(m0.cached || 0)}</div><div>Buffers</div><div class="num">${fmtBytes(m0.buffers || 0)}</div><div>Swap</div><div class="num">${m0.swapTotal ? `${fmtBytes(m0.swapUsed)} / ${fmtBytes(m0.swapTotal)}` : 'none'}</div></div>
    <h3 class="sub-h">Top memory processes</h3>${procs.length ? `<table><thead><tr><th>PID</th><th>User</th><th>Name</th><th class="right">RSS</th><th class="right">%</th></tr></thead><tbody>${procs.map((p) => `<tr><td class="mono">${p.pid}</td><td>${esc(p.user)}</td><td class="ellipsis">${esc(p.name)}</td><td class="right num">${fmtBytes(p.rss)}</td><td class="right num">${fmtNum(p.mem, 1)}</td></tr>`).join('')}</tbody></table>` : skel('text', 3)}`; }
  if (kind === 'disk') { const dio = d.diskIo || { disks: [] }; const pm = d.primaryDisk && d.primaryDisk.mount; return `<h3 class="sub-h">Mounts</h3>${d.disks.map((x) => { const p = (x.used / x.size) * 100; return `<div class="mount-row"><div class="row small"><b class="ellipsis">${esc(x.mount)}</b>${x.mount === pm ? '<span class="chip ok">primary</span>' : ''}<span class="muted ellipsis grow">${esc(x.fs)} · ${esc(x.type)}</span><span class="num">${fmtBytes(x.used)} / ${fmtBytes(x.size)}</span></div>${bar(p)}<div class="muted small">${fmtBytes(x.avail)} free · ${fmtPct(p, 0)} used</div></div>`; }).join('') || '<div class="muted">No mounts</div>'}
    ${dio.disks && dio.disks.length ? `<h3 class="sub-h">Per device I/O</h3><table><thead><tr><th>Device</th><th class="right">Read</th><th class="right">Write</th><th class="right">Total read / written</th></tr></thead><tbody>${dio.disks.map((x) => `<tr><td class="mono">${esc(x.name)}</td><td class="right num">${fmtRate(x.readRate)}</td><td class="right num">${fmtRate(x.writeRate)}</td><td class="right muted num">${fmtBytes(x.readBytes)} / ${fmtBytes(x.writeBytes)}</td></tr>`).join('')}</tbody></table>` : ''}`; }
  if (kind === 'net') return `<h3 class="sub-h">Per interface</h3><table><thead><tr><th>Interface</th><th class="right">Download</th><th class="right">Upload</th><th class="right">Total ↓ / ↑</th></tr></thead><tbody>${d.network.interfaces.map((i) => `<tr><td class="mono">${esc(i.name)}</td><td class="right num">${fmtRate(i.rxRate)}</td><td class="right num">${fmtRate(i.txRate)}</td><td class="right muted num">${fmtBytes(i.rxBytes)} / ${fmtBytes(i.txBytes)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No interfaces</td></tr>'}</tbody></table>`;
  if (kind === 'temp') return `<h3 class="sub-h">Sensors</h3>${(d.temps || []).map((t) => `<div class="mount-row"><div class="row small"><span class="grow ellipsis">${esc(t.sensor)} <span class="muted">${esc(t.label)}</span></span><b class="num">${fmtNum(t.celsius, 1)} °C</b></div><div class="bar ${t.celsius >= 85 ? 'crit' : t.celsius >= 70 ? 'warn' : ''}"><i style="width:${Math.min(100, t.celsius)}%"></i></div></div>`).join('') || '<div class="muted">No temperature sensors are exposed on this host (common on VPS / cloud servers).</div>'}`;
  if (kind === 'gpu') { const g = d.gpu; if (!g) return '<div class="muted">No GPU reported (nvidia-smi not available on this host).</div>'; return `<div class="kv"><div>Model</div><div>${esc(g.name)}</div><div>VRAM</div><div class="num">${g.memTotal ? `${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}` : 'n/a'}</div><div>Temperature</div><div class="num">${g.temp != null ? fmtNum(g.temp, 0) + ' °C' : '–'}</div></div>
    ${(g.devices || []).length > 1 ? `<h3 class="sub-h">Per GPU</h3><table><thead><tr><th>GPU</th><th class="right">Util</th><th class="right">VRAM</th><th class="right">Temp</th></tr></thead><tbody>${g.devices.map((x, i) => `<tr><td class="ellipsis">${esc(x.name || 'GPU ' + i)}</td><td class="right num">${x.util == null ? '–' : fmtNum(x.util, 0) + '%'}</td><td class="right num">${x.memTotal ? `${fmtBytes(x.memUsed)} / ${fmtBytes(x.memTotal)}` : '–'}</td><td class="right num">${x.temp != null ? fmtNum(x.temp, 0) + '°C' : '–'}</td></tr>`).join('')}</tbody></table>` : ''}`; }
  return '';
}

function openStatExpand(kind) {
  const M = STAT_META[kind]; if (!M) return;
  const keys = M.series.map((x) => x[0]).concat(M.extraKey ? [M.extraKey[0]] : []);
  const live = {}; keys.forEach((k) => { live[k] = []; });
  // seed Live from the in-browser buffer (one sample ~ every 3 s)
  const h = Stats.history; const seedMap = { cpu: h.cpu, mem: h.mem, rx: h.rx, tx: h.tx, gpu: h.gpu };
  const now0 = Date.now();
  keys.forEach((k) => { const arr = seedMap[k] || []; live[k] = arr.map((v, i) => ({ t: now0 - (arr.length - 1 - i) * 3000, v })); });
  let range = localStorage.getItem('uiable-stat-range') || '1h'; let data = null; let retain = 7; let procs = []; let unsub = null; let ptimer = null;
  const LIVE_CAP = 200;

  const summaryOf = (k) => {
    if (range !== 'live' && data) return data.summary[k] || {};
    const vals = live[k].map((p) => p.v).filter((v) => v != null);
    if (!vals.length) return {};
    return { min: Math.min(...vals), max: Math.max(...vals), avg: vals.reduce((a, b) => a + b, 0) / vals.length, current: vals[vals.length - 1], count: vals.length };
  };
  const paintSummary = (m) => {
    const rows = M.series.map(([k, label, color]) => [k, label, color, M.fmt]).concat(M.extraKey ? [[M.extraKey[0], M.extraKey[1], null, M.extraKey[2]]] : []);
    const f = (fn, v) => (v == null ? '–' : fn(v));
    $('[data-sum]', m).innerHTML = `<table class="sum-table"><thead><tr><th></th><th class="right">Current</th><th class="right">Average</th><th class="right">Min</th><th class="right">Max</th></tr></thead><tbody>${rows.map(([k, label, color, fn]) => { const s = summaryOf(k); const cur = range === 'live' || s.current == null ? (live[k].length ? live[k][live[k].length - 1].v : s.current) : s.current; return `<tr><td>${color ? `<i class="key" style="background:${color}"></i>` : ''}${esc(label)}</td><td class="right num"><b>${f(fn, cur)}</b></td><td class="right num">${f(fn, s.avg)}</td><td class="right num">${f(fn, s.min)}</td><td class="right num">${f(fn, s.max)}</td></tr>`; }).join('')}</tbody></table>`;
  };
  const paintChart = (m) => {
    const cv = $('[data-chart]', m); const note = $('[data-chart-note]', m);
    let series;
    if (range === 'live') series = M.series.map(([k, label, color]) => ({ label, color, data: live[k] }));
    else series = M.series.map(([k, label, color]) => ({ label, color, data: (data ? data.points : []).map((p) => ({ t: p.t, v: p[k], lo: p[k + 'Min'], hi: p[k + 'Max'] })) }));
    const has = series.some((s) => s.data.some((p) => p.v != null));
    note.hidden = has;
    if (!has) note.innerHTML = range === 'live' ? 'Collecting live samples…' : `No stored history for this range yet. Uiable records a sample every ${data ? data.intervalSec : 60} s and keeps ${retain} day${retain === 1 ? '' : 's'} (Metrics history → Settings).`;
    const opts = { max: M.max, fmt: M.fmt, tipEl: $('[data-tip]', m) };
    if (range !== 'live' && data) Object.assign(opts, { from: data.from, to: data.to });
    if (range === 'live') Object.assign(opts, { from: Date.now() - Math.max(60000, (live[M.series[0][0]].length) * 3000), to: Date.now() });
    drawChart(cv, has ? series : [{ label: '', color: '#888888', data: [] }], opts);
    const s = summaryOf(M.series[0][0]);
    cv.setAttribute('aria-label', `${M.title} ${range === 'live' ? 'live' : 'over ' + range}: average ${s.avg == null ? 'unknown' : M.fmt(s.avg)}, max ${s.max == null ? 'unknown' : M.fmt(s.max)}`);
  };
  const loadRange = async (m) => {
    if (range === 'live') { data = null; paintChart(m); paintSummary(m); return; }
    $('[data-chart-wrap]', m).classList.add('loading');
    try {
      data = await GET(`/metrics/range?metric=${M.metric}&range=${range}&points=240`);
      retain = data.retainDays;
      $$('[data-range]', m).forEach((b) => { const hrs = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 }[b.dataset.range]; b.disabled = hrs && hrs > retain * 24; if (b.disabled) b.title = `History is kept for ${retain} day${retain === 1 ? '' : 's'}`; });
    } catch (e) { data = null; $('[data-chart-note]', m).textContent = e.message; }
    $('[data-chart-wrap]', m).classList.remove('loading');
    paintChart(m); paintSummary(m);
  };

  modal({
    title: M.title, wide: true, cls: 'stat-modal',
    body: `<div class="stat-head row wrap"><div class="seg" role="radiogroup" aria-label="Time range">${STAT_RANGES.map(([id, l]) => `<button type="button" role="radio" data-range="${id}" aria-checked="${id === range}" class="${id === range ? 'active' : ''}">${l}</button>`).join('')}</div><span class="spacer"></span><span class="legend">${M.series.map(([, l, c]) => `<span><i class="key" style="background:${c}"></i>${esc(l)}</span>`).join('')}</span></div>
      <div class="chart-wrap" data-chart-wrap><canvas class="big-chart" data-chart role="img" tabindex="0"></canvas><div class="chart-tip" data-tip hidden></div><div class="chart-note muted small" data-chart-note hidden></div></div>
      <div data-sum class="sum"></div>
      <div data-breakdown class="breakdown">${skel('text', 4)}</div>`,
    buttons: [{ label: 'Close', value: null }],
    onOpen: (m) => {
      $$('[data-range]', m).forEach((b) => (b.onclick = () => {
        range = b.dataset.range; localStorage.setItem('uiable-stat-range', range);
        $$('[data-range]', m).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', x === b); });
        loadRange(m);
      }));
      const onResize = () => paintChart(m);
      window.addEventListener('resize', onResize);
      const loadProcs = async () => { if (kind !== 'mem') return; try { procs = ((await GET('/system/processes')).processes || []).slice().sort((a, b) => b.rss - a.rss).slice(0, 8); } catch (_) { procs = []; } };
      loadProcs(); if (kind === 'mem') ptimer = setInterval(loadProcs, 8000);
      unsub = Stats.subscribe((d) => {
        const v = M.live(d); const t = Date.now();
        keys.forEach((k) => { if (v[k] !== undefined) { live[k].push({ t, v: v[k] }); while (live[k].length > LIVE_CAP) live[k].shift(); } });
        const bd = $('[data-breakdown]', m); if (bd) bd.innerHTML = statBreakdownHtml(kind, d, procs);
        if (range === 'live') paintChart(m);
        paintSummary(m);
      });
      requestAnimationFrame(() => loadRange(m));
      return () => { if (unsub) unsub(); clearInterval(ptimer); window.removeEventListener('resize', onResize); };
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
    <div class="card"><div class="card-title">${ICON.cpu} CPU cores<span class="spacer"></span><button type="button" class="sm" data-expand="cpu" aria-label="Open cpu details">Details</button></div><div class="cores" data-k="cores"></div><div class="muted small" style="margin-top:12px" data-k="cpumodel"></div></div>
    <div class="card"><div class="card-title">${ICON.disk} Disks<span class="spacer"></span><button type="button" class="sm" data-expand="disk" aria-label="Open disk details">Details</button></div><div data-k="disks"></div></div>
    <div class="card"><div class="card-title">${ICON.globe} Network interfaces<span class="spacer"></span><button type="button" class="sm" data-expand="net" aria-label="Open net details">Details</button></div><div data-k="net"></div></div>
    <div class="card"><div class="card-title">${ICON.thermo} Temperatures<span class="spacer"></span><button type="button" class="sm" data-expand="temp" aria-label="Open temp details">Details</button></div><div data-k="temps"></div></div>
    <div class="card"><div class="card-title">${ICON.disk} Memory &amp; swap<span class="spacer"></span><button type="button" class="sm" data-expand="mem" aria-label="Open mem details">Details</button></div><div data-k="mem"></div></div>
    <div class="card hidden" data-gpu-card><div class="card-title">GPU<span class="spacer"></span><button type="button" class="sm" data-expand="gpu">Details</button></div><div data-k="gpu"></div></div>
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
    const gpuCard = el.querySelector('[data-gpu-card]');
    if (gpuCard) {
      if (d.gpu) {
        gpuCard.classList.remove('hidden');
        const g = d.gpu;
        k('gpu').innerHTML = `<div class="row small"><span class="grow ellipsis">${esc(g.name)}</span><b class="num">${g.util == null ? '–' : fmtNum(g.util, 0) + '%'}</b></div>
          <div style="margin:6px 0 12px">${bar(g.util || 0)}</div>
          <div class="kv small"><div>VRAM</div><div class="num">${g.memTotal ? `${fmtBytes(g.memUsed)} / ${fmtBytes(g.memTotal)}` : 'n/a'}</div>
          <div>Temp</div><div class="num">${g.temp != null ? fmtNum(g.temp, 0) + ' °C' : '–'}</div>
          <div>Devices</div><div class="num">${g.count || 1}</div></div>`;
      } else {
        gpuCard.classList.add('hidden');
      }
    }
  });
  return unsub;
};

document.addEventListener('DOMContentLoaded', boot);
