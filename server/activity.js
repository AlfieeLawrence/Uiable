'use strict';
// Activity / notifications centre (the bell). Gathers what already exists —
// audit log, alert history, recent jobs and cached update checks — into one
// newest-first list where every item links back to its source. Pure: index.js
// passes the data in, so this is easy to test.
const crypto = require('crypto');

const SOURCES = [
  [/^(POST|PUT|DELETE) \/docker\/containers\/([^/]+)/, (m) => `#/docker/c/${encodeURIComponent(m[2])}`],
  [/^(POST|PUT|DELETE) \/docker/, () => '#/docker'],
  [/^(POST|PUT|DELETE) \/stacks\/([^/]+)/, (m) => `#/stacks/${encodeURIComponent(m[2])}`],
  [/^(POST|PUT|DELETE) \/stacks/, () => '#/stacks'],
  [/^(POST|PUT|DELETE) \/apps/, () => '#/apps'],
  [/^(POST|PUT|DELETE) \/files/, () => '#/files'],
  [/^(POST|PUT|DELETE) \/scripts/, () => '#/scripts'],
  [/^(POST|PUT|DELETE) \/updates|^updates\./, () => '#/updates'],
  [/^(POST|PUT|DELETE) \/backup/, () => '#/backup'],
  [/^(POST|PUT|DELETE) \/firewall/, () => '#/firewall'],
  [/^(POST|PUT|DELETE) \/cron/, () => '#/cron'],
  [/^(POST|PUT|DELETE) \/wireguard/, () => '#/wireguard'],
  [/^(POST|PUT|DELETE) \/integrity/, () => '#/integrity'],
  [/^(POST|PUT|DELETE) \/system\/(wifi|network)/, () => '#/settings/network'],
  [/^(POST|PUT|DELETE) \/system/, () => '#/settings/general'],
  [/^(POST|PUT|DELETE) \/alerts|^alerts\./, () => '#/settings/alerts'],
  [/^(POST|PUT|DELETE) \/(account|accounts)|^account\./, () => '#/settings/account'],
  [/^(POST|PUT|DELETE) \/tokens|^token\./, () => '#/settings/tokens'],
  [/^(POST|PUT|DELETE) \/features|^settings\./, () => '#/settings/general'],
];
const hrefFor = (action) => { for (const [re, f] of SOURCES) { const m = re.exec(action || ''); if (m) return f(m); } return '#/audit'; };

const VERBS = { POST: 'Ran', PUT: 'Changed', DELETE: 'Deleted' };
function titleFor(e) {
  const a = String(e.action || '');
  const m = /^(POST|PUT|DELETE) \/(.+)$/.exec(a);
  if (!m) return a.replace(/[._-]/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  const parts = m[2].split('/').filter((p) => !/^[a-f0-9]{12,}$/.test(p));
  if (parts[0] === 'docker' && parts[1] === 'containers') {
    if (m[1] === 'DELETE') return 'Removed a container';
    const raw = m[2].split('/'); // docker/containers/<id>/<action>
    return `Container ${raw[3] || 'change'}${e.target ? ` · ${String(e.target).slice(0, 24)}` : ''}`;
  }
  return `${VERBS[m[1]]} ${parts.join(' › ')}`;
}
const mkId = (...parts) => crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16);
const ms = (t) => (typeof t === 'number' ? t : Date.parse(t) || 0);

/**
 * @param {object} o
 * @param {Array} o.audit   audit entries (newest first)
 * @param {Array} o.alerts  alert history (newest first)
 * @param {Array} o.jobs    jobs list (newest first)
 * @param {object} o.updates { self:{update,current,latest,url,at}, images:{images:[{tag,update}]}, host:{updates:[]}}
 * @param {string} o.user   viewing dashboard user
 * @param {boolean} o.isAdmin
 */
function build({ audit = [], alerts = [], jobs = [], updates = {}, user = '', isAdmin = false, limit = 60 } = {}) {
  const items = [];
  for (const e of audit) {
    if (!isAdmin && e.user !== user) continue;
    const failed = e.ok === false || (e.status && e.status >= 400);
    items.push({ id: mkId('a', e.t, e.action, e.user), kind: 'action', level: failed ? 'error' : 'info', t: ms(e.t), title: titleFor(e), detail: `${e.user || 'system'}${failed ? ` · failed${e.status ? ` (${e.status})` : ''}` : ''}`, href: hrefFor(e.action), user: e.user || null });
  }
  if (isAdmin) for (const a of alerts) {
    items.push({ id: mkId('al', a.t, a.key), kind: 'alert', level: 'warn', t: ms(a.t), title: a.title || a.key, detail: String(a.body || '').slice(0, 160), href: '#/settings/alerts' });
  }
  for (const j of jobs) {
    if (!isAdmin && j.user !== user) continue;
    if (j.state !== 'failed') continue;
    items.push({ id: mkId('j', j.id), kind: 'job', level: 'error', t: ms(j.ended || j.started), title: `Job failed: ${j.title}`, detail: `exit ${j.code == null ? '?' : j.code}${j.user ? ` · ${j.user}` : ''}`, href: `job:${j.id}` });
  }
  if (isAdmin) {
    const s = updates.self;
    if (s && s.update) items.push({ id: mkId('u', 'self', s.latest), kind: 'update', level: 'info', t: ms(s.at), title: `Uiable ${s.latest} is available`, detail: `You're on ${s.current}`, href: '#/updates' });
    const imgs = ((updates.images && updates.images.images) || []).filter((i) => i.update);
    if (imgs.length) items.push({ id: mkId('u', 'img', imgs.map((i) => i.tag).join(',')), kind: 'update', level: 'info', t: ms(updates.images.checkedAt), title: `${imgs.length} container image update${imgs.length === 1 ? '' : 's'}`, detail: imgs.slice(0, 3).map((i) => i.tag).join(', ') + (imgs.length > 3 ? '…' : ''), href: '#/updates' });
    const hp = (updates.host && (updates.host.updates || [])) || [];
    if (hp.length) items.push({ id: mkId('u', 'host', hp.length, updates.host.checkedAt), kind: 'update', level: 'info', t: ms(updates.host.checkedAt), title: `${hp.length} system package update${hp.length === 1 ? '' : 's'}`, detail: 'Host packages', href: '#/updates' });
  }
  items.sort((a, b) => b.t - a.t);
  return items.slice(0, limit);
}

module.exports = { build, hrefFor, titleFor };
