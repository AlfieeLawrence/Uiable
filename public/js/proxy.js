'use strict';
Pages.proxy = (el) => {
  el.innerHTML = `<div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    const r = await GET('/proxy');
    body.innerHTML = `<div class="card section"><div class="card-title">${ICON.globe} Caddy reverse proxy <span class="chip ${r.running ? 'ok' : ''}">${r.running ? 'running' : 'stopped'}</span></div>
      <p class="muted">Optional. When enabled, Uiable starts a Caddy container that gives your apps local HTTPS hostnames with an internal CA. Nothing runs until you turn this on.</p>
      <label class="row" style="margin:12px 0"><input type="checkbox" data-en ${r.enabled ? 'checked' : ''}> Enable Caddy proxy</label>
      <div class="row wrap"><label class="field" style="margin:0"><span>HTTP port</span><input data-http type="number" value="${r.httpPort}" style="width:100px"></label>
        <label class="field" style="margin:0"><span>HTTPS port</span><input data-https type="number" value="${r.httpsPort}" style="width:100px"></label></div>
      ${r.conflicts && r.conflicts.length ? `<div class="notice">Port conflict: ${esc(r.conflicts.map((c) => c.usedBy).join(', '))}. Umbrel and many apps use 80/443 — pick alternate ports above.</div>` : ''}
      <div class="card-title" style="margin-top:18px">Routes</div>
      <div data-routes>${(r.routes || []).map((x, i) => routeRow(x, i)).join('') || '<div class="muted">No routes yet</div>'}</div>
      <button class="sm" data-add style="margin-top:8px">${ICON.plus} Add route</button>
      <div class="row" style="margin-top:18px"><button class="primary" data-save>Save &amp; apply</button>
        <a class="btn sm" href="/api/proxy/root-cert" data-cert>Download root certificate</a></div></div>`;
  };
  const routeRow = (x = {}, i) => `<div class="list-item" data-i="${i}"><input data-host placeholder="app.local" value="${esc(x.host || '')}" style="max-width:180px">
    <input data-up placeholder="127.0.0.1:8096" value="${esc(x.upstream || '')}" style="max-width:200px">
    <input data-label placeholder="label" value="${esc(x.label || '')}" style="max-width:140px">
    <button class="sm icon danger" data-rm>${ICON.x}</button></div>`;
  body.onclick = async (e) => {
    if (e.target.closest('[data-add]')) { $('[data-routes]', body).insertAdjacentHTML('beforeend', routeRow({}, $$('[data-routes] .list-item', body).length)); return; }
    if (e.target.closest('[data-rm]')) { e.target.closest('.list-item').remove(); return; }
    if (e.target.closest('[data-cert]')) { e.preventDefault(); window.open('/api/proxy/root-cert'); return; }
    if (e.target.closest('[data-save]')) {
      const routes = $$('[data-routes] .list-item', body).map((row) => ({ host: $('[data-host]', row).value.trim(), upstream: $('[data-up]', row).value.trim(), label: $('[data-label]', row).value.trim() }));
      const payload = { enabled: $('[data-en]', body).checked, httpPort: +$('[data-http]', body).value, httpsPort: +$('[data-https]', body).value, routes };
      const r = await act(e.target, () => api('PUT', '/proxy', payload));
      if (r) { if (r.job) await watchJob(r.job, r.enabled ? 'Starting Caddy' : 'Stopping Caddy'); toast('Saved'); load(); }
    }
  };
  load().catch((e) => { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; });
};
