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
