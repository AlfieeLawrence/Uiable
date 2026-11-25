'use strict';
// AA contrast (WCAG 2.1, 4.5:1 for normal text) for every theme, computed from
// the CSS variables in public/style.css (later blocks override earlier ones).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
const THEMES = ['dark', 'light', 'solarized', 'dracula', 'monokai'];

function vars(theme) {
  const out = {};
  const re = /(^|\n)\s*(:root|html\[data-theme="([a-z]+)"\])\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    if (m[2] !== ':root' && m[3] !== theme) continue;
    for (const d of m[4].split(';')) { const k = d.indexOf(':'); if (k < 0) continue; const name = d.slice(0, k).trim(); if (name.startsWith('--')) out[name] = d.slice(k + 1).trim(); }
  }
  return out;
}
const hex = (s) => { const h = String(s).trim().replace('#', ''); if (!/^[0-9a-f]{6}$/i.test(h)) return null; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const lum = (rgb) => { const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const parseOnAccent = (v) => hex(v === '#fff' ? '#ffffff' : v);

for (const t of THEMES) {
  test(`theme ${t}: text, muted, links and accent buttons meet AA`, () => {
    const v = vars(t);
    const surfaces = { card: hex(v['--card-solid']), page: hex(v['--bg']) };
    const pairs = [['--text', 4.5], ['--muted', 4.5], ['--accent', 3], ['--danger', 3]];
    for (const [k, min] of pairs) {
      for (const [sn, s] of Object.entries(surfaces)) {
        const c = hex(v[k]); assert.ok(c && s, `${t} ${k} parse`);
        const r = ratio(c, s);
        assert.ok(r >= min, `${t}: ${k} ${v[k]} on ${sn} = ${r.toFixed(2)} < ${min}`);
      }
    }
    const onA = ratio(parseOnAccent(v['--on-accent']), hex(v['--accent']));
    assert.ok(onA >= 4.5, `${t}: --on-accent on --accent = ${onA.toFixed(2)}`);
  });
}
module.exports = { vars, ratio, hex };
