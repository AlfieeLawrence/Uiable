// Applied before first paint to avoid a theme flash.
(function () {
  var KEY = 'uiable-theme';
  var NAMED = { dark: 1, light: 1, solarized: 1, dracula: 1, monokai: 1 };
  var t = localStorage.getItem(KEY) || 'system';
  var resolved = NAMED[t] ? t
    : (t === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  document.documentElement.dataset.theme = resolved;
})();
