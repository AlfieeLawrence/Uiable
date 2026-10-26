'use strict';
Pages.wireguard = (el) => {
  el.innerHTML = `<div class="toolbar">
    <button class="primary" data-up>Bring up iface</button>
    <button data-ref>${ICON.refresh} Refresh</button>
  </div><div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/wireguard');
      if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
      body.innerHTML = (r.interfaces || []).map((iface) => `<div class="card" style="margin-bottom:14px">
        <div class="card-title">${ICON.globe} ${esc(iface.name)}
          <span class="muted small mono">port ${iface.listenPort || '?'} · ${esc((iface.publicKey || '').slice(0, 16))}…</span>
          <span class="spacer"></span>
          <button class="sm" data-down="${esc(iface.name)}">Down</button>
          <button class="sm primary" data-add="${esc(iface.name)}">Add peer</button>
        </div>
        <div class="table-wrap"><table><thead><tr><th>Peer</th><th>Endpoint</th><th>Allowed IPs</th><th>Handshake</th><th>Transfer</th><th></th></tr></thead><tbody>
          ${(iface.peers || []).map((p) => `<tr>
            <td class="mono small">${esc((p.publicKey || '').slice(0, 20))}…</td>
            <td class="mono small">${esc(p.endpoint || '—')}</td>
            <td class="mono small">${esc((p.allowedIps || []).join(', '))}</td>
            <td class="muted small">${p.latestHandshake ? esc(fmtDate(p.latestHandshake * 1000)) : '—'}</td>
            <td class="muted small">${fmtBytes(p.transferRx || 0)} ↓ / ${fmtBytes(p.transferTx || 0)} ↑</td>
            <td class="row">
              <button class="sm" data-cfg="${esc(iface.name)}" data-pub="${esc(p.publicKey)}">Config/QR</button>
              <button class="sm danger" data-del="${esc(iface.name)}" data-pub="${esc(p.publicKey)}">Remove</button>
            </td>
          </tr>`).join('') || '<tr><td colspan="6" class="empty">No peers</td></tr>'}
        </tbody></table></div>
      </div>`).join('') || '<div class="empty">No WireGuard interfaces up. Use “Bring up iface” if /etc/wireguard/&lt;name&gt;.conf exists.</div>';
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  el.onclick = async (e) => {
    if (e.target.closest('[data-ref]')) return load();
    if (e.target.closest('[data-up]')) {
      const f = await formDlg('Bring up WireGuard', [{ name: 'iface', label: 'Interface', value: 'wg0' }], 'Up');
      if (!f || !f.iface) return;
      await act(null, () => POST('/wireguard/' + encodeURIComponent(f.iface) + '/up'), 'Interface up');
      return load();
    }
    const down = e.target.closest('[data-down]');
    if (down) {
      if (!(await confirmDlg('Bring down ' + down.dataset.down + '?', 'Disconnects all peers on this interface.', { okLabel: 'Down', danger: true }))) return;
      await act(down, () => POST('/wireguard/' + encodeURIComponent(down.dataset.down) + '/down'), 'Down');
      return load();
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      const f = await formDlg('Add WireGuard peer', [
        { name: 'allowedIps', label: 'Allowed IPs', value: '10.0.0.2/32' },
        { name: 'endpoint', label: 'Endpoint (optional)', value: '' },
        { name: 'keepalive', label: 'Keepalive seconds', value: '25' },
      ], 'Add');
      if (!f) return;
      const r = await act(add, () => POST('/wireguard/' + encodeURIComponent(add.dataset.add) + '/peers', f));
      if (r && r.privateKey) {
        modal({ title: 'Peer created', body: `<p>Store this private key now — it is shown once.</p>
          <p class="mono small">Public: ${esc(r.publicKey)}</p>
          <p class="mono small">Private: ${esc(r.privateKey)}</p>
          <p class="muted small">Use Config/QR on the peer row to download a client config.</p>` });
      }
      return load();
    }
    const cfg = e.target.closest('[data-cfg]');
    if (cfg) {
      const f = await formDlg('Client config / QR', [
        { name: 'serverEndpoint', label: 'Server endpoint (host:port)', value: '' },
        { name: 'privateKey', label: 'Client private key (if you have it)', type: 'password', value: '' },
        { name: 'address', label: 'Client address', value: '' },
        { name: 'dns', label: 'DNS', value: '1.1.1.1' },
      ], 'Generate');
      if (!f || !f.serverEndpoint) return;
      const r = await act(cfg, () => POST('/wireguard/' + encodeURIComponent(cfg.dataset.cfg) + '/peers/' + encodeURIComponent(cfg.dataset.pub) + '/config', f));
      if (!r) return;
      const blob = new Blob([r.config || ''], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      modal({
        title: 'Peer config',
        wide: true,
        body: `${r.qrDataUrl ? `<p><img alt="QR" src="${r.qrDataUrl}" style="background:#fff;padding:8px;border-radius:8px"></p>` : '<p class="muted">QR unavailable</p>'}
          <p><a download="${esc(r.filename || 'wg.conf')}" href="${url}">Download ${esc(r.filename || 'wg.conf')}</a></p>
          <pre class="mono small">${esc(r.config || '')}</pre>`,
      });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmDlg('Remove peer?', (del.dataset.pub || '').slice(0, 16) + '…', { okLabel: 'Remove', danger: true }))) return;
      await act(del, () => api('DELETE', '/wireguard/' + encodeURIComponent(del.dataset.del) + '/peers/' + encodeURIComponent(del.dataset.pub)), 'Removed');
      return load();
    }
  };
  load();
};
