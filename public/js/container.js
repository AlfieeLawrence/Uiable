'use strict';
/* Container page (#/docker/c/<id>/<tab>): live stats graphs, logs (follow + search),
   env vars (secrets masked; admins can reveal, audit-logged), ports, mounts, networks
   and one-click redeploy (pull latest image + recreate with the same settings). */

function containerPage(el, cid, tab) {
  let detail = null; let alive = true; let statsTimer = null; let logTimer = null;
  const hist = { t: [], cpu: [], mem: [], rx: [], tx: [], br: [], bw: [] }; let prev = null;
  const TABS = [['overview', 'Overview', 'chart'], ['logs', 'Logs', 'logs'], ['env', 'Environment', 'braces']];
  el.innerHTML = `<nav class="crumb small" aria-label="Breadcrumb"><a href="#/docker">Containers</a><span aria-hidden="true">›</span><span data-cname>…</span></nav>
    <div data-chead>${skel('text', 2)}</div>
    <div class="tabs scroll-x" role="tablist" aria-label="Container sections">${TABS.map(([id, l, ic]) => `<button type="button" role="tab" data-ctab="${id}" aria-selected="${id === tab}" class="${id === tab ? 'active' : ''}">${ICON[ic]} ${l}</button>`).join('')}</div>
    <div data-cbody>${skel('stats', 4)}</div>`;
  const body = $('[data-cbody]', el);

  const load = async (reveal) => {
    try { detail = await GET(`/docker/containers/${encodeURIComponent(cid)}/detail${reveal ? '?reveal=1' : ''}`); }
    catch (e) { $('[data-chead]', el).innerHTML = ''; body.innerHTML = emptyState({ icon: 'docker', title: e.status === 404 ? 'Container not found' : 'Couldn\'t load this container', text: esc(e.message), actions: [{ label: 'Back to containers', href: '#/docker', primary: true }] }); return false; }
    paintHead(); return true;
  };
  const I = () => detail.inspect;
  const nameOf = () => String(I().Name || cid).replace(/^\//, '');
  const health = () => (I().State && I().State.Health && I().State.Health.Status) || null;

  function paintHead() {
    const i = I(); const st = i.State || {}; const name = nameOf();
    const lvl = health() === 'unhealthy' ? 'bad' : (health() === 'starting' || st.Restarting) ? 'warn' : st.Running ? 'ok' : (st.ExitCode ? 'bad' : '');
    $('[data-cname]', el).textContent = name;
    document.title = `${name} · Uiable`;
    const ports = Object.entries((i.NetworkSettings && i.NetworkSettings.Ports) || {}).flatMap(([k, v]) => (v || []).map((p) => ({ k, host: p.HostPort })));
    const web = ports.find((p) => /tcp/.test(p.k));
    const op = can('operator');
    $('[data-chead]', el).innerHTML = `<section class="card ctr-hero"><div class="row wrap">
      <div class="avatar big" style="background:${ctrColor(name)}" aria-hidden="true">${esc(name[0] ? name[0].toUpperCase() : '?')}</div>
      <div class="grow"><h2 class="ellipsis">${esc(name)}</h2><div class="muted small mono ellipsis" title="${esc(i.Config.Image)}">${esc(i.Config.Image)}</div>
        <div class="row wrap small" style="margin-top:6px"><span class="chip ${lvl}">${esc(health() && st.Running ? health() : st.Status || 'unknown')}</span>${st.Running ? `<span class="muted">up since ${esc(fmtDate(Date.parse(st.StartedAt)))}</span>` : st.FinishedAt && !st.FinishedAt.startsWith('0001') ? `<span class="muted">exited ${esc(String(st.ExitCode))} · ${esc(fmtDate(Date.parse(st.FinishedAt)))}</span>` : ''}${i.RestartCount ? `<span class="chip warn plain">${i.RestartCount} restarts</span>` : ''}</div></div>
      <div class="hero-actions row wrap">
        ${web ? `<a class="btn" href="http://${esc(location.hostname)}:${esc(web.host)}" target="_blank" rel="noopener">${ICON.ext} Open</a>` : ''}
        ${op ? (st.Running ? `<button type="button" data-ha="restart">${ICON.restart} Restart</button><button type="button" data-ha="stop">${ICON.stop} Stop</button>` : `<button type="button" class="primary" data-ha="start">${ICON.play} Start</button>`) : ''}
        ${op ? `<button type="button" data-ha="redeploy" title="Pull the latest image and recreate with the same settings">${ICON.redeploy} Redeploy</button><button type="button" class="icon danger" data-ha="remove" title="Remove container">${ICON.trash}</button>` : ''}
      </div></div></section>`;
  }

  // ---------------------------------------------------------------- overview
  const CHARTS = [['cpu', 'CPU', '#7c5cff', (v) => fmtPct(v, 1)], ['mem', 'Memory', '#22c1c3', (v) => fmtBytes(v)], ['net', 'Network ↓ / ↑', '#7c5cff', (v) => fmtRate(v)], ['blk', 'Disk read / write', '#f59e0b', (v) => fmtRate(v)]];
  function overview() {
    const i = I(); const hc = i.HostConfig || {};
    const ports = Object.entries((i.NetworkSettings && i.NetworkSettings.Ports) || {});
    const nets = Object.entries((i.NetworkSettings && i.NetworkSettings.Networks) || {});
    const mounts = i.Mounts || [];
    body.innerHTML = `<div class="stat-grid">${CHARTS.map(([k, l]) => `<div class="card mini-chart"><div class="row small"><span class="label">${l}</span><span class="spacer"></span><b class="num" data-cv="${k}">–</b></div><div class="chart-wrap sm"><canvas class="big-chart sm" data-cc="${k}" role="img" aria-label="${l} graph"></canvas><div class="chart-tip" data-ct="${k}" hidden></div></div></div>`).join('')}</div>
      ${i.State && i.State.Running ? '' : '<p class="muted small">Not running — graphs fill in once it starts.</p>'}
      <div class="grid cols-2" style="margin-top:var(--sp-4)">
        <section class="card"><h3 class="card-title">${ICON.plug} Ports</h3>${ports.length ? `<table><thead><tr><th>Container</th><th>Host</th><th></th></tr></thead><tbody>${ports.map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono">${(v || []).map((p) => esc(`${p.HostIp && p.HostIp !== '0.0.0.0' ? p.HostIp + ':' : ''}${p.HostPort}`)).join('<br>') || '<span class="muted">not published</span>'}</td><td class="right">${(v || [])[0] && /tcp/.test(k) ? `<a class="btn sm icon" href="http://${esc(location.hostname)}:${esc(v[0].HostPort)}" target="_blank" rel="noopener" title="Open port ${esc(v[0].HostPort)}">${ICON.ext}</a>` : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">No ports exposed.</p>'}</section>
        <section class="card"><h3 class="card-title">${ICON.net} Networks</h3>${nets.length ? `<table><thead><tr><th>Network</th><th>IP</th><th>Gateway</th><th class="hide-sm">MAC</th></tr></thead><tbody>${nets.map(([n, v]) => `<tr><td><b>${esc(n)}</b>${(v.Aliases || []).length ? `<div class="muted small">${esc(v.Aliases.join(', '))}</div>` : ''}</td><td class="mono">${esc(v.IPAddress || '–')}</td><td class="mono">${esc(v.Gateway || '–')}</td><td class="mono muted hide-sm">${esc(v.MacAddress || '')}</td></tr>`).join('')}</tbody></table>` : `<p class="muted">Network mode: <span class="mono">${esc(hc.NetworkMode || 'none')}</span></p>`}</section>
        <section class="card"><h3 class="card-title">${ICON.folder} Mounts</h3>${mounts.length ? `<table><thead><tr><th>Source</th><th>Container path</th><th>Mode</th></tr></thead><tbody>${mounts.map((m) => `<tr><td class="mono small">${m.Type === 'bind' ? `<a href="#/files/${esc(String(m.Source).replace(/^\//, ''))}">${esc(m.Source)}</a>` : `${esc(m.Name || m.Source)} <span class="chip plain">${esc(m.Type)}</span>`}</td><td class="mono small">${esc(m.Destination)}</td><td><span class="chip plain">${m.RW ? 'rw' : 'ro'}</span></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No mounts.</p>'}</section>
        <section class="card"><h3 class="card-title">${ICON.info} Details</h3><div class="kv small">
          <div>ID</div><div class="mono">${esc(i.Id.slice(0, 12))}</div><div>Created</div><div>${esc(fmtDate(Date.parse(i.Created)))}</div>
          <div>Restart policy</div><div>${esc((hc.RestartPolicy && hc.RestartPolicy.Name) || 'no')}</div>
          <div>Command</div><div class="mono">${esc([...(i.Config.Entrypoint || []), ...(i.Config.Cmd || [])].join(' ') || '–')}</div>
          <div>Working dir</div><div class="mono">${esc(i.Config.WorkingDir || '/')}</div>
          ${i.Config.Labels && i.Config.Labels['com.docker.compose.project'] ? `<div>Compose</div><div><a href="#/stacks/${encodeURIComponent(i.Config.Labels['com.docker.compose.project'])}">${esc(i.Config.Labels['com.docker.compose.project'])}</a> · ${esc(i.Config.Labels['com.docker.compose.service'] || '')}</div>` : ''}
          <div>Memory limit</div><div>${hc.Memory ? fmtBytes(hc.Memory) : 'none'}</div></div></section>
      </div>`;
    paintCharts();
  }
  function paintCharts() {
    if (!$('[data-cc]', body)) return;
    const T = hist.t; const ser = (arr, label, color) => ({ label, color, data: arr.map((v, j) => ({ t: T[j], v })) });
    const map = { cpu: [ser(hist.cpu, 'CPU', '#7c5cff')], mem: [ser(hist.mem, 'Memory', '#22c1c3')], net: [ser(hist.rx, 'Download', '#7c5cff'), ser(hist.tx, 'Upload', '#f472b6')], blk: [ser(hist.br, 'Read', '#f59e0b'), ser(hist.bw, 'Write', '#10b981')] };
    for (const [k, , , fmt] of CHARTS) {
      const cv = $(`[data-cc="${k}"]`, body); if (!cv) continue;
      const series = map[k];
      drawChart(cv, series, { fmt, tipEl: $(`[data-ct="${k}"]`, body), from: T[0], to: T[T.length - 1], max: k === 'cpu' ? Math.max(100, ...hist.cpu) : undefined });
      const last = series.map((s) => s.data.length ? fmt(s.data[s.data.length - 1].v) : '–').join(' / ');
      $(`[data-cv="${k}"]`, body).textContent = last;
    }
  }
  const pollStats = async () => {
    if (!alive) return;
    if (!document.hidden && I().State && I().State.Running) {
      try {
        const s = await GET(`/docker/containers/${encodeURIComponent(cid)}/stats`); const t = Date.now();
        if (prev) {
          const dt = Math.max(0.5, (t - prev.t) / 1000);
          hist.t.push(t); hist.cpu.push(s.cpu); hist.mem.push(s.memUsed);
          hist.rx.push(Math.max(0, (s.netRx - prev.netRx) / dt)); hist.tx.push(Math.max(0, (s.netTx - prev.netTx) / dt));
          hist.br.push(Math.max(0, (s.blockRead - prev.blockRead) / dt)); hist.bw.push(Math.max(0, (s.blockWrite - prev.blockWrite) / dt));
          Object.values(hist).forEach((a) => { while (a.length > 90) a.shift(); });
          if (tab === 'overview') paintCharts();
        }
        prev = Object.assign({ t }, s);
      } catch (_) {}
    }
    statsTimer = setTimeout(pollStats, 2000);
  };

  // ---------------------------------------------------------------- logs
  function logs() {
    body.innerHTML = `<section class="card log-card"><div class="toolbar">
        <input type="search" class="search" data-lq placeholder="Search logs…  ( / )" aria-label="Search logs">
        <span class="muted small" data-lcount aria-live="polite"></span><span class="spacer"></span>
        <label class="row small"><input type="checkbox" data-follow checked> Follow</label>
        <label class="row small"><input type="checkbox" data-ts> Timestamps</label>
        <label class="row small"><input type="checkbox" data-wrap checked> Wrap</label>
        <select data-tail aria-label="Lines" style="width:auto"><option>200</option><option selected>1000</option><option>5000</option></select>
        <button type="button" class="sm" data-dl>${ICON.download} Save</button></div>
      <pre class="out log-out page-log" data-logs tabindex="0" aria-label="Container logs">${esc('Loading…')}</pre></section>`;
    const pre = $('[data-logs]', body); let raw = '';
    const render = () => {
      const q = $('[data-lq]', body).value.trim().toLowerCase();
      let lines = raw.split('\n'); if (!$('[data-ts]', body).checked) lines = lines.map((l) => l.replace(/^\S+Z /, ''));
      const total = lines.length;
      if (q) lines = lines.filter((l) => l.toLowerCase().includes(q));
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
      const hl = (l) => { const e = esc(l); if (!q) return e; const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), 'gi'); return e.replace(re, (m) => `<mark>${m}</mark>`); };
      pre.innerHTML = lines.length ? lines.map((l) => `<span class="ll ${/\b(error|err|fatal|panic|exception)\b/i.test(l) ? 'e' : /\b(warn|wrn|warning)\b/i.test(l) ? 'w' : ''}">${hl(l)}</span>`).join('\n') : `<span class="muted">${q ? 'No lines match.' : '(no output)'}</span>`;
      $('[data-lcount]', body).textContent = q ? `${lines.length} of ${total} lines` : `${total} lines`;
      pre.classList.toggle('nowrap-log', !$('[data-wrap]', body).checked);
      if ($('[data-follow]', body).checked && (atBottom || !pre.dataset.first)) { pre.scrollTop = pre.scrollHeight; pre.dataset.first = '1'; }
    };
    const fetchLogs = async () => {
      try { raw = (await GET(`/docker/containers/${encodeURIComponent(cid)}/logs?tail=${$('[data-tail]', body).value}`)).logs || ''; render(); }
      catch (e) { pre.textContent = e.message; }
    };
    const tick = async () => { if (!alive || tab !== 'logs') return; if (!document.hidden && $('[data-follow]', body).checked) await fetchLogs(); logTimer = setTimeout(tick, 2000); };
    fetchLogs().then(() => { logTimer = setTimeout(tick, 2000); });
    $('[data-lq]', body).addEventListener('input', render);
    ['[data-ts]', '[data-wrap]'].forEach((s) => $(s, body).addEventListener('change', render));
    $('[data-tail]', body).onchange = fetchLogs;
    $('[data-follow]', body).onchange = (e) => { if (e.target.checked) { pre.scrollTop = pre.scrollHeight; fetchLogs(); } };
    $('[data-dl]', body).onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([raw], { type: 'text/plain' })); a.download = `${nameOf()}.log`; a.click(); };
  }

  // ---------------------------------------------------------------- env
  function env() {
    const list = (I().Config.Env || []).map((e) => { const k = e.indexOf('='); return k < 0 ? [e, ''] : [e.slice(0, k), e.slice(k + 1)]; });
    const masked = new Set(detail.masked || []);
    body.innerHTML = `<section class="card"><div class="toolbar"><input type="search" class="search" data-eq placeholder="Filter variables…" aria-label="Filter variables"><span class="spacer"></span>
      ${detail.revealed ? `<span class="chip warn">secrets shown</span><button type="button" class="sm" data-hide>${ICON.eyeOff} Hide secrets</button>` : detail.canReveal && masked.size ? `<button type="button" class="sm" data-reveal title="Admins only; audit-logged">${ICON.eye} Reveal ${masked.size} secret${masked.size === 1 ? '' : 's'}</button>` : ''}</div>
      ${masked.size && !detail.revealed ? `<p class="muted small">${masked.size} value${masked.size === 1 ? ' looks' : 's look'} secret (passwords, tokens, keys, URL credentials) and ${masked.size === 1 ? 'is' : 'are'} masked.${detail.canReveal ? ' Revealing is audit-logged.' : ''}</p>` : ''}
      ${list.length ? `<table class="env-table"><thead><tr><th>Variable</th><th>Value</th></tr></thead><tbody>${list.map(([k, v]) => `<tr data-k="${esc(k.toLowerCase())}"><td class="mono"><b>${esc(k)}</b></td><td class="mono env-v">${masked.has(k) && !detail.revealed ? `<span class="masked" aria-label="masked">${esc(v)}</span>` : esc(v)}</td></tr>`).join('')}</tbody></table>` : emptyState({ icon: 'braces', title: 'No environment variables' })}</section>`;
    const q = $('[data-eq]', body); if (q) q.oninput = () => $$('tr[data-k]', body).forEach((tr) => { tr.hidden = !tr.dataset.k.includes(q.value.trim().toLowerCase()) && !tr.textContent.toLowerCase().includes(q.value.trim().toLowerCase()); });
    const rv = $('[data-reveal]', body); if (rv) rv.onclick = async () => { if (await load(true)) env(); };
    const hd = $('[data-hide]', body); if (hd) hd.onclick = async () => { if (await load(false)) env(); };
  }

  const show = () => {
    clearTimeout(logTimer);
    $$('[data-ctab]', el).forEach((b) => { b.classList.toggle('active', b.dataset.ctab === tab); b.setAttribute('aria-selected', b.dataset.ctab === tab); });
    ({ overview, logs, env })[tab]();
  };
  $$('[data-ctab]', el).forEach((b) => (b.onclick = () => { tab = b.dataset.ctab; history.replaceState(null, '', `#/docker/c/${encodeURIComponent(cid)}/${tab}`); show(); }));

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ha]'); if (!b) return;
    const a = b.dataset.ha; const name = nameOf(); const id = I().Id;
    if (a === 'start') { await act(b, () => POST(`/docker/containers/${id}/start`), `Started ${name}`); await load(); return show(); }
    if (a === 'stop' || a === 'restart') { b.disabled = true; ctrAction(id, name, a, async () => { await load(); show(); }).done.then(() => { b.disabled = false; }); return; }
    if (a === 'remove') {
      if (!(await typedConfirm({ title: `Remove ${name}?`, text: `The container <b class="mono">${esc(name)}</b> is force-removed. Named volumes are kept.`, word: name, okLabel: 'Remove container' }))) return;
      if (await act(b, () => DEL(`/docker/containers/${id}`), 'Container removed') !== undefined) location.hash = '#/docker';
      return;
    }
    if (a === 'redeploy') {
      const r = await modal({ title: `Redeploy ${name}?`, body: `<p>Pulls the newest <span class="mono">${esc(I().Config.Image)}</span> and recreates the container with the same settings (ports, volumes, env, networks, restart policy). Expect a few seconds of downtime. If anything fails, the old container is put back.</p>${I().Config.Labels && I().Config.Labels['com.docker.compose.project'] ? '<p class="muted small">Part of a compose project: uses <span class="mono">docker compose pull</span> + <span class="mono">up -d --force-recreate</span> for this service.</p>' : ''}<label class="row small"><input type="checkbox" data-pull checked> Pull the latest image first</label>`,
        buttons: [{ label: 'Cancel', value: null }, { label: 'Redeploy', cls: 'primary', value: (m) => ({ pull: $('[data-pull]', m).checked }) }] });
      if (!r) return;
      try { const res = await POST(`/docker/containers/${id}/recreate`, r); const j = await watchJob(res.job, `Redeploy ${name}`); if (j && j.state === 'done') { toast(`Redeployed ${name}`); cid = name; await load(); show(); } } catch (err) { toastErr(err); }
    }
  });

  load().then((ok) => { if (!ok) return; show(); pollStats(); });
  return () => { alive = false; clearTimeout(statsTimer); clearTimeout(logTimer); document.title = 'Uiable'; };
}
