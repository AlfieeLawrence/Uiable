'use strict';
Pages.backup = (el) => {
  el.innerHTML = `<div class="toolbar">
    <button class="primary" data-add>Add profile</button>
    <button data-secrets>Secrets status</button>
    <button data-ref>${ICON.refresh} Refresh</button>
  </div><div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/backup');
      if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message || 'Install restic or rsync on the host to enable backups.')}</div>`; return; }
      const sec = r.secrets || {};
      body.innerHTML = `<div class="notice info">Available: ${r.restic ? 'restic ' : ''}${r.rsync ? 'rsync' : ''}
        · Secrets: ${sec.unlocked ? '<span class="chip ok">unlocked</span>' : (sec.encrypted ? '<span class="chip warn">locked</span>' : '<span class="chip">not set</span>')}
        <span class="muted small">(passwords live in secrets.env.enc — never in backups.json)</span></div>
        <div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Kind</th><th>Source</th><th>Dest</th><th>Secrets</th><th>Last</th><th></th></tr></thead><tbody>
        ${(r.profiles || []).map((p) => `<tr>
          <td><b>${esc(p.name)}</b></td><td class="mono">${esc(p.kind)}</td>
          <td class="mono small">${esc(p.source)}</td><td class="mono small">${esc(p.dest)}</td>
          <td class="muted small">${p.hasPassword || (p.secrets && p.secrets.resticPassword) ? 'password ✓' : '—'}</td>
          <td class="muted small">${p.lastRun ? esc(fmtDate(p.lastRun)) : '—'} ${p.lastStatus ? esc(p.lastStatus) : ''}</td>
          <td class="row"><button class="sm primary" data-run="${esc(p.id)}">Run</button>
            ${p.kind === 'restic' ? `<button class="sm" data-setpw="${esc(p.id)}">Set password</button><button class="sm" data-snap="${esc(p.id)}">Snapshots</button>` : ''}
            <button class="sm danger" data-del="${esc(p.id)}">Delete</button></td>
        </tr>`).join('') || '<tr><td colspan="7" class="empty">No backup profiles yet</td></tr>'}
        </tbody></table></div></div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  el.onclick = async (e) => {
    if (e.target.closest('[data-ref]')) return load();
    if (e.target.closest('[data-secrets]')) {
      const st = await GET('/secrets/status');
      const actn = await formDlg('Secrets', [
        { name: 'action', label: 'Action', type: 'select', value: st.unlocked ? 'lock' : 'unlock', options: ['unlock', 'lock', 'status'] },
        { name: 'passphrase', label: 'Passphrase (unlock)', type: 'password', value: '' },
      ], 'Go');
      if (!actn) return;
      if (actn.action === 'unlock') await act(null, () => POST('/secrets/unlock', { passphrase: actn.passphrase }), 'Unlocked');
      else if (actn.action === 'lock') await act(null, () => POST('/secrets/lock'), 'Locked');
      else modal({ title: 'Secrets status', body: `<pre class="mono small">${esc(JSON.stringify(st, null, 2))}</pre>` });
      return load();
    }
    if (e.target.closest('[data-add]')) {
      const f = await formDlg('Add backup profile', [
        { name: 'kind', label: 'Kind', type: 'select', value: 'restic', options: ['restic', 'rsync'] },
        { name: 'name', label: 'Name', value: 'Backup' },
        { name: 'source', label: 'Source path', value: '/home' },
        { name: 'dest', label: 'Destination (restic repo or rsync target)', value: '' },
        { name: 'password', label: 'Restic password (stored encrypted)', type: 'password', value: '' },
        { name: 'passphrase', label: 'Secrets passphrase (if locked)', type: 'password', value: '' },
      ], 'Create');
      if (!f) return;
      await act(null, () => POST('/backup', f), 'Profile created');
      return load();
    }
    const setpw = e.target.closest('[data-setpw]');
    if (setpw) {
      const f = await formDlg('Set restic password', [
        { name: 'password', label: 'Restic password', type: 'password', value: '' },
        { name: 'passphrase', label: 'Secrets passphrase (if locked)', type: 'password', value: '' },
      ], 'Save');
      if (!f || !f.password) return;
      await act(null, () => api('PUT', '/backup/' + encodeURIComponent(setpw.dataset.setpw) + '/secrets', f), 'Password stored encrypted');
      return load();
    }
    const run = e.target.closest('[data-run]');
    if (run) {
      if (!(await confirmDlg('Run backup now?', 'Starts a background job.', { okLabel: 'Run' }))) return;
      const j = await act(run, () => POST('/backup/' + encodeURIComponent(run.dataset.run) + '/run'));
      if (j && j.job) await watchJob(j.job, 'Backup');
      return load();
    }
    const snap = e.target.closest('[data-snap]');
    if (snap) {
      const r = await GET('/backup/' + encodeURIComponent(snap.dataset.snap) + '/snapshots');
      modal({ title: 'Snapshots', wide: true, body: `<pre class="mono small">${esc(JSON.stringify(r.snapshots || [], null, 2))}</pre>` });
      return;
    }
    const del = e.target.closest('[data-del]');
    if (del) {
      if (!(await confirmDlg('Delete profile?', 'Does not delete the backup data itself.', { okLabel: 'Delete', danger: true }))) return;
      await act(del, () => api('DELETE', '/backup/' + encodeURIComponent(del.dataset.del)), 'Deleted');
      return load();
    }
  };
  load();
};
