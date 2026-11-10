// First-paint theme for NH Studio: the theme last shown ("nh-theme-last",
// written by src/renderer/lib/theme.ts applyTheme()), before React loads.
(function () {
  var theme = 'light';
  try {
    theme = localStorage.getItem('nh-theme-last') === 'dark' ? 'dark' : 'light';
  } catch (error) {}
  document.documentElement.dataset.theme = theme;
})();
