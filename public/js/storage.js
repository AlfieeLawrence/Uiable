'use strict';
Pages.storage = (el, params) => {
  // RAID / ZFS panel is loaded alongside disks

  el.innerHTML = `<div class="tabs"><button data-tab="disks" class="active">Disks</button><button data-tab="usage">Folder usage</button></div><div data-body></div>
  <div data-raid style="margin-top:14px"></div>`;

  const raidBox = () => $('[data-raid]', el);
  const loadRaid = async () => {
    const box = raidBox(); if (!box) return;
    try {
      const r = await GET('/storage/raid');
      const md = r.mdadm || {}, z = r.zfs || {};
      box.innerHTML = `<div class="grid cols-2">
        <div class="card"><div class="card-title">MD RAID ${md.available ? '' : '<span class="chip">n/a</span>'}</div>
          ${!md.available ? '<p class="muted">mdadm not installed</p>' : `<pre class="mono small">${esc(md.mdstat || md.scan || 'No arrays')}</pre>
            <ul>${(md.arrays||[]).map((a) => `<li class="mono">${esc(a.name)} · ${esc(a.level)} · ${esc(a.status)} · ${esc(a.devices)}
              <button class="sm" data-md-start="${esc(a.name)}">Start</button>
              <button class="sm danger" data-md-stop="${esc(a.name)}">Stop</button></li>`).join('') || ''}</ul>`}
        </div>
        <div class="card"><div class="card-title">ZFS ${z.available ? '' : '<span class="chip">n/a</span>'}</div>
          ${!z.available ? '<p class="muted">zfs/zpool not installed</p>' : `
            <div class="table-wrap"><table><thead><tr><th>Pool</th><th>Size</th><th>Alloc</th><th>Health</th><th></th></tr></thead><tbody>
              ${(z.pools||[]).map((p) => `<tr><td class="mono">${esc(p.name)}</td><td>${esc(p.size)}</td><td>${esc(p.alloc)}</td><td>${esc(p.health)}</td>
                <td><button class="sm" data-zscrub="${esc(p.name)}">Scrub</button></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No pools</td></tr>'}
            </tbody></table></div>`}
        </div>
      </div>`;
      const box = raidBox();
      if (box && !box._raidBound) {
        box._raidBound = true;
        box.addEventListener('click', async (ev) => {
          const stBtn = ev.target.closest('[data-md-start]');
          if (stBtn) {
            if (!(await confirmDlg('Start array ' + stBtn.dataset.mdStart + '?', 'Runs mdadm --run. Safe assemble only.', { okLabel: 'Start' }))) return;
            await act(stBtn, () => POST('/storage/raid/mdadm/' + encodeURIComponent(stBtn.dataset.mdStart) + '/start'), 'Started');
            return loadRaid();
          }
          const sp = ev.target.closest('[data-md-stop]');
          if (sp) {
            if (!(await confirmDlg('STOP array ' + sp.dataset.mdStop + '?', 'Confirm exact name. Does not destroy the array.', { okLabel: 'Stop ' + sp.dataset.mdStop, danger: true }))) return;
            await act(sp, () => POST('/storage/raid/mdadm/' + encodeURIComponent(sp.dataset.mdStop) + '/stop', { confirm: sp.dataset.mdStop }), 'Stopped');
            return loadRaid();
          }
          const zb = ev.target.closest('[data-zscrub]');
          if (zb) {
            if (!(await confirmDlg('Scrub ZFS pool ' + zb.dataset.zscrub + '?', 'Starts zpool scrub (no destroy).', { okLabel: 'Scrub' }))) return;
            await act(zb, () => POST('/storage/raid/zfs/' + encodeURIComponent(zb.dataset.zscrub) + '/scrub'), 'Scrub started');
            return loadRaid();
          }
        });
      }
    } catch (e) { if (raidBox()) raidBox().innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  loadRaid();

  let tab = 'disks';
  const body = $('[data-body]', el);
  const showDisks = async () => {
    body.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      const r = await GET('/storage/disks');
      const row = (d, depth) => `<tr><td style="padding-left:${12 + depth * 16}px" class="mono">${esc(d.path || d.name)}</td><td>${esc(d.type)}</td><td>${esc(d.fstype || '—')}</td>
        <td class="right">${fmtBytes(d.size)}</td><td class="mono small">${esc(d.mount || '—')}</td><td class="muted small">${esc([d.model, d.serial, d.tran].filter(Boolean).join(' · '))}</td>
        <td><div class="actions">${d.type === 'disk' ? `<button class="sm" data-smart="${esc(d.path)}">SMART</button>` : ''}
          ${can('admin') && d.mount ? `<button class="sm" data-umount="${esc(d.mount)}">Unmount</button>` : ''}
          ${can('admin') && !d.mount && (d.type === 'part' || d.fstype) ? `<button class="sm" data-mount="${esc(d.path)}" data-fs="${esc(d.fstype || '')}">Mount</button>` : ''}
          ${can('admin') && d.type === 'part' && !d.mount ? `<button class="sm danger" data-fmt="${esc(d.path)}">Format</button>` : ''}</div></td></tr>${(d.children || []).map((c) => row(c, depth + 1)).join('')}`;
      body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Device</th><th>Type</th><th>FS</th><th class="right">Size</th><th>Mount</th><th>Model</th><th></th></tr></thead><tbody>${r.disks.map((d) => row(d, 0)).join('') || '<tr><td colspan="7" class="empty">No block devices</td></tr>'}</tbody></table></div></div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  const showUsage = async (path = '/') => {
    body.innerHTML = `<div class="toolbar"><div class="crumbs" data-crumbs></div><button data-ref>${ICON.refresh}</button></div><div class="card flush"><div class="empty"><span class="spinner"></span> Scanning…</div></div>`;
    try {
      const r = await GET('/storage/usage?path=' + encodeURIComponent(path));
      const parts = path.split('/').filter(Boolean);
      let acc = '';
      $('[data-crumbs]', body).innerHTML = `<a href="#" data-go="/">/</a>` + parts.map((p) => { acc += '/' + p; return `<span class="sep">/</span><a href="#" data-go="${esc(acc)}">${esc(p)}</a>`; }).join('');
      $('[data-crumbs]', body).onclick = (e) => { const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); showUsage(a.dataset.go); } };
      $('[data-ref]', body).onclick = () => showUsage(path);
      const max = Math.max(1, ...r.items.map((i) => i.size || 0));
      body.querySelector('.card').innerHTML = `<div class="table-wrap"><table><thead><tr><th>Name</th><th class="right">Size</th><th style="width:40%"></th></tr></thead><tbody>
        ${r.items.map((i) => `<tr data-n="${esc(i.name)}" data-t="${i.type}"><td class="fname">${i.type === 'dir' ? ICON.folder : ICON.file}<span>${esc(i.name)}</span></td>
          <td class="right nowrap">${i.size != null ? fmtBytes(i.size) : '…'}</td>
          <td>${i.size != null ? bar((i.size / max) * 100) : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Empty</td></tr>'}</tbody></table>
        <p class="muted small" style="padding:10px 14px">Total of this folder: ${r.total != null ? fmtBytes(r.total) : '—'}</p></div>`;
      $$('tbody tr', body).forEach((tr) => tr.ondblclick = () => { if (tr.dataset.t === 'dir') showUsage((path === '/' ? '' : path) + '/' + tr.dataset.n); });
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  body.onclick = async (e) => {
    const sm = e.target.closest('[data-smart]');
    if (sm) {
      const r = await act(null, () => GET('/storage/smart/' + encodeURIComponent(sm.dataset.smart)));
      if (!r) return;
      if (!r.available) return toast(r.message, true);
      modal({ title: 'SMART · ' + sm.dataset.smart, wide: true, body: `<p>Health: <b>${r.healthy === true ? 'PASSED' : r.healthy === false ? 'FAILED' : 'unknown'}</b> · ${esc(r.model || '')} · ${esc(r.serial || '')}${r.temp != null ? ' · ' + r.temp + '°C' : ''}</p>
        <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Value</th><th>Worst</th><th>Raw</th></tr></thead><tbody>${(r.attributes || []).map((a) => `<tr><td>${a.id}</td><td>${esc(a.name)}</td><td>${a.value}</td><td>${a.worst}</td><td>${a.raw}</td></tr>`).join('')}</tbody></table></div>` });
      return;
    }
    const um = e.target.closest('[data-umount]');
    if (um) { if (!(await confirmDlg('Unmount ' + um.dataset.umount + '?', 'Open files on this mount will break.', { okLabel: 'Unmount', danger: true }))) return; await act(um, () => POST('/storage/unmount', { target: um.dataset.umount }), 'Unmounted'); showDisks(); return; }
    const mt = e.target.closest('[data-mount]');
    if (mt) {
      const r = await formDlg('Mount ' + mt.dataset.mount, [
        { name: 'target', label: 'Mount point', value: '/mnt/' + mt.dataset.mount.split('/').pop() },
        { name: 'fstype', label: 'Filesystem (blank = auto)', value: mt.dataset.fs || '' },
        { name: 'fstab', label: 'Also add to /etc/fstab', type: 'checkbox' },
      ], 'Mount');
      if (!r) return;
      await act(null, () => POST('/storage/mount', { device: mt.dataset.mount, target: r.target, fstype: r.fstype, fstab: r.fstab }), 'Mounted');
      showDisks(); return;
    }
    const fmt = e.target.closest('[data-fmt]');
    if (fmt) {
      const r = await formDlg('Format ' + fmt.dataset.fmt, [
        { name: 'fstype', label: 'Filesystem', type: 'select', options: ['ext4', 'ext3', 'xfs', 'btrfs', 'vfat'], value: 'ext4' },
        { name: 'confirm', label: `Type ${fmt.dataset.fmt} to confirm`, placeholder: fmt.dataset.fmt },
      ], 'Format disk', { intro: '<b class="danger">This erases all data on the device.</b>' });
      if (!r) return;
      const j = await act(null, () => POST('/storage/format', { device: fmt.dataset.fmt, fstype: r.fstype, confirm: r.confirm }));
      if (j) await watchJob(j.job, 'Formatting');
      showDisks();
    }
  };
  $$('[data-tab]', el).forEach((b) => b.onclick = () => { tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('active', x === b)); tab === 'disks' ? showDisks() : showUsage('/'); });
  showDisks();
};
