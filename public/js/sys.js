'use strict';
/* Processes and systemd services. */

Pages.processes = (el) => {
  let sort = { key: 'cpu', dir: -1 }; let filter = ''; let data = []; let paused = false;
  el.innerHTML = `<div class="toolbar"><input class="search" placeholder="Filter by name, user, PID or command…">
    <span class="muted small" data-count></span><div class="spacer"></div>
    <label class="row small"><input type="checkbox" data-auto checked> Live refresh</label>
    <button data-refresh>${ICON.refresh} Refresh</button></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr>
      ${[['pid', 'PID'], ['user', 'User'], ['cpu', 'CPU %'], ['mem', 'Mem %'], ['rss', 'RSS'], ['elapsed', 'Uptime'], ['stat', 'State'], ['name', 'Command']].map(([k, l]) => `<th class="sortable ${['cpu', 'mem', 'rss', 'elapsed', 'pid'].includes(k) ? 'right' : ''}" data-sort="${k}">${l}</th>`).join('')}<th></th></tr></thead><tbody></tbody></table></div></div>`;
  const tbody = $('tbody', el);
  const render = () => {
    const f = filter.toLowerCase();
    const rows = data.filter((p) => !f || String(p.pid).includes(f) || p.user.toLowerCase().includes(f) || p.cmd.toLowerCase().includes(f) || p.name.toLowerCase().includes(f))
      .sort((a, b) => { const x = a[sort.key], y = b[sort.key]; return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir; });
    $('[data-count]', el).textContent = `${rows.length} of ${data.length} processes`;
    tbody.innerHTML = rows.slice(0, 400).map((p) => `<tr><td class="right mono">${p.pid}</td><td>${esc(p.user)}</td>
      <td class="right"><b style="color:${p.cpu > 50 ? 'var(--danger)' : p.cpu > 10 ? 'var(--warn)' : 'inherit'}">${p.cpu.toFixed(1)}</b></td><td class="right">${p.mem.toFixed(1)}</td>
      <td class="right nowrap">${fmtBytes(p.rss)}</td><td class="right nowrap muted">${fmtDur(p.elapsed)}</td><td class="mono muted">${esc(p.stat)}</td>
      <td style="max-width:520px"><div class="ellipsis" title="${esc(p.cmd)}"><b>${esc(p.name)}</b> <span class="muted mono">${esc(p.cmd)}</span></div></td>
      <td><div class="actions"><button class="sm" data-kill="${p.pid}" data-sig="SIGTERM" title="Send SIGTERM">End</button><button class="sm danger" data-kill="${p.pid}" data-sig="SIGKILL" title="Send SIGKILL">Kill</button></div></td></tr>`).join('');
  };
  const load = async () => { try { data = (await GET('/system/processes')).processes; render(); } catch (e) { toastErr(e); } };
  $('.search', el).oninput = (e) => { filter = e.target.value; render(); };
  $('[data-refresh]', el).onclick = load;
  $('[data-auto]', el).onchange = (e) => { paused = !e.target.checked; };
  $$('th[data-sort]', el).forEach((th) => (th.onclick = () => { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (['user', 'name', 'stat'].includes(k) ? 1 : -1) }; render(); }));
  tbody.onclick = async (e) => {
    const b = e.target.closest('[data-kill]'); if (!b) return;
    const p = data.find((x) => x.pid === +b.dataset.kill);
    if (!(await confirmDlg(`${b.dataset.sig === 'SIGKILL' ? 'Kill' : 'End'} process ${b.dataset.kill}?`, `Send <b>${b.dataset.sig}</b> to <span class="mono">${esc(p ? p.name : '')}</span> (PID ${b.dataset.kill}).`, { okLabel: b.dataset.sig === 'SIGKILL' ? 'Kill' : 'End process', danger: true }))) return;
    await act(null, () => POST(`/system/processes/${b.dataset.kill}/kill`, { signal: b.dataset.sig }), 'Signal sent');
    setTimeout(load, 400);
  };
  load();
  const t = setInterval(() => { if (!paused && !document.hidden && !$('.modal-bg')) load(); }, 5000);
  return () => clearInterval(t);
};

Pages.services = (el) => {
  let data = []; let filter = ''; let show = 'all';
  el.innerHTML = `<div class="toolbar"><input class="search" placeholder="Filter services…">
    <div class="seg">${['all', 'running', 'failed', 'inactive'].map((s) => `<button data-show="${s}" class="${s === 'all' ? 'active' : ''}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <span class="muted small" data-count></span><div class="spacer"></div><button data-refresh>${ICON.refresh} Refresh</button></div>
    <div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const chip = (s) => { const c = s.active === 'active' ? (s.sub === 'running' ? 'ok' : 'ok') : s.active === 'failed' ? 'bad' : s.active === 'activating' || s.active === 'deactivating' ? 'warn' : ''; return `<span class="chip ${c}">${esc(s.active)}${s.sub && s.sub !== s.active ? ' · ' + esc(s.sub) : ''}</span>`; };
  const render = () => {
    const f = filter.toLowerCase();
    const rows = data.filter((s) => (!f || s.name.toLowerCase().includes(f) || s.description.toLowerCase().includes(f)) &&
      (show === 'all' || (show === 'running' && s.sub === 'running') || (show === 'failed' && s.active === 'failed') || (show === 'inactive' && s.active === 'inactive')));
    $('[data-count]', el).textContent = `${rows.length} services`;
    body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Service</th><th>Status</th><th class="hide-sm">Boot</th><th class="hide-sm">Description</th><th></th></tr></thead><tbody>
      ${rows.map((s) => `<tr><td class="mono"><a href="#" data-status="${esc(s.name)}" style="color:inherit">${esc(s.name.replace(/\.service$/, ''))}</a></td><td>${chip(s)}</td>
      <td class="hide-sm"><span class="chip plain">${esc(s.enabled || '–')}</span></td><td class="hide-sm muted ellipsis" style="max-width:340px">${esc(s.description)}</td>
      <td><div class="actions">
        ${s.active === 'active' ? `<button class="sm icon" title="Restart" data-a="restart" data-n="${esc(s.name)}">${ICON.restart}</button><button class="sm icon danger" title="Stop" data-a="stop" data-n="${esc(s.name)}">${ICON.stop}</button>` : `<button class="sm icon" title="Start" data-a="start" data-n="${esc(s.name)}">${ICON.play}</button>`}
        ${s.enabled === 'enabled' ? `<button class="sm" data-a="disable" data-n="${esc(s.name)}">Disable</button>` : s.enabled === 'disabled' ? `<button class="sm" data-a="enable" data-n="${esc(s.name)}">Enable</button>` : ''}
        <button class="sm icon" title="Status & logs" data-status="${esc(s.name)}">${ICON.logs}</button>
      </div></td></tr>`).join('')}</tbody></table></div></div>`;
  };
  const load = async () => {
    try {
      const r = await GET('/system/services');
      if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
      data = r.services; render();
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $('.search', el).oninput = (e) => { filter = e.target.value; render(); };
  $$('[data-show]', el).forEach((b) => (b.onclick = () => { show = b.dataset.show; $$('[data-show]', el).forEach((x) => x.classList.toggle('active', x === b)); render(); }));
  $('[data-refresh]', el).onclick = load;
  body.onclick = async (e) => {
    const st = e.target.closest('[data-status]');
    if (st) {
      e.preventDefault();
      const r = await act(null, () => GET(`/system/services/${encodeURIComponent(st.dataset.status)}/status`));
      if (r) modal({ title: st.dataset.status, wide: true, body: `<pre>${esc(r.output || 'No output')}</pre>` });
      return;
    }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a, n = b.dataset.n;
    if ((a === 'stop' || a === 'disable') && !(await confirmDlg(`${a[0].toUpperCase() + a.slice(1)} ${n}?`, a === 'stop' ? 'The service will stop running until it is started again. Stopping ssh, networking or docker can cut off your access.' : 'The service will no longer start at boot.', { okLabel: a[0].toUpperCase() + a.slice(1), danger: true }))) return;
    await act(b, () => POST(`/system/services/${encodeURIComponent(n)}/${a}`), `${n}: ${a} done`);
    load();
  };
  load();
};
