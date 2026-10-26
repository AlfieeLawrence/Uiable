'use strict';
/* File manager (SFTP-style): browse, drag-and-drop upload, download, edit, rename, chmod, delete. */
const joinPath = (dir, name) => (dir === '/' ? '' : dir) + '/' + name;
const parentPath = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+$/, '') || '/');
function permString(type, mode) {
  const m = parseInt(mode, 8); const t = type === 'dir' ? 'd' : type === 'link' ? 'l' : '-';
  let s = '';
  for (let i = 2; i >= 0; i--) { const b = (m >> (i * 3)) & 7; s += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-'); }
  return t + s;
}

// Collect files (with relative paths) from a drop event, including whole folders.
async function filesFromDrop(dt) {
  const out = [];
  const items = Array.from(dt.items || []).filter((i) => i.kind === 'file');
  const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!entries.some(Boolean)) return Array.from(dt.files).map((f) => ({ file: f, path: f.name }));
  const readAll = (reader) => new Promise((res, rej) => { const all = []; const next = () => reader.readEntries((ents) => { if (!ents.length) return res(all); all.push(...ents); next(); }, rej); next(); });
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + entry.name });
    } else if (entry.isDirectory) {
      const kids = await readAll(entry.createReader());
      if (!kids.length) out.push({ dir: true, path: prefix + entry.name });
      for (const k of kids) await walk(k, prefix + entry.name + '/');
    }
  };
  for (const e of entries) if (e) await walk(e, '');
  return out;
}


async function filesSudoSaved() {
  try { return !!(await GET('/files/sudo')).saved; } catch (_) { return false; }
}
async function ensureFilesSudoPw() {
  if (await filesSudoSaved()) return true;
  // Probe: try passwordless by asking user only when needed — prompt first.
  const r = await formDlg('sudo password', [
    { name: 'password', label: 'Host sudo password', type: 'password', placeholder: 'Saved for this browser session only' },
    { name: 'remember', type: 'checkbox', label: 'Keep for this session', checked: true },
  ], 'Save', { intro: 'Needed to browse or edit paths your user cannot access. Never written to the audit log.' });
  if (!r || !r.password) return false;
  await POST('/files/sudo', { password: r.password });
  toast('sudo password saved for this session');
  return true;
}
function sudoQS(on) { return on ? '&sudo=1' : ''; }

const Uploads = {
  el: null,
  show(text, pct) {
    if (!this.el) { this.el = document.createElement('div'); this.el.className = 'card progress'; document.body.appendChild(this.el); }
    this.el.innerHTML = `<div class="row small" style="margin-bottom:8px"><b class="grow ellipsis">${esc(text)}</b><span>${pct.toFixed(0)}%</span></div>${bar(pct)}`;
  },
  hide() { if (this.el) { this.el.remove(); this.el = null; } },
};

function uploadBatch(dir, batch, overwrite, onProgress, useSudo) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    batch.forEach((b) => fd.append('files', b.file, b.path));
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload?path=${encodeURIComponent(dir)}${overwrite ? '&overwrite=1' : ''}${useSudo ? '&sudo=1' : ''}`);
    xhr.setRequestHeader('X-CSRF-Token', State.csrf || '');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    xhr.onload = () => { let d = {}; try { d = JSON.parse(xhr.responseText); } catch (_) {} if (xhr.status < 300) resolve(d); else reject(new ApiError(d.error || `Upload failed (${xhr.status})`, xhr.status, d)); };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(fd);
  });
}

async function uploadAll(dir, entries, existing, useSudo) {
  const files = entries.filter((e) => e.file);
  const dirs = entries.filter((e) => e.dir);
  if (!files.length && !dirs.length) return false;
  const tops = new Set(entries.map((e) => e.path.split('/')[0]));
  const clash = [...tops].filter((n) => existing.has(n));
  let overwrite = false;
  if (clash.length) {
    const r = await modal({ title: 'Some items already exist', body: `<p><b>${esc(clash.slice(0, 5).join(', '))}${clash.length > 5 ? ` and ${clash.length - 5} more` : ''}</b> already exist here.</p><p class="muted">Overwrite replaces existing files with the same name (folders are merged).</p>`, buttons: [{ label: 'Cancel', value: null }, { label: 'Overwrite', cls: 'danger solid', value: 'over' }] });
    if (!r) return false;
    overwrite = true;
  }
  for (const d of dirs) { try { await POST('/files/mkdir', { path: dir, name: d.path, recursive: true }); } catch (_) {} }
  const total = files.reduce((a, f) => a + f.file.size, 0) || 1;
  let sent = 0;
  // batch by count and size so huge folders don't become one giant request
  const batches = []; let cur = []; let curSize = 0;
  for (const f of files) { if (cur.length && (cur.length >= 100 || curSize + f.file.size > 256 * 1024 * 1024)) { batches.push(cur); cur = []; curSize = 0; } cur.push(f); curSize += f.file.size; }
  if (cur.length) batches.push(cur);
  try {
    for (const b of batches) {
      const bs = b.reduce((a, f) => a + f.file.size, 0);
      await uploadBatch(dir, b, overwrite, (loaded) => Uploads.show(`Uploading ${files.length} file${files.length === 1 ? '' : 's'}…`, ((sent + Math.min(loaded, bs)) / total) * 100), useSudo);
      sent += bs;
    }
    Uploads.hide();
    toast(`Uploaded ${files.length} file${files.length === 1 ? '' : 's'}${dirs.length ? ` and ${dirs.length} empty folder(s)` : ''}`);
  } catch (e) { Uploads.hide(); toastErr(e); }
  return true;
}

async function openEditor(path, onSaved, useSudo) {
  let r;
  const sudo = !!useSudo;
  try { r = await GET(`/files/read?path=${encodeURIComponent(path)}${sudoQS(sudo)}`); } catch (e) {
    if (await confirmDlg('Cannot edit this file', `${esc(e.message)}. Download it instead?`, { okLabel: 'Download' })) downloadPath(path, sudo);
    return;
  }
  let dirty = false;
  const save = async (m, asSudo) => {
    await POST('/files/write', { path, content: $('textarea', m).value, sudo: !!asSudo });
    dirty = false; toast((asSudo ? 'Saved with sudo: ' : 'Saved ') + path.split('/').pop()); if (onSaved) onSaved(); return false;
  };
  await modal({
    title: path, full: true, dismissable: false,
    body: `<textarea class="editor" spellcheck="false"></textarea>`,
    buttons: [
      { label: 'Close', value: null },
      { label: 'Save as sudo', handler: async (m) => { if (!(await ensureFilesSudoPw())) return false; return save(m, true); }, keepOpenOnError: true },
      { label: 'Save  (Ctrl+S)', cls: 'primary', handler: (m) => save(m, false), keepOpenOnError: true },
    ],
    onOpen: (m, close) => {
      const ta = $('textarea', m); ta.value = r.content;
      ta.oninput = () => { dirty = true; };
      ta.onkeydown = (e) => {
        if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('\t', s, ta.selectionEnd, 'end'); dirty = true; }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); act(null, () => save(m, false)); }
      };
      const x = $('[data-x]', m); const closeBtn = $('footer button[data-i="0"]', m);
      const guarded = async () => { if (!dirty || await confirmDlg('Discard changes?', 'You have unsaved changes.', { okLabel: 'Discard', danger: true })) close(null); };
      x.onclick = guarded; closeBtn.onclick = guarded;
      // Split-style: turn "Save as sudo" + Save into a dropdown beside Save
      const footer = $('footer', m);
      const sudoBtn = footer && footer.querySelector('button[data-i="1"]');
      const saveBtn = footer && footer.querySelector('button[data-i="2"]');
      if (sudoBtn && saveBtn) {
        const wrap = document.createElement('div'); wrap.className = 'split-btn';
        const caret = document.createElement('button'); caret.type = 'button'; caret.className = 'primary split-caret'; caret.title = 'More save options'; caret.textContent = '▾';
        const menu = document.createElement('div'); menu.className = 'split-menu hidden';
        sudoBtn.classList.remove('hidden');
        menu.appendChild(sudoBtn);
        saveBtn.replaceWith(wrap);
        wrap.appendChild(saveBtn); wrap.appendChild(caret); wrap.appendChild(menu);
        caret.onclick = (e) => { e.stopPropagation(); menu.classList.toggle('hidden'); };
        m.addEventListener('click', (e) => { if (!e.target.closest('.split-btn')) menu.classList.add('hidden'); });
      }
    },
  });
}

function downloadPath(p, useSudo) {
  const a = document.createElement('a');
  a.href = `/api/files/download?path=${encodeURIComponent(p)}${sudoQS(!!useSudo)}`;
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}

async function chmodDlg(item, path, reload) {
  const m0 = item.mode.slice(-3);
  const who = ['Owner', 'Group', 'Others']; const what = [['r', 4, 'Read'], ['w', 2, 'Write'], ['x', 1, 'Execute']];
  const r = await modal({
    title: 'Permissions · ' + item.name,
    body: `<table style="margin-bottom:14px"><thead><tr><th></th>${what.map((w) => `<th>${w[2]}</th>`).join('')}</tr></thead><tbody>${who.map((w, i) => `<tr><td>${w}</td>${what.map(([, bit]) => `<td><input type="checkbox" data-b="${i}" data-v="${bit}" ${(+m0[i] & bit) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table>
      <label class="field"><span>Octal mode</span><input data-oct value="${esc(item.mode)}" class="mono"></label>
      <p class="muted small">Owner: ${esc(item.owner)} · Group: ${esc(item.group)}</p>
      ${item.type === 'dir' ? '<label class="row"><input type="checkbox" data-rec> Apply recursively to everything inside</label>' : ''}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Apply', cls: 'primary', value: (m) => ({ mode: $('[data-oct]', m).value.trim(), recursive: !!($('[data-rec]', m) || {}).checked }) }],
    onOpen: (m) => {
      const oct = $('[data-oct]', m);
      const special = item.mode.length === 4 ? item.mode[0] : '0';
      const sync = () => { const d = [0, 1, 2].map((i) => $$(`[data-b="${i}"]`, m).reduce((a, c) => a + (c.checked ? +c.dataset.v : 0), 0)); oct.value = special + d.join(''); };
      $$('[data-b]', m).forEach((c) => (c.onchange = sync));
      oct.oninput = () => { const v = oct.value.trim().slice(-3); if (/^[0-7]{3}$/.test(v)) $$('[data-b]', m).forEach((c) => { c.checked = !!(+v[+c.dataset.b] & +c.dataset.v); }); };
    },
  });
  if (!r) return;
  await act(null, () => POST('/files/chmod', { path, mode: r.mode, recursive: r.recursive }), 'Permissions updated');
  reload();
}

Pages.files = (el, params) => {
  let cwd = params.length ? params.join('/') : (localStorage.getItem('uiable-cwd') || '/');
  if (!cwd.startsWith('/')) cwd = '/' + cwd;
  let items = []; let selected = new Set(); let showHidden = localStorage.getItem('uiable-hidden') === '1'; let useSudo = localStorage.getItem('uiable-files-sudo') === '1'; let filter = '';
  let sort = { key: 'name', dir: 1 };
  el.innerHTML = `<div class="toolbar">
      <button class="icon" data-up title="Up one level">${ICON.up}</button>
      <div class="crumbs" data-crumbs></div>
      <button class="icon" data-refresh title="Refresh">${ICON.refresh}</button>
    </div>
    <div class="toolbar">
      <button data-upload>${ICON.upload} Upload files</button><button data-upload-dir>${ICON.upload} Upload folder</button>
      <button data-mkdir>${ICON.folderPlus} New folder</button><button data-touch>${ICON.plus} New file</button>
      <span data-selactions class="row hidden"><span class="muted small" data-selcount></span><button class="sm" data-dlsel>${ICON.download} Download</button><button class="sm danger" data-delsel>${ICON.trash} Delete</button></span>
      <div class="spacer"></div><input class="search" placeholder="Filter this folder…" style="max-width:200px">
      <label class="row small"><input type="checkbox" data-sudo> Use sudo</label>
      <label class="row small"><input type="checkbox" data-hidden ${showHidden ? 'checked' : ''}> Hidden files</label>
      <input type="file" multiple data-file class="hidden"><input type="file" multiple webkitdirectory data-dir class="hidden">
    </div>
    <div class="card flush dropzone" data-drop><div class="table-wrap"><table><thead><tr><th style="width:34px"><input type="checkbox" data-all></th>
      <th class="sortable" data-sort="name">Name</th><th class="sortable right" data-sort="size">Size</th><th class="sortable hide-sm" data-sort="mtime">Modified</th><th class="hide-sm">Permissions</th><th class="hide-sm">Owner</th><th></th></tr></thead><tbody></tbody></table></div></div>
    <p class="muted small" style="margin-top:10px">Tip: drag files or whole folders onto the list to upload. Tick <b>Use sudo</b> to browse/upload/view paths that need root (uses a session sudo password). In the editor, use the Save ▾ menu for <b>Save as sudo</b>. Normal saves keep the original owner, group and mode.</p>`;
  const tbody = $('tbody', el);

  const visible = () => {
    const f = filter.toLowerCase();
    return items.filter((i) => (showHidden || !i.name.startsWith('.')) && (!f || i.name.toLowerCase().includes(f))).sort((a, b) => {
      const ad = a.type === 'dir' || a.targetDir, bd = b.type === 'dir' || b.targetDir;
      if (ad !== bd) return ad ? -1 : 1;
      const x = a[sort.key], y = b[sort.key];
      return (typeof x === 'string' ? x.localeCompare(y, undefined, { numeric: true }) : x - y) * sort.dir;
    });
  };
  function renderCrumbs() {
    const parts = cwd.split('/').filter(Boolean);
    let acc = '';
    $('[data-crumbs]', el).innerHTML = `<a href="#" data-go="/">/</a>` + parts.map((p, i) => { acc += '/' + p; return `${i ? '<span class="sep">/</span>' : ''}<a href="#" data-go="${esc(acc)}">${esc(p)}</a>`; }).join('') + `<input data-pathinput class="grow" value="" placeholder="type a path…" style="min-width:60px">`;
  }
  function render() {
    const list = visible();
    tbody.innerHTML = list.map((i) => {
      const p = joinPath(cwd, i.name);
      const isDir = i.type === 'dir' || i.targetDir;
      return `<tr data-name="${esc(i.name)}" class="${selected.has(i.name) ? 'sel' : ''}"><td><input type="checkbox" data-sel ${selected.has(i.name) ? 'checked' : ''}></td>
      <td><div class="fname" data-open>${i.type === 'link' ? ICON.link : isDir ? ICON.folder : ICON.file}<span class="ellipsis">${esc(i.name)}</span>${i.target ? `<span class="link ellipsis">→ ${esc(i.target)}</span>` : ''}</div></td>
      <td class="right nowrap muted">${isDir ? '–' : fmtBytes(i.size)}</td><td class="nowrap muted hide-sm">${fmtDate(i.mtime)}</td>
      <td class="mono muted hide-sm" title="${esc(i.mode)}">${permString(i.type, i.mode)}</td><td class="muted hide-sm nowrap">${esc(i.owner)}:${esc(i.group)}</td>
      <td><div class="actions"><button class="sm icon" data-menu title="More" data-path="${esc(p)}">${ICON.more}</button></div></td></tr>`;
    }).join('') || `<tr><td colspan="7" class="empty">${items.length ? 'No matching items' : 'This folder is empty. Drop files here to upload.'}</td></tr>`;
    const n = selected.size;
    $('[data-selactions]', el).classList.toggle('hidden', !n);
    $('[data-selcount]', el).textContent = `${n} selected`;
    $('[data-all]', el).checked = n > 0 && n === list.length;
  }
  async function load(path = cwd, quiet) {
    try {
      if (useSudo && !(await ensureFilesSudoPw())) { useSudo = false; localStorage.setItem('uiable-files-sudo', '0'); const cb = $('[data-sudo]', el); if (cb) cb.checked = false; }
      const r = await GET(`/files/list?path=${encodeURIComponent(path)}${sudoQS(useSudo)}`);
      cwd = r.path; items = r.items; if (!quiet) selected.clear();
      localStorage.setItem('uiable-cwd', cwd);
      history.replaceState(null, '', '#/files' + cwd.split('/').map(encodeURIComponent).join('/'));
      renderCrumbs(); render();
    } catch (e) {
      toastErr(e);
      if (path !== '/' && !items.length) load('/');
    }
  }
  const reload = () => load(cwd, true);
  const go = (p) => { filter = ''; $('.search', el).value = ''; load(p); };
  const itemByName = (n) => items.find((i) => i.name === n);

  async function openItem(i) {
    const p = joinPath(cwd, i.name);
    if (i.type === 'dir' || i.targetDir) return go(p);
    if (i.size > 5 * 1024 * 1024) return downloadPath(p, useSudo);
    openEditor(p, reload, useSudo);
  }
  async function rename(i) {
    const r = await formDlg('Rename', [{ name: 'name', label: 'New name', value: i.name }], 'Rename');
    if (!r || !r.name || r.name === i.name) return;
    await act(null, () => POST('/files/rename', { from: joinPath(cwd, i.name), to: joinPath(cwd, r.name) }), 'Renamed');
    reload();
  }
  async function del(names) {
    const many = names.length > 1;
    if (!(await confirmDlg(`Delete ${many ? names.length + ' items' : names[0]}?`, `${many ? 'These items' : 'This'} will be permanently deleted from the server${names.some((n) => (itemByName(n) || {}).type === 'dir') ? ', including everything inside folders' : ''}. This cannot be undone.`, { okLabel: 'Delete', danger: true }))) return;
    await act(null, () => POST('/files/delete', { paths: names.map((n) => joinPath(cwd, n)) }), 'Deleted');
    selected.clear(); reload();
  }

  function menu(x, y, i) {
    document.querySelectorAll('.ctx').forEach((c) => c.remove());
    const p = joinPath(cwd, i.name);
    const isDir = i.type === 'dir' || i.targetDir;
    const m = document.createElement('div'); m.className = 'ctx';
    m.innerHTML = `${isDir ? `<button data-m="open">${ICON.files} Open</button><button data-m="term">${ICON.term} Open in terminal</button>` : `<button data-m="edit">${ICON.edit} Edit</button>`}
      <button data-m="dl">${ICON.download} Download${isDir ? ' as .tar.gz' : ''}</button><hr>
      <button data-m="rename">${ICON.edit} Rename</button><button data-m="chmod">${ICON.lock} Permissions</button><button data-m="copy">${ICON.logs} Copy path</button><hr>
      <button data-m="del" class="danger">${ICON.trash} Delete</button>`;
    document.body.appendChild(m);
    const r = m.getBoundingClientRect();
    m.style.left = Math.min(x, innerWidth - r.width - 10) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
    const off = (e) => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('mousedown', off); } };
    setTimeout(() => document.addEventListener('mousedown', off), 0);
    m.onclick = (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return; m.remove();
      ({
        open: () => go(p), edit: () => openEditor(p, reload, useSudo), dl: () => downloadPath(p, useSudo), rename: () => rename(i), chmod: () => chmodDlg(i, p, reload), del: () => del([i.name]),
        term: () => { sessionStorage.setItem('uiable-term-cd', p); location.hash = '#/terminal'; },
        copy: () => { navigator.clipboard.writeText(p).then(() => toast('Path copied'), () => toast(p)); },
      })[b.dataset.m]();
    };
  }

  // events
  $('[data-up]', el).onclick = () => go(parentPath(cwd));
  $('[data-refresh]', el).onclick = reload;
  $('[data-crumbs]', el).onclick = (e) => { const a = e.target.closest('[data-go]'); if (a) { e.preventDefault(); go(a.dataset.go); } };
  $('[data-crumbs]', el).addEventListener('keydown', (e) => { if (e.target.matches('[data-pathinput]') && e.key === 'Enter') { const v = e.target.value.trim(); if (v) go(v.startsWith('/') ? v : joinPath(cwd, v)); } });
  const sudoEl = $('[data-sudo]', el); if (sudoEl) { sudoEl.checked = useSudo; sudoEl.onchange = async (e) => { useSudo = e.target.checked; if (useSudo && !(await ensureFilesSudoPw())) { useSudo = false; e.target.checked = false; } localStorage.setItem('uiable-files-sudo', useSudo ? '1' : '0'); reload(); }; }
  $('[data-hidden]', el).onchange = (e) => { showHidden = e.target.checked; localStorage.setItem('uiable-hidden', showHidden ? '1' : '0'); render(); };
  $('.search', el).oninput = (e) => { filter = e.target.value; render(); };
  $('[data-all]', el).onchange = (e) => { selected = new Set(e.target.checked ? visible().map((i) => i.name) : []); render(); };
  $$('th[data-sort]', el).forEach((th) => (th.onclick = () => { const k = th.dataset.sort; sort = { key: k, dir: sort.key === k ? -sort.dir : (k === 'name' ? 1 : -1) }; render(); }));
  $('[data-mkdir]', el).onclick = async () => { const r = await formDlg('New folder', [{ name: 'name', label: 'Folder name' }], 'Create'); if (r && r.name) { await act(null, () => POST('/files/mkdir', { path: cwd, name: r.name }), 'Folder created'); reload(); } };
  $('[data-touch]', el).onclick = async () => { const r = await formDlg('New file', [{ name: 'name', label: 'File name' }], 'Create'); if (r && r.name) { const ok = await act(null, () => POST('/files/touch', { path: cwd, name: r.name })); if (ok) { reload(); openEditor(joinPath(cwd, r.name), reload, useSudo); } } };
  $('[data-upload]', el).onclick = () => $('[data-file]', el).click();
  $('[data-upload-dir]', el).onclick = () => $('[data-dir]', el).click();
  const fromInput = async (inp) => { const list = Array.from(inp.files).map((f) => ({ file: f, path: f.webkitRelativePath || f.name })); inp.value = ''; if (useSudo && !(await ensureFilesSudoPw())) return; if (await uploadAll(cwd, list, new Set(items.map((i) => i.name)), useSudo)) reload(); };
  $('[data-file]', el).onchange = (e) => fromInput(e.target);
  $('[data-dir]', el).onchange = (e) => fromInput(e.target);
  $('[data-dlsel]', el).onclick = () => [...selected].forEach((n, k) => setTimeout(() => downloadPath(joinPath(cwd, n), useSudo), k * 400));
  $('[data-delsel]', el).onclick = () => del([...selected]);

  tbody.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-name]'); if (!tr) return;
    const i = itemByName(tr.dataset.name);
    if (e.target.closest('[data-menu]')) { const r = e.target.closest('[data-menu]').getBoundingClientRect(); return menu(r.left - 150, r.bottom + 4, i); }
    if (e.target.matches('[data-sel]')) { e.target.checked ? selected.add(i.name) : selected.delete(i.name); return render(); }
    if (e.target.closest('[data-open]') && (i.type === 'dir' || i.targetDir)) return openItem(i);
  });
  tbody.addEventListener('dblclick', (e) => { const tr = e.target.closest('tr[data-name]'); if (tr && !e.target.matches('input')) openItem(itemByName(tr.dataset.name)); });
  tbody.addEventListener('contextmenu', (e) => { const tr = e.target.closest('tr[data-name]'); if (!tr) return; e.preventDefault(); menu(e.clientX, e.clientY, itemByName(tr.dataset.name)); });

  const dz = $('[data-drop]', el); let depth = 0;
  const isFiles = (e) => Array.from(e.dataTransfer.types || []).includes('Files');
  dz.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; dz.classList.add('over'); });
  dz.addEventListener('dragover', (e) => { if (isFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
  dz.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; dz.classList.remove('over'); } });
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); depth = 0; dz.classList.remove('over');
    const list = await filesFromDrop(e.dataTransfer);
    if (useSudo && !(await ensureFilesSudoPw())) return; if (await uploadAll(cwd, list, new Set(items.map((i) => i.name)), useSudo)) reload();
  });
  const stopNav = (e) => { if (isFiles(e)) e.preventDefault(); };
  window.addEventListener('dragover', stopNav); window.addEventListener('drop', stopNav);

  load(cwd);
  return () => { window.removeEventListener('dragover', stopNav); window.removeEventListener('drop', stopNav); document.querySelectorAll('.ctx').forEach((c) => c.remove()); };
};
