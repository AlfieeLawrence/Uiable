'use strict';
/* Home edit mode: add / remove / resize / rearrange tiles + customise dock. Lazy-loaded. */

const HomeEdit = {
  async enter(el, onDone) {
    if (Home.editing || $('.home-edit-bar', el)) return; // already mounted
    Home.editing = true;
    let layout = JSON.parse(JSON.stringify(await loadHomeLayout()));
    const bar = document.createElement('div');
    bar.className = 'home-edit-bar';
    bar.innerHTML = `
      <button class="primary" data-done>Done</button>
      <button data-add>${ICON.plus} Add tile</button>
      <button data-dock>Edit dock</button>
      <button data-reset>Reset to default</button>
      <button data-export>Export</button>
      <button data-import>Import</button>
      <span class="spacer"></span>
      <span class="muted small">Drag tiles to rearrange · click a tile to edit</span>`;
    el.prepend(bar);
    el.classList.add('home-editing');
    const grid = $('[data-home-grid]', el);
    paintHomeGrid(el, layout);
    decorateEdit(grid, layout);

    const finish = async (save) => {
      Home.editing = false;
      el.classList.remove('home-editing');
      bar.remove();
      if (save) {
        try { Home.layout = (await PUT('/layout', layout)).layout; State.layout = Home.layout; toast('Home saved'); }
        catch (e) { toastErr(e); }
      }
      if (onDone) await onDone();
    };

    bar.onclick = async (e) => {
      if (e.target.closest('[data-done]')) return finish(true);
      if (e.target.closest('[data-reset]')) {
        if (!(await confirmDlg('Reset home layout?', 'Replace your home and dock with the default layout.', { okLabel: 'Reset', danger: true }))) return;
        layout = (await POST('/layout/reset')).layout;
        Home.layout = layout; State.layout = layout;
        paintHomeGrid(el, layout); decorateEdit(grid, layout); toast('Reset');
        return;
      }
      if (e.target.closest('[data-export]')) {
        const blob = new Blob([JSON.stringify(layout, null, 2)], { type: 'application/json' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'uiable-home.json'; a.click();
        return;
      }
      if (e.target.closest('[data-import]')) {
        const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'application/json,.json';
        inp.onchange = async () => {
          try {
            const text = await inp.files[0].text();
            layout = JSON.parse(text);
            paintHomeGrid(el, layout); decorateEdit($('[data-home-grid]', el), layout);
            toast('Imported — tap Done to save');
          } catch (err) { toastErr(err); }
        };
        inp.click();
        return;
      }
      if (e.target.closest('[data-add]')) {
        const t = await addTileDlg();
        if (!t) return;
        // place at end
        const maxY = layout.tiles.reduce((m, x) => Math.max(m, (x.y || 0) + (x.h || 1)), 0);
        t.x = 0; t.y = maxY; t.id = t.id || Math.random().toString(16).slice(2, 10);
        layout.tiles.push(t);
        paintHomeGrid(el, layout); decorateEdit($('[data-home-grid]', el), layout);
        return;
      }
      if (e.target.closest('[data-dock]')) {
        layout.dock = await editDockDlg(layout.dock || []);
        return;
      }
    };

    grid.onclick = async (e) => {
      const tileEl = e.target.closest('[data-tid]');
      if (!tileEl) return;
      const id = tileEl.dataset.tid;
      const tile = layout.tiles.find((x) => x.id === id);
      if (!tile) return;
      if (e.target.closest('[data-rm]')) {
        layout.tiles = layout.tiles.filter((x) => x.id !== id);
        paintHomeGrid(el, layout); decorateEdit($('[data-home-grid]', el), layout);
        return;
      }
      if (e.target.closest('[data-sz]')) {
        const order = ['1x1', '2x1', '2x2'];
        const cur = `${tile.w || 1}x${tile.h || 1}`;
        const next = order[(order.indexOf(cur) + 1) % order.length];
        const [w, h] = next.split('x').map(Number);
        tile.w = w; tile.h = h;
        paintHomeGrid(el, layout); decorateEdit($('[data-home-grid]', el), layout);
        return;
      }
      const edited = await editTileDlg(tile);
      if (edited) {
        Object.assign(tile, edited);
        paintHomeGrid(el, layout); decorateEdit($('[data-home-grid]', el), layout);
      }
    };

    enableDragReorder(grid, layout, el);
  },
};

function decorateEdit(grid, layout) {
  if (!grid) return;
  $$('[data-tid]', grid).forEach((el) => {
    el.classList.add('editing');
    if (!el.querySelector('.tile-edit-tools')) {
      const tools = document.createElement('div');
      tools.className = 'tile-edit-tools';
      const sz = `${(el.className.match(/size-(\dx\d)/) || [])[1] || '1x1'}`;
      tools.innerHTML = `<span class="tile-drag" title="Drag to move">⠿</span><span class="spacer"></span><button type="button" class="tool-btn" data-sz title="Resize (1x1 → 2x1 → 2x2)">${sz}</button><button type="button" class="tool-btn danger" data-rm title="Remove">${ICON.trash}</button>`;
      el.appendChild(tools);
      const handle = document.createElement('button');
      handle.type = 'button'; handle.className = 'tile-resize'; handle.dataset.sz = '1'; handle.title = 'Resize';
      handle.innerHTML = '<svg viewBox="0 0 12 12"><path d="M11 3 3 11M11 7 7 11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/></svg>';
      el.appendChild(handle);
      const hint = document.createElement('span');
      hint.className = 'tile-hint'; hint.textContent = 'Click to edit name / icon';
      el.appendChild(hint);
    }
    el.draggable = true;
  });
}

function enableDragReorder(grid, layout, root) {
  let dragId = null;
  grid.ondragstart = (e) => {
    const t = e.target.closest('[data-tid]');
    if (!t) return;
    dragId = t.dataset.tid;
    e.dataTransfer.effectAllowed = 'move';
    t.classList.add('dragging');
  };
  grid.ondragend = (e) => { $$('.dragging', grid).forEach((x) => x.classList.remove('dragging')); };
  grid.ondragover = (e) => { e.preventDefault(); };
  grid.ondrop = (e) => {
    e.preventDefault();
    const over = e.target.closest('[data-tid]');
    if (!dragId || !over || over.dataset.tid === dragId) return;
    const from = layout.tiles.findIndex((t) => t.id === dragId);
    const to = layout.tiles.findIndex((t) => t.id === over.dataset.tid);
    if (from < 0 || to < 0) return;
    const [item] = layout.tiles.splice(from, 1);
    layout.tiles.splice(to, 0, item);
    // reflow y/x sequentially on 8-col grid
    reflowTiles(layout.tiles);
    paintHomeGrid(root, layout);
    decorateEdit($('[data-home-grid]', root), layout);
  };
}

function reflowTiles(tiles) {
  let x = 0, y = 0, rowH = 1;
  const cols = 8;
  tiles.forEach((t) => {
    const w = t.w || 1, h = t.h || 1;
    if (x + w > cols) { x = 0; y += rowH; rowH = 1; }
    t.x = x; t.y = y;
    x += w; rowH = Math.max(rowH, h);
  });
}

async function addTileDlg() {
  const kind = await modal({
    title: 'Add tile',
    body: `<div class="grid cols-2" style="gap:8px">
      ${[['app', 'Built-in app'], ['widget', 'Widget'], ['container', 'Docker container'], ['stack', 'Compose stack'], ['script', 'Script'], ['folder', 'File location'], ['link', 'Custom URL']].map(([k, l]) =>
        `<button data-k="${k}" class="card" style="text-align:left;cursor:pointer"><b>${esc(l)}</b></button>`).join('')}
    </div>`,
    buttons: [{ label: 'Cancel', value: null }],
    onOpen: (m, close) => {
      m.onclick = (e) => { const b = e.target.closest('[data-k]'); if (b) close(b.dataset.k); };
    },
  });
  if (!kind) return null;
  if (kind === 'app') {
    const opts = visibleApps().map((a) => a.id);
    const f = await formDlg('App shortcut', [
      { name: 'app', label: 'App', type: 'select', options: opts, value: opts[0] },
      { name: 'name', label: 'Display name (optional)' },
      { name: 'size', label: 'Size', type: 'select', options: ['1x1', '2x1', '2x2'], value: '1x1' },
      { name: 'color', label: 'Colour', value: '' },
    ], 'Add');
    if (!f) return null;
    const [w, h] = f.size.split('x').map(Number);
    return { type: 'app', app: f.app, name: f.name, w, h, color: f.color };
  }
  if (kind === 'widget') {
    const widgets = ['cpu', 'mem', 'disk', 'net', 'clock', 'uptime', 'containers', 'processes', 'notes', 'audit', 'updates', 'storage'];
    const f = await formDlg('Widget', [
      { name: 'widget', label: 'Widget', type: 'select', options: widgets, value: 'cpu' },
      { name: 'name', label: 'Display name (optional)' },
      { name: 'size', label: 'Size', type: 'select', options: ['1x1', '2x1', '2x2'], value: '2x1' },
      { name: 'color', label: 'Colour', value: '' },
      { name: 'text', label: 'Note text (for notes widget)', value: '' },
    ], 'Add');
    if (!f) return null;
    const [w, h] = f.size.split('x').map(Number);
    return { type: 'widget', widget: f.widget, name: f.name, w, h, color: f.color, text: f.text };
  }
  if (kind === 'folder') {
    const f = await formDlg('File location', [
      { name: 'path', label: 'Path', value: '/' },
      { name: 'name', label: 'Display name', value: 'Files' },
      { name: 'size', label: 'Size', type: 'select', options: ['1x1', '2x1'], value: '1x1' },
    ], 'Add');
    if (!f) return null;
    const [w, h] = f.size.split('x').map(Number);
    return { type: 'folder', path: f.path, name: f.name, w, h, icon: 'folder', iconKind: 'pack' };
  }
  if (kind === 'link') {
    const f = await formDlg('Custom URL', [
      { name: 'url', label: 'URL', value: 'https://' },
      { name: 'name', label: 'Display name', value: 'Link' },
      { name: 'size', label: 'Size', type: 'select', options: ['1x1', '2x1'], value: '1x1' },
    ], 'Add');
    if (!f) return null;
    const [w, h] = f.size.split('x').map(Number);
    return { type: 'link', url: f.url, name: f.name, w, h, icon: 'link', iconKind: 'pack' };
  }
  if (kind === 'script') {
    if (!can('admin')) { toast('Admin only', true); return null; }
    let scripts = [];
    try { scripts = (await GET('/scripts')).scripts.map((s) => s.id); } catch (_) {}
    if (!scripts.length) { toast('No scripts yet', true); return null; }
    const f = await formDlg('Script', [
      { name: 'ref', label: 'Script', type: 'select', options: scripts },
      { name: 'name', label: 'Display name (optional)' },
    ], 'Add');
    if (!f) return null;
    return { type: 'script', ref: f.ref, name: f.name || f.ref, w: 1, h: 1, icon: 'terminal', iconKind: 'pack' };
  }
  if (kind === 'container') {
    let names = [];
    try {
      const r = await GET('/docker/containers');
      names = (r.containers || []).map((c) => (c.Names && c.Names[0] || '').replace(/^\//, '') || c.Id.slice(0, 12));
    } catch (e) { toastErr(e); return null; }
    if (!names.length) { toast('No containers', true); return null; }
    const f = await formDlg('Container', [
      { name: 'ref', label: 'Container', type: 'select', options: names },
      { name: 'name', label: 'Display name (optional)' },
    ], 'Add');
    if (!f) return null;
    return { type: 'container', ref: f.ref, name: f.name || f.ref, w: 1, h: 1, icon: 'docker', iconKind: 'pack' };
  }
  if (kind === 'stack') {
    let names = [];
    try { names = ((await GET('/stacks')).stacks || []).map((s) => s.name); } catch (e) { toastErr(e); return null; }
    if (!names.length) { toast('No stacks', true); return null; }
    const f = await formDlg('Stack', [
      { name: 'ref', label: 'Stack', type: 'select', options: names },
      { name: 'name', label: 'Display name (optional)' },
    ], 'Add');
    if (!f) return null;
    return { type: 'stack', ref: f.ref, name: f.name || f.ref, w: 1, h: 1, icon: 'layers', iconKind: 'pack' };
  }
  return null;
}

const EMOJI = '🏠 📁 🎬 🎵 📷 🖼️ 🎮 📚 💾 🖥️ 🛠️ ⚙️ 🔒 🔑 🌐 ☁️ 📦 🐳 🚀 ⭐ ❤️ 🔥 ⚡ 💡 📈 📊 🕒 📅 ✉️ 💬 🛒 💰 🧪 🧰 🗂️ 📝 🔔 🎧 📺 🏡'.split(' ');
let iconIndex = null;
async function loadIconIndex() {
  if (iconIndex) return iconIndex;
  try { iconIndex = await (await fetch('/icons/pack/index.json')).json(); } catch (_) { iconIndex = { icons: [], categories: {} }; }
  return iconIndex;
}
const iconPrev = (kind, icon) => kind === 'pack' && icon ? `<img src="/icons/pack/${esc(icon)}.svg" alt="">`
  : kind === 'emoji' && icon ? esc(icon) : kind === 'upload' && icon ? `<img src="${esc(icon)}" alt="" style="width:30px;height:30px;border-radius:8px">` : '<span class="muted small">auto</span>';

/** Searchable icon picker (pack icons by category, emoji, upload, auto). Writes hidden inputs icon / iconKind. */
function iconPickerHtml(tile) {
  return `<div class="field"><span>Icon</span>
    <button type="button" class="ip-current" data-ip-toggle aria-expanded="false"><span class="ip-prev" data-ip-prev>${iconPrev(tile.iconKind || (tile.icon ? 'pack' : ''), tile.icon)}</span>
      <span class="grow" style="text-align:left"><b data-ip-label>${esc(tile.icon && !String(tile.icon).startsWith('/api/') ? tile.icon : tile.icon ? 'Uploaded image' : 'Automatic')}</b><div class="muted small">Click to choose · search ${'&'} categories</div></span>${ICON.chevronDown || '▾'}</button>
    <div class="ip-panel" data-ip-panel hidden>
      <div class="ip-head"><input type="search" data-ip-q placeholder="Search icons (e.g. disk, music, lock)" autocomplete="off"><button type="button" class="sm" data-ip-upload>${ICON.upload || ''} Upload</button><button type="button" class="sm" data-ip-auto>Auto</button></div>
      <div class="ip-cats" data-ip-cats></div>
      <div class="ip-grid" data-ip-grid></div>
    </div></div>`;
}
async function bindIconPicker(m, tile) {
  const idx = await loadIconIndex();
  const cats = Object.assign({ All: idx.icons }, idx.categories || {}, { Emoji: EMOJI });
  let cat = 'All', q = '';
  const kindIn = $('[name=iconKind]', m), iconIn = $('[name=icon]', m), panel = $('[data-ip-panel]', m), grid = $('[data-ip-grid]', m);
  const set = (kind, icon, label) => {
    kindIn.value = kind; iconIn.value = icon;
    $('[data-ip-prev]', m).innerHTML = iconPrev(kind, icon);
    $('[data-ip-label]', m).textContent = label || icon || 'Automatic';
    paint();
  };
  const paintCats = () => { $('[data-ip-cats]', m).innerHTML = Object.keys(cats).map((c) => `<button type="button" class="${c === cat ? 'active' : ''}" data-ip-cat="${esc(c)}">${esc(c)} <span class="muted">${cats[c].length}</span></button>`).join(''); };
  const paint = () => {
    const ql = q.trim().toLowerCase();
    const emoji = cat === 'Emoji';
    let list = emoji ? EMOJI : cats[cat];
    if (ql) list = (emoji ? EMOJI : idx.icons).filter((n) => emoji || n.includes(ql) || Object.entries(idx.categories || {}).some(([c, l]) => c.toLowerCase().includes(ql) && l.includes(n)));
    grid.innerHTML = list.length ? list.map((n) => emoji
      ? `<button type="button" data-ip-emoji="${esc(n)}" class="${iconIn.value === n ? 'sel' : ''}" title="${esc(n)}"><span class="em">${esc(n)}</span></button>`
      : `<button type="button" data-ip-pick="${esc(n)}" class="${kindIn.value === 'pack' && iconIn.value === n ? 'sel' : ''}"><img src="/icons/pack/${esc(n)}.svg" alt="" loading="lazy">${mq(n)}</button>`).join('')
      : '<div class="muted small" style="grid-column:1/-1;padding:10px">No icons match. Try another word, or upload your own.</div>';
  };
  paintCats(); paint();
  m.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.closest('[data-ip-toggle]')) { panel.hidden = !panel.hidden; t.closest('[data-ip-toggle]').setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden) $('[data-ip-q]', m).focus(); return; }
    const c = t.closest('[data-ip-cat]'); if (c) { cat = c.dataset.ipCat; paintCats(); paint(); return; }
    const p = t.closest('[data-ip-pick]'); if (p) { set('pack', p.dataset.ipPick); return; }
    const em = t.closest('[data-ip-emoji]'); if (em) { set('emoji', em.dataset.ipEmoji); return; }
    if (t.closest('[data-ip-auto]')) { set('', '', 'Automatic'); return; }
    if (t.closest('[data-ip-upload]')) { const url = await uploadTileIcon(); if (url) set('upload', url, 'Uploaded image'); }
  });
  $('[data-ip-q]', m).addEventListener('input', (e) => { q = e.target.value; paint(); });
  $('[data-ip-q]', m).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); const first = $('[data-ip-pick],[data-ip-emoji]', grid); if (first) first.click(); } });
}

async function editTileDlg(tile) {
  const fields = [
    { name: 'name', label: 'Display name', value: tile.name || '' },
    { name: 'size', label: 'Size', type: 'select', options: ['1x1', '2x1', '2x2'], value: `${tile.w || 1}x${tile.h || 1}` },
    { name: 'color', label: 'Colour (hex or empty)', value: tile.color || '' },
    { name: 'pickerUi', type: 'html', html: iconPickerHtml(tile) },
    { name: 'iconKind', type: 'hidden', value: tile.iconKind || (tile.icon ? 'pack' : '') },
    { name: 'icon', type: 'hidden', value: tile.icon || '' },
  ];
  if (tile.type === 'widget' && tile.widget === 'notes') fields.push({ name: 'text', label: 'Note text', value: tile.text || '' });
  if (tile.type === 'folder') fields.push({ name: 'path', label: 'Path', value: tile.path || '/' });
  if (tile.type === 'link') fields.push({ name: 'url', label: 'URL', value: tile.url || '' });
  const f = await formDlg('Edit tile', fields, 'Save', { onOpen: (m) => { bindIconPicker(m, tile); } });
  if (!f) return null;
  const [w, h] = f.size.split('x').map(Number);
  const out = { name: f.name, w, h, color: f.color, icon: f.icon, iconKind: f.iconKind };
  if (f.text != null) out.text = f.text;
  if (f.path != null) out.path = f.path;
  if (f.url != null) out.url = f.url;
  return out;
}

function uploadTileIcon() {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*,.svg';
    inp.onchange = async () => {
      if (!inp.files[0]) return resolve(null);
      const fd = new FormData();
      fd.append('file', inp.files[0]);
      try {
        const res = await fetch('/api/layout/icon', { method: 'POST', headers: { 'X-CSRF-Token': State.csrf || '' }, body: fd, credentials: 'same-origin' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        resolve(data.url);
      } catch (e) { toastErr(e); resolve(null); }
    };
    inp.click();
  });
}

async function editDockDlg(dock) {
  let current = dock.slice();
  const bodyHtml = () => `<p class="muted small">Home and All apps stay pinned. Drag to reorder the rest.</p>
    <div data-dock-list>${current.map((d, i) => `<div class="list-item" draggable="true" data-i="${i}">
      <span class="grow"><b>${esc(d.type)}</b> ${esc(d.app || d.ref || d.path || d.url || '')} ${d.name ? '· ' + esc(d.name) : ''}</span>
      ${d.type === 'home' || d.type === 'launcher' ? '<span class="chip plain">pinned</span>' : `<button class="sm danger" data-del="${i}">${ICON.trash}</button>`}
    </div>`).join('')}</div>
    <div class="row wrap" style="margin-top:12px">
      <button data-add-app class="sm">${ICON.plus} App</button>
      <button data-add-link class="sm">${ICON.plus} Link</button>
      <button data-add-folder class="sm">${ICON.plus} Folder</button>
      <button data-add-theme class="sm">${ICON.plus} Theme toggle</button>
    </div>`;

  const ok = await modal({
    title: 'Customise dock', wide: true,
    body: bodyHtml(),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', cls: 'primary', value: true }],
    onOpen: (m) => {
      const bind = () => {
        let drag = null;
        $$('[data-i]', m).forEach((row) => {
          row.ondragstart = () => { drag = +row.dataset.i; };
          row.ondragover = (e) => e.preventDefault();
          row.ondrop = () => {
            const to = +row.dataset.i;
            if (drag == null || drag === to) return;
            const [it] = current.splice(drag, 1);
            current.splice(to, 0, it);
            // keep home/launcher at front
            const home = current.filter((d) => d.type === 'home');
            const launch = current.filter((d) => d.type === 'launcher');
            const rest = current.filter((d) => d.type !== 'home' && d.type !== 'launcher');
            current.splice(0, current.length, ...(home.length ? home.slice(0, 1) : [{ type: 'home' }]), ...(launch.length ? launch.slice(0, 1) : [{ type: 'launcher' }]), ...rest);
            $('[data-dock-list]', m).parentElement.innerHTML = bodyHtml();
            bind();
          };
        });
        m.querySelectorAll('[data-del]').forEach((b) => b.onclick = () => {
          current.splice(+b.dataset.del, 1);
          $('[data-dock-list]', m).parentElement.innerHTML = bodyHtml();
          bind();
        });
        const add = (item) => { current.push(item); $('[data-dock-list]', m).parentElement.innerHTML = bodyHtml(); bind(); };
        const addApp = $('[data-add-app]', m);
        if (addApp) addApp.onclick = async () => {
          const opts = visibleApps().map((a) => a.id);
          const f = await formDlg('Dock app', [{ name: 'app', label: 'App', type: 'select', options: opts }]);
          if (f) add({ type: 'app', app: f.app });
        };
        const addLink = $('[data-add-link]', m);
        if (addLink) addLink.onclick = async () => {
          const f = await formDlg('Dock link', [{ name: 'url', label: 'URL', value: 'https://' }, { name: 'name', label: 'Name', value: 'Link' }]);
          if (f) add({ type: 'link', url: f.url, name: f.name, icon: 'link', iconKind: 'pack' });
        };
        const addFolder = $('[data-add-folder]', m);
        if (addFolder) addFolder.onclick = async () => {
          const f = await formDlg('Dock folder', [{ name: 'path', label: 'Path', value: '/' }, { name: 'name', label: 'Name', value: 'Files' }]);
          if (f) add({ type: 'folder', path: f.path, name: f.name, icon: 'folder', iconKind: 'pack' });
        };
        const addTheme = $('[data-add-theme]', m);
        if (addTheme) addTheme.onclick = () => {
          if (!current.some((d) => d.type === 'theme')) add({ type: 'theme' });
        };
      };
      bind();
      return null;
    },
  });
  return ok ? current : dock;
}
