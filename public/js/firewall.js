'use strict';
Pages.firewall = (el) => {
  el.innerHTML = `<div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/firewall');
      if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
      const fb = await GET('/firewall/fail2ban').catch(() => ({ available: false }));
      body.innerHTML = `<div class="grid cols-2">
        <div class="card"><div class="card-title">${ICON.shield} Firewall (${esc(r.backend)}) <span class="chip ${r.active ? 'ok' : ''}">${r.active ? 'active' : 'inactive'}</span>
          <span class="spacer"></span>${r.backend === 'ufw' ? (r.active ? `<button class="sm danger" data-dis>Disable</button>` : `<button class="sm primary" data-en>Enable</button>`) : ''}<button class="sm" data-ref>${ICON.refresh}</button></div>
          <div class="notice info">Protected: SSH port ${r.protected.ssh} and Uiable port ${r.protected.uiable} cannot be blocked from this UI.</div>
          <div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>#</th><th>Rule</th><th></th></tr></thead><tbody>
            ${r.rules.map((x) => `<tr><td class="muted">${esc(x.id)}</td><td class="mono small">${esc(x.text)}</td>
              <td>${r.backend === 'ufw' ? `<button class="sm danger" data-del="${esc(x.id)}">Delete</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No rules</td></tr>'}</tbody></table></div>
          ${r.backend === 'ufw' || r.backend === 'iptables' ? `<div class="row wrap" style="margin-top:14px">
            <select data-act style="width:auto"><option>allow</option><option>deny</option></select>
            <input data-spec placeholder="80/tcp or 22/tcp" style="max-width:220px">
            <button class="primary" data-add>Add rule</button></div>` : '<p class="muted small">Use the terminal to edit nftables rules.</p>'}
        </div>
        <div class="card"><div class="card-title">Listening ports</div>
          <table><thead><tr><th>Port</th><th>Proto</th><th>Address</th></tr></thead><tbody>
          ${r.listening.map((p) => `<tr><td class="mono">${p.port}</td><td>${esc(p.proto)}</td><td class="mono muted">${esc(p.address)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">None</td></tr>'}</tbody></table></div>
        <div class="card" style="grid-column:1/-1"><div class="card-title">fail2ban ${fb.available ? '' : '<span class="chip">unavailable</span>'}</div>
          ${!fb.available ? `<p class="muted">${esc(fb.message || 'fail2ban-client not installed')}</p>` : `
          <div class="table-wrap"><table><thead><tr><th>Jail</th><th>Failed</th><th>Banned</th><th>IPs</th></tr></thead><tbody>
            ${(fb.jails||[]).map((j) => `<tr><td class="mono">${esc(j.name)}</td><td>${j.failed}</td><td>${j.bannedCount}</td>
              <td class="mono small">${(j.banned||[]).map((ip) => `${esc(ip)} <button class="sm" data-unban="${esc(j.name)}" data-ip="${esc(ip)}">Unban</button>`).join(' ') || '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No jails</td></tr>'}
          </tbody></table></div>`}
        </div></div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  body.onclick = async (e) => {
    if (e.target.closest('[data-ref]')) return load();
    if (e.target.closest('[data-en]')) { if (!(await confirmDlg('Enable UFW?', 'SSH and Uiable ports will be allowed first.', { okLabel: 'Enable' }))) return; await act(null, () => POST('/firewall/enable'), 'Enabled'); return load(); }
    if (e.target.closest('[data-dis]')) { if (!(await confirmDlg('Disable UFW?', 'The host will accept all traffic.', { okLabel: 'Disable', danger: true }))) return; await act(null, () => POST('/firewall/disable'), 'Disabled'); return load(); }
    const del = e.target.closest('[data-del]');
    if (del) { if (!(await confirmDlg('Delete rule #' + del.dataset.del + '?', 'Make sure this is not your SSH allow rule.', { okLabel: 'Delete', danger: true }))) return; await act(del, () => POST('/firewall/rule', { action: 'delete', spec: del.dataset.del }), 'Deleted'); return load(); }
    const un = e.target.closest('[data-unban]');
    if (un) { await act(un, () => POST('/firewall/fail2ban/unban', { jail: un.dataset.unban, ip: un.dataset.ip }), 'Unbanned'); return load(); }
    if (e.target.closest('[data-add]')) {
      await act(e.target, () => POST('/firewall/rule', { action: $('[data-act]', body).value, spec: $('[data-spec]', body).value.trim() }), 'Rule added');
      return load();
    }
  };
  load();
};
