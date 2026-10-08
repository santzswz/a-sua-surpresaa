(() => {
  'use strict';
  const menu = document.getElementById('chapterMenu');
  if (!menu) return;
  const summary = menu.querySelector('summary');
  menu.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link) return;
    menu.open = false;
    const destination = document.getElementById(link.hash.slice(1));
    const heading = destination?.querySelector('h1, h2, h3') || destination;
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    requestAnimationFrame(() => heading.focus({ preventScroll: true }));
  });
  document.addEventListener('click', event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menu.open) return;
    event.preventDefault();
    event.stopPropagation();
    menu.open = false;
    summary?.focus();
  });
})();
