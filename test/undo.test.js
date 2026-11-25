'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUndoQueue } = require('../public/js/undo.js');

// Manual clock so tests are instant and deterministic
function fakeTimers() {
  let now = 0; const q = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { q.set(++id, { fn, at: now + ms }); return id; },
    clearTimer: (h) => q.delete(h),
    tick(ms) { now += ms; for (const [h, x] of [...q]) if (x.at <= now) { q.delete(h); x.fn(); } },
    pending: () => q.size,
  };
}

test('runs the action after the delay', async () => {
  const t = fakeTimers(); const u = createUndoQueue({ delayMs: 5000, ...t });
  let ran = 0;
  const h = u.schedule('Stop web', () => { ran++; });
  assert.equal(u.size(), 1); assert.deepEqual(u.labels(), ['Stop web']);
  t.tick(4999); assert.equal(ran, 0);
  t.tick(1); assert.equal(await h.done, 'ran'); assert.equal(ran, 1); assert.equal(u.size(), 0);
});

test('undo cancels it; a second undo / late timer does nothing', async () => {
  const t = fakeTimers(); const u = createUndoQueue({ delayMs: 5000, ...t });
  let ran = 0;
  const h = u.schedule('Restart db', () => { ran++; });
  assert.equal(h.undo(), true); assert.equal(h.undo(), false);
  t.tick(10000);
  assert.equal(await h.done, 'undone'); assert.equal(ran, 0); assert.equal(t.pending(), 0);
});

test('runNow and flushAll execute pending actions exactly once (page close)', async () => {
  const t = fakeTimers(); const u = createUndoQueue({ delayMs: 5000, ...t });
  const ran = [];
  const a = u.schedule('a', () => ran.push('a')); const b = u.schedule('b', () => ran.push('b')); const c = u.schedule('c', () => ran.push('c'));
  a.runNow(); assert.equal(a.undo(), false);
  c.undo();
  assert.equal(u.flushAll(), 1);
  t.tick(6000);
  assert.deepEqual(ran, ['a', 'b']);
  assert.deepEqual(await Promise.all([a.done, b.done, c.done]), ['ran', 'ran', 'undone']);
});

test('failures resolve as failed and call onError', async () => {
  const t = fakeTimers(); const u = createUndoQueue({ delayMs: 10, ...t });
  let err = null;
  const h = u.schedule('x', async () => { throw new Error('nope'); }, { onError: (e) => { err = e; } });
  t.tick(10);
  assert.equal(await h.done, 'failed'); assert.equal(err.message, 'nope');
});

test('per-item delay overrides the default', async () => {
  const t = fakeTimers(); const u = createUndoQueue({ delayMs: 5000, ...t });
  let ran = false; const h = u.schedule('x', () => { ran = true; }, { delayMs: 100 });
  t.tick(100); await h.done; assert.equal(ran, true);
});
