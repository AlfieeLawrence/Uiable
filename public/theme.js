// Applied before first paint to avoid a light/dark flash.
(function () {
  var t = localStorage.getItem('uiable-theme') || 'system';
  var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
