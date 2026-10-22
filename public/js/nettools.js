'use strict';
Pages['network-tools'] = (el) => {
  el.innerHTML = `<div class="tabs">${['ping', 'traceroute', 'dns', 'speed', 'lan'].map((t, i) => `<button data-tab="${t}" class="${i ? '' : 'active'}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div><div data-body></div>`;
  let tab = 'ping';
  const body = $('[data-body]', el);
  const show = () => {
    if (tab === 'ping') {
      body.innerHTML = `<div class="card"><div class="row wrap"><input data-host placeholder="host or IP" style="max-width:280px"><input data-n type="number" value="4" min="1" max="20" style="width:80px"><button class="primary" data-go>Ping</button></div><pre class="out" data-out style="margin-top:12px;min-height:160px"></pre></div>`;
      $('[data-go]', body).onclick = async (e) => { const r = await act(e.target, () => POST('/nettools/ping', { host: $('[data-host]', body).value, count: +$('[data-n]', body).value })); if (r) $('[data-out]', body).textContent = r.output; };
    } else if (tab === 'traceroute') {
      body.innerHTML = `<div class="card"><div class="row"><input data-host placeholder="host or IP" style="max-width:280px"><button class="primary" data-go>Trace</button></div><p class="muted small">Runs as a background job so you can watch the hops arrive.</p></div>`;
      $('[data-go]', body).onclick = async (e) => { const r = await act(e.target, () => POST('/nettools/traceroute', { host: $('[data-host]', body).value })); if (r) watchJob(r.job, 'Traceroute'); };
    } else if (tab === 'dns') {
      body.innerHTML = `<div class="card"><div class="row wrap"><input data-host placeholder="name" style="max-width:280px"><select data-type style="width:auto">${['A','AAAA','MX','TXT','CNAME','NS','PTR'].map((t) => `<option>${t}</option>`).join('')}</select><button class="primary" data-go>Lookup</button></div><pre class="out" data-out style="margin-top:12px"></pre></div>`;
      $('[data-go]', body).onclick = async (e) => { const r = await act(e.target, () => POST('/nettools/dns', { name: $('[data-host]', body).value, type: $('[data-type]', body).value })); if (r) $('[data-out]', body).textContent = r.output || JSON.stringify(r.records || r.error, null, 2); };
    } else if (tab === 'speed') {
      body.innerHTML = `<div class="card"><p class="muted">Runs against Cloudflare's public speed endpoints from this server (not your browser).</p><button class="primary" data-go>Run speed test</button><div data-out style="margin-top:16px"></div></div>`;
      $('[data-go]', body).onclick = async (e) => {
        $('[data-out]', body).innerHTML = '<span class="spinner"></span> Testing…';
        const r = await act(e.target, () => POST('/nettools/speedtest', {}));
        if (r) $('[data-out]', body).innerHTML = `<div class="grid cols-4"><div class="card widget"><div class="label">Latency</div><div class="big">${r.latencyMs != null ? r.latencyMs.toFixed(0) + ' ms' : '—'}</div></div>
          <div class="card widget"><div class="label">Download</div><div class="big">${r.downloadMbps != null ? r.downloadMbps.toFixed(1) + ' Mbps' : '—'}</div></div>
          <div class="card widget"><div class="label">Upload</div><div class="big">${r.uploadMbps != null ? r.uploadMbps.toFixed(1) + ' Mbps' : '—'}</div></div></div>`;
      };
    } else {
      body.innerHTML = `<div class="card"><div class="card-title">LAN neighbours <span class="spacer"></span><button class="sm" data-refresh>${ICON.refresh}</button>${can('operator') ? '<button class="sm" data-sweep>Ping sweep /24…</button>' : ''}</div><div data-list></div></div>`;
      const load = async () => { const r = await GET('/nettools/lan'); $('[data-list]', body).innerHTML = `<table><thead><tr><th>IP</th><th>MAC</th><th>Iface</th><th>State</th></tr></thead><tbody>${r.neighbours.map((n) => `<tr><td class="mono">${esc(n.ip)}</td><td class="mono muted">${esc(n.hw || '—')}</td><td>${esc(n.device || '')}</td><td>${esc(n.state || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No neighbours</td></tr>'}</tbody></table>`; };
      $('[data-refresh]', body).onclick = load; load();
      const sw = $('[data-sweep]', body); if (sw) sw.onclick = async () => { const r = await formDlg('Ping sweep', [{ name: 'cidr', label: 'CIDR (/24)', value: '192.168.1.0/24' }], 'Sweep'); if (!r) return; const j = await POST('/nettools/lan/sweep', r); await watchJob(j.job, 'Ping sweep'); load(); };
    }
  };
  $$('[data-tab]', el).forEach((b) => b.onclick = () => { tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('active', x === b)); show(); });
  show();
};
