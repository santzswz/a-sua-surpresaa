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
  const soundToggle = byId('soundToggle');
  const photoSoundToggle = byId('photoSoundToggle');
  const musicPlayButton = byId('musicPlayBtn');
  const musicStatus = byId('musicStatus');
  const photoListenButton = byId('photoListenBtn');
  const photoMusicStatus = byId('photoMusicStatus');
  const photoDialog = document.querySelector('.photo-dialog');
  const readAlbum = selector => [...document.querySelectorAll(selector)].map(figure => ({
    figure, button: figure.querySelector('.shot-button, .final-surprise-photo-button, [data-photo-open]'),
    image: figure.querySelector('img'), caption: figure.querySelector('figcaption')?.textContent.trim() || '',
    note: figure.querySelector('.shot-note')?.textContent.trim() || ''
  })).filter(photo => photo.button && photo.image);
  const galleryPhotos = readAlbum('.shot');
  const finalPhotos = readAlbum('.final-surprise-photo');
  const allPhotos = [...galleryPhotos, ...finalPhotos];
  let photos = galleryPhotos;
  let enabled = false;
  let backgroundWanted = true;
  let opened = false;
  let photoIndex = -1;
  let lastPhotoIndex = -1;
  let photoRevision = 0;
  let pendingPreview = null;
  let photoRequestState = 'idle';
  let restoreBackgroundAfterPhoto = false;
  const previewCache = new Map();
  const backgroundSong = background?.dataset.song || 'A nossa trilha';
  const isBackgroundPhoto = photo => Boolean(background?.dataset.trackId
    && photo?.image.dataset.trackId === background.dataset.trackId);
  const selectedPhotoAudio = photo => isBackgroundPhoto(photo)
    ? audioState.target === 'background'
    : audioState.target === 'photo' && audioState.trackId === photo?.image.dataset.trackId;
  let audioState = { desired: false, target: null, state: 'idle', playing: false,
    backgroundPlaying: false, photoPlaying: false, backgroundState: 'idle' };
  const audioController = window.SurpriseAudio?.createController({
    background,
    backgroundGain: true,
    sequentialTransitions: /iPad|iPhone|iPod/.test(navigator.userAgent)
      || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1),
    onChange: snapshot => { audioState = snapshot; renderAudio(); }
  });
  if (audioController) audioState = audioController.getState();

  function renderAudio() {
    const playing = Boolean(enabled && audioState.playing);
    const loading = enabled && (audioState.state === 'loading' || photoRequestState === 'loading');
    soundToggle?.classList.toggle('muted', !playing);
    soundToggle?.setAttribute('aria-pressed', String(playing));
    soundToggle?.setAttribute('aria-label', playing || loading ? 'Pausar música' : 'Ativar música');
    soundToggle?.setAttribute('title', playing ? 'Som ligado' : loading ? 'Preparando música' : 'Som pausado');
    photoSoundToggle?.setAttribute('aria-pressed', String(playing));
    photoSoundToggle?.setAttribute('aria-label', playing || loading ? 'Pausar música' : 'Ativar música');
    if (photoSoundToggle) photoSoundToggle.textContent = playing || loading ? 'Pausar música' : 'Ativar música';
    const backgroundPlaying = Boolean(enabled && audioState.backgroundPlaying);
    const backgroundEnded = audioState.backgroundState === 'ended';
    musicPlayButton?.setAttribute('aria-pressed', String(backgroundPlaying));
    musicPlayButton?.setAttribute('aria-label', backgroundPlaying ? `Pausar ${backgroundSong}`
      : backgroundEnded ? `Ouvir ${backgroundSong} novamente` : `Continuar ${backgroundSong}`);
    if (musicPlayButton) musicPlayButton.textContent = backgroundPlaying ? 'Ⅱ' : '▶︎';
    document.querySelector('.audio-panel')?.classList.toggle('is-playing', backgroundPlaying);
    if (musicStatus) musicStatus.textContent = backgroundPlaying ? `Tocando ${backgroundSong}, inteira.`
      : backgroundEnded ? 'A música chegou ao fim. Toque em ▶︎ se quiser ouvir de novo.'
      : audioState.backgroundError ? audioState.backgroundError === 'blocked'
        ? 'Toque em ▶︎ para permitir a reprodução da música.'
        : 'Não foi possível tocar a trilha. Toque em ▶︎ para tentar de novo.'
      : audioState.target === 'background' && audioState.state === 'loading' ? 'Preparando a nossa trilha…'
      : audioState.target === 'photo' && enabled ? 'A trilha está pausada enquanto você ouve esta lembrança.'
      : 'Música pausada. Toque em ▶︎ para continuar.';
    const selectedIsBackground = isBackgroundPhoto(photos[photoIndex]);
    const selectedAudio = selectedPhotoAudio(photos[photoIndex]);
    const photoPlaying = Boolean(enabled && selectedAudio
      && (selectedIsBackground ? audioState.backgroundPlaying : audioState.photoPlaying));
    const excerpt = selectedIsBackground ? 'música' : 'trecho';
    photoListenButton?.setAttribute('aria-pressed', String(photoPlaying));
    photoListenButton?.setAttribute('aria-label', photoPlaying ? 'Pausar música da foto'
      : selectedAudio && audioState.state === 'ended' ? `Ouvir ${excerpt} da foto novamente` : 'Continuar música da foto');
    if (photoListenButton) photoListenButton.textContent = photoPlaying ? 'Ⅱ' : '▶︎';
    if (photoMusicStatus) photoMusicStatus.textContent = photoRequestState === 'loading' ? 'Preparando o trecho…'
      : photoRequestState === 'error' || (selectedAudio && audioState.error === 'unavailable')
        ? selectedIsBackground ? 'Não foi possível tocar a música. Toque em ▶︎ para tentar de novo.'
          : 'O trecho está indisponível. Você ainda pode ouvir a música completa.'
      : selectedAudio && audioState.error === 'blocked' ? `Toque em ▶︎ para permitir a reprodução ${selectedIsBackground ? 'desta música' : 'deste trecho'}.`
      : photoPlaying ? selectedIsBackground ? 'A música inteira continua com a gente.' : 'Tocando um trecho desta lembrança, sem repetir.'
      : selectedAudio && audioState.state === 'loading' ? `Preparando ${selectedIsBackground ? 'a música' : 'o trecho'}…`
      : selectedAudio && audioState.state === 'ended' ? `${selectedIsBackground ? 'A música terminou' : 'O trecho terminou'}. Toque em ▶︎ para ouvir novamente.`
      : !enabled ? `Som desligado. Toque em ▶︎ para ouvir ${selectedIsBackground ? 'a música' : 'um trecho'}.`
      : backgroundPlaying ? 'A nossa trilha continua. Toque em ▶︎ para ouvir esta lembrança.'
      : enabled && audioState.photoPlaying && !selectedAudio ? 'A música anterior continua. Toque em ▶︎ para ouvir esta lembrança.'
      : `Toque em ▶︎ para continuar ${selectedIsBackground ? 'a música' : 'o trecho'} desta lembrança.`;
    allPhotos.forEach(photo => photo.figure.classList.toggle('playing', enabled && selectedPhotoAudio(photo)
      && (isBackgroundPhoto(photo) ? audioState.backgroundPlaying : audioState.photoPlaying)));
    const duration = audioState.backgroundDuration;
    const elapsed = audioState.backgroundTime || 0;
    const clock = seconds => `${Math.floor(seconds / 60)}:${pad(Math.floor(seconds % 60))}`;
    setText('musicElapsed', clock(elapsed));
    setText('musicDuration', Number.isFinite(duration) && duration > 0 ? clock(duration) : '—:—');
    const fill = byId('musicProgressFill');
    if (fill) fill.style.width = `${Number.isFinite(duration) && duration > 0 ? Math.min(100, elapsed / duration * 100) : 0}%`;
  }
  function cancelPhotoRequest() {
    photoRevision += 1;
    pendingPreview?.cancel();
    audioController?.cancelPreparation();
    pendingPreview = null;
    photoRequestState = 'idle';
  }
  function stopAudio({ immediate = false } = {}) {
    cancelPhotoRequest();
    enabled = false;
    audioController?.pause({ immediate });
    renderAudio();
  }
  function playBackground({ explicit = false } = {}) {
    if (!enabled || !backgroundWanted || !opened || document.hidden) return;
    cancelPhotoRequest();
    void audioController?.playBackground({ explicit });
    renderAudio();
  }
  // New selections invalidate unfinished media work without resetting positions.
  function handlePhotoNavigation({ closing = false } = {}) {
    cancelPhotoRequest();
    if (closing || !selectedPhotoAudio(photos[photoIndex])) audioController?.cancelPending();
    if (closing && enabled) {
      if (restoreBackgroundAfterPhoto && backgroundWanted) playBackground();
      else audioController?.pause();
    }
    renderAudio();
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
  async function playPhoto({ explicit = true, automatic = false } = {}) {
    if (photoIndex < 0 || !opened || document.hidden || (automatic && !enabled)) return;
    cancelPhotoRequest();
    if (!automatic) enabled = true;
    const photo = photos[photoIndex];
    const token = photoRevision;
    try {
      if (!audioController) throw new Error('Audio unavailable');
      if (isBackgroundPhoto(photo)) {
        // This gallery item shares the full MP3 and its saved playback position.
        await audioController.playBackground({ explicit });
      } else {
        const trackId = photo.image.dataset.trackId;
        if (!/^\d+$/.test(trackId || '')) throw new Error('Invalid track');
        const direct = validPreview(photo.image.dataset.preview) || previewCache.get(trackId);
        if (direct) {
          // Start within the click/swipe gesture, without waiting for JSONP.
          previewCache.set(trackId, direct);
          await audioController.playPhoto(trackId, direct, { explicit });
        } else {
          // iOS needs the eventual media element to play inside this gesture.
          // Its short preparation contains only digital silence.
          audioController.preparePhoto(trackId);
          photoRequestState = 'loading';
          const request = loadPreview(trackId);
          pendingPreview = request;
          renderAudio();
          const preview = await request.promise;
          if (token !== photoRevision || photoIndex < 0 || !enabled || document.hidden) return;
          pendingPreview = null;
          photoRequestState = 'idle';
          await audioController.playPhoto(trackId, preview, { explicit });
        }
      }
    } catch {
      if (token !== photoRevision) return;
      pendingPreview = null;
      photoRequestState = 'error';
    }
    renderAudio();
  }
  function toggleSound() {
    if (enabled && (audioState.playing || audioState.state === 'loading' || photoRequestState === 'loading'
      || (audioState.suspended && audioState.desired))) stopAudio();
    else {
      enabled = true;
      if (photoIndex >= 0) void playPhoto();
      else { backgroundWanted = true; playBackground({ explicit: true }); }
    }
  }
  soundToggle?.addEventListener('click', toggleSound);
  photoSoundToggle?.addEventListener('click', toggleSound);
  musicPlayButton?.addEventListener('click', () => {
    if (enabled && (audioState.backgroundPlaying || (audioState.target === 'background' && audioState.state === 'loading'))) {
      backgroundWanted = false;
      stopAudio();
    } else { enabled = true; backgroundWanted = true; playBackground({ explicit: true }); }
  });
  photoListenButton?.addEventListener('click', () => {
    const selected = selectedPhotoAudio(photos[photoIndex]);
    if (enabled && (photoRequestState === 'loading' || (selected && ['playing', 'loading'].includes(audioState.state)))) stopAudio();
    else void playPhoto();
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
  function showPhoto(index, { explicit = false } = {}) {
    if (!photoDialog || !photos.length || typeof photoDialog.showModal !== 'function') return;
    if (!photoDialog.open) restoreBackgroundAfterPhoto = enabled && backgroundWanted && audioState.desired;
    photoIndex = (index + photos.length) % photos.length;
    if (photos === galleryPhotos) lastPhotoIndex = photoIndex;
    const photo = photos[photoIndex];
    handlePhotoNavigation();
    const image = byId('modalImg');
    if (image) { image.src = photo.image.currentSrc || photo.image.src; image.alt = photo.image.alt; }
    setText('photoCaption', photo.caption || photo.image.alt);
    setText('photoNote', photo.note);
    setText('photoCounter', `${pad(photoIndex + 1)} / ${pad(photos.length)}`);
    const song = photo.image.dataset.song || 'A trilha desta lembrança';
    const artist = photo.image.dataset.artist;
    const title = photoDialog.querySelector('.modal-song');
    if (title) title.textContent = artist ? `${song} · ${artist}` : song;
    const link = byId('photoTrackLink');
    if (link) {
      const id = photo.image.dataset.trackId;
      link.href = isBackgroundPhoto(photo) ? background.src
        : /^\d+$/.test(id || '') ? `https://www.deezer.com/track/${id}`
        : `https://www.deezer.com/search/${encodeURIComponent(song)}`;
    }
    if (!photoDialog.open) { lockPage(); photoDialog.showModal(); }
    renderAudio();
    void playPhoto({ explicit, automatic: !explicit });
  }
  function finishPhoto() {
    if (photoIndex < 0) return;
    photoIndex = -1;
    handlePhotoNavigation({ closing: true });
    byId('modalImg')?.removeAttribute('src');
    unlockPage();
    const trigger = photoTrigger;
    photoTrigger = null;
    requestAnimationFrame(() => { if (!photoDialog?.open) trigger?.focus({ preventScroll: true }); });
  }
  function closePhoto() { photoDialog?.close(); finishPhoto(); }
  document.addEventListener('click', event => {
    const button = event.target.closest('.shot-button, .final-surprise-photo-button, [data-photo-open]');
    const album = button?.closest('.final-surprise-photos') ? finalPhotos : galleryPhotos;
    const index = album.findIndex(photo => photo.button === button);
    if (index < 0) return;
    photos = album;
    photoTrigger = button;
    showPhoto(index, { explicit: true });
  });
  const randomButton = byId('randomMemoryBtn');
  if (randomButton && galleryPhotos.length && typeof photoDialog?.showModal === 'function') {
    randomButton.hidden = false;
    randomButton.addEventListener('click', () => {
      photos = galleryPhotos;
      const choices = galleryPhotos.map((_, index) => index).filter(index => index !== lastPhotoIndex);
      const index = choices[Math.floor(Math.random() * choices.length)] ?? 0;
      photoTrigger = randomButton;
      showPhoto(index, { explicit: true });
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
    setText('balanceValue', balanceVisible ? realRevealed ? 'R$ 200,00' : 'R$ 0,20' : 'R$ ••••');
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
  function resumeVisibleAudio() {
    if (document.hidden) return;
    void audioController?.resumeFromSuspension();
    if (enabled && photoIndex >= 0) {
      handlePhotoNavigation();
      void playPhoto({ explicit: false, automatic: true });
    }
  }
  document.addEventListener('visibilitychange', () => {
    scheduleCounters();
    if (document.hidden) { cancelPhotoRequest(); audioController?.suspend(); }
    else resumeVisibleAudio();
  });
  window.addEventListener('pagehide', () => { cancelPhotoRequest(); audioController?.suspend(); });
  window.addEventListener('pageshow', event => { if (event.persisted) resumeVisibleAudio(); });
  renderAudio();
  if (entryGate && typeof entryGate.showModal === 'function') { lockPage(); entryGate.showModal(); }
  else opened = true;
})();
