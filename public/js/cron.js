'use strict';
Pages.cron = (el) => {
  el.innerHTML = `<div class="tabs"><button data-tab="user" class="active">User crontab</button><button data-tab="system">/etc/cron.d</button></div><div data-body></div>`;
  let tab = 'user';
  const body = $('[data-body]', el);
  const show = async () => {
    if (tab === 'user') {
      body.innerHTML = `<div class="card"><div class="row"><input data-user value="root" style="max-width:160px"><button data-load>Load</button><div class="spacer"></div>
        <select data-preset style="width:auto"><option value="">Insert preset…</option></select><button data-next>Next runs</button></div>
        <textarea class="editor" data-text style="min-height:40vh;margin-top:12px" spellcheck="false"></textarea>
        <div class="row" style="margin-top:12px"><button class="primary" data-save>Save crontab</button><span class="muted small" data-hint></span></div></div>`;
      const presets = (await GET('/cron/presets')).presets;
      $('[data-preset]', body).innerHTML += presets.map((p) => `<option value="${esc(p.expr)}">${esc(p.label)}</option>`).join('');
      const loadUser = async () => { const r = await GET('/cron/user/' + encodeURIComponent($('[data-user]', body).value.trim())); $('[data-text]', body).value = r.text; $('[data-hint]', body).textContent = r.exists ? '' : 'No crontab yet — saving will create one.'; };
      $('[data-load]', body).onclick = loadUser; loadUser();
      $('[data-preset]', body).onchange = (e) => { if (!e.target.value) return; const ta = $('[data-text]', body); ta.value += (ta.value && !ta.value.endsWith('\n') ? '\n' : '') + e.target.value + ' /bin/true  # ' + e.target.selectedOptions[0].text + '\n'; e.target.value = ''; };
      $('[data-next]', body).onclick = async () => {
        const line = ($('[data-text]', body).value.split('\n').find((l) => l.trim() && !l.trim().startsWith('#')) || '').trim();
        const expr = line.split(/\s+/).slice(0, 5).join(' ');
        const r = await POST('/cron/next', { expr, count: 8 });
        modal({ title: 'Next runs for ' + expr, body: `<ul>${r.next.map((t) => `<li>${esc(fmtDate(Date.parse(t)))}</li>`).join('') || '<li>None</li>'}</ul>` });
      };
      $('[data-save]', body).onclick = async (e) => { await act(e.target, () => api('PUT', '/cron/user/' + encodeURIComponent($('[data-user]', body).value.trim()), { text: $('[data-text]', body).value }), 'Saved'); };
    } else {
      const r = await GET('/cron/system');
      if (!r.available) { body.innerHTML = `<div class="notice">${esc(r.message)}</div>`; return; }
      body.innerHTML = `<div class="card"><div class="card-title">/etc/cron.d <span class="spacer"></span><button class="sm primary" data-new>${ICON.plus} New file</button></div>
        ${r.files.map((f) => `<div class="list-item"><div class="grow"><b class="mono">${esc(f.name)}</b><div class="muted small">${f.lines.filter((l) => l.type === 'job').length} job(s)</div></div>
          <button class="sm" data-edit="${esc(f.name)}">Edit</button><button class="sm danger" data-del="${esc(f.name)}">${ICON.trash}</button></div>`).join('') || '<div class="muted">No files</div>'}</div>`;
      body.onclick = async (e) => {
        if (e.target.closest('[data-new]')) {
          const n = await formDlg('New cron.d file', [{ name: 'name', label: 'File name', placeholder: 'uiable-job' }, { name: 'text', label: 'Contents', value: 'SHELL=/bin/sh\nPATH=/usr/bin:/bin\n\n# m h dom mon dow user command\n0 2 * * * root /bin/true\n' }], 'Create');
          if (!n) return; await act(null, () => api('PUT', '/cron/system/' + encodeURIComponent(n.name), { text: n.text }), 'Created'); return show();
        }
        const ed = e.target.closest('[data-edit]');
        if (ed) {
          const f = r.files.find((x) => x.name === ed.dataset.edit);
          await modal({ title: ed.dataset.edit, full: true, body: `<textarea class="editor" data-t style="min-height:50vh"></textarea>`,
            buttons: [{ label: 'Cancel', value: null }, { label: 'Save', cls: 'primary', handler: async (m) => { await api('PUT', '/cron/system/' + encodeURIComponent(ed.dataset.edit), { text: $('[data-t]', m).value }); toast('Saved'); show(); return true; }, keepOpenOnError: true }],
            onOpen: (m) => { $('[data-t]', m).value = f.text; } });
          return;
        }
        const del = e.target.closest('[data-del]');
        if (del && await confirmDlg('Delete ' + del.dataset.del + '?', 'Removes /etc/cron.d/' + del.dataset.del, { okLabel: 'Delete', danger: true })) { await act(null, () => DEL('/cron/system/' + encodeURIComponent(del.dataset.del))); show(); }
      };
    }
  };
  $$('[data-tab]', el).forEach((b) => b.onclick = () => { tab = b.dataset.tab; $$('[data-tab]', el).forEach((x) => x.classList.toggle('active', x === b)); show(); });
  show();
};
