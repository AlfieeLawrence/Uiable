'use strict';
/* Admin-only Scripts app: save/edit/run host shell scripts under /var/lib/uiable/scripts. */

Pages.scripts = (el) => {
  el.innerHTML = `<div class="scripts-layout">
    <aside class="card scripts-list">
      <div class="card-title">${ICON.term} Scripts <span class="spacer"></span>
        <button class="sm primary" data-new>${ICON.plus} New</button></div>
      <div data-list class="muted small">Loading…</div>
      <p class="muted small" style="margin-top:12px">Stored on the host at <span class="mono" data-root>/var/lib/uiable/scripts</span>. Admins edit · operators run as their linked Linux user · audit-logged.</p>
    </aside>
    <div class="card scripts-editor" data-editor>
      <div class="empty">Select a script or create a new one.</div>
    </div>
  </div>`;

  let scripts = [], current = null;
  const listEl = $('[data-list]', el);
  const ed = $('[data-editor]', el);

  const paintList = () => {
    if (!scripts.length) { listEl.innerHTML = '<div class="muted">No scripts yet</div>'; return; }
    listEl.innerHTML = scripts.map((s) => `<button type="button" class="scripts-item ${current && current.id === s.id ? 'active' : ''}" data-id="${esc(s.id)}">
      ${mq(s.name, 'scripts-name')}
      <span class="muted small ellipsis">${esc(s.description || s.path)}</span>
    </button>`).join('');
  };

  const load = async () => {
    try {
      const r = await GET('/scripts');
      scripts = r.scripts || [];
      const rootHint = $('[data-root]', el); if (rootHint && r.root) rootHint.textContent = r.root;
      paintList();
      if (current) {
        const still = scripts.find((s) => s.id === current.id);
        if (still) openScript(still.id); else { current = null; ed.innerHTML = '<div class="empty">Select a script or create a new one.</div>'; }
      }
    } catch (e) { listEl.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };

  const isAdmin = can('admin');
  const runAsSelect = async (sel) => {
    const o = await linuxOptions();
    if (!isAdmin) return `<span class="chip plain" title="Non-admins always run as their linked Linux user">as ${esc(State.linuxUser || 'not linked')}</span>`;
    const users = o.users.length ? o.users : [{ name: 'root', uid: 0 }];
    const has = users.some((u) => u.name === sel);
    return `<label class="row small">Run as <select data-runas class="mono" style="width:auto">${has ? '' : `<option value="${esc(sel)}" selected>${esc(sel)} (missing)</option>`}${linuxUserOptionsHtml(users, sel)}</select></label>`;
  };
  const openScript = async (id) => {
    try {
      const s = await GET('/scripts/' + encodeURIComponent(id));
      const runAsHtml = await runAsSelect(s.runAs || 'root');
      current = s;
      paintList();
      ed.innerHTML = `
        <div class="row wrap" style="gap:8px;margin-bottom:10px">
          <div class="grow" style="min-width:0"><b class="mono">${mq(s.id + '.sh')}</b>
            <div class="muted small ellipsis">${esc(s.path)}</div></div>
          ${runAsHtml}
          ${isAdmin ? `
          <button class="sm" data-cron title="Add to Scheduled">${ICON.clock} Cron</button>
          <button class="sm" data-rename title="Rename">${ICON.edit} Rename</button>
          <button class="sm danger" data-del>${ICON.trash}</button>
          <button class="sm primary" data-save>Save</button>` : ''}
          <button class="sm primary" data-run>${ICON.play} Run</button>
        </div>
        <label class="field"><span>Description</span><input ${isAdmin ? '' : 'readonly'} data-desc value="${esc(s.description || '')}" placeholder="What this script does"></label>
        <textarea class="editor" data-code spellcheck="false" style="min-height:42vh;margin-top:8px"></textarea>
        <div class="card" style="margin-top:12px;padding:0;overflow:hidden">
          <div class="row small" style="padding:8px 12px;border-bottom:1px solid var(--border)">
            <b>Output</b><span class="spacer"></span>
            <span class="chip plain" data-exit>idle</span>
          </div>
          <pre class="out" data-out style="min-height:120px;max-height:28vh;margin:0;border-radius:0;background:var(--input)">(run to see live output)</pre>
        </div>`;
      $('[data-code]', ed).value = s.content || '#!/bin/bash\n\n';
      if (!isAdmin) $('[data-code]', ed).readOnly = true;
    } catch (e) { toastErr(e); }
  };

  const saveCurrent = async () => {
    if (!current) return;
    const content = $('[data-code]', ed).value;
    const description = $('[data-desc]', ed).value;
    if (!isAdmin) return;
    const runAs = $('[data-runas]', ed).value || 'root';
    const login = !!($('[data-login]', ed) || {}).checked;
    await PUT('/scripts/' + encodeURIComponent(current.id), { content, description, runAs, login });
    toast('Saved');
    await load();
  };

  if (!isAdmin) $('[data-new]', el).remove();
  else $('[data-new]', el).onclick = async () => {
    const o = await linuxOptions();
    const dflt = State.linuxUser || 'root';
    const f = await formDlg('New script', [
      { name: 'name', label: 'Name', placeholder: 'backup-photos' },
      { name: 'description', label: 'Description (optional)' },
      { name: 'runAs', label: 'Run as user', type: 'select', options: (o.users.length ? o.users : [{ name: 'root' }]).map((u) => u.name), value: dflt },
    ], 'Create', { intro: 'Run as: real Linux users (uid 1000+) and root. Defaults to your linked Linux user.' });
    if (!f || !f.name) return;
    const id = f.name.replace(/\.sh$/, '');
    await PUT('/scripts/' + encodeURIComponent(id), {
      content: '#!/bin/bash\nset -euo pipefail\necho "Hello from ' + id + '"\n',
      description: f.description || '', runAs: f.runAs || 'root',
    });
    toast('Created');
    await load();
    openScript(id);
  };

  listEl.onclick = (e) => {
    const b = e.target.closest('[data-id]');
    if (b) openScript(b.dataset.id);
  };

  ed.onclick = async (e) => {
    if (e.target.closest('[data-save]')) { try { await act(e.target.closest('button'), saveCurrent); } catch (err) { toastErr(err); } return; }
    if (e.target.closest('[data-del]')) {
      if (!(await confirmDlg('Delete ' + current.id + '?', 'Removes the script from the host.', { okLabel: 'Delete', danger: true }))) return;
      await DEL('/scripts/' + encodeURIComponent(current.id));
      current = null; ed.innerHTML = '<div class="empty">Select a script or create a new one.</div>';
      toast('Deleted'); load(); return;
    }
    if (e.target.closest('[data-rename]')) {
      let res = null;
      const f = await formDlg(`Rename ${current.id}.sh`, [{ name: 'newName', label: 'New name', value: current.id }], 'Rename', {
        intro: 'Keeps run-as and description. Cron entries that call this script and home/dock tiles that point to it are updated. Audit-logged.',
        handler: async (v) => { res = await POST('/scripts/' + encodeURIComponent(current.id) + '/rename', { newName: v.newName.replace(/\.sh$/, '').trim() }); },
      });
      if (!f || !res) return;
      const fx = res.fixed || {};
      toast(`Renamed to ${res.id}.sh` + ((fx.cronFiles || []).length + (fx.crontabs || []).length ? ` · cron updated` : '') + (fx.layouts ? ` · ${fx.layouts} tile(s) updated` : ''));
      current = { id: res.id }; State.layout = null; if (typeof Home !== 'undefined') Home.layout = null;
      await load(); openScript(res.id);
      return;
    }
    if (e.target.closest('[data-cron]')) {
      const path = current.path || `/var/lib/uiable/scripts/${current.id}.sh`;
      const runAs = (($('[data-runas]', ed) || {}).value || 'root').trim();
      location.hash = '#/cron';
      toast(`Add a cron line like: 0 3 * * * ${runAs} ${path}`);
      return;
    }
    if (e.target.closest('[data-run]')) {
      try {
        await saveCurrent();
        const sel = $('[data-runas]', ed);
        const r = await POST('/scripts/' + encodeURIComponent(current.id) + '/run', sel ? { runAs: sel.value, login: !!($('[data-login]', ed) || {}).checked } : {});
        const pre = $('[data-out]', ed);
        const chip = $('[data-exit]', ed);
        chip.className = 'chip warn'; chip.textContent = 'running…';
        let timer;
        const tick = async () => {
          try {
            const j = await GET('/jobs/' + r.job.id);
            pre.textContent = j.output || '(no output yet)';
            pre.scrollTop = pre.scrollHeight;
            if (j.state === 'running') timer = setTimeout(tick, 800);
            else {
              chip.className = j.state === 'done' ? 'chip ok' : 'chip bad';
              chip.textContent = `exit ${j.code == null ? '?' : j.code}`;
              toast(j.state === 'done' ? 'Finished' : 'Failed', j.state !== 'done');
            }
          } catch (err) { chip.className = 'chip bad'; chip.textContent = 'error'; pre.textContent += '\n' + err.message; }
        };
        tick();
        return () => clearTimeout(timer);
      } catch (err) { toastErr(err); }
    }
  };

  load();
  return null;
};
