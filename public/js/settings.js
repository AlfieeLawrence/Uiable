'use strict';
/* Settings: general (hostname/timezone), network & Wi-Fi, Linux users, dashboard accounts, appearance, power, about. */
const SECTIONS = [
  ['account', 'My account', 'users', 'viewer'],
  ['general', 'General', 'settings', 'admin'], ['network', 'Network & Wi-Fi', 'wifi', 'admin'], ['users', 'Linux users', 'users', 'admin'],
  ['accounts', 'Dashboard accounts', 'key', 'admin'], ['security', 'Security & 2FA', 'lock', 'viewer'], ['alerts', 'Alerts', 'info', 'admin'], ['tokens', 'API tokens', 'key', 'admin'],
  ['appearance', 'Appearance', 'palette', 'viewer'], ['power', 'Power', 'power', 'admin'], ['about', 'About & security', 'shield', 'viewer'],
].filter((s) => can(s[3]));

Pages.settings = (el, params) => {
  let sec = SECTIONS.find((s) => s[0] === params[0]) ? params[0] : (SECTIONS[0] && SECTIONS[0][0]) || 'appearance';
  el.innerHTML = `<div class="settings"><nav class="card">${SECTIONS.map(([id, label, ic]) => `<a href="#/settings/${id}" data-sec="${id}">${ICON[ic]} ${label}</a>`).join('')}</nav><div data-sec-body></div></div>`;
  $$('nav a', el).forEach((a) => a.classList.toggle('active', a.dataset.sec === sec));
  const body = $('[data-sec-body]', el);
  body.innerHTML = '<div class="card"><span class="spinner"></span></div>';
  Settings[sec](body);
  return null;
};

const Settings = {};
const reloadSection = () => route();

Settings.general = async (b) => {
  let g, mounts = [];
  try { g = await GET('/system/general'); } catch (e) { b.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  try { mounts = (await GET('/system/primary-mount')).disks || []; } catch (_) {}
  const pref = g.primaryMount || '';
  b.innerHTML = `<div class="card section"><div class="card-title">Hostname</div>
      <div class="row"><input data-hn value="${esc(g.hostname)}" class="mono" style="max-width:360px"><button class="primary" data-savehn>Save</button></div>
      <p class="muted small">Changes the server's hostname (uses hostnamectl when available).</p></div>
    <div class="card section"><div class="card-title">Time zone</div>
      <div class="row wrap"><input data-tz list="tzlist" value="${esc(g.timezone)}" class="mono" style="max-width:360px"><datalist id="tzlist"></datalist><button class="primary" data-savetz>Save</button></div>
      <p class="muted small">Server time now: <span class="mono">${esc(g.time)}</span></p></div>
    <div class="card section"><div class="card-title">${ICON.disk} Primary storage mount</div>
      <p class="muted small">The dashboard Storage card highlights this mount. On Umbrel / rugix the big data disk is usually under <span class="mono">/run/rugix/mounts/data</span>. Leave on Auto to pick the largest real disk.</p>
      <div class="row wrap"><select data-pm style="max-width:420px"><option value="">Auto (largest disk)</option>${mounts.map((d) => `<option value="${esc(d.mount)}" ${d.mount === pref ? 'selected' : ''}>${esc(d.mount)} — ${fmtBytes(d.size)} (${fmtBytes(d.avail)} free)</option>`).join('')}</select>
        <button class="primary" data-savepm>Save</button></div></div>
    ${can('admin') ? `<div class="card section" id="features"><div class="card-title">${ICON.grid} Features</div>
      <div class="switch-row"><div class="grow"><b id="ft-store-l">App store</b><p class="muted small" id="ft-store-d">One-click installs from the Uiable app catalog. When off, the store is hidden from the dock, home, search and the dashboard, and its API is blocked on the server. Installed apps keep running.</p></div>
        <label class="switch"><input type="checkbox" role="switch" data-feature="store" aria-labelledby="ft-store-l" aria-describedby="ft-store-d" ${featureOn('store') ? 'checked' : ''}><span aria-hidden="true"></span></label></div></div>` : ''}`;
  GET('/system/timezones').then((r) => { $('#tzlist').innerHTML = r.timezones.map((t) => `<option value="${esc(t)}">`).join(''); }).catch(() => {});
  $('[data-savehn]', b).onclick = async (e) => {
    const v = $('[data-hn]', b).value.trim();
    if (!(await confirmDlg('Change hostname?', `Rename this server to <b class="mono">${esc(v)}</b>?`, { okLabel: 'Change' }))) return;
    await act(e.target.closest('button'), () => POST('/system/hostname', { hostname: v }), 'Hostname changed');
  };
  $('[data-savetz]', b).onclick = async (e) => { await act(e.target.closest('button'), () => POST('/system/timezone', { timezone: $('[data-tz]', b).value.trim() }), 'Time zone updated'); reloadSection(); };
  $$('[data-feature]', b).forEach((cb) => (cb.onchange = async () => { cb.disabled = true; const ok = await setFeature(cb.dataset.feature, cb.checked, { stay: true }); if (!ok) cb.checked = !cb.checked; cb.disabled = false; }));
  $('[data-savepm]', b).onclick = async (e) => { await act(e.target.closest('button'), () => POST('/system/primary-mount', { mount: $('[data-pm]', b).value }), 'Primary mount saved'); };
};

const signalBars = (s) => `<span class="signal" title="${s}%">${[20, 45, 65, 85].map((t, i) => `<i class="${s >= t ? 'on' : ''}" style="height:${(i + 1) * 4}px"></i>`).join('')}</span>`;

Settings.network = async (b) => {
  b.innerHTML = `<div data-conn></div><div data-nmbox></div><div data-wifi class="card section"><div class="card-title">${ICON.wifi} Wi-Fi <span class="spacer"></span><button class="sm" data-diag title="Collect Wi-Fi diagnostics (passwords removed)">${ICON.info} Diagnostics</button><button class="sm" data-scan>${ICON.refresh} Scan</button></div><div data-wlist><span class="spinner"></span></div></div>
    <div class="card section"><div class="card-title">${ICON.globe} Interfaces &amp; IP addresses</div><div data-ifs><span class="spinner"></span></div></div>`;
  let net = null;
  const BK = { networkmanager: 'NetworkManager', iwd: 'iwd', wpa_supplicant: 'wpa_supplicant', netplan: 'netplan', 'systemd-networkd': 'systemd-networkd', ip: 'ip link', iw: 'iw' };
  const MODES = [['prefer-wired', 'Prefer wired (fail over to Wi-Fi)'], ['prefer-wifi', 'Prefer Wi-Fi (fail over to wired)'], ['wired-only', 'Wired only'], ['wifi-only', 'Wi-Fi only']];
  const TYPE = { ethernet: 'wired', wifi: 'Wi-Fi', virtual: 'virtual', loopback: 'loopback' };
  const ip4 = (i) => (i.ipv4 || [])[0] || '';
  const chipCls = (st) => (st === 'connected' || st === 'active' ? 'ok' : st === 'idle' || st === 'loopback' ? 'plain' : '');

  // Guarded changes come back with { pending: { token, seconds } }: ask to keep, else the server reverts.
  const keepDialog = async (pending) => {
    if (!pending || !pending.token) return;
    let left = pending.seconds || pending.secondsLeft || 60, timer;
    const r = await modal({
      title: 'Keep these network settings?', dismissable: false,
      body: `<p><b>${esc(pending.label || 'Network change')}</b> was applied. If you can see this, the connection still works.</p><p class="muted">Reverting automatically in <b data-left>${left}</b>s unless you keep it.</p>`,
      onOpen: (m, close) => { timer = setInterval(() => { left -= 1; const el = $('[data-left]', m); if (el) el.textContent = Math.max(0, left); if (left <= 0) { clearInterval(timer); close(null); } }, 1000); return () => clearInterval(timer); },
      buttons: [{ label: 'Revert now', value: 'revert' }, { label: 'Keep', cls: 'primary', value: 'keep' }],
    });
    clearInterval(timer);
    if (r === 'keep') await act(null, () => POST('/system/network/pending/confirm', { token: pending.token }), 'Kept');
    else if (r === 'revert') await act(null, () => POST('/system/network/pending/revert', { token: pending.token }), 'Reverted');
    else toast('Not confirmed: the previous settings were restored.');
    setTimeout(() => { loadNet(true); loadWifi(); }, 1500);
  };
  const guardedPost = async (url, body, okMsg) => {
    try {
      const out = await POST(url, Object.assign({ seconds: 60 }, body || {}));
      if (out && out.pending) await keepDialog(out.pending); else if (okMsg) toast(okMsg);
      return out;
    } catch (e) {
      toastErr(new Error(`${e.message}${/fetch|network|Failed/i.test(e.message) ? ' — if the connection dropped, the change reverts by itself within 60s.' : ''}`));
      return null;
    }
  };

  const renderConn = (n) => {
    const box = $('[data-conn]', b);
    const u = n.uplink || {};
    const phys = (n.interfaces || []).filter((i) => i.type === 'ethernet' || i.type === 'wifi');
    const p = u.primary;
    const pi = p && phys.find((i) => i.name === p.dev);
    box.innerHTML = `<div class="card section"><div class="card-title">${ICON.globe} Connection</div>
      ${p ? `<p style="margin-top:0">Online via <b class="mono">${esc(p.dev)}</b> (${esc(TYPE[p.type] || p.type || '?')}${pi && pi.wifi ? ' · ' + esc(pi.wifi.ssid) : ''}) · IP <b class="mono">${esc((p.ip || '').split('/')[0] || 'none')}</b> · gateway <span class="mono">${esc(p.gateway || 'none')}</span></p>` : '<div class="notice">No default route: this server has no internet uplink right now.</div>'}
      <table><thead><tr><th>Interface</th><th>Status</th><th>IP</th><th class="hide-sm">Gateway</th><th class="hide-sm">DNS</th></tr></thead><tbody>${phys.map((i) => `<tr>
        <td class="mono"><b>${esc(i.name)}</b> ${i.primary ? '<span class="chip ok">primary</span>' : ''}<div class="muted small">${esc(TYPE[i.type])}${i.metric != null ? ' · metric ' + esc(i.metric) : ''}</div></td>
        <td><span class="chip ${chipCls(i.state)}">${esc(i.label)}</span>${i.wifi ? `<div class="row small" style="gap:6px;margin-top:4px">${i.wifi.signal != null ? signalBars(i.wifi.signal) : ''} ${esc(i.wifi.ssid)}${i.wifi.signal != null ? ` · ${esc(i.wifi.signal)}%` : ''}</div>` : ''}</td>
        <td class="mono small">${esc(ip4(i) || 'none')}${ip4(i) ? `<div class="muted">${i.dhcp ? 'DHCP' : 'static'}</div>` : ''}</td>
        <td class="mono small hide-sm">${esc(i.gateway || '—')}</td><td class="mono small hide-sm">${esc((i.dns || []).join(', ') || (n.dns || []).join(', ') || '—')}</td></tr>`).join('')}</tbody></table>
      ${u.canSet && u.wired.length && u.wireless.length ? `<div class="row wrap" style="margin-top:14px;gap:8px"><label class="small"><b>Wired / Wi-Fi</b></label>
        <select data-uplink style="max-width:320px">${MODES.map(([v, l]) => `<option value="${v}" ${u.mode === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
        <button class="primary sm" data-setuplink>Apply</button>${u.modeStored ? '' : '<span class="muted small">(current: detected from routes)</span>'}</div>
        <p class="muted small">With a "prefer" option both connections stay up, so unplugging the cable (or losing Wi-Fi) fails over automatically. The server's IP address changes when it fails over — reserve both addresses on your router (DHCP reservation) or set static IPs with <b>IP settings…</b>.</p>`
        : (u.wired && u.wired.length && u.wireless && u.wireless.length ? '<p class="muted small">Wired / Wi-Fi preference needs NetworkManager, netplan or systemd-networkd on the host.</p>' : '')}
    </div>`;
  };

  const renderBackend = (n) => {
    const box = $('[data-nmbox]', b);
    const bk = n.backend || {};
    if (n.networkManager) { box.innerHTML = ''; return; }
    const inst = n.nmInstall;
    const chips = [['Wi-Fi', bk.wifi], ['IP settings', bk.config], ['Up/down', bk.link]].map(([k, v]) => `<span class="chip ${v ? 'ok' : 'plain'}">${k}: ${v ? esc(BK[v] || v) : 'unsupported'}</span>`).join(' ');
    box.innerHTML = `<div class="card section"><div class="card-title">${ICON.globe} Network backend</div>
      <p class="muted small" style="margin-top:0">${esc(bk.summary || n.message || '')}</p>
      <div class="row wrap" style="gap:6px">${chips}</div>
      ${(bk.unsupported || []).length ? `<p class="muted small">Not supported here: ${bk.unsupported.map(esc).join('; ')}.</p>` : ''}
      ${inst ? (inst.available
        ? `<div class="row wrap" style="margin-top:10px"><button class="primary" data-nminstall>Install NetworkManager</button><span class="muted small">Uses ${esc(inst.pkg)} on ${esc(inst.osName || 'the host')} for full Wi-Fi and connection management.</span></div>`
        : (inst.reason ? `<p class="muted small">NetworkManager can't be installed from Uiable: ${esc(inst.reason)}</p>` : '')) : ''}</div>`;
  };

  const loadNet = async (refresh) => {
    try {
      const n = net = await GET('/system/network' + (refresh ? '?refresh=1' : ''));
      renderConn(n);
      renderBackend(n);
      const bk = n.backend || {};
      $('[data-ifs]', b).innerHTML = `${bk.readOnly ? `<p class="muted small" style="margin-top:0">Read-only: no supported network backend on this host.</p>` : ''}
        <table><thead><tr><th>Interface</th><th>State</th><th>Addresses</th><th class="hide-sm">MAC</th><th></th></tr></thead><tbody>${n.interfaces.map((i) => {
          const on = i.state === 'connected' || i.state === 'no-ip';
          return `<tr><td class="mono"><b>${esc(i.name)}</b><div class="muted small">${esc(TYPE[i.type] || i.type)}${i.connection ? ' · ' + esc(i.connection) : ''}${i.managedBy && i.managedBy !== 'networkmanager' && n.networkManager ? ' · ' + esc(BK[i.managedBy] || i.managedBy) : ''}</div></td>
          <td><span class="chip ${chipCls(i.state)}">${esc(i.label || i.state)}</span></td>
          <td class="mono small">${i.addresses.map(esc).join('<br>') || '<span class="muted">none</span>'}</td><td class="mono muted small hide-sm">${esc(i.mac || '')}</td>
          <td><div class="actions">${i.canLink ? (on || (i.type === 'ethernet' && i.state === 'no-cable') ? `<button class="sm" data-dev="${esc(i.name)}" data-act="disconnect">Disconnect</button>` : `<button class="sm" data-dev="${esc(i.name)}" data-act="connect">Connect</button>`) : ''}${i.canConfig ? `<button class="sm" data-ipcfg="${esc(i.name)}">IP settings…</button>` : ''}</div></td></tr>`;
        }).join('')}</tbody></table>`;
      if (n.pending && !document.querySelector('.modal-bg')) keepDialog(n.pending);
    } catch (e) { $('[data-ifs]', b).innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  const hiddenRow = `<div class="list-item"><div class="grow muted">Hidden network?</div><button class="sm" data-hidden>Join other network…</button></div>`;
  const loadWifi = async (rescan) => {
    const wl = $('[data-wlist]', b); wl.innerHTML = '<span class="spinner"></span> <span class="muted">Scanning…</span>';
    try {
      const w = await GET('/system/wifi' + (rescan ? '?rescan=1' : ''));
      if (!w.available) { wl.innerHTML = `<div class="notice">${esc(w.message)}</div>`; $('[data-scan]', b).disabled = true; return; }
      $('[data-scan]', b).disabled = w.canScan === false;
      const via = w.backend && w.backend !== 'networkmanager' ? `<p class="muted small" style="margin-top:0">Managed with ${esc(BK[w.backend] || w.backend)}.${w.message ? ' ' + esc(w.message) : ''}</p>` : '';
      wl.innerHTML = via + w.networks.map((n) => `<div class="list-item">${signalBars(n.signal)}<div class="grow"><b>${esc(n.ssid)}</b> ${n.inUse ? '<span class="chip ok">connected</span>' : ''}<div class="muted small">${esc(n.security || 'Open')}${n.channel ? ' · ch ' + esc(n.channel) : ''} · ${esc(n.device)}</div></div>
        ${n.inUse ? `<button class="sm" data-dev="${esc(n.device)}" data-act="disconnect">Disconnect</button>` : `<button class="sm primary" data-join="${esc(n.ssid)}" data-sec="${esc(n.security)}" data-wdev="${esc(n.device)}">Connect</button>`}</div>`).join('') + hiddenRow;
    } catch (e) { wl.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  const join = async (ssid, security, device, hidden) => {
    const fields = hidden ? [{ name: 'ssid', label: 'Network name (SSID)' }, { name: 'password', label: 'Password (leave empty if open)', type: 'password' }] : (security && security !== '--' ? [{ name: 'password', label: 'Password', type: 'password' }] : []);
    if (fields.some((f) => f.type === 'password')) fields.push({ type: 'html', html: '<label class="row small" style="margin:-4px 0 10px"><input type="checkbox" data-showpw> Show password</label>' });
    const showPw = (m) => { const c = $('[data-showpw]', m); if (c) c.onchange = () => { const i = $('input[name=password]', m); if (i) i.type = c.checked ? 'text' : 'password'; }; };
    const r = fields.length ? await formDlg(`Connect to ${hidden ? 'hidden network' : ssid}`, fields, 'Connect', { onOpen: showPw, intro: `${security && security !== '--' ? `Security: <b>${esc(security)}</b>. ` : ''}Uiable waits until the Wi-Fi is joined and has an IP address (up to ~60s) and tells you what went wrong if not.` }) : (await confirmDlg(`Connect to ${esc(ssid)}?`, 'This is an open network.', { okLabel: 'Connect' })) && {};
    if (!r) return;
    const wl = $('[data-wlist]', b); wl.innerHTML = `<span class="spinner"></span> <span class="muted">Connecting to ${esc(hidden ? r.ssid : ssid)} and waiting for an IP address…</span>`;
    let out = null;
    try { out = await POST('/system/wifi/connect', { ssid: hidden ? r.ssid : ssid, password: r.password || '', device, hidden: !!hidden }); }
    catch (err) {
      // Failures carry the reason plus the relevant (scrubbed) log lines: show them in full, not a toast.
      const [head, ...rest] = String(err.message || err).split('\n\n');
      const again = await modal({
        title: `Couldn't connect to ${hidden ? r.ssid : ssid}`, wide: true, log: !!rest.length,
        body: `<p style="margin-top:0">${esc(head)}</p>${rest.length ? `<pre class="out log-out">${esc(rest.join('\n\n'))}</pre>` : ''}`,
        buttons: [{ label: 'Diagnostics', value: 'diag' }, { label: 'Close', cls: 'primary', value: null }],
      });
      if (again === 'diag') diag(device);
    }
    if (out) toast(out.output || 'Connected');
    loadWifi(); loadNet(true);
  };
  // Wi-Fi interface without a saved network: pick one (SSID + password) instead of a bare "connect".
  const pickWifi = async (dev, why) => {
    const r = await modal({
      title: 'Choose a Wi-Fi network', wide: true,
      body: `<p class="muted small" style="margin-top:0">${esc(why || '')} Interface <b class="mono">${esc(dev)}</b>.</p><div data-pick><span class="spinner"></span> <span class="muted">Scanning…</span></div>`,
      buttons: [{ label: 'Join other network…', value: { hidden: true } }, { label: 'Cancel', value: null }],
      onOpen: (m, close) => {
        const box = $('[data-pick]', m);
        GET('/system/wifi?rescan=1').then((w) => {
          if (!w.available) { box.innerHTML = `<div class="notice">${esc(w.message || 'Wi-Fi is not available.')}</div>`; return; }
          const list = (w.networks || []).filter((n) => !n.device || n.device === dev);
          box.innerHTML = list.length ? `<div class="wifi-list">${list.map((n, i) => `<div class="list-item">${signalBars(n.signal)}<div class="grow" style="min-width:0"><b class="ellipsis" style="display:block">${esc(n.ssid)}</b><div class="muted small">${esc(n.security || 'Open')}${n.channel ? ' · ch ' + esc(n.channel) : ''}</div></div><button class="sm primary" data-pk="${i}">Connect</button></div>`).join('')}</div>`
            : '<div class="empty">No networks found. Use “Join other network…” for a hidden one.</div>';
          box.onclick = (e) => { const k = e.target.closest('[data-pk]'); if (k) close({ net: list[+k.dataset.pk] }); };
        }).catch((e) => { box.innerHTML = `<div class="notice">${esc(e.message)}</div>`; });
      },
    });
    if (!r) return;
    if (r.hidden) return join('', '', dev, true);
    return join(r.net.ssid, r.net.security, dev);
  };
  // Scrubbed host diagnostics (rfkill, iw, nmcli, services, netplan, journal) to copy into a support chat.
  const diag = async (dev) => {
    const wifiDev = dev || ((net && net.interfaces) || []).filter((i) => i.type === 'wifi').map((i) => i.name)[0] || '';
    let text = '';
    await modal({
      title: 'Wi-Fi diagnostics', wide: true, log: true,
      body: `<p class="muted small" style="margin:0">Read-only checks on the host. Passwords and keys are removed, so this is safe to paste into a chat.</p><pre class="out log-out" data-dg>Collecting… (up to ~30s)</pre>`,
      buttons: [{ label: 'Copy', handler: async () => { try { await navigator.clipboard.writeText(text); toast('Copied diagnostics'); } catch (_) { toast('Select the text and copy it', true); } return false; } }, { label: 'Close', cls: 'primary', value: null }],
      onOpen: (m) => {
        GET('/system/network/diagnostics' + (wifiDev ? '?device=' + encodeURIComponent(wifiDev) : '')).then((r) => { text = r.text; const p = $('[data-dg]', m); if (p) p.textContent = r.text; })
          .catch((e) => { const p = $('[data-dg]', m); if (p) p.textContent = e.message; });
      },
    });
  };
  const ipSettings = async (dev) => {
    let cur = {};
    try { cur = await GET('/system/network/config/' + encodeURIComponent(dev)); } catch (_) {}
    const i = (net.interfaces || []).find((x) => x.name === dev) || {};
    const via = BK[cur.backend] || 'the host';
    const r = await formDlg(`IP settings · ${dev}`, [
      { name: 'mode', label: 'Mode', type: 'select', options: ['dhcp', 'static'], value: cur.mode || (i.dhcp === false && ip4(i) ? 'static' : 'dhcp') },
      { name: 'address', label: 'Address (CIDR, static only)', value: cur.address || ip4(i), placeholder: '192.168.1.50/24' },
      { name: 'gateway', label: 'Gateway (static only)', value: cur.gateway || i.gateway || '', placeholder: '192.168.1.1' },
      { name: 'dns', label: 'DNS servers (comma separated, static only)', value: cur.dns || (i.dns || []).join(', '), placeholder: '1.1.1.1, 9.9.9.9' },
    ], 'Apply', { intro: `Saved with ${esc(via)}${cur.managed === false ? ' (Uiable adds its own config file; your existing files are left untouched)' : ''}. You'll be asked to keep the change; if this page can't reach the server afterwards, it reverts automatically after 60s.` });
    if (!r) return;
    if (!(await confirmDlg(`Apply IP settings to ${esc(dev)}?`, `The interface is reconfigured now${i.primary ? ' and it is the one this server is reached through' : ''}. If you lose access, it reverts by itself within 60 seconds.`, { okLabel: 'Apply', danger: !!i.primary }))) return;
    await guardedPost('/system/network/config', Object.assign({ device: dev }, r), 'IP settings applied');
    loadNet(true);
  };
  const setUplink = async () => {
    const mode = $('[data-uplink]', b).value;
    const label = (MODES.find((m) => m[0] === mode) || [])[1];
    if (!(await confirmDlg(`Switch to "${esc(label)}"?`, 'Route priorities are changed now; the connection may drop for a few seconds. If this page can\'t reach the server afterwards, it reverts automatically within 60 seconds.', { okLabel: 'Apply' }))) return;
    const out = await guardedPost('/system/network/uplink', { mode });
    if (out) { (out.warnings || []).forEach((w) => toast(w, true)); if (out.note) toast(out.note); }
    loadNet(true);
  };
  const installNm = async () => {
    const inst = (net && net.nmInstall) || {};
    const managed = (inst.managedBy || []).length ? inst.managedBy.map(esc).join(', ') : 'netplan / systemd-networkd / ifupdown';
    const r = await formDlg('Install NetworkManager?', [
      { name: 'mode', label: 'What should NetworkManager manage?', type: 'select', options: ['Wi-Fi only (leave existing config unmanaged)', 'All interfaces (take over existing config)'], value: 'Wi-Fi only (leave existing config unmanaged)' },
      { name: 'ack', label: 'I understand the connection may drop briefly', type: 'checkbox' },
    ], 'Install', { intro: `Installs NetworkManager with <b class="mono">${esc(inst.pkg || '')}</b> on the host, then enables and starts it.<br><br>Interfaces on this host are currently managed by <b>${managed}</b>. NetworkManager can take those interfaces over, which may drop your connection briefly (or for good if it can't bring them back up). <b>Wi-Fi only</b> (default) keeps wired interfaces with your existing config; choose <b>All interfaces</b> only if you want NetworkManager to manage everything.` });
    if (!r) return;
    if (!r.ack) { toastErr(new Error('Tick the box to confirm you understand the connection may drop.')); return; }
    const out = await act(null, () => POST('/system/network/nm-install', { mode: /^All/.test(r.mode) ? 'all' : 'wifi-only' }));
    if (out && out.job) {
      let j = await watchJob(out.job, 'Installing NetworkManager');
      // Closing the log early doesn't stop the install: keep waiting so the page switches over when it's done.
      while (j && j.state === 'running') { await new Promise((res) => setTimeout(res, 2000)); j = await GET('/jobs/' + out.job.id).catch(() => null); }
      if (j && j.state === 'failed') toastErr(new Error('NetworkManager install failed — open it again to see the log.'));
      // NetworkManager takes a few seconds to pick up devices after starting: re-detect until it shows.
      for (let k = 0; k < 8; k++) {
        await loadNet(true);
        if (!b.isConnected || (net && net.networkManager) || (j && j.state === 'failed')) break;
        await new Promise((res) => setTimeout(res, 2500));
      }
      if (net && net.networkManager) toast('NetworkManager is running — network management switched over.');
    } else loadNet(true);
    loadWifi();
  };
  b.onclick = async (e) => {
    if (e.target.closest('[data-nminstall]')) return installNm();
    if (e.target.closest('[data-setuplink]')) return setUplink();
    if (e.target.closest('[data-scan]')) return loadWifi(true);
    if (e.target.closest('[data-diag]')) return diag();
    if (e.target.closest('[data-hidden]')) return join('', '', '', true);
    const ipc = e.target.closest('[data-ipcfg]'); if (ipc) return ipSettings(ipc.dataset.ipcfg);
    const j = e.target.closest('[data-join]'); if (j) return join(j.dataset.join, j.dataset.sec, j.dataset.wdev);
    const d = e.target.closest('[data-dev]');
    if (d) {
      const dev = d.dataset.dev;
      if (d.dataset.act === 'disconnect') {
        const i = ((net && net.interfaces) || []).find((x) => x.name === dev) || {};
        if (!(await confirmDlg(`Disconnect ${esc(dev)}?`, `${i.primary ? '<b>This is the interface the server is reached through.</b> ' : ''}If you lose access, it reconnects by itself within 60 seconds unless you confirm.`, { okLabel: 'Disconnect', danger: true }))) return;
        await guardedPost(`/system/network/device/${encodeURIComponent(dev)}/disconnect`, {}, 'Disconnected');
      } else {
        d.disabled = true;
        try { await POST(`/system/network/device/${encodeURIComponent(dev)}/connect`); toast(`Connected ${dev}`); }
        catch (err) {
          if (err.data && err.data.reason === 'needs-ssid') { if (d.isConnected) d.disabled = false; return pickWifi(dev, err.message); }
          toastErr(err);
        } finally { if (d.isConnected) d.disabled = false; }
      }
      loadNet(true); loadWifi();
    }
  };
  loadNet(); loadWifi();
};

Settings.users = async (b) => {
  let r;
  try { r = await GET('/system/users'); } catch (e) { b.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
  let showSystem = false;
  const render = () => {
    const list = r.users.filter((u) => showSystem || !u.system);
    b.innerHTML = `<div class="card"><div class="card-title">${ICON.users} Linux users <span class="spacer"></span><label class="row small" style="font-weight:400"><input type="checkbox" data-sys ${showSystem ? 'checked' : ''}> System accounts</label><button class="primary" data-add>${ICON.plus} Add user</button></div>
      ${r.adminGroup ? `<p class="muted small">Administrators are members of the <b class="mono">${esc(r.adminGroup)}</b> group.</p>` : '<div class="notice" style="margin-bottom:12px">No sudo or wheel group exists on this host, so admin rights cannot be toggled here.</div>'}
      ${list.map((u) => `<div class="list-item"><div class="ctr"><div class="avatar" style="background:${ctrColor(u.name)};width:38px;height:38px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:700">${esc(u.name[0].toUpperCase())}</div></div>
        <div class="grow" style="min-width:0"><b>${esc(u.name)}</b> ${u.admin ? '<span class="chip ok">admin</span>' : ''} ${u.system ? '<span class="chip plain">system</span>' : ''}
          <div class="muted small ellipsis">uid ${u.uid} · ${esc(u.home)} · ${esc(u.shell)}${u.groups.length ? ' · ' + esc(u.groups.join(', ')) : ''}</div></div>
        <div class="actions">
          ${!u.system && u.uid !== 0 ? `<button class="sm" data-lren="${esc(u.name)}">${ICON.edit} Rename</button>` : ''}
          <button class="sm" data-pw="${esc(u.name)}">${ICON.key} Password</button>
          ${u.uid !== 0 && r.adminGroup ? `<button class="sm" data-admin="${esc(u.name)}" data-on="${u.admin ? '' : '1'}">${u.admin ? 'Remove admin' : 'Make admin'}</button>` : ''}
          ${u.uid !== 0 ? `<button class="sm icon danger" data-del="${esc(u.name)}" title="Delete">${ICON.trash}</button>` : ''}
        </div></div>`).join('')}</div>`;
  };
  const refresh = async () => { r = await GET('/system/users'); render(); };
  b.onclick = async (e) => {
    const t = e.target;
    if (t.closest('[data-add]')) {
      const f = await formDlg('Add Linux user', [{ name: 'username', label: 'Username', placeholder: 'lowercase, e.g. alfie' }, { name: 'password', label: 'Password', type: 'password' }, { name: 'shell', label: 'Login shell', value: '/bin/bash' }, ...(r.adminGroup ? [{ name: 'admin', label: `Administrator (add to ${r.adminGroup})`, type: 'checkbox' }] : [])], 'Create user', {
        handler: (v) => POST('/system/users', v),
      });
      if (f) { toast('User created'); refresh(); }
      return;
    }
    const lren = t.closest('[data-lren]');
    if (lren) { if (await renameLinuxDlg(lren.dataset.lren)) refresh(); return; }
    const pw = t.closest('[data-pw]');
    if (pw) {
      const f = await formDlg(`Set password for ${pw.dataset.pw}`, [{ name: 'password', label: 'New password', type: 'password' }, { name: 'confirm', label: 'Confirm password', type: 'password' }], 'Set password');
      if (!f) return;
      if (f.password !== f.confirm) return toast('Passwords do not match', true);
      await act(null, () => POST(`/system/users/${encodeURIComponent(pw.dataset.pw)}/password`, { password: f.password }), 'Password changed');
      return;
    }
    const ad = t.closest('[data-admin]');
    if (ad) { await act(ad, () => POST(`/system/users/${encodeURIComponent(ad.dataset.admin)}/admin`, { admin: !!ad.dataset.on }), 'Updated'); return refresh(); }
    const del = t.closest('[data-del]');
    if (del) {
      const f = await modal({ title: `Delete ${del.dataset.del}?`, body: `<p>The Linux account <b class="mono">${esc(del.dataset.del)}</b> will be deleted.</p><label class="row"><input type="checkbox" data-home> Also delete their home directory and mail spool</label>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Delete user', cls: 'danger solid', value: (m) => ({ home: $('[data-home]', m).checked }) }] });
      if (!f) return;
      await act(null, () => DEL(`/system/users/${encodeURIComponent(del.dataset.del)}${f.home ? '?removeHome=1' : ''}`), 'User deleted');
      return refresh();
    }
  };
  b.onchange = (e) => { if (e.target.matches('[data-sys]')) { showSystem = e.target.checked; render(); } };
  render();
};

// Shared dashboard-account rename dialog. Resolves the new name or null.
const USERNAME_RE = '[A-Za-z0-9_.\\-@]{1,64}';
async function renameAccountDlg(name) {
  const self = name === State.user;
  let out = null;
  const f = await formDlg(self ? 'Change my username' : `Rename ${name}`, [{ name: 'username', label: 'New username', value: name, pattern: USERNAME_RE }],
    'Rename', {
      intro: `Letters, digits, <span class="mono">. _ - @</span>, up to 64 characters, and must be unique. ${self ? 'You stay signed in.' : 'Their sessions stay signed in.'} Home layout, custom icons, role and 2FA move with the account. Earlier audit entries keep the old name, and a rename event links the two.`,
      handler: async (v) => { const r = await POST(`/accounts/${encodeURIComponent(name)}/rename`, { username: v.username.trim() }); out = r.username; },
    });
  if (!f || !out) return null;
  toast(`Renamed to ${out}`);
  if (self) { State.user = out; State.layout = null; if (typeof Home !== 'undefined') Home.layout = null; }
  return out;
}

Settings.account = async (b) => {
  const me = await GET('/account/me');
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.users} My account</div>
      <div class="list-item"><div class="grow"><div class="muted small">Username</div><b class="mono">${esc(me.username)}</b> <span class="chip plain">${esc(me.role)}</span>${me.twoFactor ? ' <span class="chip ok">2FA</span>' : ''}</div>
        <div class="actions"><button class="sm" data-ren>${ICON.edit} Change username</button></div></div>
      <form class="list-item" data-dn style="align-items:flex-end"><label class="field grow" style="margin:0"><span>Display name (shown in the greeting)</span><input name="displayName" maxlength="64" value="${esc(me.displayName || '')}" placeholder="${esc(me.username)}"></label>
        <div class="actions"><button class="sm primary" type="submit">Save</button></div></form>
      <div class="list-item"><div class="grow" style="min-width:0"><div class="muted small">Linked Linux user</div>${me.linuxUser ? `<b class="mono">${esc(me.linuxUser)}</b>` : '<span class="muted">Not linked</span>'}
          <div class="muted small">Default for new terminal tabs, scripts and upload ownership.${can('admin') ? '' : ' Non-admins always run as this user.'}</div></div>
        <div class="actions"><button class="sm" data-lu>${ICON.user || ICON.users} Change</button></div></div>
      <div class="list-item"><div class="grow"><div class="muted small">Password</div>Changing it signs you out everywhere.</div><div class="actions"><button class="sm" data-pw>${ICON.key} Change password</button></div></div>
      <div class="list-item"><div class="grow"><div class="muted small">Two-factor authentication</div>${me.twoFactor ? 'Enabled' : 'Not enabled'}</div><div class="actions"><a class="btn sm" href="#/settings/security">${ICON.lock} Manage 2FA</a></div></div>
      <p class="muted small" style="margin-top:10px">Account created ${esc(fmtDate(Date.parse(me.created)))}.</p></div>`;
  $('[data-dn]', b).onsubmit = async (e) => {
    e.preventDefault();
    const v = e.target.displayName.value.trim();
    const ok = await act(null, () => POST('/account/profile', { displayName: v }), 'Display name saved');
    if (ok !== false) State.displayName = v;
  };
  b.onclick = async (e) => {
    if (e.target.closest('[data-lu]')) { if (await linuxBindDlg()) reloadSection(); return; }
    if (e.target.closest('[data-ren]')) { if (await renameAccountDlg(State.user)) { if (typeof rebuildDock === 'function') rebuildDock(); route(); } return; }
    if (e.target.closest('[data-pw]')) {
      const f = await formDlg('Change password', [{ name: 'current', label: 'Current password', type: 'password' }, { name: 'password', label: 'New password (min 8 characters)', type: 'password' }, { name: 'confirm', label: 'Confirm new password', type: 'password' }], 'Change', {
        handler: async (v) => { if (v.password !== v.confirm) throw new Error('Passwords do not match'); await POST(`/accounts/${encodeURIComponent(State.user)}/password`, v); },
      });
      if (f) { toast('Password changed. Please sign in again.'); setTimeout(boot, 800); }
    }
  };
};

Settings.accounts = async (b) => {
  const r = await GET('/accounts');
  b.innerHTML = `<div class="card"><div class="card-title">${ICON.key} Dashboard accounts <span class="spacer"></span><button data-lbind>${ICON.users} Linux linking</button><button class="primary" data-add>${ICON.plus} Add user</button></div>
    <p class="muted small">These accounts sign in to Uiable itself (separate from Linux users). Roles: viewer (read-only), operator (day-to-day actions, runs as their linked Linux user), admin (everything).</p>
    ${r.accounts.map((a) => `<div class="list-item"><div class="grow"><b>${esc(a.username)}</b> ${a.username === r.me ? '<span class="chip ok">you</span>' : ''} <span class="chip plain">${esc(a.role)}</span>${a.twoFactor ? ' <span class="chip ok">2FA</span>' : ''}<div class="muted small">created ${esc(fmtDate(Date.parse(a.created)))} · Linux user ${a.linuxUser ? `<b class="mono">${esc(a.linuxUser)}</b>` : '<i>not linked</i>'}</div></div>
      <div class="actions"><button class="sm" data-ren="${esc(a.username)}">${ICON.edit} Rename</button><button class="sm" data-alu="${esc(a.username)}" data-cur="${esc(a.linuxUser)}">${ICON.users} Linux user</button><button class="sm" data-pw="${esc(a.username)}">${ICON.key} Password</button>${a.username !== r.me ? `<button class="sm" data-role="${esc(a.username)}" data-cur="${esc(a.role)}">Role</button><button class="sm icon danger" data-del="${esc(a.username)}">${ICON.trash}</button>` : ''}</div></div>`).join('')}</div>`;
  b.onclick = async (e) => {
    const alu = e.target.closest('[data-alu]');
    if (alu) {
      const L = await GET('/accounts-linux-settings');
      const cur = alu.dataset.cur || '';
      const f = await modal({ title: `Linux user for ${alu.dataset.alu}`,
        body: `<p class="muted">Non-admin accounts always run terminals and scripts as this user. To link a Linux user, type <b>that Linux user's</b> password (ask its owner), even as an admin. Unlinking doesn't need it. Audit-logged.</p>${linuxLinkFields(L.users, cur, { allowNone: true })}`,
        onOpen: (m) => { linuxLinkWire(m, cur); },
        buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', handler: (m) => linuxLinkSubmit(m, `/accounts/${encodeURIComponent(alu.dataset.alu)}/linux-user`, cur) }] });
      if (f) { toast('Linux user updated'); reloadSection(); }
      return;
    }
    if (e.target.closest('[data-lbind]')) {
      const L = await GET('/accounts-linux-settings');
      const nonRoot = L.users.filter((u) => u.uid !== 0);
      const ok = await modal({ title: 'Linux account linking', body: `<label class="field"><span>Default Linux user for new dashboard accounts</span><select name="def">${linuxUserOptionsHtml(L.users, L.defaultUser, { allowNone: true })}</select></label>
        <div class="field"><span>Users non-admins may link themselves to</span>${nonRoot.map((u) => `<label class="row" style="margin:6px 0"><input type="checkbox" name="al" value="${esc(u.name)}" ${L.allowed.includes(u.name) ? 'checked' : ''}> <span class="mono">${esc(u.name)}</span> <span class="muted small">uid ${u.uid}${u.admin ? ' · sudo' : ''}</span></label>`).join('') || '<p class="muted small">No users with uid ≥ 1000.</p>'}</div>
        <p class="muted small">Admins can link to any user, including root. Root is never offered to non-admins. The default is pre-selected when a new account first links (for non-admins only if it is also in the allowed list); linking always needs that Linux user's password.</p>`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', keepOpenOnError: true, handler: async (m) => { await PUT('/accounts-linux-settings', { defaultUser: $('[name=def]', m).value, allowed: $$('[name=al]:checked', m).map((x) => x.value) }); return true; } }] });
      if (ok) { toast('Saved'); reloadSection(); }
      return;
    }
    const ren = e.target.closest('[data-ren]');
    if (ren) { if (await renameAccountDlg(ren.dataset.ren)) reloadSection(); return; }
    if (e.target.closest('[data-add]')) {
      const f = await formDlg('Add dashboard account', [{ name: 'username', label: 'Username' }, { name: 'password', label: 'Password (min 8 characters)', type: 'password' }, { name: 'role', label: 'Role', type: 'select', options: ['viewer','operator','admin'], value: 'viewer' }], 'Create', { handler: (v) => POST('/accounts', v) });
      if (f) { toast('Account created'); reloadSection(); }
      return;
    }
    const pw = e.target.closest('[data-pw]');
    if (pw) {
      const self = pw.dataset.pw === r.me;
      const f = await formDlg(`Change password · ${pw.dataset.pw}`, [...(self ? [{ name: 'current', label: 'Current password', type: 'password' }] : []), { name: 'password', label: 'New password (min 8 characters)', type: 'password' }, { name: 'confirm', label: 'Confirm new password', type: 'password' }], 'Change password', {
        handler: (v) => { if (v.password !== v.confirm) throw new Error('Passwords do not match'); return POST(`/accounts/${encodeURIComponent(pw.dataset.pw)}/password`, v); },
      });
      if (f) { toast(self ? 'Password changed. Please sign in again.' : 'Password changed'); if (self) setTimeout(boot, 800); }
      return;
    }
    const role = e.target.closest('[data-role]');
    if (role) {
      const f = await formDlg('Change role · ' + role.dataset.role, [{ name: 'role', label: 'Role', type: 'select', options: ['viewer','operator','admin'], value: role.dataset.cur }], 'Save');
      if (f) { await act(null, () => POST(`/accounts/${encodeURIComponent(role.dataset.role)}/role`, { role: f.role }), 'Role updated'); reloadSection(); }
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del && await confirmDlg(`Delete ${esc(del.dataset.del)}?`, 'They will no longer be able to sign in to Uiable.', { okLabel: 'Delete', danger: true })) {
      await act(null, () => DEL(`/accounts/${encodeURIComponent(del.dataset.del)}`), 'Account deleted');
      reloadSection();
    }
  };
};

Settings.appearance = (b) => {
  const cur = getTheme();
  const opts = ['system', ...APP_THEMES];
  const label = (t) => t[0].toUpperCase() + t.slice(1);
  b.innerHTML = `<div class="card"><div class="card-title">${ICON.palette} Theme</div>
    <p class="muted small" style="margin:0 0 10px">Applies to the whole dashboard (same palettes as Uiable Connect).</p>
    <div class="seg" style="flex-wrap:wrap">${opts.map((t) => `<button data-t="${t}" class="${t === cur ? 'active' : ''}">${label(t)}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:12px">Saved in this browser. <span class="mono">system</span> follows your OS light/dark preference.</p></div>
    <div class="card section"><div class="card-title">${ICON.compass} Help &amp; onboarding</div>
      <div class="row wrap"><button type="button" data-tour>${ICON.compass} Take the tour</button><button type="button" data-keys>${ICON.keyboard} Keyboard shortcuts</button><button type="button" data-checklist-reset>${ICON.check} Show setup checklist</button></div>
      <p class="muted small" style="margin-top:12px">Press <kbd>Ctrl</kbd> <kbd>K</kbd> (<kbd>⌘</kbd> <kbd>K</kbd> on Mac) anywhere to search pages, containers and settings, or <kbd>?</kbd> for all shortcuts.</p></div>`;
  b.onclick = (e) => {
    if (e.target.closest('[data-tour]')) return Tour.start(true);
    if (e.target.closest('[data-keys]')) return showShortcuts();
    if (e.target.closest('[data-checklist-reset]')) { localStorage.removeItem(userKey('checklist-hidden')); toast('The setup checklist is back on Home'); return; }
    const x = e.target.closest('[data-t]'); if (x) { setTheme(x.dataset.t); $$('[data-t]', b).forEach((y) => y.classList.toggle('active', y === x)); } };
};

Settings.power = (b) => {
  b.innerHTML = `<div class="card"><div class="card-title">${ICON.power} Power</div><p class="muted">Restarting or shutting down ends your SSH tunnel. After a restart, reconnect with the same <span class="mono">ssh -L</span> command once the server is back.</p>
    <div class="row" style="margin-top:14px"><button data-p="reboot">${ICON.restart} Restart server</button><button class="danger solid" data-p="shutdown">${ICON.power} Shut down</button></div></div>`;
  b.onclick = async (e) => {
    const x = e.target.closest('[data-p]'); if (!x) return;
    const reboot = x.dataset.p === 'reboot';
    if (!(await confirmDlg(reboot ? 'Restart the server?' : 'Shut down the server?', reboot ? 'All running programs will stop and the server will reboot.' : 'The server will power off. <b>You will need physical or provider-console access to turn it back on.</b>', { okLabel: reboot ? 'Restart' : 'Shut down', danger: true }))) return;
    await act(x, () => POST(`/system/power/${x.dataset.p}`), reboot ? 'Restarting…' : 'Shutting down…');
  };
};

Settings.about = async (b) => {
  const s = Stats.last || await GET('/stats').catch(() => null);
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.info} About</div><div class="kv">
      <div>Uiable version</div><div>${esc(State.version)}</div><div>Build</div><div><span class="mono">${esc(State.build || '–')}</span>${State.buildDate ? ' · ' + esc(new Date(State.buildDate).toLocaleString()) : ''}</div><div>Signed in as</div><div>${esc(State.user)}</div>
      ${s ? `<div>Host</div><div>${esc(s.info.hostname)}</div><div>OS</div><div>${esc(s.info.os)}</div><div>Kernel</div><div>${esc(s.info.kernel)} (${esc(s.info.arch)})</div><div>Mode</div><div>${s.info.mode === 'nsenter' ? 'Docker container → host namespaces' : 'Running directly on host'}</div>` : ''}
    </div></div>
    <div class="card section"><div class="card-title">${ICON.shield} Security</div>
      <p>Uiable has <b>full root access</b> to this server: anyone who can sign in can read any file, run any command, and manage users and containers.</p>
      <ul class="muted"><li>Keep it bound to <span class="mono">127.0.0.1</span> and reach it through an SSH tunnel.</li><li>Use a strong dashboard password; sessions are HttpOnly SameSite cookies with CSRF tokens.</li><li>Failed sign-ins are rate limited (10 per 15 minutes per address).</li></ul>
      <button data-logout>${ICON.logout} Sign out</button></div>`;
  $('[data-logout]', b).onclick = logout;
};


Settings.security = async (b) => {
  const info = await GET('/account/2fa');
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.lock} Two-factor authentication</div>
    <p class="muted">Optional TOTP (Google Authenticator, 1Password, etc.). When enabled, signing in needs a 6-digit code or a backup code.</p>
    <p>Status: ${info.enabled ? '<span class="chip ok">enabled</span> · ' + info.backupRemaining + ' backup codes left' : '<span class="chip plain">disabled</span>'}</p>
    <div class="row wrap" style="margin-top:12px">${info.enabled
      ? `<button class="danger" data-dis>Disable 2FA</button><button data-regen>Regenerate backup codes</button>`
      : `<button class="primary" data-en>Enable 2FA</button>`}</div></div>
    <div class="card section"><div class="card-title">${ICON.key} Change my password</div>
      <button data-mypw>Change password</button></div>`;
  b.onclick = async (e) => {
    if (e.target.closest('[data-mypw]')) {
      const f = await formDlg('Change password', [{ name: 'current', label: 'Current password', type: 'password' }, { name: 'password', label: 'New password', type: 'password' }, { name: 'confirm', label: 'Confirm', type: 'password' }], 'Change', {
        handler: async (v) => { if (v.password !== v.confirm) throw new Error('Passwords do not match'); await POST(`/accounts/${encodeURIComponent(State.user)}/password`, v); },
      });
      if (f) { toast('Password changed. Please sign in again.'); setTimeout(boot, 800); }
      return;
    }
    if (e.target.closest('[data-en]')) {
      const begin = await POST('/account/2fa/begin');
      const code = await modal({
        title: 'Enrol authenticator',
        body: `<p class="muted">Scan this QR with your authenticator app, or type the secret manually.</p>
          <div style="text-align:center"><img src="${begin.qr}" alt="QR" style="width:220px;height:220px;border-radius:12px"></div>
          <p class="mono small" style="word-break:break-all">${esc(begin.secret)}</p>
          <label class="field"><span>Enter the 6-digit code to confirm</span><input data-code inputmode="numeric" autocomplete="one-time-code"></label>`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Enable', cls: 'primary', value: (m) => $('[data-code]', m).value.trim() }],
      });
      if (!code) return;
      const r = await act(null, () => POST('/account/2fa/enable', { code }));
      if (r) {
        await modal({ title: 'Save your backup codes', body: `<p class="muted">Store these somewhere safe. Each can be used once if you lose your phone.</p><pre class="out">${esc(r.backupCodes.join('\n'))}</pre>`, buttons: [{ label: 'I have saved them', cls: 'primary', value: true }] });
        reloadSection();
      }
      return;
    }
    if (e.target.closest('[data-dis]')) {
      const f = await formDlg('Disable 2FA', [{ name: 'password', label: 'Account password', type: 'password' }], 'Disable');
      if (!f) return; await act(null, () => POST('/account/2fa/disable', f), '2FA disabled'); reloadSection(); return;
    }
    if (e.target.closest('[data-regen]')) {
      const f = await formDlg('Regenerate backup codes', [{ name: 'password', label: 'Account password', type: 'password' }], 'Regenerate');
      if (!f) return;
      const r = await act(null, () => POST('/account/2fa/backup', f));
      if (r) await modal({ title: 'New backup codes', body: `<pre class="out">${esc(r.backupCodes.join('\n'))}</pre>`, buttons: [{ label: 'Done', cls: 'primary', value: true }] });
      reloadSection();
    }
  };
};

Settings.alerts = async (b) => {
  const s = await GET('/alerts');
  const ch = s.channels || {};
  const email = ch.email || {}, tg = ch.telegram || {}, wh = ch.webhook || {}, dc = ch.discord || {}, nt = ch.ntfy || {};
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.info} Alerts <span class="chip ${s.running ? 'ok' : ''}">${s.running ? 'running' : 'idle'}</span></div>
    <p class="muted">Checks about every 60 seconds when enabled and at least one channel is configured.</p>
    <label class="row"><input type="checkbox" data-en ${s.enabled ? 'checked' : ''}> Enable alerts</label>
    <label>Cooldownoldown (minutes)<input type="number" data-cd value="${esc(String(s.cooldownMinutes || 30))}"></label>
    <label class="row"><input type="checkbox" data-quiet ${s.quietMode !== false ? 'checked' : ''}> Quiet mode (doubles cooldown after each fire until recovered)</label>
    <div class="card" style="margin-top:12px" data-hist><div class="card-title">Alert history <button class="sm" data-hist-ref>Refresh</button></div><div data-hist-body class="muted small">Loading…</div></div>
    <div class="card-title" style="margin-top:16px">Rules</div>
    <div class="grid cols-2">
      ${['cpu','mem','disk','temp'].map((k) => {
        const r = (s.rules && s.rules[k]) || {};
        return `<label class="row"><input type="checkbox" data-rule="${k}" ${r.enabled ? 'checked' : ''}> ${k.toUpperCase()} above <input type="number" data-above="${k}" value="${esc(String(r.above ?? 90))}" style="width:70px"> ${k === 'temp' ? '°C' : '%'} ${r.forMinutes != null ? `for <input type="number" data-for="${k}" value="${esc(String(r.forMinutes))}" style="width:60px"> min` : ''}</label>`;
      }).join('')}
      <label class="row"><input type="checkbox" data-rule="containerDown" ${(s.rules && s.rules.containerDown && s.rules.containerDown.enabled) ? 'checked' : ''}> Container down</label>
    </div>
    <div class="card-title" style="margin-top:16px">Channels</div>
    <div class="grid cols-2">
      <div class="card"><div class="card-title">Email <button class="sm" data-test="email">Test</button></div>
        <label class="row"><input type="checkbox" data-c-email-en ${email.enabled ? 'checked' : ''}> Enabled</label>
        <label>Host<input data-c-email-host value="${esc(email.host || '')}"></label>
        <label>Port<input type="number" data-c-email-port value="${esc(String(email.port || 587))}"></label>
        <label>To<input data-c-email-to value="${esc(email.to || '')}"></label>
        <label>From<input data-c-email-from value="${esc(email.from || '')}"></label>
        <label>User<input data-c-email-user value="${esc(email.user || '')}"></label>
        <label>Password<input type="password" data-c-email-pass value="${email.pass ? '••••••' : ''}" placeholder="unchanged if blank"></label>
      </div>
      <div class="card"><div class="card-title">Telegram <button class="sm" data-test="telegram">Test</button></div>
        <label class="row"><input type="checkbox" data-c-tg-en ${tg.enabled ? 'checked' : ''}> Enabled</label>
        <label>Bot token<input data-c-tg-token value="${esc(tg.botToken || '')}"></label>
        <label>Chat ID<input data-c-tg-chat value="${esc(tg.chatId || '')}"></label>
      </div>
      <div class="card"><div class="card-title">Webhook <button class="sm" data-test="webhook">Test</button></div>
        <label class="row"><input type="checkbox" data-c-wh-en ${wh.enabled ? 'checked' : ''}> Enabled</label>
        <label>URL<input data-c-wh-url value="${esc(wh.url || '')}" placeholder="https://…"></label>
      </div>
      <div class="card"><div class="card-title">Discord <button class="sm" data-test="discord">Test</button></div>
        <label class="row"><input type="checkbox" data-c-dc-en ${dc.enabled ? 'checked' : ''}> Enabled</label>
        <label>Webhook URL<input data-c-dc-url value="${esc(dc.webhookUrl || '')}"></label>
      </div>
      <div class="card"><div class="card-title">ntfy <button class="sm" data-test="ntfy">Test</button></div>
        <label class="row"><input type="checkbox" data-c-nt-en ${nt.enabled ? 'checked' : ''}> Enabled</label>
        <label>Server<input data-c-nt-server value="${esc(nt.server || 'https://ntfy.sh')}"></label>
        <label>Topic<input data-c-nt-topic value="${esc(nt.topic || '')}"></label>
        <label>Token<input data-c-nt-token value="${esc(nt.token || '')}" placeholder="optional"></label>
      </div>
    </div>
    <button class="primary" data-save style="margin-top:14px">Save alerts</button></div>`;
  
  const loadHist = async () => {
    const hb = $('[data-hist-body]', b); if (!hb) return;
    try {
      const h = await GET('/alerts/history?limit=40');
      const ev = h.events || [];
      hb.innerHTML = ev.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Key</th><th>Title</th><th>Result</th></tr></thead><tbody>
        ${ev.map((e) => `<tr><td class="muted small">${esc(fmtDate(e.t))}</td><td class="mono small">${esc(e.key)}</td><td>${esc(e.title)}</td><td class="muted small">${esc((e.results || []).join(', '))}</td></tr>`).join('')}
      </tbody></table></div>` : '<span class="muted">No alerts fired yet</span>';
    } catch (e) { hb.textContent = e.message; }
  };
  loadHist();
  const href = $('[data-hist-ref]', b); if (href) href.onclick = (ev) => { ev.preventDefault(); loadHist(); };

b.onclick = async (e) => {
    const test = e.target.closest('[data-test]');
    if (test) {
      const r = await act(test, () => POST('/alerts/test', { channel: test.dataset.test }));
      if (r) toast(JSON.stringify(r.results || r));
      return;
    }
    if (!e.target.closest('[data-save]')) return;
    const rules = {};
    for (const k of ['cpu','mem','disk','temp','containerDown']) {
      rules[k] = { enabled: !!$(`[data-rule="${k}"]`, b)?.checked };
      const above = $(`[data-above="${k}"]`, b); if (above) rules[k].above = Number(above.value);
      const fr = $(`[data-for="${k}"]`, b); if (fr) rules[k].forMinutes = Number(fr.value);
    }
    const payload = {
      enabled: !!$('[data-en]', b).checked,
      cooldownMinutes: Number($('[data-cd]', b).value) || 30,
      quietMode: !!$('[data-quiet]', b)?.checked,
      rules,
      channels: {
        email: {
          enabled: !!$('[data-c-email-en]', b).checked,
          host: $('[data-c-email-host]', b).value, port: Number($('[data-c-email-port]', b).value) || 587,
          to: $('[data-c-email-to]', b).value, from: $('[data-c-email-from]', b).value,
          user: $('[data-c-email-user]', b).value, pass: $('[data-c-email-pass]', b).value,
        },
        telegram: {
          enabled: !!$('[data-c-tg-en]', b).checked,
          botToken: $('[data-c-tg-token]', b).value, chatId: $('[data-c-tg-chat]', b).value,
        },
        webhook: { enabled: !!$('[data-c-wh-en]', b).checked, url: $('[data-c-wh-url]', b).value },
        discord: { enabled: !!$('[data-c-dc-en]', b).checked, webhookUrl: $('[data-c-dc-url]', b).value },
        ntfy: {
          enabled: !!$('[data-c-nt-en]', b).checked,
          server: $('[data-c-nt-server]', b).value, topic: $('[data-c-nt-topic]', b).value, token: $('[data-c-nt-token]', b).value,
        },
      },
    };
    await act(e.target, () => api('PUT', '/alerts', payload), 'Alerts saved');
  };
};

Settings.tokens = async (b) => {
  const r = await GET('/tokens');
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.key} API tokens</div>
    <p class="muted">Bearer tokens for machine auth (skip CSRF). Secret shown only at creation. Header <span class="mono">Authorization: Bearer uk_…</span>. Scopes: <b>read</b> (GET only) or <b>operator</b> (writes).</p>
    <div class="row wrap" style="margin-bottom:12px">
      <input data-name placeholder="Name" style="max-width:160px">
      <select data-scope style="width:auto"><option value="read">read</option><option value="operator" selected>operator</option></select>
      <select data-role style="width:auto"><option value="viewer">viewer</option><option value="operator" selected>operator</option><option value="admin">admin</option></select>
      <input type="number" data-exp placeholder="Expires days (blank=never)" style="max-width:140px" min="1">
      <button class="primary" data-create>Create token</button>
      <button class="danger" data-revoke-all>Revoke all</button>
    </div>
    <table><thead><tr><th>Name</th><th>Scope</th><th>Role</th><th>Prefix</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr></thead><tbody>
      ${(r.tokens || []).map((t) => `<tr class="${t.expired ? 'warn' : ''}">
        <td>${esc(t.name)}</td><td>${esc(t.scope || '—')}</td><td>${esc(t.role)}</td><td class="mono">${esc(t.prefix || '')}…</td>
        <td class="muted small">${t.created ? esc(fmtDate(t.created)) : '—'}</td>
        <td class="muted small">${t.expiresAt ? esc(fmtDate(t.expiresAt)) : 'never'}${t.expired ? ' (expired)' : ''}</td>
        <td class="muted small">${t.lastUsed ? esc(fmtDate(t.lastUsed)) : '—'}</td>
        <td><button class="sm danger" data-rev="${esc(t.id)}">Revoke</button></td>
      </tr>`).join('') || '<tr><td colspan="8" class="empty">No tokens</td></tr>'}
    </tbody></table></div>`;
  b.onclick = async (e) => {
    if (e.target.closest('[data-create]')) {
      const days = $('[data-exp]', b).value;
      const created = await act(e.target, () => POST('/tokens', {
        name: $('[data-name]', b).value,
        role: $('[data-role]', b).value,
        scope: $('[data-scope]', b).value,
        expiresInDays: days ? Number(days) : undefined,
      }));
      if (created && created.token) {
        modal({ title: 'Token created', body: `<p>Copy now — it will not be shown again.</p><p class="mono" style="word-break:break-all">${esc(created.token)}</p>` });
      }
      return Settings.tokens(b);
    }
    if (e.target.closest('[data-revoke-all]')) {
      if (!(await confirmDlg('Revoke ALL API tokens?', 'Every machine token will stop working immediately.', { okLabel: 'Revoke all', danger: true }))) return;
      await act(e.target, () => api('DELETE', '/tokens'), 'All revoked');
      return Settings.tokens(b);
    }
    const rev = e.target.closest('[data-rev]');
    if (rev) {
      await act(rev, () => api('DELETE', '/tokens/' + encodeURIComponent(rev.dataset.rev)), 'Revoked');
      return Settings.tokens(b);
    }
  };
};
