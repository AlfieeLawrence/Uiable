'use strict';
Pages.audit = (el) => {
  el.innerHTML = `<div class="toolbar"><input class="search" data-q placeholder="Search…"><input data-user placeholder="User" style="max-width:140px"><input data-action placeholder="Action prefix" style="max-width:160px"><button data-go>${ICON.refresh}</button><div class="spacer"></div><span class="muted small" data-ret></span></div>
    <div class="card flush"><div class="table-wrap"><table><thead><tr><th>When</th><th>User</th><th>Action</th><th>IP</th><th>Status</th><th>Details</th></tr></thead><tbody></tbody></table></div></div>`;
  const tbody = $('tbody', el);
  const load = async () => {
    try {
      const r = await GET(`/audit?q=${encodeURIComponent($('[data-q]', el).value)}&user=${encodeURIComponent($('[data-user]', el).value)}&action=${encodeURIComponent($('[data-action]', el).value)}&limit=300`);
      $('[data-ret]', el).textContent = `Retention ${r.retentionDays} days · ${r.entries.length} shown`;
      tbody.innerHTML = r.entries.map((e) => `<tr><td class="nowrap muted small">${esc(fmtDate(Date.parse(e.t)))}</td><td>${esc(e.user || '—')}</td>
        <td class="mono small">${esc(e.action)}</td><td class="mono small muted">${esc(e.ip || '')}</td>
        <td>${e.ok === false || (e.status && e.status >= 400) ? `<span class="chip bad">${esc(e.status || 'fail')}</span>` : `<span class="chip ok">${esc(e.status || 'ok')}</span>`}</td>
        <td class="small muted ellipsis" style="max-width:280px">${esc(e.details ? JSON.stringify(e.details) : '')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No entries</td></tr>';
    } catch (e) { toastErr(e); }
  };
  $('[data-go]', el).onclick = load; $('.search', el).onkeydown = (e) => { if (e.key === 'Enter') load(); };
  load();
};
