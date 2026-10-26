'use strict';
/* Uiable core: helpers, API client, modals, toasts, icons, router. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const State = { csrf: null, user: null, role: null, version: '' };

function splitBytes(n, d = 1) {
  n = Number(n) || 0;
  if (!Number.isFinite(n)) return { num: '0.0', unit: 'B' };
  const sign = n < 0 ? '-' : '';
  n = Math.abs(n);
  if (n < 1024) return { num: sign + n.toFixed(d), unit: 'B' };
  const u = ['KB', 'MB', 'GB', 'TB', 'PB']; let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return { num: sign + n.toFixed(d), unit: u[i] };
}
function fmtBytes(n, d = 1) { const p = splitBytes(n, d); return p.num + ' ' + p.unit; }
const splitRate = (n) => { const p = splitBytes(n, 1); return { num: p.num, unit: p.unit + '/s' }; };
const fmtRate = (n) => { const p = splitRate(n); return p.num + ' ' + p.unit; };
const fmtPct = (n, d = 0) => (Number(n) || 0).toFixed(d) + '%';
const fmtNum = (n, d = 1) => (Number(n) || 0).toFixed(d);
/** Set a .widget-value pair: [data-w=key] num + [data-w=key+'u'] unit */
function setVal(root, key, num, unit) {
  const n = root.querySelector(`[data-w="${key}"]`);
  const u = root.querySelector(`[data-w="${key}u"]`);
  if (n) n.textContent = num;
  if (u) u.textContent = unit;
}
function fmtDur(s) {
  s = Math.floor(Number(s) || 0);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`; if (h) return `${h}h ${m}m`; if (m) return `${m}m`; return `${s}s`;
}
function fmtDate(ms) { if (!ms) return ''; const d = new Date(ms); return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); }
function timeAgo(sec) { const s = Date.now() / 1000 - sec; if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + ' min ago'; if (s < 86400) return Math.floor(s / 3600) + ' h ago'; return Math.floor(s / 86400) + ' days ago'; }
const pctClass = (p) => (p >= 90 ? 'crit' : p >= 75 ? 'warn' : '');

class ApiError extends Error { constructor(msg, status, data) { super(msg); this.status = status; this.data = data; } }
async function api(method, url, body) {
  const headers = { 'X-CSRF-Token': State.csrf || '' };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch('/api' + url, { method, headers, body: payload, credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && !url.startsWith('/login') && !url.startsWith('/state')) { State.user = null; boot(); throw new ApiError('Session expired', 401); }
  if (!res.ok) throw new ApiError((data && data.error) || `Request failed (${res.status})`, res.status, data);
  return data;
}
const GET = (u) => api('GET', u);
const POST = (u, b) => api('POST', u, b === undefined ? {} : b);
const DEL = (u) => api('DELETE', u);
const PUT = (u, b) => api('PUT', u, b);

function toast(msg, isErr) {
  const t = document.createElement('div');
  t.className = 'toast' + (isErr ? ' err' : '');
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, isErr ? 6000 : 3000);
}
const toastErr = (e) => toast(e && e.message ? e.message : String(e), true);

/** Run an async action with a busy button and error toast. */
async function act(btn, fn, okMsg) {
  if (btn) { btn.disabled = true; btn.dataset.html = btn.innerHTML; btn.innerHTML = '<span class="spinner" style="width:14px;height:14px"></span>'; }
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e) { toastErr(e); return undefined; } finally { if (btn && btn.isConnected) { btn.disabled = false; btn.innerHTML = btn.dataset.html; } }
}

const openModals = new Set();
function closeAllModals() { [...openModals].forEach((c) => c(null)); }
function modal({ title, body = '', wide, full, buttons = [{ label: 'Close', value: null }], onOpen, dismissable = true }) {
  return new Promise((resolve) => {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''} ${full ? 'wide full' : ''}"><header><h2 class="grow ellipsis">${esc(title)}</h2><button class="icon" data-x>${ICON.x}</button></header><div class="body">${body}</div><footer>${buttons.map((b, i) => `<button data-i="${i}" class="${b.cls || ''}">${esc(b.label)}</button>`).join('')}</footer></div>`;
    const m = bg.firstChild;
    let cleanup = null;
    const close = (v) => { if (!openModals.has(close)) return; openModals.delete(close); if (cleanup) cleanup(); bg.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    openModals.add(close);
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(null); };
    document.addEventListener('keydown', onKey);
    bg.addEventListener('mousedown', (e) => { if (e.target === bg && dismissable) close(null); });
    $('[data-x]', m).onclick = () => close(null);
    $$('footer button', m).forEach((b) => {
      b.onclick = async () => {
        const def = buttons[+b.dataset.i];
        if (def.handler) { const r = await act(b, () => def.handler(m)); if (r === false || r === undefined && def.keepOpenOnError) return; close(r === undefined ? def.value : r); }
        else close(typeof def.value === 'function' ? def.value(m) : def.value);
      };
    });
    $('#modal-root').appendChild(bg);
    if (onOpen) cleanup = onOpen(m, close) || null;
    const f = $('input:not([type=checkbox]), textarea, select', m);
    if (f) setTimeout(() => f.focus(), 30);
    $$('input', m).forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = $('footer button.primary, footer button.danger.solid', m); if (p) p.click(); } }));
  });
}

function confirmDlg(title, text, { okLabel = 'Confirm', danger = false } = {}) {
  return modal({ title, body: `<p>${text}</p>`, buttons: [{ label: 'Cancel', value: false }, { label: okLabel, cls: danger ? 'danger solid' : 'primary', value: true }] });
}

/** fields: [{name,label,type,value,placeholder,options,checked}] */
function formDlg(title, fields, okLabel = 'Save', { intro = '', handler, onOpen } = {}) {
  const body = (intro ? `<p class="muted">${intro}</p>` : '') + fields.map((f) => {
    if (f.type === 'html') return f.html;
    if (f.type === 'hidden') return `<input type="hidden" name="${f.name}" value="${esc(f.value || '')}">`;
    if (f.type === 'checkbox') return `<label class="row" style="margin-bottom:12px"><input type="checkbox" name="${f.name}" ${f.checked ? 'checked' : ''}> ${esc(f.label)}</label>`;
    if (f.type === 'select') return `<label class="field"><span>${esc(f.label)}</span><select name="${f.name}">${f.options.map((o) => `<option ${o === f.value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    return `<label class="field"><span>${esc(f.label)}</span><input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value || '')}" placeholder="${esc(f.placeholder || '')}" autocomplete="${f.type === 'password' ? 'new-password' : 'off'}" ${f.pattern ? `pattern="${f.pattern}"` : ''}></label>`;
  }).join('');
  const collect = (m) => { const o = {}; fields.filter((f) => f.type !== 'html').forEach((f) => { const el = $(`[name="${f.name}"]`, m); o[f.name] = f.type === 'checkbox' ? el.checked : el.value; }); return o; };
  return modal({
    title, body, onOpen,
    buttons: [{ label: 'Cancel', value: null }, handler
      ? { label: okLabel, cls: 'primary', handler: async (m) => { await handler(collect(m)); return true; }, keepOpenOnError: true }
      : { label: okLabel, cls: 'primary', value: collect }],
  });
}

// ------------------------------------------------------------------ icons
const svg = (p, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
const ICON = {
  home: svg('<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'),
  dash: svg('<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 6-6"/>'),
  cpu: svg('<rect x="5" y="5" width="14" height="14" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/>'),
  procs: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  services: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  docker: svg('<path d="M3 12h18c0 4.5-3.5 8-9 8s-9-3-9-8z"/><path d="M6 12V9h3v3M9 12V9h3v3M12 12V9h3v3M9 9V6h3v3"/><path d="M21 12c-1 0-2-.5-2.5-1.5"/>'),
  files: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  term: svg('<rect x="2" y="4" width="20" height="16" rx="3"/><path d="m6 9 3 3-3 3M12 15h6"/>'),
  settings: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>'),
  refresh: svg('<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>'),
  play: svg('<path d="m6 4 14 8-14 8z"/>'),
  stop: svg('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  restart: svg('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  logs: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>'),
  chart: svg('<path d="M18 20V10M12 20V4M6 20v-6"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="currentColor" fill-opacity=".2"/>', 'style="color:#7c9cff"'),
  file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>', 'style="color:var(--muted)"'),
  link: svg('<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>', 'style="color:#22c1c3"'),
  up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  folderPlus: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10v6M9 13h6"/>'),
  edit: svg('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
  more: svg('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>'),
  wifi: svg('<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0"/><circle cx="12" cy="19.5" r="1"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>'),
  users: svg('<circle cx="9" cy="8" r="4"/><path d="M1 21a8 8 0 0 1 16 0M17 4a4 4 0 0 1 0 8M23 21a8 8 0 0 0-5-7.4"/>'),
  power: svg('<path d="M18.4 6.6a9 9 0 1 1-12.8 0M12 2v10"/>'),
  globe: svg('<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>'),
  shield: svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  palette: svg('<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.7-.8 1.7-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H17a5 5 0 0 0 5-5C22 6 17.5 2 12 2z"/>'),
  key: svg('<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>'),
  lock: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  apps: svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  store: svg('<path d="M4 7h16l-1 13H5L4 7z"/><path d="M8 7V5a4 4 0 0 1 8 0v2"/><path d="M9 11v2M15 11v2"/>'),
  stacks: svg('<rect x="3" y="3" width="18" height="6" rx="1"/><rect x="3" y="11" width="18" height="6" rx="1"/><rect x="3" y="19" width="18" height="2" rx="1"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  image: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>'),
  disk: svg('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>'),
};

const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 };
const can = (min) => (ROLE_RANK[State.role] ?? -1) >= (ROLE_RANK[min] ?? 99);
const APPS = [
  { id: 'dashboard', name: 'Dashboard', icon: 'dash', bg: 'linear-gradient(135deg,#7c5cff,#b26bff)', role: 'viewer' },
  { id: 'files', name: 'Files', icon: 'files', bg: 'linear-gradient(135deg,#3b82f6,#22c1c3)', role: 'viewer' },
  { id: 'apps', name: 'App store', icon: 'store', bg: 'linear-gradient(135deg,#f59e0b,#ef4444)', role: 'viewer' },
  { id: 'stacks', name: 'Stacks', icon: 'stacks', bg: 'linear-gradient(135deg,#6366f1,#8b5cf6)', role: 'viewer' },
  { id: 'docker', name: 'Docker', icon: 'docker', bg: 'linear-gradient(135deg,#0ea5e9,#2563eb)', role: 'viewer' },
  { id: 'logs', name: 'Logs', icon: 'logs', bg: 'linear-gradient(135deg,#64748b,#334155)', role: 'viewer' },
  { id: 'terminal', name: 'Terminal', icon: 'term', bg: 'linear-gradient(135deg,#1f2937,#4b5563)', role: 'operator' },
  { id: 'scripts', name: 'Scripts', icon: 'term', bg: 'linear-gradient(135deg,#0f766e,#14b8a6)', role: 'operator' },
  { id: 'processes', name: 'Processes', icon: 'cpu', bg: 'linear-gradient(135deg,#f97316,#f43f5e)', role: 'viewer' },
  { id: 'services', name: 'Services', icon: 'services', bg: 'linear-gradient(135deg,#10b981,#059669)', role: 'viewer' },
  { id: 'storage', name: 'Storage', icon: 'disk', bg: 'linear-gradient(135deg,#14b8a6,#0d9488)', role: 'viewer' },
  { id: 'network-tools', name: 'Net tools', icon: 'globe', bg: 'linear-gradient(135deg,#06b6d4,#0284c8)', role: 'viewer' },
  { id: 'updates', name: 'Updates', icon: 'refresh', bg: 'linear-gradient(135deg,#a855f7,#7c3aed)', role: 'admin' },
  { id: 'firewall', name: 'Firewall', icon: 'shield', bg: 'linear-gradient(135deg,#ef4444,#b91c1c)', role: 'admin' },
  { id: 'cron', name: 'Scheduled', icon: 'clock', bg: 'linear-gradient(135deg,#f59e0b,#d97706)', role: 'admin' },
  { id: 'backup', name: 'Backups', icon: 'download', bg: 'linear-gradient(135deg,#0ea5e9,#0369a1)', role: 'admin' },
  { id: 'wireguard', name: 'WireGuard', icon: 'globe', bg: 'linear-gradient(135deg,#88171a,#b91c1c)', role: 'admin' },
  { id: 'integrity', name: 'Integrity', icon: 'shield', bg: 'linear-gradient(135deg,#57534e,#292524)', role: 'admin' },
  { id: 'metrics', name: 'Metrics history', icon: 'chart', bg: 'linear-gradient(135deg,#7c5cff,#22c1c3)', role: 'viewer' },
  { id: 'proxy', name: 'Proxy', icon: 'globe', bg: 'linear-gradient(135deg,#22c55e,#16a34a)', role: 'admin' },
  { id: 'audit', name: 'Audit log', icon: 'logs', bg: 'linear-gradient(135deg,#78716c,#57534e)', role: 'admin' },
  { id: 'settings', name: 'Settings', icon: 'settings', bg: 'linear-gradient(135deg,#64748b,#94a3b8)', role: 'viewer' },
];
const visibleApps = () => APPS.filter((a) => can(a.role));
const ctrColor = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return `linear-gradient(135deg,hsl(${h},70%,55%),hsl(${(h + 40) % 360},70%,45%))`; };
const appIcon = (a, cls = '') => `<div class="app-icon ${cls}" style="background:${a.bg}">${ICON[a.icon]}</div>`;

// ------------------------------------------------------------------ theme (whole-app; matches Uiable Connect palettes)
const APP_THEMES = ['dark', 'light', 'solarized', 'dracula', 'monokai'];
const THEME_KEY = 'uiable-theme';
function resolveTheme(pref) {
  const p = pref || localStorage.getItem(THEME_KEY) || 'system';
  if (p === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return APP_THEMES.includes(p) ? p : 'dark';
}
function setTheme(t) {
  if (t != null) localStorage.setItem(THEME_KEY, t);
  document.documentElement.dataset.theme = resolveTheme();
  try { window.dispatchEvent(new CustomEvent('uiable-theme')); } catch (_) {}
}
const getTheme = () => localStorage.getItem(THEME_KEY) || 'system';
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (getTheme() === 'system') setTheme('system'); });

// ------------------------------------------------------------------ live stats hub (websocket with polling fallback)
const Stats = {
  subs: new Set(), ws: null, poll: null, last: null, history: { cpu: [], mem: [], rx: [], tx: [], gpu: [] },
  subscribe(fn) {
    this.subs.add(fn);
    if (this.last) fn(this.last);
    this.connect();
    return () => { this.subs.delete(fn); if (!this.subs.size) this.pause(); };
  },
  push(d) {
    this.last = d;
    const h = this.history; const cap = 90;
    h.cpu.push(d.cpu.usage); h.mem.push(d.memory.total ? (d.memory.used / d.memory.total) * 100 : 0);
    h.rx.push(d.network.rxRate); h.tx.push(d.network.txRate);
    if (d.gpu && d.gpu.util != null) h.gpu.push(d.gpu.util);
    Object.values(h).forEach((a) => { while (a.length > cap) a.shift(); });
    this.subs.forEach((fn) => { try { fn(d); } catch (e) { console.error(e); } });
  },
  connect() {
    if (this.ws || this.poll || !State.user || !this.subs.size || document.hidden) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let opened = false;
    const ws = new WebSocket(`${proto}://${location.host}/ws/stats`);
    this.ws = ws;
    ws.onopen = () => { opened = true; };
    ws.onmessage = (e) => { try { this.push(JSON.parse(e.data)); } catch (_) {} };
    ws.onclose = () => {
      this.ws = null;
      if (!State.user) return;
      if (!opened) this.startPolling(); else setTimeout(() => this.connect(), 3000);
    };
  },
  startPolling() {
    if (this.poll) return;
    const tick = async () => { try { this.push(await GET('/stats')); } catch (_) {} };
    tick(); this.poll = setInterval(() => { if (!document.hidden) tick(); }, 3000);
  },
  pause() { if (this.ws) { const w = this.ws; this.ws = null; w.onclose = null; w.close(); } clearInterval(this.poll); this.poll = null; },
  stop() { if (this.ws) { const w = this.ws; this.ws = null; w.onclose = null; w.close(); } clearInterval(this.poll); this.poll = null; this.last = null; Object.values(this.history).forEach((a) => a.length = 0); },
};

function sparkline(canvas, series, { max, colors = ['#7c5cff', '#22c1c3'] } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const top = max || Math.max(1, ...series.flat());
  series.forEach((data, si) => {
    if (data.length < 2) return;
    const step = w / (Math.max(data.length, 20) - 1); const off = w - (data.length - 1) * step;
    const pts = data.map((v, i) => [off + i * step, h - 2 - (Math.min(v, top) / top) * (h - 6)]);
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, colors[si] + '55'); g.addColorStop(1, colors[si] + '00');
    ctx.beginPath(); ctx.moveTo(pts[0][0], h); pts.forEach((p) => ctx.lineTo(p[0], p[1])); ctx.lineTo(pts[pts.length - 1][0], h); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.strokeStyle = colors[si]; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
  });
}

function ring(pct, label) {
  const r = 26, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return `<svg class="ring" viewBox="0 0 64 64"><defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7c5cff"/><stop offset="1" stop-color="#22c1c3"/></linearGradient></defs><circle class="t" cx="32" cy="32" r="${r}"/><circle class="v" cx="32" cy="32" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/><text x="32" y="36" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">${esc(label)}</text></svg>`;
}
const bar = (pct) => `<div class="bar ${pctClass(pct)}"><i style="width:${Math.min(100, Math.max(0, pct)).toFixed(1)}%"></i></div>`;

// ------------------------------------------------------------------ router
const Pages = {};
// Each app's JS (and xterm for the terminal) is fetched only the first time it is opened.
const PAGE_ASSETS = {
  processes: ['/js/sys.js'], services: ['/js/sys.js'], docker: ['/js/docker.js'], files: ['/js/files.js'], settings: ['/js/settings.js'],
  terminal: ['/vendor/xterm/css/xterm.css', '/vendor/xterm/lib/xterm.js', '/vendor/xterm-fit/lib/addon-fit.js', '/js/terminal.js'],
  apps: ['/js/apps.js'], scripts: ['/js/scripts.js'], stacks: ['/js/stacks.js'], logs: ['/js/logs.js'], storage: ['/js/storage.js'],
  updates: ['/js/updates.js'], firewall: ['/js/firewall.js'], cron: ['/js/cron.js'], proxy: ['/js/proxy.js'],
  'network-tools': ['/js/nettools.js'], audit: ['/js/audit.js'],
  backup: ['/js/backup.js'], wireguard: ['/js/wireguard.js'], integrity: ['/js/integrity.js'], metrics: ['/js/metrics-page.js'],
  home: ['/js/home.js'], launcher: ['/js/launcher.js'],
};
const loadedAssets = {};
window.UIABLE_BUILD = (document.querySelector('meta[name="uiable-build"]') || {}).content || '';
function loadAsset(src) {
  if (!loadedAssets[src]) {
    loadedAssets[src] = new Promise((resolve, reject) => {
      const css = src.endsWith('.css');
      const el = document.createElement(css ? 'link' : 'script');
      const url = src + (window.UIABLE_BUILD && !src.includes('?') ? `?v=${window.UIABLE_BUILD}` : '');
      if (css) { el.rel = 'stylesheet'; el.href = url; } else { el.src = url; el.async = false; }
      el.onload = resolve; el.onerror = () => { delete loadedAssets[src]; reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(el);
    });
  }
  return loadedAssets[src];
}
let currentCleanup = null;
let routeSeq = 0;
async function route() {
  if (!State.user) return;
  if (!State.layout) {
    try { State.layout = (await GET('/layout')).layout; } catch (_) { State.layout = null; }
  }
  const hash = location.hash.replace(/^#\/?/, '');
  const [name, ...rest] = hash.split('/');
  const seq = ++routeSeq;
  const want = name || 'home';
  if (!Pages[want] && PAGE_ASSETS[want]) {
    try { for (const a of PAGE_ASSETS[want]) await loadAsset(a); } catch (e) { toastErr(e); }
    if (seq !== routeSeq) return; // user navigated again while loading
  }
  let page = Pages[want] ? want : (Pages[name] ? name : 'home');
  const appDef = APPS.find((a) => a.id === page);
  if (appDef && !can(appDef.role)) { toast('Your role cannot open that app', true); page = 'home'; }
  closeAllModals(); document.querySelectorAll('.ctx').forEach((c) => c.remove());
  if (currentCleanup) { try { currentCleanup(); } catch (_) {} currentCleanup = null; }
  const app = APPS.find((a) => a.id === page);
  const root = $('#app');
  root.innerHTML = `<div class="page">${page === 'home' || page === 'launcher' ? '' : `
    <div class="topbar">
      <a href="#/" class="btn icon" title="Home">${ICON.back}</a>
      <div class="title">${appIcon(app)}<h1 style="font-size:24px">${esc(app.name)}</h1></div>
      <div class="spacer"></div><div id="page-actions" class="row"></div>
    </div>`}<div id="view"></div></div>${dockHtml(page)}`;
  bindDock();
  currentCleanup = Pages[page]($('#view'), rest.map(decodeURIComponent)) || null;
}
function dockItemIcon(d) {
  if (d.type === 'home') return { bg: 'linear-gradient(135deg,#7c5cff,#22c1c3)', html: ICON.home, tip: 'Home', href: '#/' };
  if (d.type === 'launcher') return { bg: 'linear-gradient(135deg,#f59e0b,#ef4444)', html: ICON.grid, tip: 'All apps', href: '#/launcher' };
  if (d.type === 'theme') return { bg: 'var(--input)', html: document.documentElement.dataset.theme === 'light' ? ICON.moon : ICON.sun, tip: 'Theme · ' + getTheme(), href: '#', theme: true, color: 'var(--text)' };
  if (d.type === 'app') {
    const a = APPS.find((x) => x.id === d.app);
    if (!a || !can(a.role)) return null;
    return { bg: d.color || a.bg, html: d.icon ? (ICON[d.icon] || `<img class="tile-ic-img pack" src="/icons/pack/${esc(d.icon)}.svg" alt="">`) : ICON[a.icon], tip: d.name || a.name, href: '#/' + a.id };
  }
  if (d.type === 'folder') return { bg: d.color || 'linear-gradient(135deg,#3b82f6,#22c1c3)', html: ICON.folder, tip: d.name || d.path || 'Files', href: '#/files/' + String(d.path || '/').replace(/^\//, '') };
  if (d.type === 'link') return { bg: d.color || 'linear-gradient(135deg,#6366f1,#8b5cf6)', html: ICON.link, tip: d.name || 'Link', href: d.url || '#', external: true };
  if (d.type === 'script') return { bg: d.color || 'linear-gradient(135deg,#0f766e,#14b8a6)', html: ICON.term, tip: d.name || d.ref || 'Script', href: '#', script: d.ref };
  if (d.type === 'container' || d.type === 'stack') return { bg: d.color || 'linear-gradient(135deg,#0ea5e9,#2563eb)', html: ICON.docker, tip: d.name || d.ref || d.type, href: d.type === 'stack' ? '#/stacks/' + encodeURIComponent(d.ref || '') : '#/docker' };
  return null;
}
function dockHtml(active) {
  const layout = State.layout || (typeof Home !== 'undefined' && Home.layout) || null;
  let items = layout && layout.dock && layout.dock.length ? layout.dock.slice() : [{ type: 'home' }, { type: 'launcher' }, ...visibleApps().slice(0, 6).map((a) => ({ type: 'app', app: a.id })), { type: 'theme' }];
  // Ensure home + launcher present
  if (!items.some((d) => d.type === 'home')) items.unshift({ type: 'home' });
  if (!items.some((d) => d.type === 'launcher')) items.splice(1, 0, { type: 'launcher' });
  const parts = [];
  items.forEach((d, i) => {
    const it = dockItemIcon(d);
    if (!it) return;
    if (i === 2) parts.push('<div class="sep"></div>');
    const activeCls = (d.type === 'home' && active === 'home') || (d.type === 'launcher' && active === 'launcher') || (d.type === 'app' && active === d.app) ? 'active' : '';
    const extra = it.theme ? ' data-theme-toggle' : '';
    const script = it.script ? ` data-dock-script="${esc(it.script)}"` : '';
    const ext = it.external ? ` data-ext="${esc(it.href)}" href="#"` : ` href="${esc(it.href)}"`;
    parts.push(`<a class="${activeCls}"${ext}${extra}${script}><div class="app-icon" style="background:${it.bg};${it.color ? 'color:'+it.color : ''}">${it.html}</div><span class="tip">${esc(it.tip)}</span></a>`);
  });
  return `<nav class="dock">${parts.join('')}</nav>`;
}
function bindDock() {
  const t = $('[data-theme-toggle]');
  if (t) t.onclick = (e) => {
    e.preventDefault();
    const cycle = ['system', ...APP_THEMES];
    const cur = getTheme();
    const i = cycle.indexOf(cur);
    setTheme(cycle[(i < 0 ? 0 : i + 1) % cycle.length]);
    const resolved = document.documentElement.dataset.theme;
    const ic = t.querySelector('.app-icon');
    if (ic) ic.innerHTML = resolved === 'light' ? ICON.moon : ICON.sun;
    const tip = t.querySelector('.tip');
    if (tip) tip.textContent = 'Theme · ' + getTheme();
  };
  $$('[data-ext]', document.querySelector('.dock') || document).forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); window.open(a.dataset.ext, '_blank', 'noopener'); };
  });
  $$('[data-dock-script]').forEach((a) => {
    a.onclick = async (e) => {
      e.preventDefault();
      if (!can('admin')) { toast('Admin only', true); return; }
      try { const r = await POST('/scripts/' + encodeURIComponent(a.dataset.dockScript) + '/run', {}); await watchJob(r.job, 'Run script'); } catch (err) { toastErr(err); }
    };
  });
}
function rebuildDock() {
  const dock = document.querySelector('.dock');
  if (!dock) return;
  const active = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'home';
  dock.outerHTML = dockHtml(active === '' ? 'home' : active);
  bindDock();
}
window.addEventListener('hashchange', route);

async function logout() {
  try { await POST('/logout'); } catch (_) {}
  State.user = null; State.role = null; State.csrf = null; State.layout = null; if (typeof Home !== 'undefined') Home.layout = null; Stats.stop();
  if (typeof Term !== 'undefined') { Term.tabs.forEach((t) => { try { t.ws.onclose = null; t.ws.close(); t.term.dispose(); } catch (_) {} }); Term.tabs = []; }
  if (currentCleanup) { try { currentCleanup(); } catch (_) {} currentCleanup = null; }
  boot();
}

// Nothing streams while the tab is in the background.
document.addEventListener('visibilitychange', () => { if (document.hidden) Stats.pause(); else Stats.connect(); });

/** Watch a long-running job in a modal until it finishes. */
async function watchJob(job, title) {
  if (!job || !job.id) return;
  let timer;
  await modal({
    title: title || job.title || 'Working…', wide: true,
    body: `<pre class="out" data-job style="min-height:240px;max-height:60vh">Starting…</pre>`,
    buttons: [{ label: 'Close', value: true }],
    onOpen: (m) => {
      const pre = $('[data-job]', m);
      const tick = async () => {
        try {
          const j = await GET('/jobs/' + job.id);
          pre.textContent = j.output || '(no output yet)';
          pre.scrollTop = pre.scrollHeight;
          if (j.state === 'running') timer = setTimeout(tick, 1000);
        } catch (e) { pre.textContent += '\n' + e.message; }
      };
      tick();
      return () => clearTimeout(timer);
    },
  });
}

/* Marquee for names that may overflow their pill/tile: ellipsis at rest; on
   hover/focus/tap the full text scrolls (CSS animation), reset on leave.
   Reduced motion: no animation, the full name is in the tooltip. One shared,
   delegated listener; nothing runs until the pointer is over a .mq. */
const mq = (text, cls = '') => `<span class="mq ${cls}" title="${esc(text)}"><span class="mq-in">${esc(text)}</span></span>`;
(function () {
  const start = (el) => {
    const inner = el.firstElementChild; if (!inner) return;
    const dist = inner.scrollWidth - el.clientWidth;
    if (dist <= 2) return;
    el.style.setProperty('--mq-dist', `-${dist + 8}px`);
    el.style.setProperty('--mq-time', `${Math.max(2, (dist + 8) / 40).toFixed(2)}s`);
    el.classList.add('mq-on');
  };
  const stop = (el) => el.classList.remove('mq-on');
  document.addEventListener('pointerover', (e) => { const m = e.target.closest && e.target.closest('.mq'); if (m) start(m); }, { passive: true });
  document.addEventListener('pointerout', (e) => { const m = e.target.closest && e.target.closest('.mq'); if (m && !m.contains(e.relatedTarget)) stop(m); }, { passive: true });
  document.addEventListener('focusin', (e) => { const m = e.target.querySelector && (e.target.matches('.mq') ? e.target : e.target.querySelector('.mq')); if (m) start(m); });
  document.addEventListener('focusout', (e) => { const m = e.target.querySelector && (e.target.matches('.mq') ? e.target : e.target.querySelector('.mq')); if (m) stop(m); });
})();

/* Linux users the current dashboard user may run as / link to (cached per page load). */
let _linuxOpts = null;
async function linuxOptions(force) {
  if (!_linuxOpts || force) _linuxOpts = await GET('/account/linux-options');
  return _linuxOpts;
}
const linuxUserOptionsHtml = (users, selected, { allowNone } = {}) =>
  (allowNone ? `<option value="" ${!selected ? 'selected' : ''}>— not linked —</option>` : '') +
  users.map((u) => `<option value="${esc(u.name)}" ${u.name === selected ? 'selected' : ''}>${esc(u.name)}${u.uid === 0 ? ' (root)' : ` (uid ${u.uid})`}${u.admin && u.uid !== 0 ? ' · sudo' : ''}</option>`).join('');

/** Pick a Linux user to link the current account to. Used on first login and in My account. */
async function linuxBindDlg({ firstLogin } = {}) {
  const o = await linuxOptions(true);
  const users = o.users;
  const pre = o.current || o.settings.defaultUser || '';
  const none = !users.length;
  const r = await modal({
    title: firstLogin ? 'Link your Linux account' : 'Linked Linux user',
    body: `<p class="muted">${firstLogin ? `Welcome, <b>${esc(State.displayName || State.user)}</b>. ` : ''}Choose which Linux user on this server is yours. It becomes the default for new terminal tabs, the user scripts run as, and the owner of files you upload into its home folder.</p>
      ${none ? `<div class="notice">${o.isAdmin ? 'No Linux users with uid 1000 or above were found.' : 'An admin has not allowed any Linux users for self-linking yet. You can skip this and ask an admin to link your account.'}</div>`
      : `<label class="field"><span>Linux user</span><select name="lu">${linuxUserOptionsHtml(users, pre, { allowNone: !firstLogin })}</select></label>
         <p class="muted small">${o.isAdmin ? 'As an admin you can pick any user, including root, and still choose a different user per terminal tab or script.' : 'You can only pick from the users an admin has approved, and you will always run as this user.'}</p>`}
      <p class="muted small">You can change this later in Settings → My account. Changes are audit-logged.</p>`,
    dismissable: !firstLogin,
    buttons: [{ label: firstLogin ? 'Skip for now' : 'Cancel', value: firstLogin ? 'skip' : null },
      ...(none ? [] : [{ label: firstLogin ? 'Link account' : 'Save', cls: 'primary', handler: async (m) => { await POST('/account/linux-user', { linuxUser: $('[name=lu]', m).value }); return 'ok'; }, keepOpenOnError: true }])],
  });
  if (r === 'skip') { await POST('/account/linux-user', { skip: true }).catch(() => {}); }
  const st = await GET('/state'); State.linuxUser = st.linuxUser || ''; _linuxOpts = null;
  if (r === 'ok') toast(State.linuxUser ? `Linked to Linux user ${State.linuxUser}` : 'Linux link removed');
  return r;
}

const buildLabel = () => `Uiable v${State.version || '?'}${State.buildDate ? ' · built ' + new Date(State.buildDate).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''}${State.build ? ' · ' + State.build : ''}`;
