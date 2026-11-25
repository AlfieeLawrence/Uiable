'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const activity = require('../server/activity');
const checklist = require('../server/checklist');

// Shapes as written by audit.middleware ("METHOD /path"), audit.write ("dotted.name") and alerts history
const audit = [
  { t: 1000, user: 'admin', action: 'POST /docker/containers/abc123/stop', ok: true },
  { t: 2000, user: 'bob', action: 'auth.login.fail', ok: false },
  { t: 3000, user: 'bob', action: 'PUT /files/write', ok: true },
];
const alerts = [{ t: 4000, key: 'cpu', title: 'CPU above 90%', body: 'for 5 min' }];
const jobs = [{ id: 'j1', title: 'Install Jellyfin', state: 'failed', user: 'admin', started: 5000, ended: 5100, code: 1 }, { id: 'j2', title: 'Pull', state: 'done', user: 'bob', started: 6000, ended: 6100 }];
const updates = { self: { update: true, current: '1.2.7', latest: '1.2.8', at: 7000 }, images: { checkedAt: 7100, images: [{ tag: 'nginx:latest', update: true }, { tag: 'redis:7', update: false }] }, host: { checkedAt: 7200, updates: [{ name: 'openssl' }, { name: 'curl' }] } };

test('admin sees everything, newest first, each with a link to its source', () => {
  const items = activity.build({ audit, alerts, jobs, updates, user: 'admin', isAdmin: true });
  assert.ok(items.length >= 6);
  for (let i = 1; i < items.length; i++) assert.ok(items[i - 1].t >= items[i].t, 'sorted');
  for (const it of items) { assert.ok(it.href, `href for ${it.title}`); assert.ok(['action', 'alert', 'job', 'update'].includes(it.kind)); assert.ok(['info', 'warn', 'error'].includes(it.level)); }
  const failed = items.find((i) => i.kind === 'job');
  assert.equal(failed.href, 'job:j1'); assert.equal(failed.level, 'error');
  assert.ok(!items.some((i) => i.kind === 'job' && i.href === 'job:j2'), 'successful jobs are not notifications');
  assert.ok(items.some((i) => i.kind === 'alert' && i.level === 'warn'));
  assert.ok(items.some((i) => i.kind === 'update'));
  const stop = items.find((i) => i.kind === 'action' && /stop/i.test(i.title + i.detail));
  assert.equal(stop.href, '#/docker/c/abc123');
  assert.equal(items.filter((i) => i.kind === 'update').length, 3);
  assert.ok(items.some((i) => i.kind === 'action' && i.level === 'error'), 'failed actions are errors');
});

test('non-admins only see their own actions and jobs, no alerts or updates', () => {
  const items = activity.build({ audit, alerts, jobs, updates, user: 'bob', isAdmin: false });
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.kind === 'action' || i.kind === 'job'));
  assert.ok(!JSON.stringify(items).includes('abc123'));
});

test('limit caps the list', () => {
  assert.equal(activity.build({ audit, alerts, jobs, updates, user: 'admin', isAdmin: true, limit: 2 }).length, 2);
});

test('hrefFor maps audit actions to pages', () => {
  assert.equal(activity.hrefFor('settings.features'), '#/settings/general');
  assert.equal(activity.hrefFor('POST /stacks/media/up'), '#/stacks/media');
  assert.equal(activity.hrefFor('PUT /system/wifi'), '#/settings/network');
  assert.equal(activity.hrefFor('something.unknown'), '#/audit');
  assert.equal(activity.titleFor({ action: 'DELETE /docker/containers/abcdef1234567890' }), 'Removed a container');
});

test('setup checklist: items, counts and admin-only entries', () => {
  const now = Date.now();
  const a = checklist.compute({ isAdmin: true, twoFactor: true, linuxUser: '', bindSkipped: false, https: false, backups: 0, alerts: true, updatesCheckedAt: now - 3600e3, now });
  const ids = a.items.map((i) => i.id);
  assert.deepEqual(ids.sort(), ['2fa', 'alerts', 'backups', 'https', 'linux', 'updates'].sort());
  assert.equal(a.total, 6); assert.equal(a.done, 3); assert.equal(a.complete, false);
  for (const i of a.items) { assert.ok(i.href.startsWith('#/')); assert.ok(i.label); }
  const v = checklist.compute({ isAdmin: false, twoFactor: false, linuxUser: 'bob', now });
  assert.deepEqual(v.items.map((i) => i.id).sort(), ['2fa', 'linux']);
  assert.equal(v.done, 1);
  const stale = checklist.compute({ isAdmin: true, twoFactor: true, linuxUser: 'x', https: true, backups: 1, alerts: true, updatesCheckedAt: now - 30 * 86400e3, now });
  assert.equal(stale.items.find((i) => i.id === 'updates').done, false);
});
