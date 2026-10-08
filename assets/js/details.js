(() => {
  'use strict';
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const button = document.getElementById('keepsakeBtn');
  const quote = document.getElementById('keepsakeText');
  // The keepsake borrows the author's own words; the original letter stays intact.
  const phrases = [...document.querySelectorAll('.letter .memory-highlight, .letter .pullquote p, .letter-emphasis p, .letter-finale p')]
    .map(element => element.textContent.trim()).filter(Boolean);
  let deck = [];
  function refillDeck() {
    deck = [...new Set(phrases)].filter(text => text !== quote?.textContent);
    for (let index = deck.length - 1; index > 0; index -= 1) {
      const choice = Math.floor(Math.random() * (index + 1));
      [deck[index], deck[choice]] = [deck[choice], deck[index]];
    }
  }
  if (button && quote && phrases.length > 1) {
    button.hidden = false;
    button.addEventListener('click', () => {
      if (!deck.length) refillDeck();
      quote.textContent = deck.pop();
      document.querySelector('.keepsake')?.classList.add('is-open');
      if (!reducedMotion.matches && typeof quote.animate === 'function') {
        quote.getAnimations().forEach(animation => animation.cancel());
        quote.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 380, easing: 'ease-out' });
      }
    });
  }

  document.getElementById('backToTop')?.addEventListener('click', event => {
    event.preventDefault();
    const heading = document.querySelector('h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'instant' : 'smooth' });
  });

  const links = [...document.querySelectorAll('.chapter-nav a')];
  const chapters = links.map(link => ({ link, section: document.getElementById(link.hash.slice(1)) }))
    .filter(chapter => chapter.section);
  let frame = 0;
  function updateChapter() {
    frame = 0;
    const threshold = Math.min(innerHeight * 0.36, 250);
    const active = chapters.map(chapter => ({ ...chapter, bounds: chapter.section.getBoundingClientRect() }))
      .filter(chapter => chapter.bounds.top <= threshold && chapter.bounds.bottom > 95)
      .sort((a, b) => b.bounds.top - a.bounds.top || a.bounds.height - b.bounds.height)[0];
    for (const chapter of chapters) {
      const current = chapter.section === active?.section;
      chapter.link.classList.toggle('active', current);
      if (current) chapter.link.setAttribute('aria-current', 'location');
      else chapter.link.removeAttribute('aria-current');
    }
  }
  function scheduleChapter() { if (!frame) frame = requestAnimationFrame(updateChapter); }
  window.addEventListener('scroll', scheduleChapter, { passive: true });
  window.addEventListener('resize', scheduleChapter, { passive: true });
  window.addEventListener('load', scheduleChapter, { once: true });
  updateChapter();
})();
