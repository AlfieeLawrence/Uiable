'use strict';
/* Undoable actions: "safe" actions (stop / restart a container…) run after a short
   delay with an Undo button instead of a confirm dialog. Pending actions still run
   if the page is closed (flushAll on pagehide). Works in the browser and in Node
   (test/undo.test.js). */
(function (root) {
  function createUndoQueue({ delayMs = 5000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    const pending = new Map(); // id -> { run, timer, label }
    let seq = 0;
    return {
      /** Schedule `run` after delayMs. Returns { id, undo(), runNow(), done } where done resolves to 'ran' | 'undone' | 'failed'. */
      schedule(label, run, opts = {}) {
        const id = ++seq;
        let settle;
        const done = new Promise((r) => { settle = r; });
        const fire = async () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          try { await run(); settle('ran'); } catch (e) { if (opts.onError) opts.onError(e); settle('failed'); }
        };
        const timer = setTimer(fire, opts.delayMs != null ? opts.delayMs : delayMs);
        pending.set(id, { run: fire, timer, label });
        return {
          id, done,
          undo() { const p = pending.get(id); if (!p) return false; clearTimer(p.timer); pending.delete(id); settle('undone'); return true; },
          runNow() { const p = pending.get(id); if (!p) return false; clearTimer(p.timer); p.run(); return true; },
        };
      },
      /** Run everything still pending right away (page is going away). */
      flushAll() { const all = [...pending.values()]; for (const p of all) { clearTimer(p.timer); p.run(); } return all.length; },
      size() { return pending.size; },
      labels() { return [...pending.values()].map((p) => p.label); },
    };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createUndoQueue };
  else root.createUndoQueue = createUndoQueue;
})(typeof window !== 'undefined' ? window : globalThis);
