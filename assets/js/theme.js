/* Image4K — Global Theme Switcher.
   Persists light/dark preference to localStorage. */
(function () {
  'use strict';
  try {
    const saved = localStorage.getItem('image4k_theme');
    if (saved) document.documentElement.dataset.theme = saved;
  } catch (e) {}

  function init() {
    const btn = document.getElementById('themeToggle');
    if (!btn || btn.dataset.themeBound) return;
    btn.dataset.themeBound = 'true';
    btn.addEventListener('click', () => {
      const isLight = document.documentElement.dataset.theme === 'light';
      const next = isLight ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('image4k_theme', next); } catch (e) {}
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
