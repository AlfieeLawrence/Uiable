'use strict';
/* Settings: general (hostname/timezone), network & Wi-Fi, Linux users, dashboard accounts, appearance, power, about. */
const SECTIONS = [
  ['account', 'My account', 'users', 'viewer'],
  ['general', 'General', 'settings', 'admin'], ['network', 'Network & Wi-Fi', 'wifi', 'admin'], ['users', 'Linux users', 'users', 'admin'],
  ['accounts', 'Dashboard accounts', 'key', 'admin'], ['security', 'Security & 2FA', 'lock', 'viewer'], ['alerts', 'Alerts', 'info', 'admin'],
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
        <button class="primary" data-savepm>Save</button></div></div>`;
  GET('/system/timezones').then((r) => { $('#tzlist').innerHTML = r.timezones.map((t) => `<option value="${esc(t)}">`).join(''); }).catch(() => {});
  $('[data-savehn]', b).onclick = async (e) => {
    const v = $('[data-hn]', b).value.trim();
    if (!(await confirmDlg('Change hostname?', `Rename this server to <b class="mono">${esc(v)}</b>?`, { okLabel: 'Change' }))) return;
    await act(e.target.closest('button'), () => POST('/system/hostname', { hostname: v }), 'Hostname changed');
  };
  $('[data-savetz]', b).onclick = async (e) => { await act(e.target.closest('button'), () => POST('/system/timezone', { timezone: $('[data-tz]', b).value.trim() }), 'Time zone updated'); reloadSection(); };
  $('[data-savepm]', b).onclick = async (e) => { await act(e.target.closest('button'), () => POST('/system/primary-mount', { mount: $('[data-pm]', b).value }), 'Primary mount saved'); };
};

const signalBars = (s) => `<span class="signal" title="${s}%">${[20, 45, 65, 85].map((t, i) => `<i class="${s >= t ? 'on' : ''}" style="height:${(i + 1) * 4}px"></i>`).join('')}</span>`;

Settings.network = async (b) => {
  b.innerHTML = `<div data-wifi class="card section"><div class="card-title">${ICON.wifi} Wi-Fi <span class="spacer"></span><button class="sm" data-scan>${ICON.refresh} Scan</button></div><div data-wlist><span class="spinner"></span></div></div>
    <div class="card section"><div class="card-title">${ICON.globe} Interfaces &amp; IP addresses</div><div data-ifs><span class="spinner"></span></div></div>`;
  const loadNet = async () => {
    try {
      const n = await GET('/system/network');
      const devs = Object.fromEntries((n.devices || []).map((d) => [d.device, d]));
      $('[data-ifs]', b).innerHTML = `${n.message ? `<p class="muted small" style="margin-top:0">Read-only: ${n.message.startsWith('NetworkManager (nmcli) is not available') ? 'NetworkManager is not available on this host.' : esc(n.message)}</p>` : ''}
        <table><thead><tr><th>Interface</th><th>State</th><th>Addresses</th><th class="hide-sm">MAC</th><th></th></tr></thead><tbody>${n.interfaces.map((i) => {
          const d = devs[i.name];
          return `<tr><td class="mono"><b>${esc(i.name)}</b>${d ? `<div class="muted small">${esc(d.type)}${d.connection ? ' · ' + esc(d.connection) : ''}</div>` : ''}</td>
          <td><span class="chip ${/up|connected/i.test(i.state) || (d && d.state === 'connected') ? 'ok' : ''}">${esc(d ? d.state : (i.state || '').toLowerCase())}</span></td>
          <td class="mono small">${i.addresses.map(esc).join('<br>') || '<span class="muted">none</span>'}</td><td class="mono muted small hide-sm">${esc(i.mac || '')}</td>
          <td>${n.networkManager && d && d.type !== 'loopback' ? `<div class="actions">${d.state === 'connected' ? `<button class="sm" data-dev="${esc(i.name)}" data-act="disconnect">Disconnect</button>` : `<button class="sm" data-dev="${esc(i.name)}" data-act="connect">Connect</button>`}</div>` : ''}</td></tr>`;
        }).join('')}</tbody></table>
        <div class="kv small" style="margin-top:14px"><div>Default route</div><div class="mono">${esc(n.defaultRoute || 'none')}</div><div>DNS servers</div><div class="mono">${esc((n.dns || []).join(', ') || 'unknown')}</div></div>`;
    } catch (e) { $('[data-ifs]', b).innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  const loadWifi = async (rescan) => {
    const wl = $('[data-wlist]', b); wl.innerHTML = '<span class="spinner"></span> <span class="muted">Scanning…</span>';
    try {
      const w = await GET('/system/wifi' + (rescan ? '?rescan=1' : ''));
      if (!w.available) { wl.innerHTML = `<div class="notice">${esc(w.message)}</div>`; $('[data-scan]', b).disabled = true; return; }
      wl.innerHTML = w.networks.map((n) => `<div class="list-item">${signalBars(n.signal)}<div class="grow"><b>${esc(n.ssid)}</b> ${n.inUse ? '<span class="chip ok">connected</span>' : ''}<div class="muted small">${esc(n.security || 'Open')} · ch ${esc(n.channel)} · ${esc(n.device)}</div></div>
        ${n.inUse ? `<button class="sm" data-dev="${esc(n.device)}" data-act="disconnect">Disconnect</button>` : `<button class="sm primary" data-join="${esc(n.ssid)}" data-sec="${esc(n.security)}" data-wdev="${esc(n.device)}">Connect</button>`}</div>`).join('') + `<div class="list-item"><div class="grow muted">Hidden network?</div><button class="sm" data-hidden>Join other network…</button></div>`;
    } catch (e) { wl.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  const join = async (ssid, security, device, hidden) => {
    const fields = hidden ? [{ name: 'ssid', label: 'Network name (SSID)' }, { name: 'password', label: 'Password (leave empty if open)', type: 'password' }] : (security && security !== '--' ? [{ name: 'password', label: 'Password', type: 'password' }] : []);
    const r = fields.length ? await formDlg(`Connect to ${hidden ? 'hidden network' : ssid}`, fields, 'Connect', { intro: 'If you are connected to this server over the network you are changing, your SSH session may drop.' }) : (await confirmDlg(`Connect to ${esc(ssid)}?`, 'This is an open network.', { okLabel: 'Connect' })) && {};
    if (!r) return;
    const ok = await act(null, () => POST('/system/wifi/connect', { ssid: hidden ? r.ssid : ssid, password: r.password || '', device, hidden: !!hidden }), 'Connected');
    if (ok) { loadWifi(); loadNet(); }
  };
  b.onclick = async (e) => {
    if (e.target.closest('[data-scan]')) return loadWifi(true);
    if (e.target.closest('[data-hidden]')) return join('', '', '', true);
    const j = e.target.closest('[data-join]'); if (j) return join(j.dataset.join, j.dataset.sec, j.dataset.wdev);
    const d = e.target.closest('[data-dev]');
    if (d) {
      if (d.dataset.act === 'disconnect' && !(await confirmDlg(`Disconnect ${esc(d.dataset.dev)}?`, 'If this is the interface your SSH tunnel uses, you will lose access to the server.', { okLabel: 'Disconnect', danger: true }))) return;
      await act(d, () => POST(`/system/network/device/${encodeURIComponent(d.dataset.dev)}/${d.dataset.act}`), 'Done');
      loadNet(); loadWifi();
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
      const f = await formDlg(`Linux user for ${alu.dataset.alu}`, [{ name: 'linuxUser', label: 'Linked Linux user', type: 'html', html: `<label class="field"><span>Linked Linux user</span><select name="linuxUser">${linuxUserOptionsHtml(L.users, alu.dataset.cur, { allowNone: true })}</select></label>` }], 'Save', {
        intro: 'Non-admin accounts always run terminals and scripts as this user. Audit-logged.',
        handler: (v) => POST(`/accounts/${encodeURIComponent(alu.dataset.alu)}/linux-user`, { linuxUser: $('.modal [name=linuxUser]').value }),
      });
      if (f) { toast('Linux user updated'); reloadSection(); }
      return;
    }
    if (e.target.closest('[data-lbind]')) {
      const L = await GET('/accounts-linux-settings');
      const nonRoot = L.users.filter((u) => u.uid !== 0);
      const ok = await modal({ title: 'Linux account linking', body: `<label class="field"><span>Default Linux user for new dashboard accounts</span><select name="def">${linuxUserOptionsHtml(L.users, L.defaultUser, { allowNone: true })}</select></label>
        <div class="field"><span>Users non-admins may link themselves to</span>${nonRoot.map((u) => `<label class="row" style="margin:6px 0"><input type="checkbox" name="al" value="${esc(u.name)}" ${L.allowed.includes(u.name) ? 'checked' : ''}> <span class="mono">${esc(u.name)}</span> <span class="muted small">uid ${u.uid}${u.admin ? ' · sudo' : ''}</span></label>`).join('') || '<p class="muted small">No users with uid ≥ 1000.</p>'}</div>
        <p class="muted small">Admins can link to any user, including root. Root is never offered to non-admins. The default only applies to non-admins if it is also in the allowed list.</p>`,
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
  b.innerHTML = `<div class="card"><div class="card-title">${ICON.palette} Theme</div><div class="seg">${['system', 'light', 'dark'].map((t) => `<button data-t="${t}" class="${t === cur ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <p class="muted small" style="margin-top:12px">Saved in this browser.</p></div>`;
  b.onclick = (e) => { const x = e.target.closest('[data-t]'); if (x) { setTheme(x.dataset.t); $$('[data-t]', b).forEach((y) => y.classList.toggle('active', y === x)); } };
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
  b.innerHTML = `<div class="card section"><div class="card-title">${ICON.info} Alerts <span class="chip ${s.running ? 'ok' : ''}">${s.running ? 'loop running' : 'idle'}</span></div>
    <p class="muted">Checks about every 60 seconds, but only while at least one channel is configured and alerts are enabled. Cooldown prevents spam.</p>
    <label class="row"><input type="checkbox" data-en ${s.enabled ? 'checked' : ''}> Enable alerts</label>
    <label class="field" style="margin-top:10px"><span>Cooldown minutes</span><input data-cd type="number" value="${s.cooldownMinutes}" style="max-width:120px"></label></div>
    <div class="card section"><div class="card-title">Rules</div>
      ${['cpu','mem','disk','temp'].map((k) => { const r = s.rules[k]; return `<div class="list-item"><label class="row"><input type="checkbox" data-r="${k}" ${r.enabled ? 'checked' : ''}> ${k.toUpperCase()} above</label>
        <input data-v="${k}" type="number" value="${r.above}" style="width:80px"> %
        ${r.forMinutes != null ? ` for <input data-for="${k}" type="number" value="${r.forMinutes}" style="width:60px"> min` : ''}</div>`; }).join('')}
      <div class="list-item"><label class="row"><input type="checkbox" data-r="containerDown" ${s.rules.containerDown.enabled ? 'checked' : ''}> Container went down</label>
        <input data-ctrs placeholder="names (blank = any previously seen)" value="${esc((s.rules.containerDown.names || []).join(', '))}" style="flex:1"></div></div>
    <div class="card section"><div class="card-title">Email (SMTP)</div>
      <label class="row"><input type="checkbox" data-eon ${s.channels.email.enabled ? 'checked' : ''}> Enable email</label>
      <div class="grid cols-2" style="margin-top:10px">
        <label class="field"><span>SMTP host</span><input data-ehost value="${esc(s.channels.email.host)}"></label>
        <label class="field"><span>Port</span><input data-eport type="number" value="${s.channels.email.port}"></label>
        <label class="field"><span>Username</span><input data-euser value="${esc(s.channels.email.user)}"></label>
        <label class="field"><span>Password</span><input data-epass type="password" value="${esc(s.channels.email.pass)}" placeholder="unchanged if blank"></label>
        <label class="field"><span>From</span><input data-efrom value="${esc(s.channels.email.from)}"></label>
        <label class="field"><span>To</span><input data-eto value="${esc(s.channels.email.to)}"></label>
      </div>
      <label class="row"><input type="checkbox" data-esec ${s.channels.email.secure ? 'checked' : ''}> Use TLS (port 465 style)</label>
      <button class="sm" data-test-email style="margin-top:8px">Send test email</button></div>
    <div class="card section"><div class="card-title">Telegram</div>
      <label class="row"><input type="checkbox" data-ton ${s.channels.telegram.enabled ? 'checked' : ''}> Enable Telegram</label>
      <label class="field"><span>Bot token</span><input data-ttoken value="${esc(s.channels.telegram.botToken)}"></label>
      <label class="field"><span>Chat ID</span><input data-tchat value="${esc(s.channels.telegram.chatId)}"></label>
      <button class="sm" data-test-tg>Send test message</button></div>
    <button class="primary" data-save>Save alerts</button>`;
  b.onclick = async (e) => {
    if (e.target.closest('[data-test-email]')) { const r = await act(e.target, () => POST('/alerts/test', { channel: 'email' })); if (r) toast(JSON.stringify(r.results)); return; }
    if (e.target.closest('[data-test-tg]')) { const r = await act(e.target, () => POST('/alerts/test', { channel: 'telegram' })); if (r) toast(JSON.stringify(r.results)); return; }
    if (!e.target.closest('[data-save]')) return;
    const payload = {
      enabled: $('[data-en]', b).checked, cooldownMinutes: +$('[data-cd]', b).value,
      rules: {
        cpu: { enabled: $('[data-r="cpu"]', b).checked, above: +$('[data-v="cpu"]', b).value, forMinutes: +$('[data-for="cpu"]', b).value },
        mem: { enabled: $('[data-r="mem"]', b).checked, above: +$('[data-v="mem"]', b).value, forMinutes: +$('[data-for="mem"]', b).value },
        disk: { enabled: $('[data-r="disk"]', b).checked, above: +$('[data-v="disk"]', b).value },
        temp: { enabled: $('[data-r="temp"]', b).checked, above: +$('[data-v="temp"]', b).value },
        containerDown: { enabled: $('[data-r="containerDown"]', b).checked, names: $('[data-ctrs]', b).value.split(',').map((x) => x.trim()).filter(Boolean) },
      },
      channels: {
        email: { enabled: $('[data-eon]', b).checked, host: $('[data-ehost]', b).value, port: +$('[data-eport]', b).value, user: $('[data-euser]', b).value, pass: $('[data-epass]', b).value, from: $('[data-efrom]', b).value, to: $('[data-eto]', b).value, secure: $('[data-esec]', b).checked },
        telegram: { enabled: $('[data-ton]', b).checked, botToken: $('[data-ttoken]', b).value, chatId: $('[data-tchat]', b).value },
      },
    };
    await act(e.target, () => api('PUT', '/alerts', payload), 'Alerts saved');
    reloadSection();
  };
};

async function renameLinuxDlg(name) {
  const c = await GET(`/system/users/${encodeURIComponent(name)}/rename-check`);
  if (c.blocked) { toast(c.blocked, true); return false; }
  const busy = c.sessions || c.procs;
  let done = null;
  const send = async (m, force) => {
    const v = { newName: $('[name=newName]', m).value.trim(), moveHome: $('[name=moveHome]', m).checked, renameGroup: $('[name=renameGroup]', m)?.checked || false, force };
    try { done = await POST(`/system/users/${encodeURIComponent(name)}/rename`, v); return true; }
    catch (e) {
      if (e.status === 409 && /logged in/.test(e.message) && !force) {
        const ok = await modal({ title: `${name} is in use`, body: `<p>${esc(e.message)}</p><p class="muted small">usermod usually refuses while the user has running processes.</p>`, buttons: [{ label: 'Cancel', value: false }, { label: 'Try anyway', cls: 'danger solid', value: true }] });
        return ok ? send(m, true) : false;
      }
      throw e;
    }
  };
  const ok = await modal({
    title: `Rename Linux user ${name}`,
    body: `${busy ? `<div class="notice warn" style="margin-bottom:12px"><b>${esc(name)}</b> ${[c.sessions ? `is logged in (${c.sessions} session${c.sessions === 1 ? '' : 's'})` : '', c.procs ? `has ${c.procs} running process${c.procs === 1 ? '' : 'es'}` : ''].filter(Boolean).join(' and ')}. Renaming a user who is in use can fail or confuse running programs.</div>` : ''}
      <label class="field"><span>New username</span><input name="newName" value="${esc(name)}" pattern="[a-z_][a-z0-9_\-]{0,31}" autocomplete="off"></label>
      <p class="muted small" style="margin-top:-4px">Lowercase letters, digits, - and _. Runs <span class="mono">usermod -l</span>. The uid stays ${c.uid}, so file ownership is unchanged.</p>
      <label class="row" style="margin:12px 0"><input type="checkbox" name="moveHome"> Also move the home directory <span class="mono muted small">${esc(c.home)} → ${esc(c.home.replace(/[^/]+$/, ''))}<span data-newhome>${esc(name)}</span></span></label>
      ${c.primaryGroup ? `<label class="row" style="margin-bottom:12px"><input type="checkbox" name="renameGroup" checked> Also rename the primary group <span class="mono muted small">${esc(c.primaryGroup)}</span></label>` : ''}
      <p class="muted small">Logged to the audit log. Cron jobs, sudoers entries or scripts that mention the old name are not changed.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Rename user', cls: 'primary', handler: (m) => send(m, false), keepOpenOnError: true }],
    onOpen: (m) => { const i = $('[name=newName]', m); i.oninput = () => { $('[data-newhome]', m).textContent = i.value.trim() || '…'; }; i.select(); },
  });
  if (ok && done) { toast(`Renamed to ${done.name}`); return true; }
  return false;
}
