'use strict';
/* Customisable home grid: tiles + widgets. Edit mode is lazy-loaded (home-edit.js). */

const Home = {
  layout: null,
  editing: false,
  wcache: {}, // tile id -> last rendered widget HTML (shown dimmed in edit mode)
};

const TILE_COLORS = ['#7c5cff', '#22c1c3', '#3b82f6', '#f59e0b', '#ef4444', '#10b981', '#0ea5e9', '#f472b6', '#64748b', '#a855f7'];

function tileSizeKey(t) { return `${t.w || 1}x${t.h || 1}`; }

function tileIconHtml(t, fallbackApp) {
  const kind = t.iconKind || (t.icon && t.icon.startsWith('/api/') ? 'upload' : t.icon && t.icon.length <= 4 && !/^[a-z0-9-]+$/i.test(t.icon) ? 'emoji' : (t.icon ? 'pack' : ''));
  if (kind === 'upload' && t.icon) return `<img class="tile-ic-img" src="${esc(t.icon)}" alt="">`;
  if (kind === 'emoji' && t.icon) return `<span class="tile-emoji">${esc(t.icon)}</span>`;
  if ((kind === 'pack' || !kind) && t.icon && !t.icon.startsWith('/')) {
    // pack icon or legacy ICON key
    if (ICON[t.icon]) return ICON[t.icon];
    return `<img class="tile-ic-img pack" src="/icons/pack/${esc(t.icon)}.svg" alt="" onerror="this.style.display='none'">`;
  }
  if (fallbackApp && ICON[fallbackApp.icon]) return ICON[fallbackApp.icon];
  if (t.type === 'folder') return ICON.folder;
  if (t.type === 'link') return ICON.link;
  if (t.type === 'script') return ICON.term;
  if (t.type === 'container' || t.type === 'stack') return ICON.docker;
  if (t.type === 'widget') return ICON.chart;
  return ICON.apps || ICON.grid || ICON.dash;
}

function tileBg(t, fallbackApp) {
  if (t.color) return t.color.startsWith('linear') ? t.color : t.color;
  if (fallbackApp) return fallbackApp.bg;
  const map = { cpu: '#7c5cff', mem: '#22c1c3', disk: '#14b8a6', net: '#f472b6', clock: '#64748b', uptime: '#94a3b8', containers: '#0ea5e9', processes: '#f97316', notes: '#f59e0b', audit: '#78716c', updates: '#a855f7', storage: '#14b8a6' };
  if (t.type === 'widget' && map[t.widget]) return map[t.widget];
  return '#64748b';
}

function tileDisabled(t) {
  if (t.type === 'app') {
    const a = APPS.find((x) => x.id === t.app);
    return a ? !can(a.role) : true;
  }
  if (t.type === 'script') return !can('operator');
  if (t.type === 'container' || t.type === 'stack') return false; // view ok; actions gated on click
  if (t.type === 'widget' && (t.widget === 'audit' || t.widget === 'updates')) return !can('admin');
  return false;
}

function tileActionRole(t) {
  if (t.type === 'script') return 'operator';
  if (t.type === 'container' || t.type === 'stack') return 'operator';
  if (t.type === 'app') { const a = APPS.find((x) => x.id === t.app); return a ? a.role : 'admin'; }
  return 'viewer';
}

async function loadHomeLayout(force) {
  if (Home.layout && !force) return Home.layout;
  const r = await GET('/layout');
  Home.layout = r.layout;
  State.layout = Home.layout;
  return Home.layout;
}

function renderTile(t) {
  const app = t.type === 'app' ? APPS.find((a) => a.id === t.app) : null;
  const disabled = tileDisabled(t);
  const name = t.name || (app && app.name) || (t.type === 'widget' ? (t.widget || 'Widget') : t.ref || t.path || t.url || t.type);
  const bg = tileBg(t, app);
  const w = t.w || 1, h = t.h || 1;
  const isWidget = t.type === 'widget';
  const cls = `home-tile size-${w}x${h} ${isWidget ? 'is-widget' : 'is-shortcut'} ${disabled ? 'disabled' : ''} ${Home.editing ? 'editing' : ''}`;
  const style = `grid-column: span ${w}; grid-row: span ${h}; --tile:${esc(bg)}`;
  if (isWidget) {
    return `<div class="${cls}" style="${style}" data-tid="${esc(t.id)}" data-type="widget" data-widget="${esc(t.widget)}">
      <div class="tile-chrome">${mq(name, 'tile-name')}</div>
      <div class="tile-body" data-wbody="${esc(t.id)}">${Home.wcache[t.id] || '<span class="muted small">…</span>'}</div>
    </div>`;
  }
  const ic = tileIconHtml(t, app);
  return `<button type="button" class="${cls}" style="${style}" data-tid="${esc(t.id)}" data-type="${esc(t.type)}" ${disabled ? 'disabled' : ''}>
    <div class="tile-ic" style="background:${esc(bg)}">${ic}</div>
    ${mq(name, 'tile-name')}
    <span class="tile-meta muted small ellipsis" data-tmeta="${esc(t.id)}"></span>
  </button>`;
}

function sortTiles(tiles) {
  return tiles.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

/** Flow layout: CSS grid auto-placement by sorted order (x,y). Edit mode may use absolute later. */
function paintHomeGrid(root, layout) {
  const grid = $('[data-home-grid]', root);
  if (!grid) return;
  // Tiles for apps that no longer exist (old layouts) are hidden; edit mode still shows them so they can be removed
  const tiles = sortTiles(layout.tiles || []).filter((t) => Home.editing || t.type !== 'app' || APPS.some((a) => a.id === t.app));
  grid.innerHTML = tiles.map(renderTile).join('') || `<div class="empty">Your home is empty. Tap the pencil to add tiles.</div>`;
}

function bindVisibleWidgets(root) {
  const cleanups = [];
  const needStats = new Set();
  const widgetEls = $$('[data-widget]', root);

  const fill = (el, html) => { const b = el.querySelector('[data-wbody]') || el; b.innerHTML = html; if (el.dataset.tid) Home.wcache[el.dataset.tid] = html; };

  const paintStats = (d) => {
    widgetEls.forEach((el) => {
      if (el.dataset.off === '1') return;
      const w = el.dataset.widget;
      if (w === 'cpu') fill(el, `<div class="tile-val num">${fmtPct(d.cpu.usage, 0)}</div><div class="muted small">load ${d.load.map((x) => fmtNum(x, 2)).join(' ')}</div>`);
      else if (w === 'mem') fill(el, `<div class="tile-val num">${fmtBytes(d.memory.used)}</div><div class="muted small">of ${fmtBytes(d.memory.total)}</div>${bar(d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0)}`);
      else if (w === 'disk') {
        const root0 = d.primaryDisk || d.disks[0];
        fill(el, root0 ? `<div class="tile-val num">${fmtBytes(root0.used)}</div><div class="muted small ellipsis">of ${fmtBytes(root0.size)} on ${esc(root0.mount)}</div>${bar((root0.used / root0.size) * 100)}` : 'n/a');
      } else if (w === 'net') fill(el, `<div class="tile-net"><div><span class="muted small">↓</span> <span class="num">${fmtRate(d.network.rxRate)}</span></div><div><span class="muted small">↑</span> <span class="num">${fmtRate(d.network.txRate)}</span></div></div>`);
      else if (w === 'uptime') fill(el, `<div class="tile-val">${fmtDur(d.uptime)}</div><div class="muted small ellipsis">${esc(d.info.hostname)}</div>`);
      else if (w === 'clock') {
        const now = new Date();
        fill(el, `<div class="tile-val">${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div><div class="muted small">${now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>`);
      } else if (w === 'storage') {
        fill(el, (d.disks || []).slice(0, 4).map((x) => {
          const p = (x.used / x.size) * 100;
          return `<div class="small" style="margin-bottom:6px"><div class="row"><span class="ellipsis grow">${esc(x.mount)}</span><span class="num">${fmtPct(p, 0)}</span></div>${bar(p)}</div>`;
        }).join('') || '<span class="muted">No mounts</span>');
      }
    });
  };

  // IntersectionObserver: only subscribe to Stats while any stats widget is on screen
  const io = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      en.target.dataset.off = en.isIntersecting ? '0' : '1';
      const w = en.target.dataset.widget;
      if (['cpu', 'mem', 'disk', 'net', 'uptime', 'clock', 'storage'].includes(w)) {
        if (en.isIntersecting) needStats.add(en.target); else needStats.delete(en.target);
      }
      if (en.isIntersecting) loadLazyWidget(en.target);
    });
  }, { root: null, threshold: 0.15 });
  widgetEls.forEach((el) => io.observe(el));
  cleanups.push(() => io.disconnect());

  let unsub = null;
  const ensureStats = () => {
    if (needStats.size && !unsub) {
      unsub = Stats.subscribe((d) => { if (needStats.size) paintStats(d); });
    } else if (!needStats.size && unsub) { unsub(); unsub = null; }
  };
  const tick = setInterval(ensureStats, 500);
  cleanups.push(() => { clearInterval(tick); if (unsub) unsub(); });

  // clock refresh without stats
  const clockTimer = setInterval(() => {
    widgetEls.forEach((el) => {
      if (el.dataset.widget === 'clock' && el.dataset.off !== '1' && Stats.last) paintStats(Stats.last);
      else if (el.dataset.widget === 'clock' && el.dataset.off !== '1') {
        const now = new Date();
        fill(el, `<div class="tile-val">${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div><div class="muted small">${now.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</div>`);
      }
    });
  }, 15000);
  cleanups.push(() => clearInterval(clockTimer));

  async function loadLazyWidget(el) {
    if (el.dataset.loaded === '1') return;
    const w = el.dataset.widget;
    const tid = el.dataset.tid;
    try {
      if (w === 'containers') {
        el.dataset.loaded = '1';
        const r = await GET('/docker/containers');
        const arr = Array.isArray(r.containers) ? r.containers : [];
        const run = arr.filter((c) => /running/i.test(c.State || '')).length;
        const stopped = arr.length - run;
        fill(el, `<div class="tile-val">${run} <span class="muted small">running</span></div><div class="muted small">${stopped} stopped · ${arr.length} total</div>`);
      } else if (w === 'processes') {
        el.dataset.loaded = '1';
        const r = await GET('/system/processes');
        const top = (r.processes || []).slice().sort((a, b) => b.cpu - a.cpu).slice(0, 5);
        fill(el, top.map((p) => `<div class="row small"><span class="ellipsis grow">${esc(p.name)}</span><span class="num">${fmtNum(p.cpu, 0)}%</span></div>`).join('') || '<span class="muted">None</span>');
      } else if (w === 'audit' && can('admin')) {
        el.dataset.loaded = '1';
        const r = await GET('/audit?limit=5');
        const ev = r.entries || r.events || [];
        const arr = Array.isArray(ev) ? ev.slice(0, 5) : [];
        fill(el, arr.map((e) => `<div class="small ellipsis"><span class="muted">${esc(e.user || '')}</span> ${esc(e.action || e.msg || '')}</div>`).join('') || '<span class="muted">No events</span>');
      } else if (w === 'updates' && can('admin')) {
        el.dataset.loaded = '1';
        fill(el, '<span class="muted small">Tap to check</span>');
        el.style.cursor = 'pointer';
        el.onclick = async () => {
          if (Home.editing) return;
          try {
            fill(el, '<span class="spinner"></span>');
            const host = await GET('/updates/host?refresh=1').catch(() => null);
            const imgs = await GET('/updates/images?refresh=1').catch(() => null);
            const hp = (host && (host.updates || host.packages || [])) || [];
            const ip = ((imgs && (imgs.images || [])) || []).filter((i) => i.update);
            const n = (Array.isArray(hp) ? hp.length : 0) + ip.length;
            fill(el, `<div class="tile-val">${n}</div><div class="muted small">available</div>`);
          } catch (e) { fill(el, `<span class="muted">${esc(e.message)}</span>`); }
        };
      } else if (w === 'notes') {
        el.dataset.loaded = '1';
        const tile = (Home.layout.tiles || []).find((x) => x.id === tid);
        const text = (tile && tile.text) || '';
        fill(el, `<div class="tile-notes">${esc(text) || '<span class="muted">Empty note</span>'}</div>`);
      }
    } catch (e) {
      fill(el, `<span class="muted small">${esc(e.message)}</span>`);
    }
  }

  return () => cleanups.forEach((fn) => { try { fn(); } catch (_) {} });
}

async function activateTile(t) {
  if (tileDisabled(t)) { toast('Your role cannot use that', true); return; }
  if (t.type === 'app') { location.hash = '#/' + t.app; return; }
  if (t.type === 'folder') { location.hash = '#/files/' + String(t.path || '/').replace(/^\//, ''); return; }
  if (t.type === 'link') { window.open(t.url, '_blank', 'noopener'); return; }
  if (t.type === 'script') {
    if (!can('operator')) return;
    try {
      const r = await POST('/scripts/' + encodeURIComponent(t.ref) + '/run', {});
      await watchJob(r.job, 'Run ' + (t.name || t.ref));
    } catch (e) { toastErr(e); }
    return;
  }
  if (t.type === 'stack') { location.hash = '#/stacks/' + encodeURIComponent(t.ref); return; }
  if (t.type === 'container') {
    // Open manage modal with start/stop if operator
    try {
      const r = await GET('/docker/containers');
      const list = r.containers || [];
      const c = list.find((x) => x.Id === t.ref || x.Id.startsWith(t.ref) || (x.Names && x.Names.join('').includes(t.ref)) || (x.Name && x.Name === t.ref));
      if (!c) { toast('Container not found', true); return; }
      const name = (c.Names && c.Names[0]) || c.Name || c.Id.slice(0, 12);
      const running = /running/i.test(c.State);
      const buttons = [{ label: 'Close', value: null }];
      if (can('operator')) {
        if (running) {
          buttons.push({ label: 'Stop', cls: 'danger', handler: async () => { await POST('/docker/containers/' + c.Id + '/stop'); toast('Stopped'); return true; } });
          buttons.push({ label: 'Restart', handler: async () => { await POST('/docker/containers/' + c.Id + '/restart'); toast('Restarted'); return true; } });
        } else {
          buttons.push({ label: 'Start', cls: 'primary', handler: async () => { await POST('/docker/containers/' + c.Id + '/start'); toast('Started'); return true; } });
        }
      }
      // Try open URL from ports
      const ports = c.Ports || [];
      const pub = ports.find((p) => p.PublicPort);
      if (pub) buttons.unshift({ label: 'Open UI', cls: 'primary', handler: () => { window.open(`http://${location.hostname}:${pub.PublicPort}`, '_blank', 'noopener'); return true; } });
      await modal({ title: name.replace(/^\//, ''), body: `<p>State: <span class="chip ${running ? 'ok' : ''}">${esc(c.State)}</span></p><p class="muted small mono">${esc(c.Image || '')}</p>`, buttons });
    } catch (e) { toastErr(e); }
  }
}

Pages.home = (el) => {
  let cleanupWidgets = null;
  const paint = async () => {
    let layout;
    try { layout = await loadHomeLayout(); } catch (e) { el.innerHTML = `<div class="notice">${esc(e.message)}</div>`; return; }
    el.innerHTML = `
      <div class="home-head">
        <div class="home-greet"><div class="muted" data-clock></div><h1 class="home-title">${greeting()}, ${esc(State.displayName || State.user)}</h1>
          <div class="muted home-host" data-hostline>…</div></div>
        <div class="row home-actions">
          <a class="btn" href="#/launcher">${ICON.store || ICON.apps} All apps</a>
          <button data-edit title="Edit home">${ICON.edit}</button>
          <button data-logout>${ICON.logout}</button>
        </div>
      </div>
      <div class="home-grid" data-home-grid></div>
      <p class="muted small home-foot" style="margin-top:14px">Signed in as <b>${esc(State.user)}</b> · role <span class="chip plain">${esc(State.role)}</span><span class="spacer"></span><span class="mono" title="Version and build of the running Uiable">${esc(buildLabel())}</span></p>`;
    paintHomeGrid(el, layout);
    $('[data-logout]', el).onclick = logout;
    $('[data-edit]', el).onclick = async () => {
      // Toggle: a second click while editing just saves & leaves (never mounts a second toolbar)
      if (Home.editing || Home.entering) { const done = $('.home-edit-bar [data-done]', el); if (done) done.click(); return; }
      Home.entering = true;
      try {
        await loadAsset('/js/home-edit.js');
        if (typeof HomeEdit !== 'undefined') await HomeEdit.enter(el, async () => { Home.layout = null; await paint(); rebuildDock(); });
      } catch (e) { toastErr(e); } finally { Home.entering = false; }
    };
    if (cleanupWidgets) cleanupWidgets();
    cleanupWidgets = bindVisibleWidgets(el);
    // hostline via stats once
    const unsub = Stats.subscribe((d) => {
      const hl = $('[data-hostline]', el);
      if (hl) hl.innerHTML = `<b>${esc(d.info.hostname)}</b> · ${esc(d.info.os)} · up ${fmtDur(d.uptime)}`;
      const c = $('[data-clock]', el);
      if (c) c.textContent = new Date().toLocaleString(undefined, { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    });
    // tile clicks
    $('[data-home-grid]', el).onclick = async (e) => {
      if (Home.editing) return;
      const btn = e.target.closest('[data-tid]');
      if (!btn || btn.classList.contains('is-widget')) {
        // notes tap to edit text for owner
        const w = e.target.closest('[data-widget=notes]');
        if (w && !Home.editing) {
          const tile = (Home.layout.tiles || []).find((x) => x.id === w.dataset.tid);
          if (!tile) return;
          const f = await formDlg('Sticky note', [{ name: 'text', label: 'Note', value: tile.text || '' }], 'Save', {
            handler: async (v) => { tile.text = v.text; await PUT('/layout', Home.layout); return true; },
          });
          if (f) { Home.layout = null; paint(); }
        }
        return;
      }
      const tile = (Home.layout.tiles || []).find((x) => x.id === btn.dataset.tid);
      if (tile) activateTile(tile);
    };
    return () => { unsub(); if (cleanupWidgets) cleanupWidgets(); };
  };

  let innerCleanup = null;
  paint().then((c) => { innerCleanup = c; });
  return () => { if (innerCleanup) try { innerCleanup(); } catch (_) {} if (cleanupWidgets) cleanupWidgets(); Home.editing = false; };
};
