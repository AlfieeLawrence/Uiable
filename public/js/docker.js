'use strict';
/* Docker: containers, images, volumes. */

const ctrHealth = (c) => { const s = c.Status || ''; return /\(unhealthy\)/.test(s) ? 'unhealthy' : /health: starting/.test(s) ? 'starting' : /\(healthy\)/.test(s) ? 'healthy' : null; };
const ctrLevel = (c) => { const h = ctrHealth(c); if (h === 'unhealthy') return 'bad'; if (h === 'starting' || c.State === 'restarting' || c.State === 'paused') return 'warn'; if (c.State === 'running') return 'ok'; if (c.State === 'exited' && !/\(0\)/.test(c.Status || '')) return 'bad'; return ''; };
const CtrStats = { hist: {}, push(id, s) { const h = this.hist[id] || (this.hist[id] = { cpu: [], mem: [] }); h.cpu.push(s.cpu); h.mem.push(s.memUsed); if (h.cpu.length > 40) { h.cpu.shift(); h.mem.shift(); } h.last = s; } };

Pages.docker = (el, params) => {
  if (params[0] === 'c' && params[1]) return containerPage(el, params[1], params[2] || 'overview');
  let tab = ['containers', 'images', 'volumes'].includes(params[0]) ? params[0] : 'containers'; let filter = ''; let timer = null; let selfName = '';
  el.innerHTML = `<div data-status></div><div class="toolbar"><div class="tabs scroll-x" role="tablist" style="margin:0">${['containers', 'images', 'volumes'].map((t) => `<button role="tab" aria-selected="${t === tab}" data-tab="${t}" class="${t === tab ? 'active' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}</div>
    <input class="search" type="search" placeholder="Filter…  ( / )" aria-label="Filter"><div class="spacer"></div><span data-extra class="row"></span><button type="button" data-refresh>${ICON.refresh} Refresh</button></div><div data-body>${skel(tab === 'containers' ? 'cards' : 'rows', tab === 'containers' ? 6 : 5)}</div>`;
  const body = $('[data-body]', el);
  const status = $('[data-status]', el);

  async function checkStatus() {
    const s = await GET('/docker/status');
    if (!s.available) { status.innerHTML = ''; body.innerHTML = emptyState({ icon: 'docker', title: 'Docker isn\'t available', text: esc(s.message), actions: [{ label: 'Install guide', href: 'https://docs.docker.com/engine/install/' }] }); Live.health = null; Live.paint(); return false; }
    status.innerHTML = '';
    return true;
  }

  let pending = {}; // id -> label while an undoable action waits
  async function containers() {
    const r = await GET('/docker/containers');
    selfName = r.self;
    Live.setContainers(r.containers);
    const f = filter.toLowerCase();
    const list = r.containers.filter((c) => !f || c.Names.join(' ').toLowerCase().includes(f) || c.Image.toLowerCase().includes(f));
    list.sort((a, b) => (a.State === 'running' ? 0 : 1) - (b.State === 'running' ? 0 : 1) || a.Names[0].localeCompare(b.Names[0]));
    const running = r.containers.filter((c) => c.State === 'running').length;
    const unhealthy = r.containers.filter((c) => ctrHealth(c) === 'unhealthy').length;
    $('[data-extra]', el).innerHTML = `<span class="muted small"><i class="hdot ok"></i> ${running} running · ${r.containers.length - running} stopped${unhealthy ? ` · <span class="err-text">${unhealthy} unhealthy</span>` : ''}</span>${can('operator') ? '<button type="button" class="sm" data-prune="containers">Prune stopped</button>' : ''}`;
    if (!r.containers.length) { body.innerHTML = emptyState({ icon: 'docker', title: 'No containers yet', text: 'Install an app, deploy a compose stack, or run something with docker run.', actions: [...(featureOn('store') ? [{ label: 'Browse the app store', href: '#/apps', primary: true, icon: 'store' }] : []), { label: 'New stack', href: '#/stacks' }] }); return; }
    if (!list.length) { body.innerHTML = emptyState({ icon: 'search', title: 'No matches', text: `Nothing matches “${esc(filter)}”.`, actions: [{ label: 'Clear filter', attr: 'data-clear' }] }); return; }
    const op = can('operator');
    body.innerHTML = `<div class="ctr-grid">${list.map((c) => {
      const name = c.Names[0].replace(/^\//, '');
      const lvl = ctrLevel(c); const health = ctrHealth(c);
      const ports = [...new Set((c.Ports || []).filter((p) => p.PublicPort).map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`))];
      const isSelf = selfName && (c.Id.startsWith(selfName) || name === 'uiable');
      const href = `#/docker/c/${encodeURIComponent(c.Id.slice(0, 12))}`;
      const pend = pending[c.Id];
      return `<article class="card ctr ${pend ? 'pending' : ''}" data-cid="${esc(c.Id)}" aria-label="${esc(name)}, ${esc(c.State)}${health ? ', ' + health : ''}">
        <div class="head"><a class="avatar" href="${href}" tabindex="-1" aria-hidden="true" style="background:${ctrColor(name)}">${esc(name[0] ? name[0].toUpperCase() : '?')}</a>
          <div class="grow"><a class="ctr-name ellipsis" href="${href}" title="${esc(name)}">${esc(name)}</a>${isSelf ? ' <span class="chip plain small">this app</span>' : ''}<div class="meta ellipsis" title="${esc(c.Image)}">${esc(c.Image)}</div></div>
          <span class="chip ${lvl}" title="${esc(c.Status)}">${esc(health && c.State === 'running' ? health : c.State)}</span></div>
        <div class="meta ellipsis" title="${esc(c.Status)}">${esc(pend || c.Status)}${ports.length ? ' · ' + esc(ports.join(', ')) : ''}${c.Labels && c.Labels['com.docker.compose.project'] ? ' · ' + esc(c.Labels['com.docker.compose.project']) : ''}</div>
        ${c.State === 'running' ? `<div class="ctr-live"><canvas class="spark" data-spark="${esc(c.Id)}" aria-hidden="true"></canvas><span class="num small" data-live="${esc(c.Id)}">…</span></div>` : '<div class="ctr-live off muted small">Not running</div>'}
        <div class="btns">${op ? (c.State === 'running'
          ? `<button type="button" class="sm" data-c="${c.Id}" data-a="restart" data-name="${esc(name)}">${ICON.restart} Restart</button><button type="button" class="sm" data-c="${c.Id}" data-a="stop" data-name="${esc(name)}" data-self="${isSelf ? 1 : ''}">${ICON.stop} Stop</button>`
          : `<button type="button" class="sm" data-c="${c.Id}" data-a="start" data-name="${esc(name)}">${ICON.play} Start</button>`) : ''}
          <span class="spacer"></span>
          <button type="button" class="sm icon" title="Logs" data-c="${c.Id}" data-a="logs" data-name="${esc(name)}">${ICON.logs}</button>
          <a class="btn sm icon" href="${href}" title="Details">${ICON.arrowRight}</a>
          ${op ? `<button type="button" class="sm icon danger" title="Remove" data-c="${c.Id}" data-a="remove" data-name="${esc(name)}" data-self="${isSelf ? 1 : ''}">${ICON.trash}</button>` : ''}</div></article>`;
    }).join('')}</div>`;
    paintLive();
    loadLive();
  }
  function paintLive() {
    $$('[data-spark]', body).forEach((cv) => {
      const h = CtrStats.hist[cv.dataset.spark]; if (!h) return;
      sparkline(cv, [h.cpu], { colors: ['#7c5cff'] });
      const lbl = $(`[data-live="${cv.dataset.spark}"]`, body);
      if (lbl && h.last) lbl.textContent = `CPU ${fmtNum(h.last.cpu, 1)}% · ${fmtBytes(h.last.memUsed)}`;
    });
  }
  async function loadLive() {
    try { const r = await GET('/docker/stats-summary'); Object.entries(r.stats || {}).forEach(([id, st]) => CtrStats.push(id, st)); paintLive(); } catch (_) {}
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
    if (!r.images.length) body.innerHTML = emptyState({ icon: 'image', title: 'No images', text: 'Images appear here after you pull one or install an app.', actions: featureOn('store') ? [{ label: 'Browse the app store', href: '#/apps' }] : [] });
  }

  async function volumes() {
    const r = await GET('/docker/volumes');
    const f = filter.toLowerCase();
    const list = (r.Volumes || []).filter((v) => !f || v.Name.toLowerCase().includes(f));
    $('[data-extra]', el).innerHTML = `<span class="muted small">${(r.Volumes || []).length} volumes</span><button class="sm" data-prune="volumes">Prune unused</button>`;
    body.innerHTML = `<div class="card flush"><div class="table-wrap"><table><thead><tr><th>Name</th><th>Driver</th><th class="hide-sm">Mountpoint</th><th>Created</th><th></th></tr></thead><tbody>
      ${list.map((v) => `<tr><td class="mono ellipsis" style="max-width:300px" title="${esc(v.Name)}">${esc(v.Name)}</td><td>${esc(v.Driver)}</td><td class="mono muted small hide-sm"><a href="#/files/${encodeURIComponent(v.Mountpoint)}">${esc(v.Mountpoint)}</a></td><td class="muted nowrap">${v.CreatedAt ? esc(fmtDate(Date.parse(v.CreatedAt))) : ''}</td>
      <td><div class="actions"><button class="sm icon danger" title="Remove volume" data-vol="${esc(v.Name)}">${ICON.trash}</button></div></td></tr>`).join('') || '<tr><td colspan="5" class="empty">No volumes</td></tr>'}</tbody></table></div></div>`;
    if (!(r.Volumes || []).length) body.innerHTML = emptyState({ icon: 'disk', title: 'No volumes', text: 'Named volumes keep container data across recreates. They show up here once a container creates one.' });
  }

  const load = async () => {
    try { if (!(await checkStatus())) return; await ({ containers, images, volumes }[tab])(); } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };

  function showLogs(id, name) {
    let t = null;
    modal({
      title: `Logs · ${name}`, full: true, log: true,
      body: `<div class="toolbar"><select data-tail style="width:auto"><option>100</option><option selected>500</option><option>2000</option></select><label class="row small"><input type="checkbox" data-follow checked> Follow</label><label class="row small"><input type="checkbox" data-ts> Timestamps</label><div class="spacer"></div><button class="sm" data-dl>${ICON.download} Save</button></div><pre class="out log-out" data-logs>Loading…</pre>`,
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

  $$('[data-tab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.tab; history.replaceState(null, '', `#/docker/${tab}`); $$('[data-tab]', el).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); }); body.innerHTML = skel(tab === 'containers' ? 'cards' : 'rows', 5); load(); }));
  $('.search', el).oninput = (e) => { filter = e.target.value; load(); };
  $('[data-refresh]', el).onclick = load;
  el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-clear]')) { filter = ''; $('.search', el).value = ''; return load(); }
    const pr = e.target.closest('[data-prune]');
    if (pr) {
      const w = pr.dataset.prune;
      const ok = await typedConfirm({ title: `Prune ${w}?`, text: { containers: 'Removes <b>all stopped containers</b>.', images: 'Removes dangling (untagged) images.', volumes: 'Removes every volume not used by a container. <b>Data in them is lost.</b>' }[w], word: 'prune', okLabel: 'Prune' });
      if (!ok) return;
      const r = await act(pr, () => POST(`/docker/prune/${w}`));
      if (r) toast(`Pruned. Reclaimed ${fmtBytes(r.SpaceReclaimed || 0)}`);
      return load();
    }
    const img = e.target.closest('[data-img]');
    if (img) {
      const word = (img.dataset.name && img.dataset.name !== '<none>:<none>' ? img.dataset.name : img.dataset.img.replace('sha256:', '').slice(0, 12));
      if (!(await typedConfirm({ title: 'Remove image?', text: `Remove <span class="mono">${esc(word)}</span>? Containers using it must be removed first.`, word, okLabel: 'Remove image' }))) return;
      await act(img, () => DEL(`/docker/images/${encodeURIComponent(img.dataset.img)}`), 'Image removed');
      return load();
    }
    const vol = e.target.closest('[data-vol]');
    if (vol) {
      if (!(await typedConfirm({ title: 'Remove volume?', text: `Remove <span class="mono">${esc(vol.dataset.vol)}</span>? <b>All data in it will be lost.</b>`, word: vol.dataset.vol, okLabel: 'Remove volume' }))) return;
      await act(vol, () => DEL(`/docker/volumes/${encodeURIComponent(vol.dataset.vol)}`), 'Volume removed');
      return load();
    }
    const b = e.target.closest('[data-c]'); if (!b) return;
    const { c: id, a, name } = b.dataset;
    if (a === 'logs') return showLogs(id, name);
    if (b.dataset.self && !(await confirmDlg('This is Uiable itself', 'Stopping or removing this container shuts down this dashboard. You will lose access until you start it again on the server.', { okLabel: 'Continue', danger: true }))) return;
    if (a === 'remove') {
      if (!(await typedConfirm({ title: `Remove ${name}?`, text: `The container <b class="mono">${esc(name)}</b> is force-removed. Named volumes are kept.`, word: name, okLabel: 'Remove container' }))) return;
      await act(b, () => DEL(`/docker/containers/${id}`), 'Container removed');
      return load();
    }
    if (a === 'stop' || a === 'restart') {
      pending[id] = `${a === 'stop' ? 'Stopping' : 'Restarting'} in 5 s — Undo in the toast`;
      load();
      ctrAction(id, name, a, () => { delete pending[id]; load(); }).done.then((r) => { if (r !== 'ran') { delete pending[id]; load(); } });
      return;
    }
    await act(b, () => POST(`/docker/containers/${id}/${a}`), `Started ${name}`);
    load();
  });
  load();
  timer = setInterval(() => { if (tab === 'containers' && !document.hidden && !$('.modal-bg')) load(); }, 6000);
  return () => clearInterval(timer);
};
