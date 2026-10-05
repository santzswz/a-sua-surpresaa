(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const setText = (id, text) => { const element = byId(id); if (element) element.textContent = text; };
  const pad = number => String(number).padStart(2, '0');
  const dates = window.SurpriseDates;
  document.documentElement.classList.add('js-ready');

  // Content stays readable when JavaScript or observer support is unavailable.
  if ('IntersectionObserver' in window && !reducedMotion.matches) {
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.remove('reveal-pending');
        entry.target.classList.add('on');
        observer.unobserve(entry.target);
      }
    }, { threshold: 0, rootMargin: '0px 0px -24px 0px' });
    document.querySelectorAll('.reveal').forEach(element => {
      element.classList.add('reveal-pending');
      observer.observe(element);
    });
    reducedMotion.addEventListener?.('change', event => {
      if (!event.matches) return;
      document.querySelectorAll('.reveal-pending').forEach(element => element.classList.remove('reveal-pending'));
      observer.disconnect();
    });
  }

  function updateCounters() {
    if (!dates) return;
    const now = new Date();
    const birthday = dates.birthday(now);
    const elapsed = dates.elapsed(dates.STORY_START, now);
    for (const [unit, suffix] of [['days', 'Days'], ['hours', 'Hours'], ['minutes', 'Minutes'], ['seconds', 'Seconds']]) {
      setText('oct' + suffix, pad(birthday[unit]));
      setText('birthday' + suffix, unit === 'days' ? elapsed.days.toLocaleString('pt-BR') : pad(elapsed[unit]));
    }
    setText('birthdayCountdownLabel', birthday.isBirthday ? '15 de outubro chegou' : 'contando os segundos para 15 de outubro');
    setText('birthdayCountdownHeadline', birthday.isBirthday ? 'Hoje é o seu dia. Feliz aniversário, meu amor. ♥'
      : birthday.year === birthday.currentYear ? 'O seu dia está chegando.' : 'Até o próximo 15 de outubro.');
    byId('birthdayCountdownCard')?.classList.toggle('is-birthday', birthday.isBirthday);
    const calendar = elapsed.calendar;
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const words = [];
    if (calendar.years) words.push(plural(calendar.years, 'ano', 'anos'));
    if (calendar.months) words.push(plural(calendar.months, 'mês', 'meses'));
    if (!words.length) words.push(plural(calendar.days, 'dia', 'dias'));
    const label = byId('birthdayRelationshipLabel');
    if (label) {
      let node = [...label.childNodes].find(child => child.nodeType === Node.TEXT_NODE);
      if (!node) { node = document.createTextNode(''); label.prepend(node); }
      node.nodeValue = `${words.join(' e ')} de história `;
    }
  }
  let counterTimer;
  function scheduleCounters() {
    clearInterval(counterTimer);
    updateCounters();
    if (!document.hidden) counterTimer = setInterval(updateCounters, 1000);
  }
  scheduleCounters();

  const background = byId('bgMusic');
  const photoAudio = new Audio();
  photoAudio.preload = 'none';
  photoAudio.loop = true;
  // Native media playback needs no Web Audio graph or cross-origin permission.
  background?.removeAttribute('crossorigin');
  const media = { background, photo: photoAudio };
  const soundToggle = byId('soundToggle');
  const musicPlayButton = byId('musicPlayBtn');
  const musicStatus = byId('musicStatus');
  const photoListenButton = byId('photoListenBtn');
  const photoMusicStatus = byId('photoMusicStatus');
  const photoDialog = document.querySelector('.photo-dialog');
  const photos = [...document.querySelectorAll('.shot')].map(figure => ({
    figure, button: figure.querySelector('.shot-button'), image: figure.querySelector('img'),
    caption: figure.querySelector('figcaption')?.textContent.trim() || ''
  })).filter(photo => photo.button && photo.image);
  let enabled = false;
  let backgroundWanted = true;
  let opened = false;
  let photoIndex = -1;
  let lastPhotoIndex = -1;
  let revision = 0;
  let target = null;
  let state = 'idle';
  let statusMessage = '';
  let pendingPreview = null;
  let playbackTimeout = null;
  const previewCache = new Map();

  function renderAudio() {
    const playing = Boolean(state === 'playing' && target && !media[target]?.paused);
    const loading = state === 'loading';
    soundToggle?.classList.toggle('muted', !playing);
    soundToggle?.setAttribute('aria-pressed', String(playing));
    soundToggle?.setAttribute('aria-label', playing || loading ? 'Pausar música' : 'Ativar música');
    soundToggle?.setAttribute('title', playing ? 'Som ligado' : loading ? 'Preparando música' : 'Som pausado');
    const backgroundPlaying = playing && target === 'background';
    musicPlayButton?.setAttribute('aria-pressed', String(backgroundPlaying));
    musicPlayButton?.setAttribute('aria-label', backgroundPlaying ? 'Pausar Partilhar' : 'Reproduzir Partilhar');
    if (musicPlayButton) musicPlayButton.textContent = backgroundPlaying ? 'Ⅱ' : '▶︎';
    document.querySelector('.audio-panel')?.classList.toggle('is-playing', backgroundPlaying);
    if (musicStatus) musicStatus.textContent = target === 'background'
      ? backgroundPlaying ? 'Tocando um trecho de Partilhar.' : state === 'loading' ? 'Preparando a nossa trilha…' : statusMessage || 'Música pausada. Toque em ▶︎ para ouvir.'
      : photoIndex >= 0 ? 'A nossa trilha fica pausada enquanto você visita as fotos.' : 'Música pausada. Toque em ▶︎ para ouvir.';
    const photoPlaying = playing && target === 'photo';
    photoListenButton?.setAttribute('aria-pressed', String(photoPlaying));
    photoListenButton?.setAttribute('aria-label', photoPlaying ? 'Pausar música da foto' : 'Reproduzir música da foto');
    if (photoListenButton) photoListenButton.textContent = photoPlaying ? 'Ⅱ' : '▶︎';
    if (photoMusicStatus) photoMusicStatus.textContent = target === 'photo'
      ? photoPlaying ? 'Tocando um trecho desta lembrança.' : state === 'loading' ? 'Preparando o trecho…' : statusMessage || 'Trecho pausado. Toque em ▶︎ para ouvir.'
      : enabled ? 'Toque em ▶︎ para ouvir um trecho.' : 'Som desligado. Toque em ▶︎ para ouvir um trecho.';
    photos.forEach((photo, index) => photo.figure.classList.toggle('playing', photoPlaying && index === photoIndex));
  }
  function stopAudio() {
    revision += 1;
    pendingPreview?.cancel();
    pendingPreview = null;
    clearTimeout(playbackTimeout);
    playbackTimeout = null;
    Object.values(media).forEach(audio => audio?.pause());
    target = null;
    state = 'idle';
    statusMessage = '';
    renderAudio();
  }
  function beginAudio(kind) {
    stopAudio();
    target = kind;
    state = 'loading';
    renderAudio();
    return revision;
  }
  function failAudio(message, token) {
    if (token !== revision) return;
    revision += 1;
    clearTimeout(playbackTimeout);
    media[target]?.pause();
    state = 'error';
    statusMessage = message;
    renderAudio();
  }
  function startPlaybackTimeout(token) {
    clearTimeout(playbackTimeout);
    playbackTimeout = setTimeout(() => failAudio(target === 'photo'
      ? 'O trecho está indisponível. Você ainda pode ouvir a música completa.'
      : 'A trilha está indisponível agora. Você pode ouvir a música completa pelo link abaixo.', token), 12000);
  }
  async function playMedia(kind, token) {
    if (token !== revision || !enabled || document.hidden) return;
    const audio = media[kind];
    if (!audio) return failAudio('A música está indisponível neste navegador.', token);
    try {
      audio.volume = kind === 'background' ? 0.48 : 0.65;
      startPlaybackTimeout(token);
      await audio.play();
      if (token !== revision) {
        // A canceled play promise may still start the element in some browsers.
        // Keep a newer request on this same element intact, but stop stale audio.
        if (target !== kind || !enabled || document.hidden || state === 'error') audio.pause();
        return;
      }
      clearTimeout(playbackTimeout);
      state = 'playing';
      renderAudio();
    } catch (error) {
      if (token !== revision) return;
      failAudio(error?.name === 'NotAllowedError' ? 'Toque em ▶︎ para permitir a reprodução deste trecho.'
        : 'Não foi possível tocar o trecho. Você pode ouvir a música completa pelo link.', token);
    }
  }
  function playBackground() {
    if (!enabled || !backgroundWanted || !opened || photoIndex >= 0 || document.hidden) return;
    void playMedia('background', beginAudio('background'));
  }
  function validPreview(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && /^[a-z0-9-]+\.dzcdn\.net$/i.test(url.hostname)
        && !url.username && !url.password && (!url.port || url.port === '443') ? url.href : null;
    } catch { return null; }
  }
  function loadPreview(trackId) {
    if (!/^\d+$/.test(trackId || '')) return { promise: Promise.reject(new Error('Invalid track')), cancel() {} };
    if (previewCache.has(trackId)) return { promise: Promise.resolve(previewCache.get(trackId)), cancel() {} };
    const script = document.createElement('script');
    const callback = `surprisePreview_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    let finished = false;
    let timeout;
    let rejectRequest;
    function cleanup(keepLateCallback = false) {
      clearTimeout(timeout);
      script.onerror = null;
      script.remove();
      if (keepLateCallback) {
        // A downloaded JSONP response can still run after its script was removed.
        window[callback] = () => {};
        setTimeout(() => { delete window[callback]; }, 30000);
      } else delete window[callback];
    }
    const promise = new Promise((resolve, reject) => {
      rejectRequest = reject;
      window[callback] = data => {
        if (finished) return;
        finished = true;
        cleanup();
        const preview = validPreview(data?.preview);
        if (!preview) return reject(new Error('Unavailable preview'));
        previewCache.set(trackId, preview);
        resolve(preview);
      };
      script.onerror = () => {
        if (finished) return;
        finished = true;
        cleanup(true);
        reject(new Error('Preview network error'));
      };
      timeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        cleanup(true);
        reject(new Error('Preview timeout'));
      }, 8000);
      script.src = `https://api.deezer.com/track/${encodeURIComponent(trackId)}?output=jsonp&callback=${callback}`;
      script.async = true;
      document.head.append(script);
    });
    return { promise, cancel() {
      if (finished) return;
      finished = true;
      cleanup(true);
      rejectRequest(new Error('Preview canceled'));
    } };
  }
  async function playPhoto() {
    if (photoIndex < 0 || !enabled || document.hidden) return;
    const photo = photos[photoIndex];
    const token = beginAudio('photo');
    const request = loadPreview(photo.image.dataset.trackId);
    pendingPreview = request;
    try {
      const preview = await request.promise;
      if (token !== revision || photoIndex < 0 || !enabled) return;
      pendingPreview = null;
      if (photoAudio.src !== preview) photoAudio.src = preview;
      photoAudio.currentTime = 0;
      await playMedia('photo', token);
    } catch {
      if (token !== revision) return;
      pendingPreview = null;
      failAudio('O trecho está indisponível. Você ainda pode ouvir a música completa.', token);
    }
  }
  Object.entries(media).forEach(([kind, audio]) => {
    if (!audio) return;
    audio.addEventListener('playing', () => {
      if (target !== kind || !enabled || document.hidden || state === 'error') { audio.pause(); return; }
      clearTimeout(playbackTimeout);
      state = 'playing';
      renderAudio();
    });
    audio.addEventListener('waiting', () => {
      if (target !== kind || !enabled || state === 'error') return;
      state = 'loading';
      startPlaybackTimeout(revision);
      renderAudio();
    });
    audio.addEventListener('error', () => {
      if (target !== kind) return;
      failAudio(kind === 'photo' ? 'O trecho está indisponível. Você ainda pode ouvir a música completa.'
        : 'Não foi possível tocar a trilha. Você pode ouvir a música completa pelo link abaixo.', revision);
    });
    audio.addEventListener('pause', () => {
      if (target === kind && audio.paused && state === 'playing') { state = 'idle'; statusMessage = ''; }
      renderAudio();
    });
  });
  soundToggle?.addEventListener('click', () => {
    if (enabled && (state === 'loading' || state === 'playing')) { enabled = false; stopAudio(); }
    else {
      enabled = true;
      if (photoIndex >= 0) void playPhoto();
      else { backgroundWanted = true; playBackground(); }
    }
  });
  musicPlayButton?.addEventListener('click', () => {
    if (target === 'background' && (state === 'playing' || state === 'loading')) {
      enabled = false; backgroundWanted = false; stopAudio();
    } else { enabled = true; backgroundWanted = true; playBackground(); }
  });
  photoListenButton?.addEventListener('click', () => {
    if (target === 'photo' && (state === 'playing' || state === 'loading')) { enabled = false; stopAudio(); }
    else { enabled = true; void playPhoto(); }
  });

  let photoTrigger = null;
  let savedOverflow = '';
  let savedScrollY = 0;
  let pageLocked = false;
  function lockPage() {
    if (pageLocked) return;
    savedOverflow = document.documentElement.style.overflow;
    savedScrollY = window.scrollY;
    document.documentElement.style.overflow = 'hidden';
    pageLocked = true;
  }
  function unlockPage() {
    if (!pageLocked) return;
    document.documentElement.style.overflow = savedOverflow;
    window.scrollTo({ top: savedScrollY, behavior: 'instant' });
    pageLocked = false;
  }
  function showPhoto(index) {
    if (!photoDialog || !photos.length || typeof photoDialog.showModal !== 'function') return;
    photoIndex = (index + photos.length) % photos.length;
    lastPhotoIndex = photoIndex;
    const photo = photos[photoIndex];
    stopAudio();
    const image = byId('modalImg');
    if (image) { image.src = photo.image.currentSrc || photo.image.src; image.alt = photo.image.alt; }
    setText('photoCaption', photo.caption || photo.image.alt);
    setText('photoCounter', `${pad(photoIndex + 1)} / ${pad(photos.length)}`);
    const song = photo.image.dataset.song || 'A trilha desta lembrança';
    const artist = photo.image.dataset.artist;
    const title = photoDialog.querySelector('.modal-song');
    if (title) title.textContent = artist ? `${song} · ${artist}` : song;
    const link = byId('photoTrackLink');
    if (link) {
      const id = photo.image.dataset.trackId;
      link.href = /^\d+$/.test(id || '') ? `https://www.deezer.com/track/${id}`
        : `https://www.deezer.com/search/${encodeURIComponent(song)}`;
    }
    if (!photoDialog.open) { lockPage(); photoDialog.showModal(); }
    renderAudio();
    if (enabled) void playPhoto();
  }
  function finishPhoto() {
    if (photoIndex < 0) return;
    photoIndex = -1;
    stopAudio();
    photoAudio.removeAttribute('src');
    photoAudio.load();
    byId('modalImg')?.removeAttribute('src');
    unlockPage();
    const trigger = photoTrigger;
    photoTrigger = null;
    requestAnimationFrame(() => { if (!photoDialog?.open) trigger?.focus({ preventScroll: true }); });
    playBackground();
  }
  function closePhoto() { photoDialog?.close(); finishPhoto(); }
  document.querySelector('.gallery')?.addEventListener('click', event => {
    const button = event.target.closest('.shot-button');
    const index = photos.findIndex(photo => photo.button === button);
    if (index < 0) return;
    photoTrigger = button;
    showPhoto(index);
  });
  const randomButton = byId('randomMemoryBtn');
  if (randomButton && photos.length && typeof photoDialog?.showModal === 'function') {
    randomButton.hidden = false;
    randomButton.addEventListener('click', () => {
      const choices = photos.map((_, index) => index).filter(index => index !== lastPhotoIndex);
      const index = choices[Math.floor(Math.random() * choices.length)] ?? 0;
      photoTrigger = randomButton;
      showPhoto(index);
    });
  }
  byId('photoPrev')?.addEventListener('click', () => showPhoto(photoIndex - 1));
  byId('photoNext')?.addEventListener('click', () => showPhoto(photoIndex + 1));
  photoDialog?.querySelector('.close')?.addEventListener('click', closePhoto);
  photoDialog?.addEventListener('cancel', event => { event.preventDefault(); closePhoto(); });
  photoDialog?.addEventListener('close', () => { if (!photoDialog.open) finishPhoto(); });
  photoDialog?.addEventListener('click', event => {
    if (event.target !== photoDialog) return;
    const rect = photoDialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closePhoto();
  });
  photoDialog?.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); showPhoto(photoIndex + (event.key === 'ArrowRight' ? 1 : -1));
    }
  });
  let touchStart = null;
  const stage = photoDialog?.querySelector('.photo-stage');
  stage?.addEventListener('touchstart', event => {
    if (event.target.closest('button, a') || event.touches.length !== 1) { touchStart = null; return; }
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  stage?.addEventListener('touchend', event => {
    if (!touchStart || !event.changedTouches.length) return;
    const dx = event.changedTouches[0].clientX - touchStart.x;
    const dy = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) showPhoto(photoIndex + (dx < 0 ? 1 : -1));
  }, { passive: true });
  stage?.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });

  function confetti() {
    if (reducedMotion.matches) return;
    const palette = ['#d04f76', '#f4a8bc', '#bd8c4e', '#ffd36d', '#ffffff'];
    const cx = innerWidth / 2;
    const cy = Math.min(innerHeight * 0.32, 280);
    for (let i = 0; i < 30; i += 1) {
      const piece = document.createElement('i');
      piece.className = 'birthday-confetti';
      piece.setAttribute('aria-hidden', 'true');
      piece.style.background = palette[i % palette.length];
      piece.style.setProperty('--x0', `${cx}px`);
      piece.style.setProperty('--y0', `${cy}px`);
      piece.style.setProperty('--x1', `${cx + Math.random() * innerWidth * 0.9 - innerWidth * 0.45}px`);
      piece.style.setProperty('--y1', `${cy + 180 + Math.random() * innerHeight * 0.7}px`);
      piece.style.setProperty('--spin', `${360 + Math.random() * 720}deg`);
      document.body.append(piece);
      setTimeout(() => piece.remove(), 2200);
    }
  }
  function hearts(origin) {
    if (!origin || reducedMotion.matches) return;
    const rect = origin.getBoundingClientRect();
    for (let i = 0; i < 12; i += 1) {
      const heart = document.createElement('span');
      heart.className = 'tiny'; heart.textContent = '♥';
      heart.setAttribute('aria-hidden', 'true');
      heart.style.left = `${rect.left + rect.width / 2}px`;
      heart.style.top = `${rect.top + rect.height / 2}px`;
      heart.style.setProperty('--dx', `${Math.random() * 220 - 110}px`);
      heart.style.setProperty('--rot', `${Math.random() * 120 - 60}deg`);
      heart.style.fontSize = `${12 + Math.random() * 20}px`;
      document.body.append(heart);
      setTimeout(() => heart.remove(), 2200);
    }
  }
  const entryGate = byId('entryGate');
  function openSurprise(withMusic) {
    if (opened) return;
    opened = true;
    enabled = withMusic;
    entryGate?.close();
    unlockPage();
    const heading = document.querySelector('h1');
    heading?.setAttribute('tabindex', '-1');
    heading?.focus({ preventScroll: true });
    if (withMusic) playBackground(); else renderAudio();
    confetti();
  }
  byId('entryBtn')?.addEventListener('click', () => openSurprise(true));
  byId('entryQuietBtn')?.addEventListener('click', () => openSurprise(false));
  entryGate?.addEventListener('cancel', event => { event.preventDefault(); openSurprise(false); });

  let balanceVisible = false;
  let realRevealed = false;
  function renderBalance() {
    const eye = byId('balanceEye');
    const message = byId('realBalanceMessage');
    setText('balanceValue', balanceVisible ? realRevealed ? 'R$ 300,00' : 'R$ 0,20' : 'R$ ••••');
    setText('balanceLabel', !balanceVisible ? 'Saldo do seu presente' : realRevealed ? 'Agora é o saldo de verdade' : 'Seu saldo… eu juro');
    setText('prankCopy', balanceVisible && !realRevealed ? 'KKKKKK calma, minha benção. Eu não sou tão miserável assim.' : '');
    eye?.classList.toggle('revealed', balanceVisible);
    eye?.setAttribute('aria-pressed', String(balanceVisible));
    eye?.setAttribute('aria-label', balanceVisible ? 'Ocultar saldo' : 'Mostrar saldo');
    if (byId('realBalanceBtn')) byId('realBalanceBtn').hidden = !balanceVisible || realRevealed;
    if (message) message.hidden = !balanceVisible || !realRevealed;
  }
  byId('balanceEye')?.addEventListener('click', () => { balanceVisible = !balanceVisible; renderBalance(); });
  byId('realBalanceBtn')?.addEventListener('click', () => {
    realRevealed = true; balanceVisible = true;
    byId('giftBalance')?.classList.add('real-revealed');
    renderBalance();
    byId('balanceEye')?.focus({ preventScroll: true });
    confetti();
  });
  renderBalance();
  function disclosure(buttonId, contentId, closedText, openText, burst = false) {
    const button = byId(buttonId);
    const content = byId(contentId);
    button?.addEventListener('click', () => {
      if (!content) return;
      const opening = content.hidden;
      content.hidden = !opening;
      content.classList.toggle('open', opening);
      button.setAttribute('aria-expanded', String(opening));
      button.textContent = opening ? openText : closedText;
      if (opening && burst) hearts(button);
    });
  }
  disclosure('secretBtn', 'secretMessage', 'não aperta aqui', 'eu avisei ♥', true);
  disclosure('finalMoreBtn', 'finalNote', 'mais uma coisinha…', 'guarda isso com você ♥');
  document.querySelector('.float-heart')?.addEventListener('click', event => hearts(event.currentTarget));

  let progressFrame = 0;
  function updateProgress() {
    progressFrame = 0;
    const progress = byId('experienceProgress');
    if (!progress) return;
    const height = window.visualViewport?.height || innerHeight;
    const max = Math.max(1, document.documentElement.scrollHeight - height);
    progress.style.width = `${Math.min(100, Math.max(0, window.scrollY / max * 100))}%`;
  }
  function scheduleProgress() { if (!progressFrame) progressFrame = requestAnimationFrame(updateProgress); }
  window.addEventListener('scroll', scheduleProgress, { passive: true });
  window.addEventListener('resize', scheduleProgress, { passive: true });
  window.visualViewport?.addEventListener('resize', scheduleProgress, { passive: true });
  window.addEventListener('load', scheduleProgress, { once: true });
  scheduleProgress();
  document.addEventListener('visibilitychange', () => {
    scheduleCounters();
    if (document.hidden) stopAudio();
    else if (enabled) { if (photoIndex >= 0) void playPhoto(); else playBackground(); }
  });
  window.addEventListener('pagehide', stopAudio);
  renderAudio();
  if (entryGate && typeof entryGate.showModal === 'function') { lockPage(); entryGate.showModal(); }
  else opened = true;
})();
