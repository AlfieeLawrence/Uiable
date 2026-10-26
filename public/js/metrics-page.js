'use strict';
Pages.metrics = (el) => {
  el.innerHTML = `<div class="toolbar">
    <select data-hours style="width:auto"><option value="6">6 hours</option><option value="24" selected>24 hours</option><option value="72">3 days</option><option value="168">7 days</option></select>
    <label class="row muted small" style="gap:6px">Keep
      <input type="number" data-retain min="1" max="90" style="width:64px" title="Retention days"> days
    </label>
    <button class="sm" data-save-ret>Save</button>
    <button data-ref>${ICON.refresh}</button>
    <span class="spacer"></span><span class="muted small" data-meta></span>
  </div><div data-body><div class="empty"><span class="spinner"></span></div></div>`;
  const body = $('[data-body]', el);
  const loadSettings = async () => {
    try {
      const s = await GET('/metrics/settings');
      $('[data-retain]', el).value = String(s.retainDays || 7);
    } catch (_) {}
  };
  const load = async () => {
    const hours = Number($('[data-hours]', el).value) || 24;
    try {
      const r = await GET('/metrics/history?hours=' + hours);
      $('[data-meta]', el).textContent = `${r.points} points · keep ${r.retainDays}d · every ${r.intervalSec}s · ${r.backend || 'sqlite'}`;
      if (!r.samples.length) { body.innerHTML = '<div class="empty">No samples yet — history builds as the server runs.</div>'; return; }
      const spark = (key, color) => {
        const vals = r.samples.map((s) => s[key]).filter((x) => x != null);
        if (!vals.length) return '<div class="muted small">No data</div>';
        const max = Math.max(100, ...vals);
        const w = 600, h = 80;
        const pts = r.samples.map((s, i) => {
          const v = s[key]; if (v == null) return null;
          const x = (i / Math.max(1, r.samples.length - 1)) * w;
          const y = h - (v / max) * (h - 4) - 2;
          return `${x},${y}`;
        }).filter(Boolean).join(' ');
        return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="80" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>
          <div class="muted small">last ${vals[vals.length - 1] != null ? Number(vals[vals.length - 1]).toFixed(1) : '—'} · max ${Math.max(...vals).toFixed(1)}</div>`;
      };
      body.innerHTML = `<div class="grid cols-2">
        <div class="card"><div class="card-title">CPU %</div>${spark('cpu', '#7c5cff')}</div>
        <div class="card"><div class="card-title">Memory %</div>${spark('mem', '#22c1c3')}</div>
        <div class="card"><div class="card-title">Disk %</div>${spark('disk', '#14b8a6')}</div>
        <div class="card"><div class="card-title">GPU %</div>${spark('gpu', '#a78bfa')}</div>
        <div class="card"><div class="card-title">CPU temp °C</div>${spark('temp', '#f59e0b')}</div>
        <div class="card"><div class="card-title">Load 1m</div>${spark('load1', '#f472b6')}</div>
      </div>`;
    } catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $('[data-hours]', el).onchange = load;
  $('[data-ref]', el).onclick = load;
  $('[data-save-ret]', el).onclick = async () => {
    const retainDays = Number($('[data-retain]', el).value) || 7;
    await act(null, () => api('PUT', '/metrics/settings', { retainDays }), 'Retention saved');
    load();
  };
  loadSettings().then(load);
};
