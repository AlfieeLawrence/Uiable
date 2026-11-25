'use strict';
/* Uiable 1.2.8 UX layer: icons, skeletons / empty states, typed confirms, undo
   toasts, live status (topbar, dock, tab bar), command palette + keyboard
   shortcuts, activity centre (bell), onboarding tour + setup checklist,
   accessibility helpers and the large interactive chart used by the expanded
   stat views. Loaded on every page after core.js. */

Object.assign(ICON, {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  bell: svg('<path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  circle: svg('<circle cx="12" cy="12" r="9"/>'),
  redeploy: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.1 6.1C3.5 7.9 2 12 2 12s3.5 7 10 7c1.6 0 3-.4 4.3-1"/>'),
  plug: svg('<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>'),
  net: svg('<rect x="9" y="2" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M12 8v4M5 16v-2h14v2"/>'),
  braces: svg('<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>'),
  compass: svg('<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>'),
  alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'),
  arrowRight: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
  ext: svg('<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>'),
  thermo: svg('<path d="M14 14.8V4a2 2 0 0 0-4 0v10.8a4 4 0 1 0 4 0z"/>'),
});

const userKey = (k) => `uiable-${k}:${State.user || ''}`;

// ------------------------------------------------------------------ skeletons & empty states
/** Placeholder shapes while data loads. kind: cards | rows | stats | text */
function skel(kind = 'rows', n = 4) {
  const line = (w) => `<span class="sk sk-line" style="width:${w}%"></span>`;
  if (kind === 'cards') return `<div class="sk-grid" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => `<div class="card sk-card"><div class="row"><span class="sk sk-avatar"></span><div class="grow">${line(60)}${line(40)}</div><span class="sk sk-chip"></span></div>${line(85)}<div class="row">${'<span class="sk sk-btn"></span>'.repeat(3)}</div></div>`).join('')}</div>`;
  if (kind === 'stats') return `<div class="sk-grid stats" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => `<div class="card sk-card">${line(30)}<span class="sk sk-big"></span><span class="sk sk-chart"></span></div>`).join('')}</div>`;
  if (kind === 'text') return `<div aria-busy="true" aria-label="Loading">${Array.from({ length: n }, (_, i) => line(90 - (i % 3) * 15)).join('')}</div>`;
  return `<div class="card sk-rows" aria-busy="true" aria-label="Loading">${Array.from({ length: n }, () => `<div class="row">${line(28)}${line(42)}<span class="spacer"></span>${line(12)}</div>`).join('')}</div>`;
}
/** Friendly empty state. actions: [{ label, href } | { label, attr: 'data-x', primary }] */
function emptyState({ icon = 'info', title, text = '', actions = [] }) {
  return `<div class="empty-state"><div class="es-ic" aria-hidden="true">${ICON[icon] || ICON.info}</div><h3>${esc(title)}</h3>${text ? `<p class="muted">${text}</p>` : ''}${actions.length ? `<div class="row wrap es-actions">${actions.map((a) => a.href
    ? `<a class="btn ${a.primary ? 'primary' : ''}" href="${esc(a.href)}">${a.icon ? ICON[a.icon] || '' : ''}${esc(a.label)}</a>`
    : `<button type="button" class="${a.primary ? 'primary' : ''}" ${a.attr || ''}>${a.icon ? ICON[a.icon] || '' : ''}${esc(a.label)}</button>`).join('')}</div>` : ''}</div>`;
}

// ------------------------------------------------------------------ destructive actions: type to confirm
/** Resolves true only once the user has typed `word` exactly. */
function typedConfirm({ title, text, word, okLabel = 'Delete' }) {
  return modal({
    title, cls: 'danger-dlg',
    body: `<div class="danger-note">${ICON.alert}<div>${text}</div></div>
      <label class="field"><span>Type <b class="mono">${esc(word)}</b> to confirm</span><input data-typed autocomplete="off" autocapitalize="off" spellcheck="false" aria-describedby="tc-hint"></label>
      <p class="muted small" id="tc-hint">This can't be undone.</p>`,
    buttons: [{ label: 'Cancel', value: false }, { label: okLabel, cls: 'danger solid', handler: (m) => ($('[data-typed]', m).value.trim() === word ? true : false), keepOpenOnError: true }],
    onOpen: (m) => {
      const inp = $('[data-typed]', m); const ok = $('footer button.danger', m);
      const sync = () => { ok.disabled = inp.value.trim() !== word; };
      inp.addEventListener('input', sync); sync();
    },
  });
}

// ------------------------------------------------------------------ undo toasts
const Undo = createUndoQueue({ delayMs: 5000 });
window.addEventListener('pagehide', () => Undo.flushAll());
/** POST that survives the page closing (used when pending undo actions are flushed). */
async function postKeepalive(url, body) {
  const res = await fetch('/api' + url, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': State.csrf || '' }, body: JSON.stringify(body || {}) });
  let data = null; try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}
/**
 * Run a safe action after 5 s with an Undo button. label: "Stopping jellyfin…",
 * run: async () => …, done: message after it ran, onDone: refresh callback.
 */
function undoable({ label, run, done, onDone, onUndo }) {
  const job = Undo.schedule(label, run, { onError: (e) => toastErr(e) });
  const t = toast(label, false, { timeout: 5000, action: { label: 'Undo', fn: () => job.undo() }, onTimeout: () => {} });
  job.done.then((r) => {
    t.close('x');
    if (r === 'ran') { if (done) toast(done); if (onDone) onDone(); }
    if (r === 'undone') { toast('Undone — nothing was changed'); if (onUndo) onUndo(); }
  });
  return job;
}

// ------------------------------------------------------------------ interactive chart (expanded stat views)
/**
 * Draw a time series with grid, y labels, optional min/max band and a hover tooltip.
 * series: [{ label, color, data: [{ t, v, lo?, hi? }] }], opts: { max, fmt(v), tip(el) }
 */
function drawChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(document.documentElement);
  const muted = css.getPropertyValue('--muted').trim() || '#888'; const grid = css.getPropertyValue('--border').trim() || 'rgba(127,127,127,.2)';
  const fmt = opts.fmt || ((v) => String(Math.round(v)));
  const all = series.flatMap((s) => s.data.flatMap((p) => [p.v, p.hi]).filter((v) => v != null && Number.isFinite(v)));
  const top = opts.max || Math.max(1, ...all) * 1.1;
  const ts = series.flatMap((s) => s.data.map((p) => p.t));
  const now = Date.now();
  const t0 = opts.from || (ts.length ? Math.min(...ts) : now - 60000), t1 = opts.to || (ts.length ? Math.max(...ts) : now);
  const padL = 52, padR = 10, padT = 10, padB = 22;
  const X = (t) => padL + ((t - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const Y = (v) => padT + (1 - Math.min(v, top) / top) * (h - padT - padB);
  ctx.font = '11px ' + (css.getPropertyValue('--font') || 'sans-serif'); ctx.fillStyle = muted; ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const v = (top * i) / 4; const y = Y(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(fmt(v), 4, y + 4); }
  const span = t1 - t0; const tf = span > 2 * 86400000 ? { weekday: 'short', hour: '2-digit' } : { hour: '2-digit', minute: '2-digit' };
  for (let i = 0; i <= 4; i++) { const t = t0 + (span * i) / 4; const label = new Date(t).toLocaleString(undefined, tf); const x = Math.min(w - padR - ctx.measureText(label).width, Math.max(padL, X(t) - ctx.measureText(label).width / 2)); ctx.fillText(label, x, h - 6); }
  series.forEach((s) => {
    const pts = s.data.filter((p) => p.v != null);
    if (!pts.length) return;
    if (pts.some((p) => p.lo != null)) { // min/max band
      ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.hi)) : ctx.moveTo(X(p.t), Y(p.hi)))); [...pts].reverse().forEach((p) => ctx.lineTo(X(p.t), Y(p.lo))); ctx.closePath();
      ctx.fillStyle = s.color + '22'; ctx.fill();
    }
    const g = ctx.createLinearGradient(0, padT, 0, h - padB); g.addColorStop(0, s.color + '44'); g.addColorStop(1, s.color + '00');
    ctx.beginPath(); ctx.moveTo(X(pts[0].t), h - padB); pts.forEach((p) => ctx.lineTo(X(p.t), Y(p.v))); ctx.lineTo(X(pts[pts.length - 1].t), h - padB); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); let started = false; let prevT = null; const gap = opts.gapMs || Infinity;
    s.data.forEach((p) => { if (p.v == null || (prevT != null && p.t - prevT > gap)) { started = false; } if (p.v == null) return; if (!started) { ctx.moveTo(X(p.t), Y(p.v)); started = true; } else ctx.lineTo(X(p.t), Y(p.v)); prevT = p.t; });
    ctx.strokeStyle = s.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  });
  // hover tooltip (pointer + keyboard via arrow keys handled by caller)
  canvas._chart = { X, Y, t0, t1, padL, padR, series, fmt, w, h };
  if (!canvas._hoverBound) {
    canvas._hoverBound = true;
    const tip = opts.tipEl;
    const show = (clientX) => {
      const c = canvas._chart; if (!c || !tip) return;
      const r = canvas.getBoundingClientRect(); const x = clientX - r.left;
      const t = c.t0 + ((x - c.padL) / Math.max(1, c.w - c.padL - c.padR)) * (c.t1 - c.t0);
      const rows = c.series.map((s) => { let best = null; for (const p of s.data) if (p.v != null && (!best || Math.abs(p.t - t) < Math.abs(best.t - t))) best = p; return best ? { s, p: best } : null; }).filter(Boolean);
      if (!rows.length) { tip.hidden = true; return; }
      tip.hidden = false;
      tip.innerHTML = `<div class="muted small">${esc(new Date(rows[0].p.t).toLocaleString())}</div>${rows.map(({ s, p }) => `<div class="row small"><i class="key" style="background:${s.color}"></i><span class="grow">${esc(s.label)}</span><b class="num">${esc(c.fmt(p.v))}</b>${p.lo != null ? `<span class="muted num">&nbsp;${esc(c.fmt(p.lo))}–${esc(c.fmt(p.hi))}</span>` : ''}</div>`).join('')}`;
      const tx = Math.min(r.width - tip.offsetWidth - 4, Math.max(4, c.X(rows[0].p.t) + 12));
      tip.style.left = tx + 'px'; tip.style.top = '8px';
      canvas.style.setProperty('--cursor-x', c.X(rows[0].p.t) + 'px'); canvas.parentElement.style.setProperty('--cursor-x', c.X(rows[0].p.t) + 'px'); canvas.parentElement.classList.add('hovering');
    };
    canvas.addEventListener('pointermove', (e) => show(e.clientX));
    canvas.addEventListener('pointerleave', () => { if (opts.tipEl) opts.tipEl.hidden = true; canvas.parentElement.classList.remove('hovering'); });
  }
}

// ------------------------------------------------------------------ live status: topbar pill, dock dot, tab bar
const Live = {
  health: null, unsub: null, timer: null, cpu: [],
  summarize(list) {
    const s = { running: 0, stopped: 0, unhealthy: 0, starting: 0, failed: 0, total: list.length };
    for (const c of list) {
      if (c.State === 'running') s.running++; else s.stopped++;
      if (/\(unhealthy\)/.test(c.Status || '')) s.unhealthy++;
      else if (/health: starting/.test(c.Status || '') || c.State === 'restarting') s.starting++;
      if (c.State === 'exited' && !/\(0\)/.test(c.Status || '')) s.failed++;
    }
    s.level = s.unhealthy ? 'bad' : (s.starting || s.failed) ? 'warn' : 'ok';
    return s;
  },
  setContainers(list) { this.health = this.summarize(list || []); this.paint(); },
  paint() {
    const h = this.health;
    const title = h ? `Containers: ${h.running} running, ${h.stopped} stopped${h.unhealthy ? `, ${h.unhealthy} unhealthy` : ''}${h.starting ? `, ${h.starting} starting` : ''}` : '';
    $$('[data-dock-health]').forEach((d) => { d.className = 'dock-dot' + (h ? ' ' + h.level : ''); d.title = title; });
    const pill = $('[data-live-ctr]');
    if (pill) { pill.hidden = !h; if (h) { pill.className = 'live-ctr ' + h.level; pill.innerHTML = `<i class="hdot ${h.level}"></i><span class="num">${h.running}</span><span class="sr-only"> containers running</span>`; pill.title = title; pill.setAttribute('aria-label', title); } }
  },
  async pollContainers() {
    if (document.hidden || !State.user || !can('viewer')) return;
    try { const s = await GET('/docker/status'); if (!s.available) { this.health = null; this.paint(); return; } this.setContainers((await GET('/docker/containers')).containers); } catch (_) {}
  },
  start() {
    if (!this.timer) { this.pollContainers(); this.timer = setInterval(() => { if (!location.hash.startsWith('#/docker')) this.pollContainers(); }, 20000); }
    if (!this.unsub && $('[data-live-cpu]')) {
      this.unsub = Stats.subscribe((d) => {
        const el = $('[data-live-cpu]'); if (!el) { this.unsub(); this.unsub = null; return; }
        $('.num', el).textContent = fmtPct(d.cpu.usage, 0);
        el.title = `CPU ${fmtPct(d.cpu.usage, 0)} · memory ${fmtPct(d.memory.total ? d.memory.used / d.memory.total * 100 : 0, 0)}`;
        sparkline($('canvas', el), [Stats.history.cpu.slice(-30)], { max: 100 });
      });
    }
  },
  stopCpu() { if (this.unsub) { this.unsub(); this.unsub = null; } },
};

function topActionsHtml() {
  return `<div class="top-actions" role="toolbar" aria-label="Quick actions">
    <a class="live-pill" href="#/dashboard" data-live-cpu title="CPU" aria-label="Live CPU usage, open dashboard"><canvas aria-hidden="true"></canvas><span class="num">–</span></a>
    <a class="live-ctr" href="#/docker" data-live-ctr hidden></a>
    <button type="button" class="icon" data-search title="Search (Ctrl K)" aria-label="Search and commands (Ctrl K)">${ICON.search}</button>
    <button type="button" class="icon bell" data-bell title="Activity (n)" aria-label="Activity and notifications" aria-haspopup="dialog">${ICON.bell}<span class="badge" data-bell-badge hidden></span></button>
  </div>`;
}
function tabbarHtml(page) {
  const items = [
    { id: 'home', href: '#/', icon: 'home', label: 'Home' },
    { id: 'launcher', href: '#/launcher', icon: 'grid', label: 'Apps' },
    ...(can('viewer') ? [{ id: 'docker', href: '#/docker', icon: 'docker', label: 'Docker', dot: true }] : []),
    { id: 'search', href: '#', icon: 'search', label: 'Search', attr: 'data-search' },
    { id: 'activity', href: '#', icon: 'bell', label: 'Activity', attr: 'data-bell', badge: true },
  ];
  return `<nav class="tabbar" aria-label="Main">${items.map((it) => `<a href="${it.href}" class="${it.id === page ? 'active' : ''}" ${it.attr || ''} ${it.id === page ? 'aria-current="page"' : ''}><span class="tb-ic">${ICON[it.icon]}${it.dot ? '<span class="dock-dot" data-dock-health aria-hidden="true"></span>' : ''}${it.badge ? '<span class="badge" data-bell-badge hidden></span>' : ''}</span><span class="tb-label">${it.label}</span></a>`).join('')}</nav>`;
}
function afterRoute(page) {
  Live.stopCpu(); Live.start(); Live.paint();
  Activity.badge();
  if (afterRoute.n++ && !openModals.size) { const v = $('#view'); if (v && document.activeElement === document.body) v.focus({ preventScroll: true }); }
  if (page === 'home') Tour.maybeStart();
}
afterRoute.n = 0;

document.addEventListener('click', (e) => {
  if (e.target.closest('[data-skip]')) { e.preventDefault(); const v = $('#view'); if (v) v.focus(); return; }
  if (e.target.closest('[data-search]')) { e.preventDefault(); Palette.open(); return; }
  if (e.target.closest('[data-bell]')) { e.preventDefault(); Activity.open(); }
});

// ------------------------------------------------------------------ command palette
const SETTINGS_INDEX = [
  ['account', 'My account', 'viewer', 'profile linux user password'], ['general', 'General', 'admin', 'hostname timezone features app store toggle'],
  ['network', 'Network & Wi-Fi', 'admin', 'wifi ip dns'], ['users', 'Linux users', 'admin', 'useradd'], ['accounts', 'Dashboard accounts', 'admin', 'roles users'],
  ['security', 'Security & 2FA', 'viewer', 'two-factor totp'], ['alerts', 'Alerts', 'admin', 'email telegram discord ntfy webhook notifications'],
  ['tokens', 'API tokens', 'admin', 'bearer'], ['appearance', 'Appearance', 'viewer', 'theme dark light tour shortcuts'], ['power', 'Power', 'admin', 'reboot shutdown'], ['about', 'About & security', 'viewer', 'version'],
];
/** Fuzzy score: subsequence match, bonuses for word starts / contiguous runs; -1 when no match. */
function fuzzyScore(q, text) {
  q = q.toLowerCase(); const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 || /\W/.test(t[idx - 1]) ? 50 : 0);
  let score = 0, ti = 0, run = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    run = f === ti ? run + 1 : 0;
    score += 1 + run * 2 + (f === 0 || /\W/.test(t[f - 1]) ? 5 : 0);
    ti = f + 1;
  }
  return score;
}
const Palette = {
  ctrs: null, ctrsAt: 0,
  async containers() {
    if (this.ctrs && Date.now() - this.ctrsAt < 15000) return this.ctrs;
    try { const s = await GET('/docker/status'); this.ctrs = s.available ? (await GET('/docker/containers')).containers : []; } catch (_) { this.ctrs = []; }
    this.ctrsAt = Date.now(); return this.ctrs;
  },
  baseItems() {
    const items = [];
    visibleApps().forEach((a) => items.push({ group: 'Pages', label: a.name, hint: a.id === 'apps' ? 'App store' : '', icon: a.icon, run: () => { location.hash = '#/' + a.id; } }));
    items.push({ group: 'Pages', label: 'All apps', icon: 'grid', run: () => { location.hash = '#/launcher'; } }, { group: 'Pages', label: 'Home', icon: 'home', run: () => { location.hash = '#/'; } });
    SETTINGS_INDEX.filter((x) => can(x[2])).forEach(([id, label, , kw]) => items.push({ group: 'Settings', label: `Settings › ${label}`, keywords: kw, icon: 'settings', run: () => { location.hash = '#/settings/' + id; } }));
    items.push(
      { group: 'Actions', label: 'Toggle theme', keywords: 'dark light', icon: 'sun', kbd: 't', run: cycleTheme },
      ...APP_THEMES.map((t) => ({ group: 'Actions', label: `Theme: ${t[0].toUpperCase() + t.slice(1)}`, icon: 'palette', run: () => { setTheme(t); rebuildDock(); } })),
      { group: 'Actions', label: 'Open activity & notifications', icon: 'bell', kbd: 'n', run: () => Activity.open() },
      { group: 'Actions', label: 'Keyboard shortcuts', icon: 'keyboard', kbd: '?', run: () => showShortcuts() },
      { group: 'Actions', label: 'Take the tour', icon: 'compass', run: () => Tour.start(true) },
      { group: 'Actions', label: 'Sign out', icon: 'logout', run: () => logout() },
    );
    if (can('operator')) items.push({ group: 'Actions', label: 'New terminal', icon: 'term', run: () => { location.hash = '#/terminal'; } });
    if (can('admin')) {
      items.push({ group: 'Actions', label: 'Check for updates', icon: 'refresh', run: () => { location.hash = '#/updates'; } });
      items.push({ group: 'Actions', label: `${featureOn('store') ? 'Turn off' : 'Turn on'} the app store`, keywords: 'feature store apps', icon: 'store', run: () => setFeature('store', !featureOn('store')) });
    }
    return items;
  },
  ctrItems(list) {
    const out = [];
    for (const c of list) {
      const name = c.Names[0].replace(/^\//, ''); const running = c.State === 'running';
      out.push({ group: 'Containers', label: name, hint: `${c.State} · ${c.Image}`, icon: 'docker', dot: Live.summarize([c]).level, run: () => { location.hash = '#/docker/c/' + encodeURIComponent(c.Id.slice(0, 12)); } });
      if (can('operator')) {
        if (running) {
          out.push({ group: 'Containers', label: `Restart ${name}`, icon: 'restart', run: () => ctrAction(c.Id, name, 'restart') });
          out.push({ group: 'Containers', label: `Stop ${name}`, icon: 'stop', run: () => ctrAction(c.Id, name, 'stop') });
        } else out.push({ group: 'Containers', label: `Start ${name}`, icon: 'play', run: () => ctrAction(c.Id, name, 'start') });
      }
    }
    return out;
  },
  open() {
    if ($('.palette')) return;
    let items = this.baseItems(); let sel = 0; let shown = [];
    modal({
      title: 'Search', cls: 'palette', buttons: [],
      body: `<div class="pal-in"><span aria-hidden="true">${ICON.search}</span><input data-pq role="combobox" aria-expanded="true" aria-controls="pal-list" aria-autocomplete="list" placeholder="Search pages, containers, settings and actions…" autocomplete="off" spellcheck="false" autofocus><kbd>Esc</kbd></div>
        <div class="pal-list" id="pal-list" role="listbox" aria-label="Results"></div>
        <div class="pal-foot muted small"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>?</kbd> shortcuts</span></div>`,
      onOpen: (m, close) => {
        const inp = $('[data-pq]', m); const list = $('.pal-list', m);
        const render = () => {
          const q = inp.value.trim();
          shown = items.map((it) => ({ it, s: q ? Math.max(fuzzyScore(q, it.label), it.keywords ? fuzzyScore(q, it.keywords) - 20 : -1, it.hint ? fuzzyScore(q, it.hint) - 30 : -1) : (it.group === 'Pages' ? 1 : it.group === 'Actions' ? 0.5 : 0) }))
            .filter((x) => x.s >= 0 && (q || x.it.group !== 'Containers' || !/^(Restart|Stop|Start) /.test(x.it.label)))
            .sort((a, b) => b.s - a.s).slice(0, q ? 40 : 30).map((x) => x.it);
          if (!q) { const order = ['Pages', 'Containers', 'Actions', 'Settings']; shown.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group)); }
          sel = Math.min(sel, Math.max(0, shown.length - 1));
          let last = '';
          list.innerHTML = shown.length ? shown.map((it, i) => { const head = it.group !== last ? `<div class="pal-group" role="presentation">${esc(it.group)}</div>` : ''; last = it.group; return `${head}<div class="pal-item ${i === sel ? 'sel' : ''}" role="option" id="pal-${i}" aria-selected="${i === sel}" data-i="${i}"><span class="pal-ic">${ICON[it.icon] || ICON.arrowRight}${it.dot ? `<i class="hdot ${it.dot}"></i>` : ''}</span><span class="grow ellipsis">${esc(it.label)}${it.hint ? ` <span class="muted small">${esc(it.hint)}</span>` : ''}</span>${it.kbd ? `<kbd>${esc(it.kbd)}</kbd>` : ''}</div>`; }).join('')
            : `<div class="empty small">No results for “${esc(q)}”</div>`;
          inp.setAttribute('aria-activedescendant', shown.length ? 'pal-' + sel : '');
          const el = $('.pal-item.sel', list); if (el) el.scrollIntoView({ block: 'nearest' });
        };
        const go = (i) => { const it = shown[i]; if (!it) return; close(null); setTimeout(() => it.run(), 0); };
        inp.addEventListener('input', () => { sel = 0; render(); });
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); render(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
          else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(sel); }
        });
        list.addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) go(+r.dataset.i); });
        list.addEventListener('mousemove', (e) => { const r = e.target.closest('[data-i]'); if (r && +r.dataset.i !== sel) { sel = +r.dataset.i; $$('.pal-item', list).forEach((x) => { x.classList.toggle('sel', +x.dataset.i === sel); x.setAttribute('aria-selected', +x.dataset.i === sel); }); } });
        render();
        if (can('viewer')) this.containers().then((c) => { if (!inp.isConnected) return; items = [...this.baseItems(), ...this.ctrItems(c)]; render(); });
      },
    });
  },
};
function cycleTheme() {
  const cycle = ['system', ...APP_THEMES]; const i = cycle.indexOf(getTheme());
  setTheme(cycle[(i < 0 ? 0 : i + 1) % cycle.length]); rebuildDock(); toast('Theme: ' + getTheme());
}
async function setFeature(name, on, { stay } = {}) {
  try {
    State.features = await PUT('/features', { [name]: on });
    toast(`App store turned ${on ? 'on' : 'off'}`);
    rebuildDock(); if (!stay) route();
    return true;
  } catch (e) { toastErr(e); return false; }
}
/** Container start/stop/restart from anywhere: stop and restart are undoable. */
function ctrAction(id, name, a, onDone) {
  if (a === 'start') return act(null, () => POST(`/docker/containers/${id}/start`), `Started ${name}`).then(() => onDone && onDone());
  const verb = a === 'stop' ? 'Stopping' : 'Restarting';
  return undoable({ label: `${verb} ${name} in 5 s…`, run: () => postKeepalive(`/docker/containers/${id}/${a}`), done: `${a === 'stop' ? 'Stopped' : 'Restarted'} ${name}`, onDone });
}

// ------------------------------------------------------------------ keyboard shortcuts
const SHORTCUTS = [
  ['Ctrl / ⌘ K', 'Search pages, containers, settings and actions'], ['/', 'Focus the search box on this page'], ['?', 'Show this help'],
  ['g h', 'Go home'], ['g a', 'All apps'], ['g d', 'Docker'], ['g f', 'Files'], ['g l', 'Logs'], ['g t', 'Terminal'], ['g m', 'Dashboard (metrics)'], ['g s', 'Settings'], ['g u', 'Updates'],
  ['n', 'Activity & notifications'], ['t', 'Cycle theme'], ['Esc', 'Close dialog / palette'],
];
function showShortcuts() {
  if ($('.shortcuts-dlg')) return;
  modal({ title: 'Keyboard shortcuts', cls: 'shortcuts-dlg', body: `<dl class="kbd-list">${SHORTCUTS.map(([k, d]) => `<dt>${k.split(' ').map((x) => (x === '/' && k.length > 1) ? '<span class="muted">/</span>' : `<kbd>${esc(x)}</kbd>`).join(' ')}</dt><dd>${esc(d)}</dd>`).join('')}</dl><p class="muted small">Shortcuts are ignored while you type in a field. “g” then a letter jumps to a page.</p>`, buttons: [{ label: 'Close', value: null }] });
}
(function () {
  const GO = { h: '#/', a: '#/launcher', d: '#/docker', f: '#/files', l: '#/logs', t: '#/terminal', m: '#/dashboard', s: '#/settings', u: '#/updates' };
  let gAt = 0;
  document.addEventListener('keydown', (e) => {
    if (!State.user) return;
    const k = e.key;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && k.toLowerCase() === 'k') { e.preventDefault(); if ($('.palette')) closeAllModals(); else { closeAllModals(); Palette.open(); } return; }
    const typing = e.target.closest && e.target.closest('input, textarea, select, [contenteditable="true"], .xterm');
    if (typing || e.ctrlKey || e.metaKey || e.altKey || openModals.size) return;
    if (k === '?') { e.preventDefault(); showShortcuts(); return; }
    if (k === '/') { const s = $('#view input.search, #view input[type=search], #view [data-q]'); if (s) { e.preventDefault(); s.focus(); } return; }
    if (gAt && Date.now() - gAt < 1200 && GO[k]) { e.preventDefault(); gAt = 0; location.hash = GO[k]; return; }
    gAt = 0;
    if (k === 'g') { gAt = Date.now(); return; }
    if (k === 'n') { e.preventDefault(); Activity.open(); return; }
    if (k === 't') { e.preventDefault(); cycleTheme(); }
  });
})();

// ------------------------------------------------------------------ activity / notifications centre
const Activity = {
  items: [], at: 0, timer: null,
  seen() { return Number(localStorage.getItem(userKey('activity-seen')) || 0); },
  async load(force) {
    if (!force && Date.now() - this.at < 30000) return this.items;
    try { this.items = (await GET('/activity')).items || []; this.at = Date.now(); } catch (_) {}
    return this.items;
  },
  async badge() {
    if (!this.timer) this.timer = setInterval(() => { if (!document.hidden && State.user) this.badge(); }, 60000);
    await this.load();
    const n = this.items.filter((i) => i.t > this.seen() && i.level !== 'info').length + this.items.filter((i) => i.t > this.seen() && i.kind === 'update').length;
    $$('[data-bell-badge]').forEach((b) => { b.hidden = !n; b.textContent = n > 9 ? '9+' : String(n); });
    $$('[data-bell]').forEach((b) => b.setAttribute('aria-label', `Activity and notifications${n ? `, ${n} new` : ''}`));
  },
  open() {
    if ($('.activity-dlg')) return;
    const seenBefore = this.seen();
    let filter = 'all';
    const KINDS = [['all', 'All'], ['alert', 'Alerts'], ['job', 'Failed jobs'], ['update', 'Updates'], ['action', 'Recent actions']];
    const icon = (i) => ({ alert: 'alert', job: 'alert', update: 'refresh', action: i.level === 'error' ? 'alert' : 'check' }[i.kind] || 'info');
    modal({
      title: 'Activity', cls: 'activity-dlg', wide: false,
      body: `<div class="seg act-filter" role="tablist">${KINDS.map(([k, l]) => `<button type="button" role="tab" data-k="${k}" class="${k === filter ? 'active' : ''}" aria-selected="${k === filter}">${l}</button>`).join('')}</div><div data-alist>${skel('text', 6)}</div>`,
      buttons: [{ label: 'Mark all read', handler: () => { localStorage.setItem(userKey('activity-seen'), String(Date.now())); this.badge(); return 'read'; } }, { label: 'Close', value: null }],
      onOpen: (m, close) => {
        const listEl = $('[data-alist]', m);
        const paint = () => {
          const items = this.items.filter((i) => filter === 'all' || i.kind === filter);
          listEl.innerHTML = items.length ? `<ul class="act-list">${items.map((i) => `<li><a href="${esc(i.href.startsWith('job:') ? '#' : i.href)}" data-href="${esc(i.href)}" class="act-item ${i.level} ${i.t > seenBefore ? 'unread' : ''}">
            <span class="act-ic ${i.level}" aria-hidden="true">${ICON[icon(i)]}</span>
            <span class="grow"><span class="act-title">${esc(i.title)}</span><span class="muted small act-detail">${esc(i.detail || '')}</span></span>
            <time class="muted small nowrap" datetime="${new Date(i.t).toISOString()}" title="${esc(new Date(i.t).toLocaleString())}">${esc(timeAgo(i.t / 1000))}</time></a></li>`).join('')}</ul>`
            : emptyState({ icon: 'bell', title: filter === 'all' ? 'Nothing yet' : 'Nothing here', text: filter === 'alert' ? 'Alerts appear here when a rule fires. Set channels and thresholds in Settings → Alerts.' : 'Actions, alerts, failed jobs and update notices will show up here.', actions: filter === 'alert' && can('admin') ? [{ label: 'Set up alerts', href: '#/settings/alerts' }] : [] });
        };
        $$('[data-k]', m).forEach((b) => (b.onclick = () => { filter = b.dataset.k; $$('[data-k]', m).forEach((x) => { x.classList.toggle('active', x === b); x.setAttribute('aria-selected', x === b); }); paint(); }));
        listEl.addEventListener('click', async (e) => {
          const a = e.target.closest('[data-href]'); if (!a) return;
          const h = a.dataset.href;
          if (h.startsWith('job:')) { e.preventDefault(); close(null); const j = await GET('/jobs/' + h.slice(4)).catch(() => null); if (j) watchJob(j, j.title); else toast('That job has expired', true); return; }
          close(null);
        });
        this.load(true).then(() => { if (listEl.isConnected) paint(); localStorage.setItem(userKey('activity-seen'), String(Date.now())); this.badge(); });
      },
    });
  },
};

// ------------------------------------------------------------------ onboarding: tour + setup checklist
const Tour = {
  steps: () => [
    { sel: null, title: 'Welcome to Uiable', text: 'A quick look around — about 30 seconds. You can skip at any time and re-run it from Settings → Appearance.' },
    { sel: '[data-home-grid]', title: 'Your home', text: 'Live widgets and shortcuts. Tap a stat card (CPU, memory, storage, network) to open a full-detail view with history. The pencil customises the layout.' },
    { sel: '[data-checklist]', title: 'Setup checklist', text: 'A few things worth doing on a new server: 2FA, backups, alerts, updates and linking your Linux account.' },
    { sel: '.home-actions [data-search], .tabbar [data-search]', title: 'Search everything', text: 'Press Ctrl K (⌘ K on a Mac) to jump to any page, container, setting or action. Press ? for all keyboard shortcuts.' },
    { sel: '.home-actions [data-bell], .tabbar [data-bell]', title: 'Activity', text: 'Recent actions, alerts, failed jobs and update notices, each linking to where it happened.' },
    { sel: '.tabbar, .dock', title: 'Dock', text: 'Your favourite apps, always one tap away. The dot on Docker shows container health.' },
  ],
  maybeStart() {
    if (localStorage.getItem(userKey('tour-done')) || openModals.size || this.on) return;
    setTimeout(() => { if (location.hash.replace(/^#\/?/, '') === '' && !openModals.size) this.start(); }, 900);
  },
  start(force) {
    if (force && location.hash.replace(/^#\/?/, '') !== '') { location.hash = '#/'; setTimeout(() => this.start(), 900); return; }
    if (this.on) return;
    this.on = true;
    const steps = this.steps().filter((s) => !s.sel || $$(s.sel).some((el) => el.offsetParent !== null));
    let i = 0;
    const ov = document.createElement('div'); ov.className = 'tour'; ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'tour-t');
    ov.innerHTML = `<div class="tour-hole"></div><div class="tour-pop" tabindex="-1"><div class="muted small" data-n></div><h3 id="tour-t" data-t></h3><p data-x></p><div class="row"><button type="button" data-skip-tour>Skip tour</button><span class="spacer"></span><button type="button" data-back>Back</button><button type="button" class="primary" data-next>Next</button></div></div>`;
    document.body.appendChild(ov); lockScroll();
    const hole = $('.tour-hole', ov), pop = $('.tour-pop', ov);
    const end = () => { localStorage.setItem(userKey('tour-done'), '1'); ov.remove(); unlockScroll(); document.removeEventListener('keydown', key, true); this.on = false; };
    const show = () => {
      const s = steps[i];
      $('[data-n]', ov).textContent = `${i + 1} of ${steps.length}`; $('[data-t]', ov).textContent = s.title; $('[data-x]', ov).textContent = s.text;
      $('[data-back]', ov).disabled = i === 0; $('[data-next]', ov).textContent = i === steps.length - 1 ? 'Done' : 'Next';
      const el = s.sel && $$(s.sel).find((x) => x.offsetParent !== null);
      if (el) {
        el.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
        const r = el.getBoundingClientRect(); const pad = 6;
        Object.assign(hole.style, { display: 'block', left: r.left - pad + 'px', top: r.top - pad + 'px', width: r.width + pad * 2 + 'px', height: Math.min(r.height, innerHeight - 20) + pad * 2 + 'px' });
        const below = r.bottom + 12 + 180 < innerHeight;
        const left = Math.max(12, Math.min(innerWidth - Math.min(360, innerWidth - 24) - 12, r.left));
        Object.assign(pop.style, { left: left + 'px', top: (below ? r.bottom + 12 : Math.max(12, r.top - 12 - pop.offsetHeight)) + 'px', transform: 'none' });
      } else { hole.style.display = 'none'; Object.assign(pop.style, { left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }); }
      pop.focus();
    };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(); } else if (e.key === 'ArrowRight') { $('[data-next]', ov).click(); } else if (e.key === 'ArrowLeft' && i > 0) { $('[data-back]', ov).click(); } };
    document.addEventListener('keydown', key, true);
    $('[data-skip-tour]', ov).onclick = end;
    $('[data-back]', ov).onclick = () => { if (i > 0) { i--; show(); } };
    $('[data-next]', ov).onclick = () => { if (i < steps.length - 1) { i++; show(); } else end(); };
    window.addEventListener('resize', () => { if (ov.isConnected) show(); });
    show();
  },
};
async function renderChecklist(host) {
  if (!host || localStorage.getItem(userKey('checklist-hidden')) === '1') { if (host) host.innerHTML = ''; return; }
  let c; try { c = await GET('/setup-checklist'); } catch (_) { host.innerHTML = ''; return; }
  if (c.complete) { host.innerHTML = ''; return; }
  host.innerHTML = `<section class="card checklist" data-checklist aria-labelledby="cl-h"><div class="row"><div class="grow"><h3 id="cl-h">Finish setting up</h3><div class="muted small">${c.done} of ${c.total} done</div></div><button type="button" class="sm" data-cl-hide aria-label="Hide setup checklist">Hide</button></div>
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${c.done}" aria-label="Setup progress"><i style="width:${(c.done / c.total) * 100}%"></i></div>
    <ul class="cl-list">${c.items.map((i) => `<li class="${i.done ? 'done' : ''}"><span class="cl-ic" aria-hidden="true">${i.done ? ICON.check : ICON.circle}</span><span class="grow">${esc(i.label)}<span class="sr-only">${i.done ? ' (done)' : ' (to do)'}</span></span>${i.done ? '' : `<a class="btn sm" href="${esc(i.href)}">${esc(i.cta)}</a>`}</li>`).join('')}</ul></section>`;
  $('[data-cl-hide]', host).onclick = () => { localStorage.setItem(userKey('checklist-hidden'), '1'); host.innerHTML = ''; toast('Checklist hidden. Bring it back from Settings → Appearance.'); };
}

// ------------------------------------------------------------------ accessibility helpers
(function () {
  // Icon-only buttons/links get an accessible name from their title.
  const label = (root) => {
    if (!root.querySelectorAll) return;
    const list = root.matches && root.matches('button, a.btn, a.icon') ? [root] : root.querySelectorAll('button, a.btn');
    for (const b of list) {
      if (b.hasAttribute('aria-label')) continue;
      const txt = b.textContent.trim();
      if (!txt && b.title) b.setAttribute('aria-label', b.title);
      if (b.querySelector('svg')) b.querySelectorAll('svg').forEach((s) => s.setAttribute('aria-hidden', 'true'));
    }
    for (const c of root.querySelectorAll('canvas.spark:not([role])')) { c.setAttribute('role', 'img'); c.setAttribute('aria-label', 'Trend graph'); }
  };
  const mo = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) label(n); });
  const start = () => {
    const t = $('#toasts'); if (t) { t.setAttribute('aria-live', 'polite'); t.setAttribute('aria-atomic', 'false'); }
    label(document.body); mo.observe(document.body, { childList: true, subtree: true });
    // Keyboard users: show focus rings; pointer users: don't (CSS :focus-visible does most of it)
    document.addEventListener('keydown', (e) => { if (e.key === 'Tab') document.documentElement.classList.add('kbd-nav'); }, true);
    document.addEventListener('pointerdown', () => document.documentElement.classList.remove('kbd-nav'), true);
    // Elements that act like buttons but aren't (expandable widget tiles): Enter / Space activate
    document.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[role="button"][tabindex]')) { e.preventDefault(); e.target.click(); } });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();

// Images that should disappear when missing (CSP blocks inline error handlers, which
// is why broken store/home icons used to show the browser's broken-image glyph).
document.addEventListener('error', (e) => { const t = e.target; if (t && t.tagName === 'IMG' && t.hasAttribute('data-hide-broken')) t.style.display = 'none'; }, true);
