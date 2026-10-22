'use strict';
/* Umbrel-style app store: hero, categories, search, card grid, detail modal, Installed tab. */

const STORE_CATS = ['All', 'Media', 'Home', 'Network', 'Security', 'Dev', 'Tools'];
const storeIcon = (a) => `<img class="store-icon" src="/icons/apps/${esc(a.icon || a.id)}.svg" alt="" width="56" height="56" loading="lazy" onerror="this.style.display='none'">`;

Pages.apps = (el) => {
  el.innerHTML = `<div class="store">
    <div class="toolbar store-toolbar">
      <div class="tabs" data-main-tabs>
        <button data-mtab="browse" class="active">Browse</button>
        <button data-mtab="installed">Installed</button>
      </div>
      <input class="search" data-q placeholder="Search apps…" aria-label="Search apps">
      <div class="spacer"></div>
      <button data-refresh>${ICON.refresh} Refresh</button>
    </div>
    <div class="store-cats" data-cats></div>
    <div data-body><div class="empty"><span class="spinner"></span></div></div>
  </div>`;
  let apps = [], filter = '', cat = 'All', tab = 'browse';
  const body = $('[data-body]', el);
  const catsEl = $('[data-cats]', el);

  const paintCats = () => {
    catsEl.innerHTML = STORE_CATS.map((c) => `<button class="chip-btn ${c === cat ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('');
  };

  const card = (a) => `<article class="store-card card" data-detail="${esc(a.id)}">
      <div class="store-card-top">${storeIcon(a)}
        <div class="grow" style="min-width:0"><b>${mq(a.name)}</b>
          <div class="muted small ellipsis">${esc(a.blurb)}</div></div>
      </div>
      <div class="store-card-foot">
        <span class="chip plain">${esc(a.category)}</span>
        ${a.installed ? '<span class="chip ok">installed</span>' : ''}
        <span class="spacer"></span>
        ${a.installed
          ? `<button class="sm primary" data-open="${esc(a.id)}">Open</button>
             <button class="sm" data-stack="${esc(a.stack || a.id)}">Manage</button>`
          : (can('operator') ? `<button class="sm primary" data-install="${esc(a.id)}">${ICON.plus} Install</button>` : '')}
      </div>
    </article>`;

  const render = () => {
    paintCats();
    const f = filter.toLowerCase();
    let list = apps.filter((a) => {
      if (tab === 'installed' && !a.installed) return false;
      if (tab === 'browse' && cat !== 'All' && a.category !== cat) return false;
      if (!f) return true;
      return a.name.toLowerCase().includes(f) || a.category.toLowerCase().includes(f) || a.blurb.toLowerCase().includes(f) || a.id.includes(f);
    });
    if (tab === 'installed') {
      body.innerHTML = list.length
        ? `<div class="store-grid">${list.map(card).join('')}</div>`
        : `<div class="empty">No apps installed yet. Browse the store to install one.</div>`;
      return;
    }
    const featured = apps.filter((a) => a.featured && !a.installed).slice(0, 4);
    const hero = featured[0] || apps.find((a) => !a.installed) || apps[0];
    body.innerHTML = `
      ${hero ? `<section class="store-hero card" style="--hero:${esc(hero.color || '#7c5cff')}">
        <div class="store-hero-body">
          <div class="muted small">Featured</div>
          <h2>${esc(hero.name)}</h2>
          <p class="muted">${esc(hero.blurb)}</p>
          <div class="row" style="margin-top:12px;gap:8px">
            ${hero.installed
              ? `<button class="primary" data-open="${esc(hero.id)}">Open</button><button data-stack="${esc(hero.stack || hero.id)}">Manage stack</button>`
              : (can('operator') ? `<button class="primary" data-install="${esc(hero.id)}">${ICON.plus} Install</button>` : '')}
            <button data-detail="${esc(hero.id)}">Details</button>
          </div>
        </div>
        <div class="store-hero-icon">${storeIcon(hero)}</div>
      </section>` : ''}
      ${featured.length > 1 ? `<div class="store-featured">${featured.slice(1).map((a) => `
        <button type="button" class="store-feat card" data-detail="${esc(a.id)}">${storeIcon(a)}<span class="ellipsis"><b>${esc(a.name)}</b><span class="muted small">${esc(a.blurb)}</span></span></button>`).join('')}</div>` : ''}
      <h3 class="store-section-title">${cat === 'All' ? 'All apps' : esc(cat)} <span class="muted small">${list.length}</span></h3>
      <div class="store-grid">${list.map(card).join('') || '<div class="empty">No apps match</div>'}</div>`;
  };

  const detail = async (id) => {
    const a = apps.find((x) => x.id === id); if (!a) return;
    await modal({
      title: a.name, wide: true,
      body: `<div class="store-detail">
        <div class="row" style="gap:16px;align-items:flex-start;margin-bottom:16px">
          ${storeIcon(a)}
          <div class="grow"><div class="muted small">${esc(a.category)} · <span class="mono">${esc(a.image)}</span></div>
            <p style="margin:8px 0 0">${esc(a.blurb)}</p>
            ${a.installed ? '<span class="chip ok" style="margin-top:8px">installed</span>' : ''}
          </div>
        </div>
        <div class="grid cols-2">
          <div class="card"><div class="card-title">Ports</div>
            ${a.ports.map((p) => `<div class="row small"><span class="grow">${esc(p.label)}</span><span class="mono num">${esc(p.default)} → ${esc(p.container)}${p.protocol === 'udp' ? '/udp' : ''}</span></div>`).join('') || '<div class="muted">None</div>'}
          </div>
          <div class="card"><div class="card-title">Volumes</div>
            ${a.volumes.map((v) => `<div class="row small"><span class="grow">${esc(v.label)}</span><span class="mono small ellipsis">${esc(v.default)}</span></div>`).join('') || '<div class="muted">None</div>'}
          </div>
        </div>
        ${a.env && a.env.length ? `<div class="card" style="margin-top:12px"><div class="card-title">Environment</div>
          ${a.env.map((e) => `<div class="row small"><span class="grow">${esc(e.label)}</span><span class="mono small">${e.secret ? '••••' : esc(e.default || '—')}</span></div>`).join('')}</div>` : ''}
      </div>`,
      buttons: [
        { label: 'Close', value: null },
        a.installed
          ? { label: 'Manage stack', cls: 'primary', value: 'stack' }
          : (can('operator') ? { label: 'Configure & install', cls: 'primary', value: 'install' } : { label: 'Read-only', value: null }),
      ],
    }).then((v) => {
      if (v === 'stack') location.hash = '#/stacks/' + (a.stack || a.id);
      if (v === 'install') installApp(a);
    });
  };

  const installApp = async (app) => {
    const fields = [
      { name: 'name', label: 'Stack name', value: app.id },
      ...app.ports.map((p) => ({ name: 'port_' + p.key, label: `${p.label} (host port)`, value: String(p.default) })),
      ...app.volumes.map((v) => ({ name: 'vol_' + v.key, label: v.label + ' (host path)', value: v.default })),
      ...app.env.map((e) => ({ name: 'env_' + e.key, label: e.label, value: e.default || '', type: e.secret ? 'password' : 'text' })),
    ];
    const r = await formDlg(`Install ${app.name}`, fields, 'Install', {
      intro: app.ports.some((p) => p.warnConflict === 80) ? 'Note: this app often wants port 80, which Umbrel also uses. The default below avoids that.' : 'Review ports and paths, then install. Compose runs on the host under /var/lib/uiable/stacks.',
      handler: async (v) => {
        const body = { name: v.name, ports: {}, volumes: {}, env: {} };
        app.ports.forEach((p) => { body.ports[p.key] = Number(v['port_' + p.key]); });
        app.volumes.forEach((x) => { body.volumes[x.key] = v['vol_' + x.key]; });
        app.env.forEach((x) => { body.env[x.key] = v['env_' + x.key]; });
        const out = await POST(`/apps/${app.id}/install`, body);
        await watchJob(out.job, `Installing ${app.name}`);
        return out;
      },
    });
    if (r) load();
  };

  const load = async () => {
    try { apps = (await GET('/apps')).apps; render(); }
    catch (e) { body.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };

  $('[data-q]', el).oninput = (e) => { filter = e.target.value; render(); };
  $('[data-refresh]', el).onclick = load;
  catsEl.onclick = (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; cat = b.dataset.cat; render(); };
  $$('[data-mtab]', el).forEach((b) => b.onclick = () => {
    tab = b.dataset.mtab;
    $$('[data-mtab]', el).forEach((x) => x.classList.toggle('active', x === b));
    catsEl.style.display = tab === 'installed' ? 'none' : '';
    render();
  });

  body.onclick = async (e) => {
    const st = e.target.closest('[data-stack]'); if (st) { location.hash = '#/stacks/' + st.dataset.stack; return; }
    const op = e.target.closest('[data-open]');
    if (op) {
      const a = apps.find((x) => x.id === op.dataset.open);
      if (a && a.open) window.open(a.open, '_blank', 'noopener');
      else if (a && a.stack) location.hash = '#/stacks/' + a.stack;
      else toast('Open URL not available yet — manage the stack', true);
      return;
    }
    const un = e.target.closest('[data-uninstall]');
    if (un) {
      if (!(await confirmDlg('Uninstall ' + un.dataset.uninstall + '?', 'Containers will be stopped. Optionally remove volumes too.', { okLabel: 'Uninstall', danger: true }))) return;
      const r = await act(un, () => POST(`/apps/${un.dataset.uninstall}/uninstall`, { removeVolumes: false }));
      if (r) { await watchJob(r.job, 'Uninstalling'); load(); }
      return;
    }
    const det = e.target.closest('[data-detail]');
    if (det && !e.target.closest('[data-install],[data-open],[data-stack]')) { detail(det.dataset.detail); return; }
    const ins = e.target.closest('[data-install]'); if (!ins) return;
    const app = apps.find((a) => a.id === ins.dataset.install);
    if (app) installApp(app);
  };
  load();
};
