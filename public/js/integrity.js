'use strict';
Pages.integrity = (el) => {
  el.innerHTML = `<div class="toolbar">
    <button class="primary" data-add>Watch path</button>
    <button data-scan>Scan now</button>
    <button data-settings>Schedule</button>
    <button data-ref>${ICON.refresh}</button>
  </div><div data-body></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/integrity');
      body.innerHTML = `<div class="card"><div class="card-title">File integrity
        <span class="muted small">${r.scheduleEnabled === false ? 'schedule off' : 'every ' + esc(String(r.intervalMinutes)) + ' min'}
          · alerts ${r.alertOnChange === false ? 'off' : 'on'}
          · last ${r.lastRun ? esc(fmtDate(r.lastRun)) : 'never'}</span></div>
        <table><thead><tr><th>Path</th><th>Hash</th><th>Last OK</th><th>Changed</th><th></th></tr></thead><tbody>
        ${(r.paths || []).map((p) => `<tr class="${p.lastChange ? 'warn' : ''}">
          <td class="mono">${esc(p.path)}</td><td class="mono small muted">${esc(p.hash || '—')}</td>
          <td class="muted small">${p.lastOk ? esc(fmtDate(p.lastOk)) : '—'}</td>
          <td class="muted small">${p.lastChange ? esc(fmtDate(p.lastChange)) : '—'} ${p.error ? esc(p.error) : ''}</td>
          <td><button class="sm danger" data-del="${esc(p.id)}">Remove</button></td>
        </tr>`).join('') || '<tr><td colspan="5" class="empty">No paths watched</td></tr>'}
        </tbody></table></div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  el.onclick = async (e) => {
    if (e.target.closest('[data-ref]')) return load();
    if (e.target.closest('[data-settings]')) {
      const cur = await GET('/integrity');
      const f = await formDlg('Integrity schedule', [
        { name: 'intervalMinutes', label: 'Interval (minutes)', value: String(cur.intervalMinutes || 60) },
        { name: 'scheduleEnabled', label: 'Schedule enabled', type: 'select', value: cur.scheduleEnabled === false ? 'no' : 'yes', options: ['yes', 'no'] },
        { name: 'alertOnChange', label: 'Alert on mismatch', type: 'select', value: cur.alertOnChange === false ? 'no' : 'yes', options: ['yes', 'no'] },
      ], 'Save');
      if (!f) return;
      await act(null, () => api('PUT', '/integrity', {
        intervalMinutes: Number(f.intervalMinutes) || 60,
        scheduleEnabled: f.scheduleEnabled !== 'no',
        alertOnChange: f.alertOnChange !== 'no',
      }), 'Saved');
      return load();
    }
    if (e.target.closest('[data-add]')) {
      const f = await formDlg('Watch path', [{ name: 'path', label: 'Absolute path', value: '/etc/passwd' }], 'Watch');
      if (!f || !f.path) return;
      await act(null, () => POST('/integrity/paths', { path: f.path }), 'Watching');
      return load();
    }
    if (e.target.closest('[data-scan]')) {
      await act(null, () => POST('/integrity/scan'), 'Scan complete');
      return load();
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      await act(del, () => api('DELETE', '/integrity/paths/' + encodeURIComponent(del.dataset.del)), 'Removed');
      return load();
    }
  };
  load();
};
