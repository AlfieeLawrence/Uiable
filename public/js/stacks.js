'use strict';
Pages.stacks = (el, params) => {
  if (params[0]) return stackDetail(el, params[0]);
  el.innerHTML = `<div class="toolbar"><div class="spacer"></div>${can('operator') ? `<button class="primary" data-new>${ICON.plus} New stack</button>` : ''}<button data-refresh>${ICON.refresh}</button></div><div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/stacks');
      if (!r.stacks.length) { body.innerHTML = `<div class="empty">No compose stacks yet. Install something from the App store, or create one.</div>`; return; }
      body.innerHTML = `<div class="grid cols-4" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${r.stacks.map((s) => `
        <div class="card ctr"><div class="head"><div class="avatar" style="background:${ctrColor(s.name)}">${esc(s.name[0].toUpperCase())}</div>
          <div class="grow"><b class="ellipsis">${esc(s.name)}</b><div class="meta">${s.services} service(s)${s.meta && s.meta.app ? ' · ' + esc(s.meta.app) : ''}</div></div>
          <span class="chip ${s.state.running ? 'ok' : ''}">${s.state.running}/${s.state.total} up</span></div>
          <div class="btns"><a class="btn sm" href="#/stacks/${encodeURIComponent(s.name)}">Open</a>
            ${can('operator') ? `<button class="sm" data-up="${esc(s.name)}">${ICON.play} Up</button><button class="sm" data-down="${esc(s.name)}">${ICON.stop} Down</button>` : ''}</div></div>`).join('')}</div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $('[data-refresh]', el).onclick = load;
  const neu = $('[data-new]', el); if (neu) neu.onclick = async () => {
    const r = await formDlg('New compose stack', [
      { name: 'name', label: 'Name', placeholder: 'my-app' },
      { name: 'yaml', label: 'docker-compose.yml', type: 'text' },
    ], 'Create');
    // Use a proper textarea via modal instead
  };
  if (neu) neu.onclick = () => editStack(null, load);
  body.onclick = async (e) => {
    const up = e.target.closest('[data-up]'); if (up) { const r = await act(up, () => POST(`/stacks/${up.dataset.up}/up`)); if (r) { await watchJob(r.job); load(); } return; }
    const down = e.target.closest('[data-down]'); if (down) { if (!(await confirmDlg('Bring down ' + down.dataset.down + '?', 'Containers will be stopped and removed (volumes kept).', { okLabel: 'Down', danger: true }))) return; const r = await act(down, () => POST(`/stacks/${down.dataset.down}/down`)); if (r) { await watchJob(r.job); load(); } }
  };
  load();
};

async function editStack(name, onDone) {
  let initial = `services:\n  app:\n    image: nginx:alpine\n    ports:\n      - "8088:80"\n`;
  let stackName = name || '';
  if (name) { const r = await GET('/stacks/' + encodeURIComponent(name)); initial = r.yaml; stackName = r.name; }
  await modal({
    title: name ? `Edit ${name}` : 'New stack', full: true,
    body: `${name ? '' : '<label class="field"><span>Name</span><input data-name placeholder="my-app"></label>'}<textarea class="editor" data-yaml spellcheck="false" style="min-height:50vh"></textarea>`,
    buttons: [
      { label: 'Cancel', value: null },
      { label: 'Validate', handler: async (m) => { const r = await POST('/stacks/validate', { yaml: $('[data-yaml]', m).value }); toast(r.ok ? 'Valid: ' + r.services.join(', ') : r.error, !r.ok); return false; }, keepOpenOnError: true },
      can('operator') ? { label: name ? 'Save' : 'Create', cls: 'primary', handler: async (m) => {
        const yml = $('[data-yaml]', m).value;
        if (name) await api('PUT', '/stacks/' + encodeURIComponent(name), { yaml: yml });
        else await POST('/stacks', { name: $('[data-name]', m).value.trim(), yaml: yml });
        toast('Saved'); if (onDone) onDone(); return true;
      }, keepOpenOnError: true } : null,
    ].filter(Boolean),
    onOpen: (m) => { $('[data-yaml]', m).value = initial; if (!name) $('[data-name]', m).value = stackName; },
  });
}

function stackDetail(el, name) {
  el.innerHTML = `<div class="toolbar"><button data-edit>${ICON.edit} Edit YAML</button>${can('operator') ? `<button data-a="up">${ICON.play} Up</button><button data-a="pull">${ICON.download} Pull</button><button data-a="down">${ICON.stop} Down</button><button class="danger" data-del>${ICON.trash}</button>` : ''}<div class="spacer"></div><button data-refresh>${ICON.refresh}</button></div><div data-body></div>`;
  const body = $('[data-body]', el);
  const load = async () => {
    try {
      const r = await GET('/stacks/' + encodeURIComponent(name));
      body.innerHTML = `<div class="grid cols-2"><div class="card"><div class="card-title">Status</div>${(r.status.containers || []).map((c) => `<div class="list-item"><span class="chip ${/running/i.test(c.State || c.Status || '') ? 'ok' : ''}">${esc(c.State || c.Status || '')}</span><div class="grow mono">${esc(c.Name || c.Service || '')}</div></div>`).join('') || '<div class="muted">No containers</div>'}${r.status.error ? `<div class="notice">${esc(r.status.error)}</div>` : ''}</div>
        <div class="card"><div class="card-title">Compose file</div><pre class="out" style="max-height:50vh">${esc(r.yaml)}</pre></div></div>
        <div class="card" style="margin-top:16px"><div class="card-title">Logs <button class="sm" data-logs>Refresh</button></div><pre class="out" data-logout style="max-height:40vh">Click refresh.</pre></div>`;
      $('[data-logs]', body).onclick = async () => { const l = await GET(`/stacks/${encodeURIComponent(name)}/logs?tail=200`); $('[data-logout]', body).textContent = l.logs || '(empty)'; };
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $('[data-edit]', el).onclick = () => editStack(name, load);
  $('[data-refresh]', el).onclick = load;
  $$('[data-a]', el).forEach((b) => b.onclick = async () => { const r = await act(b, () => POST(`/stacks/${encodeURIComponent(name)}/${b.dataset.a}`)); if (r) { await watchJob(r.job); load(); } });
  const del = $('[data-del]', el); if (del) del.onclick = async () => { if (!(await confirmDlg('Delete stack ' + name + '?', 'Removes the compose files. Bring the stack down first.', { okLabel: 'Delete', danger: true }))) return; await act(del, () => DEL('/stacks/' + encodeURIComponent(name))); location.hash = '#/stacks'; };
  load();
}
