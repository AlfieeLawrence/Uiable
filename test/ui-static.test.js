'use strict';
// Static checks for front-end behaviour that has no DOM test runner here (verified in a browser too).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');

test('modals lock page scrolling (iOS-safe) and restore it on close', () => {
  const core = read('js/core.js'); const css = read('style.css');
  assert.match(core, /function lockScroll\(\)[\s\S]*body\.style\.top = `-\$\{lockedY\}px`[\s\S]*classList\.add\('modal-open'\)/);
  assert.match(core, /function unlockScroll\(\)[\s\S]*classList\.remove\('modal-open'\)[\s\S]*window\.scrollTo\(0, lockedY\)/);
  assert.match(core, /openModals\.add\(close\); lockScroll\(\);/);
  assert.match(core, /openModals\.delete\(close\);[^\n]*unlockScroll\(\)/);
  assert.match(css, /html\.modal-open, html\.modal-open body \{ overflow: hidden; \}/);
  assert.match(css, /html\.modal-open body \{ position: fixed;/);
  assert.match(css, /\.modal-bg \{ overscroll-behavior: contain; \}/);
});

test('Wi-Fi card has Diagnostics; connect errors show the log in a dialog', () => {
  const s = read('js/settings.js');
  assert.match(s, /data-diag/);
  assert.match(s, /\/system\/network\/diagnostics/);
  assert.match(s, /Couldn't connect to/);
  assert.match(s, /up to ~60s/);
});

test('1.2.8 UI: scripts loaded in order, no inline handlers (CSP), key behaviours wired', () => {
  const html = read('index.html');
  const order = ['/js/core.js', '/js/undo.js', '/js/ux.js', '/js/main.js'].map((s) => html.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => !k || i > order[k - 1]), 'core → undo → ux → main');
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'public', 'js')).filter((x) => x.endsWith('.js')).map((x) => 'js/' + x)) {
    assert.doesNotMatch(read(f), /\son(click|load|error|input|change|keydown)="/, `${f}: inline handler would be blocked by CSP`);
  }
  const ux = read('js/ux.js');
  assert.match(ux, /e\.key === 'k' \|\| e\.key === 'K'|key\.toLowerCase\(\) === 'k'|\(e\.ctrlKey \|\| e\.metaKey\)/, 'Ctrl/Cmd-K palette');
  assert.match(ux, /function typedConfirm/);
  const docker = read('js/docker.js');
  assert.match(docker, /typedConfirm\(\{ title: `Remove \$\{name\}\?`/, 'container remove needs typed confirmation');
  assert.match(docker, /word: 'prune'/, 'prune needs typed confirmation');
  assert.match(docker, /ctrAction\(id, name, a/, 'stop/restart are undoable');
  const core = read('js/core.js');
  assert.match(core, /appEnabled\(appDef\)/, 'router blocks disabled features');
  assert.match(core, /docker: \['\/js\/docker\.js', '\/js\/container\.js'\]/);
  const css = read('style.css');
  assert.match(css, /prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after/);
  assert.match(css, /:focus-visible \{ outline: 2px solid var\(--accent\)/);
  assert.match(css, /\.tabbar \{ display: grid;/);
});
