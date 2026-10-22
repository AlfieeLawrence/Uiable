'use strict';
/* All apps launcher — Umbrel / Android-style drawer with search. */

Pages.launcher = (el) => {
  el.innerHTML = `<div class="launcher">
    <div class="launcher-head">
      <input class="search" data-q placeholder="Search apps…" autofocus>
    </div>
    <div class="launcher-grid" data-grid></div>
  </div>`;
  const grid = $('[data-grid]', el);
  const render = (q = '') => {
    const f = q.trim().toLowerCase();
    const apps = visibleApps().filter((a) => !f || a.name.toLowerCase().includes(f) || a.id.includes(f));
    grid.innerHTML = apps.map((a) => `<a class="app-tile" href="#/${a.id}">${appIcon(a)}${mq(a.name, 'name')}</a>`).join('')
      || `<div class="empty">No apps match</div>`;
  };
  $('[data-q]', el).oninput = (e) => render(e.target.value);
  render();
  // Also offer open-home customise hint
  return null;
};
