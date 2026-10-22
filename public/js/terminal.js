'use strict';
/* Web terminal with tabs (xterm.js + host PTY over websocket). Sessions survive page switches. */
const Term = { tabs: [], active: null, seq: 0 };

function termTheme() {
  return { background: '#0d0f17', foreground: '#e6e8ef', cursor: '#a78bfa', selectionBackground: '#7c5cff55', black: '#1b1e2b', brightBlack: '#5c6370', red: '#f87171', green: '#4ade80', yellow: '#facc15', blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e5e7eb' };
}

function newTab(user) {
  const id = ++Term.seq;
  const holder = document.createElement('div');
  const term = new Terminal({ cursorBlink: true, fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace', fontSize: 14, theme: termTheme(), scrollback: 10000, allowProposedApi: false });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const tab = { id, title: user && user !== 'root' ? `${user} #${id}` : `shell #${id}`, term, fit, holder, ws: null, opened: false, user, alive: true };
  term.onData((d) => {
    if (!tab.alive) { if (d === '\r') { tab.alive = true; term.reset(); connectTab(tab); } return; }
    if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ t: 'i', d }));
  });
  term.onResize(({ cols, rows }) => { if (tab.ws && tab.ws.readyState === 1) tab.ws.send(JSON.stringify({ t: 'r', c: cols, r: rows })); });
  Term.tabs.push(tab);
  Term.active = id;
  return tab;
}

function connectTab(tab) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const q = new URLSearchParams({ cols: tab.term.cols, rows: tab.term.rows });
  if (tab.user) q.set('user', tab.user);
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?${q}`);
  tab.ws = ws;
  ws.onopen = () => {
    const cd = sessionStorage.getItem('uiable-term-cd');
    if (cd) { sessionStorage.removeItem('uiable-term-cd'); setTimeout(() => ws.send(JSON.stringify({ t: 'i', d: `cd '${cd.replace(/'/g, "'\\''")}'\r` })), 300); }
  };
  ws.onmessage = (e) => tab.term.write(typeof e.data === 'string' ? e.data : new Uint8Array(e.data));
  ws.onclose = () => { if (tab.ws !== ws) return; tab.alive = false; tab.term.write('\r\n\x1b[90m[disconnected - press Enter to reconnect]\x1b[0m\r\n'); };
}

Pages.terminal = (el) => {
  el.innerHTML = `<div class="term-tabs" data-tabs></div><div class="term-box" data-box></div>
    <p class="muted small" style="margin-top:8px">${can('admin') ? `New tabs open as ${State.linuxUser ? `your linked Linux user <b class="mono">${esc(State.linuxUser)}</b>` : '<b>root</b> (link a Linux user in Settings → My account to change the default)'}.` : `Shell as your linked Linux user <b class="mono">${esc(State.linuxUser || 'not linked')}</b>.`} Copy: select text. Paste: Ctrl+Shift+V / right-click (browser dependent). Sessions keep running while you use other apps; closing a tab ends its shell.</p>`;
  const box = $('[data-box]', el); const tabsEl = $('[data-tabs]', el);
  const renderTabs = () => {
    tabsEl.innerHTML = Term.tabs.map((t) => `<div class="term-tab ${t.id === Term.active ? 'active' : ''}" data-id="${t.id}">${ICON.term.replace('<svg', '<svg width="14" height="14"')}<span>${esc(t.title)}</span><button class="x" data-close="${t.id}" title="Close">${ICON.x.replace('<svg', '<svg width="12" height="12"')}</button></div>`).join('') +
      `<button class="sm" data-new>${ICON.plus} New tab</button>${can('admin') ? `<button class="sm" data-newas>${ICON.user} New tab as user…</button>` : ''}`;
  };
  const show = (id) => {
    Term.active = id; box.innerHTML = '';
    const t = Term.tabs.find((x) => x.id === id); if (!t) return renderTabs();
    box.appendChild(t.holder);
    if (!t.opened) { t.term.open(t.holder); t.opened = true; t.fit.fit(); connectTab(t); } else t.fit.fit();
    t.term.focus(); renderTabs();
  };
  const add = (user) => { const t = newTab(user || State.linuxUser || ''); show(t.id); };
  tabsEl.onclick = async (e) => {
    const c = e.target.closest('[data-close]');
    if (c) {
      const id = +c.dataset.close; const t = Term.tabs.find((x) => x.id === id);
      if (t) { try { const w = t.ws; t.ws = null; if (w) w.close(); } catch (_) {} t.term.dispose(); Term.tabs = Term.tabs.filter((x) => x !== t); }
      if (!Term.tabs.length) return add();
      return show(Term.active === id ? Term.tabs[Term.tabs.length - 1].id : Term.active);
    }
    if (e.target.closest('[data-new]')) return add();
    if (e.target.closest('[data-newas]')) {
      const o = await linuxOptions();
      const r = await formDlg('Open shell as user', [{ name: 'user', label: 'Linux user', type: 'select', options: o.users.map((u) => u.name), value: State.linuxUser || 'root' }], 'Open', { intro: 'Starts a login shell for that user (<span class="mono">runuser -l</span>, cwd = their home).' });
      if (r && r.user) add(r.user);
      return;
    }
    const tb = e.target.closest('[data-id]'); if (tb) show(+tb.dataset.id);
  };
  const onResize = () => { const t = Term.tabs.find((x) => x.id === Term.active); if (t && t.opened) try { t.fit.fit(); } catch (_) {} };
  window.addEventListener('resize', onResize);
  const ro = new ResizeObserver(onResize); ro.observe(box);
  if (!Term.tabs.length || sessionStorage.getItem('uiable-term-cd')) add(); else show(Term.active || Term.tabs[0].id);
  return () => { window.removeEventListener('resize', onResize); ro.disconnect(); };
};
