/* Hub home page: category tabs + instant search across every tool. Works without JS (all categories shown). */
(function () {
  'use strict';
  const tabs = Array.from(document.querySelectorAll('#hubTabs [role=tab]'));
  const cats = Array.from(document.querySelectorAll('.hub-cat'));
  const search = document.getElementById('hubSearch');
  const empty = document.getElementById('hubEmpty');
  if (!tabs.length || !cats.length) return;
  const VALID = new Set(tabs.map((t) => t.dataset.tab));
  let active = 'all';

  function apply() {
    const q = (search.value || '').trim().toLowerCase();
    let shown = 0;
    for (const c of cats) {
      const inTab = active === 'all' || c.dataset.cat === active || !!q; // searching looks across all categories
      let visibleItems = 0;
      for (const it of c.querySelectorAll('.hub-item')) {
        const hay = (it.textContent + ' ' + (it.dataset.k || '')).toLowerCase();
        const hit = !q || q.split(/\s+/).every((w) => hay.includes(w));
        it.hidden = !hit;
        if (hit) visibleItems++;
      }
      c.hidden = !inTab || visibleItems === 0;
      if (!c.hidden) shown += visibleItems;
    }
    empty.hidden = shown > 0;
  }
  function select(tab, focus) {
    active = VALID.has(tab) ? tab : 'all';
    for (const t of tabs) {
      const on = t.dataset.tab === active;
      t.setAttribute('aria-selected', on);
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    }
    if (search.value) search.value = '';
    apply();
  }
  tabs.forEach((t) => t.addEventListener('click', () => {
    select(t.dataset.tab);
    history.replaceState(null, '', t.dataset.tab === 'all' ? location.pathname : '#' + t.dataset.tab);
  }));
  document.getElementById('hubTabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.dataset.tab === active);
    const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    n.click(); n.focus();
  });
  search.addEventListener('input', apply);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const first = document.querySelector('.hub-item:not([hidden])'); if (first) first.click(); }
    if (e.key === 'Escape') { search.value = ''; apply(); }
  });
  // deep link: /#dev, /#api …
  const fromHash = location.hash.slice(1);
  select(VALID.has(fromHash) ? fromHash : 'all');
  window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (VALID.has(h)) select(h); });
})();

/* "What's new" — recently added tools slide in one by one as separate gold toasts; shown once per
   version (dismiss is remembered). Bump VERSION whenever the list changes so visitors see it again. */
(function () {
  'use strict';
  const el = document.getElementById('whatsnew');
  if (!el) return;
  const VERSION = '2026-11-20b';
  let seen = null; try { seen = localStorage.getItem('pd_whatsnew'); } catch (e) { /* private mode */ }
  if (seen === VERSION) { el.remove(); return; }
  const markSeen = () => { try { localStorage.setItem('pd_whatsnew', VERSION); } catch (e) {} };
  const toasts = Array.from(el.querySelectorAll('.wn-toast'));
  toasts.forEach((t, i) => {
    setTimeout(() => t.classList.add('is-in'), 900 + i * 750);      // appear one after another
    const x = t.querySelector('.wn-x');
    if (x) x.addEventListener('click', () => { t.classList.remove('is-in'); t.classList.add('is-out'); markSeen(); setTimeout(() => t.remove(), 320); });
  });
  setTimeout(markSeen, 900 + toasts.length * 750 + 200);
})();
