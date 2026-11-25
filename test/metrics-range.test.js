'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const metrics = require('../server/metrics');
const { startServer } = require('./_server');

test('bucketize: averages, min/max per slot, gaps as null, summary', () => {
  const rows = [{ t: 0, cpu: 10 }, { t: 10, cpu: 30 }, { t: 60, cpu: 50 }, { t: 95, cpu: null }, { t: 99, cpu: 90 }, { t: 500, cpu: 1 }];
  const r = metrics.bucketize(rows, ['cpu'], 0, 100, 4); // slots of 25 ms
  assert.equal(r.points.length, 4);
  assert.equal(r.points[0].cpu, 20); assert.equal(r.points[0].cpuMin, 10); assert.equal(r.points[0].cpuMax, 30);
  assert.equal(r.points[1].cpu, null, 'no samples -> gap');
  assert.equal(r.points[2].cpu, 50);
  assert.equal(r.points[3].cpu, 90);
  assert.deepEqual(r.summary.cpu, { min: 10, max: 90, avg: 45, current: 90, count: 4 });
  assert.ok(r.points.every((p, i) => p.t === Math.round(((i + 0.5) * 100) / 4)));
});

test('bucketize: multiple keys and empty input', () => {
  const r = metrics.bucketize([{ t: 5, rx: 100, tx: 1 }, { t: 6, rx: 300 }], ['rx', 'tx'], 0, 10, 1);
  assert.equal(r.points[0].rx, 200); assert.equal(r.points[0].tx, 1);
  const e = metrics.bucketize([], ['rx'], 0, 10, 5);
  assert.equal(e.points.length, 5); assert.equal(e.summary.rx.count, 0); assert.equal(e.summary.rx.avg, null);
});

test('resolveRange: known ranges, fallback, clamped to retention', () => {
  assert.deepEqual(metrics.resolveRange('6h', 7), { range: '6h', hours: 6, clamped: false });
  assert.deepEqual(metrics.resolveRange('7d', 7), { range: '7d', hours: 168, clamped: false });
  assert.deepEqual(metrics.resolveRange('7d', 2), { range: '7d', hours: 48, clamped: true });
  assert.deepEqual(metrics.resolveRange('lol', 7), { range: '1h', hours: 1, clamped: false });
  assert.deepEqual(Object.keys(metrics.RANGES), ['1h', '6h', '24h', '7d']);
  assert.deepEqual(metrics.METRIC_KEYS.net, ['rx', 'tx']);
});

test('GET /api/metrics/range serves stored history within the range', async (t) => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'uiable-mr-'));
  // Seed history in-process, then start the real server on the same data dir.
  metrics.init(data); metrics.stop();
  const now = Date.now();
  for (let i = 0; i < 120; i++) metrics._insert({ t: now - i * 60000, cpu: i % 2 ? 20 : 40, mem: 50, rx: 1000, tx: 500, load1: 1 });
  metrics._insert({ t: now - 3 * 3600000, cpu: 99, mem: 50 }); // outside 1h, inside 6h
  const srv = await startServer(t, { data });
  const call = srv.client();
  assert.equal((await call('POST', '/setup', { username: 'admin', password: 'adminpass1' })).status, 200);

  let r = await call('GET', '/metrics/range?metric=bogus');
  assert.equal(r.status, 400);

  r = await call('GET', '/metrics/range?metric=cpu&range=1h&points=60');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.range, '1h'); assert.equal(r.data.points.length, 60); assert.deepEqual(r.data.keys, ['cpu', 'load1']);
  assert.equal(r.data.summary.cpu.max, 40); assert.equal(r.data.summary.cpu.min, 20);
  assert.ok(r.data.summary.cpu.count >= 55 && r.data.summary.cpu.count <= 62, String(r.data.summary.cpu.count));
  assert.ok(Math.abs(r.data.summary.cpu.avg - 30) < 1);

  r = await call('GET', '/metrics/range?metric=cpu&range=6h&points=60');
  assert.equal(r.data.summary.cpu.max, 99, '6h includes the older spike');

  r = await call('GET', '/metrics/range?metric=net&range=24h');
  assert.equal(r.data.summary.rx.avg, 1000); assert.equal(r.data.summary.tx.current, 500);
});
