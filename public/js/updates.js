'use strict';
Pages.updates = (el) => {
  el.innerHTML = `<div class="tabs"><button data-tab="host" class="active">Host packages</button><button data-tab="images">Container images</button></div>
    <div class="toolbar"><button data-refresh>${ICON.refresh} Check now</button><div class="spacer"></div><span class="muted small" data-when></span></div>
    <div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  let tab = 'host';
  const body = $('[data-body]', el);
  const load = async (force) => {
    body.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
    try {
      if (tab === 'host') {
        const r = await GET('/updates/host' + (force ? '?refresh=1' : ''));
        $('[data-when]', el).textContent = r.checkedAt ? 'Checked ' + fmtDate(r.checkedAt) : '';
        if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
        body.innerHTML = `<div class="card"><div class="card-title">${r.updates.length} package update(s) (${esc(r.kind)}) <span class="spacer"></span>${r.updates.length ? `<button class="primary" data-apply-host>Upgrade all</button>` : ''}</div>
          ${r.updates.length ? `<div class="table-wrap"><table><thead><tr><th>Package</th><th>Current</th><th>New</th></tr></thead><tbody>${r.updates.map((u) => `<tr><td class="mono">${esc(u.name)}</td><td class="muted">${esc(u.oldVersion)}</td><td>${esc(u.newVersion)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">System packages are up to date.</div>'}</div>`;
        const b = $('[data-apply-host]', body); if (b) b.onclick = async () => { if (!(await confirmDlg('Upgrade all packages?', 'Runs the system package manager upgrade. This can take a while and may restart services.', { okLabel: 'Upgrade' }))) return; const j = await act(b, () => POST('/updates/host/apply')); if (j) await watchJob(j.job, 'Host upgrade'); load(true); };
      } else {
        const r = await GET('/updates/images' + (force ? '?refresh=1' : ''));
        $('[data-when]', el).textContent = r.checkedAt ? 'Checked ' + fmtDate(r.checkedAt) : '';
        if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
        const list = r.images || [];
        body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Image</th><th>Containers</th><th>Local digest</th><th>Remote</th><th></th></tr></thead><tbody>
          ${list.map((i) => `<tr><td class="mono">${esc(i.tag)}</td><td>${esc(i.containers.join(', '))}</td>
            <td class="mono small muted">${esc((i.local || '—').slice(0, 19))}</td><td class="mono small">${i.update ? '<span class="chip warn">update</span> ' : ''}${esc((i.remote || i.error || '—').toString().slice(0, 19))}</td>
            <td>${i.update ? `<button class="sm primary" data-img="${esc(i.tag)}">Update</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">No tagged images in use</td></tr>'}</tbody></table></div></div>`;
        $$('[data-img]', body).forEach((b) => b.onclick = async () => { if (!(await confirmDlg('Update ' + b.dataset.img + '?', 'Pulls the new image and recreates containers (compose projects use compose up --force-recreate).', { okLabel: 'Update' }))) return; const j = await act(b, () => POST('/updates/images/apply', { tag: b.dataset.img })); if (j) { await watchJob(j.job, 'Updating ' + b.dataset.img); load(true); } });
      }
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $$('[data-tab]', el).forEach((b) => b.onclick = () => { tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('active', x === b)); load(false); });
  $('[data-refresh]', el).onclick = () => load(true);
  load(false);
};
