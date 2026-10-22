'use strict';
/* Docker: containers, images, volumes. */

Pages.docker = (el, params) => {
  let tab = params[0] || 'containers'; let filter = ''; let timer = null; let selfName = '';
  el.innerHTML = `<div data-status></div><div class="toolbar"><div class="tabs" style="margin:0">${['containers', 'images', 'volumes'].map((t) => `<button data-tab="${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <input class="search" placeholder="Filter…"><div class="spacer"></div><span data-extra class="row"></span><button data-refresh>${ICON.refresh} Refresh</button></div><div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const status = $('[data-status]', el);

  async function checkStatus() {
    const s = await GET('/docker/status');
    if (!s.available) { status.innerHTML = `<div class="notice">${esc(s.message)}</div>`; body.innerHTML = ''; return false; }
    status.innerHTML = '';
    return true;
  }

  async function containers() {
    const r = await GET('/docker/containers');
    selfName = r.self;
    const f = filter.toLowerCase();
    const list = r.containers.filter((c) => !f || c.Names.join(' ').toLowerCase().includes(f) || c.Image.toLowerCase().includes(f));
    list.sort((a, b) => (a.State === 'running' ? 0 : 1) - (b.State === 'running' ? 0 : 1) || a.Names[0].localeCompare(b.Names[0]));
    const running = r.containers.filter((c) => c.State === 'running').length;
    $('[data-extra]', el).innerHTML = `<span class="muted small">${running} running · ${r.containers.length - running} stopped</span><button class="sm" data-prune="containers">Prune stopped</button>`;
    if (!list.length) { body.innerHTML = '<div class="empty">No containers</div>'; return; }
    body.innerHTML = `<div class="grid cols-4" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">${list.map((c) => {
      const name = c.Names[0].replace(/^\//, '');
      const st = c.State === 'running' ? 'ok' : c.State === 'restarting' || c.State === 'paused' ? 'warn' : c.State === 'exited' && !/\(0\)/.test(c.Status) ? 'bad' : '';
      const ports = (c.Ports || []).filter((p) => p.PublicPort).map((p) => `${p.IP && p.IP !== '0.0.0.0' && p.IP !== '::' ? p.IP + ':' : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}`);
      const uniqPorts = [...new Set(ports)];
      const isSelf = selfName && (c.Id.startsWith(selfName) || name === 'uiable');
      return `<div class="card ctr"><div class="head"><div class="avatar" style="background:${ctrColor(name)}">${esc(name[0] ? name[0].toUpperCase() : '?')}</div>
        <div class="grow" style="min-width:0"><div class="ellipsis"><b>${esc(name)}</b> ${isSelf ? '<span class="chip plain small">this app</span>' : ''}</div><div class="meta ellipsis" title="${esc(c.Image)}">${esc(c.Image)}</div></div><span class="chip ${st}">${esc(c.State)}</span></div>
        <div class="meta">${esc(c.Status)}${uniqPorts.length ? ' · ' + esc(uniqPorts.join(', ')) : ''}${c.Labels && c.Labels['com.docker.compose.project'] ? ' · compose: ' + esc(c.Labels['com.docker.compose.project']) : ''}</div>
        <div class="btns">${c.State === 'running'
          ? `<button class="sm" data-c="${c.Id}" data-a="restart">${ICON.restart} Restart</button><button class="sm" data-c="${c.Id}" data-a="stop" data-self="${isSelf ? 1 : ''}">${ICON.stop} Stop</button><button class="sm" data-c="${c.Id}" data-a="stats" data-name="${esc(name)}">${ICON.chart} Stats</button>`
          : `<button class="sm" data-c="${c.Id}" data-a="start">${ICON.play} Start</button>`}
          <button class="sm" data-c="${c.Id}" data-a="logs" data-name="${esc(name)}">${ICON.logs} Logs</button>
          <button class="sm icon danger" title="Remove" data-c="${c.Id}" data-a="remove" data-name="${esc(name)}" data-self="${isSelf ? 1 : ''}">${ICON.trash}</button></div></div>`;
    }).join('')}</div>`;
  }

  async function images() {
    const r = await GET('/docker/images');
    const f = filter.toLowerCase();
    const list = r.images.filter((i) => !f || (i.RepoTags || []).join(' ').toLowerCase().includes(f) || i.Id.includes(f));
    $('[data-extra]', el).innerHTML = `<span class="muted small">${r.images.length} images · ${fmtBytes(r.images.reduce((a, i) => a + i.Size, 0))}</span><button class="sm" data-prune="images">Prune dangling</button>`;
    body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Repository:Tag</th><th>ID</th><th class="right">Size</th><th>Created</th><th class="right">In use</th><th></th></tr></thead><tbody>
      ${list.map((i) => `<tr><td class="mono">${(i.RepoTags && i.RepoTags.length && i.RepoTags[0] !== '<none>:<none>' ? i.RepoTags : ['<none>']).map(esc).join('<br>')}</td><td class="mono muted">${esc(i.Id.replace('sha256:', '').slice(0, 12))}</td>
      <td class="right nowrap">${fmtBytes(i.Size)}</td><td class="muted nowrap">${timeAgo(i.Created)}</td><td class="right">${i.Containers > 0 ? i.Containers : i.Containers === 0 ? '0' : '–'}</td>
      <td><div class="actions"><button class="sm icon danger" title="Remove image" data-img="${esc(i.Id)}" data-name="${esc((i.RepoTags || [''])[0])}">${ICON.trash}</button></div></td></tr>`).join('') || '<tr><td colspan="6" class="empty">No images</td></tr>'}</tbody></table></div></div>`;
  }

  async function volumes() {
    const r = await GET('/docker/volumes');
    const f = filter.toLowerCase();
    const list = (r.Volumes || []).filter((v) => !f || v.Name.toLowerCase().includes(f));
    $('[data-extra]', el).innerHTML = `<span class="muted small">${(r.Volumes || []).length} volumes</span><button class="sm" data-prune="volumes">Prune unused</button>`;
    body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Driver</th><th class="hide-sm">Mountpoint</th><th>Created</th><th></th></tr></thead><tbody>
      ${list.map((v) => `<tr><td class="mono ellipsis" style="max-width:300px" title="${esc(v.Name)}">${esc(v.Name)}</td><td>${esc(v.Driver)}</td><td class="mono muted small hide-sm"><a href="#/files/${encodeURIComponent(v.Mountpoint)}">${esc(v.Mountpoint)}</a></td><td class="muted nowrap">${v.CreatedAt ? esc(fmtDate(Date.parse(v.CreatedAt))) : ''}</td>
      <td><div class="actions"><button class="sm icon danger" title="Remove volume" data-vol="${esc(v.Name)}">${ICON.trash}</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No volumes</td></tr>'}</tbody></table></div></div>`;
  }

  const load = async () => {
    try { if (!(await checkStatus())) return; await ({ containers, images, volumes }[tab])(); } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };

  function showLogs(id, name) {
    let t = null;
    modal({
      title: `Logs · ${name}`, full: true,
      body: `<div class="toolbar"><select data-tail style="width:auto"><option>100</option><option selected>500</option><option>2000</option></select><label class="row small"><input type="checkbox" data-follow checked> Follow</label><label class="row small"><input type="checkbox" data-ts> Timestamps</label><div class="spacer"></div><button class="sm" data-dl>${ICON.download} Save</button></div><pre class="out" data-logs style="height:calc(100% - 50px);overflow:auto">Loading…</pre>`,
      onOpen: (m) => {
        const pre = $('[data-logs]', m); let raw = '';
        const fetchLogs = async () => {
          try {
            const r = await GET(`/docker/containers/${id}/logs?tail=${$('[data-tail]', m).value}`);
            raw = r.logs;
            const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
            pre.textContent = ($('[data-ts]', m).checked ? raw : raw.replace(/^\S+Z /gm, '')) || '(no output)';
            if (atBottom || pre.dataset.first !== '1') { pre.scrollTop = pre.scrollHeight; pre.dataset.first = '1'; }
          } catch (e) { pre.textContent = e.message; }
        };
        fetchLogs();
        t = setInterval(() => { if ($('[data-follow]', m).checked) fetchLogs(); }, 2000);
        $('[data-tail]', m).onchange = fetchLogs; $('[data-ts]', m).onchange = fetchLogs;
        $('[data-dl]', m).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([raw], { type: 'text/plain' })); a.download = `${name}.log`; a.click(); };
        return () => clearInterval(t);
      },
    });
  }

  function showStats(id, name) {
    const hist = { cpu: [], mem: [] };
    modal({
      title: `Stats · ${name}`, wide: true,
      body: `<div class="grid cols-2" style="grid-template-columns:1fr 1fr"><div class="card"><div class="label muted small">CPU</div><div class="big" style="font-size:24px;font-weight:650" data-s="cpu">…</div><canvas class="spark" data-s="cspark"></canvas></div>
        <div class="card"><div class="label muted small">MEMORY</div><div class="big" style="font-size:24px;font-weight:650" data-s="mem">…</div><div class="muted small" data-s="memsub"></div><canvas class="spark" data-s="mspark"></canvas></div></div>
        <div class="kv" style="margin-top:16px" data-s="kv"></div>`,
      onOpen: (m) => {
        let alive = true;
        const tick = async () => {
          try {
            const s = await GET(`/docker/containers/${id}/stats`);
            if (!alive) return;
            hist.cpu.push(s.cpu); hist.mem.push(s.memUsed); if (hist.cpu.length > 90) { hist.cpu.shift(); hist.mem.shift(); }
            $('[data-s="cpu"]', m).textContent = s.cpu.toFixed(1) + '%';
            $('[data-s="mem"]', m).textContent = fmtBytes(s.memUsed);
            $('[data-s="memsub"]', m).textContent = `limit ${fmtBytes(s.memLimit)}`;
            $('[data-s="kv"]', m).innerHTML = `<div>Network ↓ / ↑</div><div>${fmtBytes(s.netRx)} / ${fmtBytes(s.netTx)}</div><div>Block read / write</div><div>${fmtBytes(s.blockRead)} / ${fmtBytes(s.blockWrite)}</div><div>PIDs</div><div>${s.pids}</div>`;
            sparkline($('[data-s="cspark"]', m), [hist.cpu]); sparkline($('[data-s="mspark"]', m), [hist.mem], { colors: ['#22c1c3'] });
          } catch (e) { $('[data-s="kv"]', m).textContent = e.message; }
          if (alive) setTimeout(tick, 2000);
        };
        tick();
        return () => { alive = false; };
      },
    });
  }

  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; history.replaceState(null, '', `#/docker/${tab}`); $$('[data-tab]', el).forEach((x) => x.classList.toggle('active', x === b)); body.innerHTML = '<div class="empty"><span class="spinner"></span></div>'; load(); }));
  $('.search', el).oninput = (e) => { filter = e.target.value; load(); };
  $('[data-refresh]', el).onclick = load;
  el.addEventListener('click', async (e) => {
    const pr = e.target.closest('[data-prune]');
    if (pr) {
      const w = pr.dataset.prune;
      if (!(await confirmDlg(`Prune ${w}?`, { containers: 'Remove all stopped containers.', images: 'Remove dangling (untagged) images.', volumes: 'Remove all volumes not used by any container. <b>Data in them is lost.</b>' }[w], { okLabel: 'Prune', danger: true }))) return;
      const r = await act(pr, () => POST(`/docker/prune/${w}`));
      if (r) toast(`Pruned. Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`);
      return load();
    }
    const img = e.target.closest('[data-img]');
    if (img) {
      if (!(await confirmDlg('Remove image?', `Remove <span class="mono">${esc(img.dataset.name || img.dataset.img)}</span>?`, { okLabel: 'Remove', danger: true }))) return;
      await act(img, () => DEL(`/docker/images/${encodeURIComponent(img.dataset.img)}`), 'Image removed');
      return load();
    }
    const vol = e.target.closest('[data-vol]');
    if (vol) {
      if (!(await confirmDlg('Remove volume?', `Remove <span class="mono">${esc(vol.dataset.vol)}</span>? All data in it will be lost.`, { okLabel: 'Remove', danger: true }))) return;
      await act(vol, () => DEL(`/docker/volumes/${encodeURIComponent(vol.dataset.vol)}`), 'Volume removed');
      return load();
    }
    const b = e.target.closest('[data-c]'); if (!b) return;
    const { c: id, a } = b.dataset;
    if (a === 'logs') return showLogs(id, b.dataset.name);
    if (a === 'stats') return showStats(id, b.dataset.name);
    if (b.dataset.self && !(await confirmDlg('This is Uiable itself', 'Stopping or removing this container will shut down this dashboard and you will lose access to it until you start it again from the server.', { okLabel: 'Continue', danger: true }))) return;
    if (a === 'remove') {
      if (!b.dataset.self && !(await confirmDlg(`Remove ${b.dataset.name}?`, 'The container is force-removed. Named volumes are kept.', { okLabel: 'Remove', danger: true }))) return;
      await act(b, () => DEL(`/docker/containers/${id}`), 'Container removed');
    } else {
      await act(b, () => POST(`/docker/containers/${id}/${a}`), `Container ${a}ed`.replace('stoped', 'stopped'));
    }
    load();
  });
  load();
  timer = setInterval(() => { if (tab === 'containers' && !document.hidden && !$('.modal-bg')) load(); }, 5000);
  return () => clearInterval(timer);
};
