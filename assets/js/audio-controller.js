(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SurpriseAudio = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createController(options = {}) {
    const requestFrame = options.requestFrame || (callback => requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame || (id => cancelAnimationFrame(id));
    const now = options.now || (() => performance.now());
    const setTimer = options.setTimer || ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer || (id => clearTimeout(id));
    const makeAudio = options.makeAudio || (() => new Audio());
    const onChange = options.onChange || (() => {});
    const fadeDuration = options.fadeDuration ?? 900;
    const pauseDuration = options.pauseDuration ?? 350;
    const endFadeSeconds = options.endFadeSeconds ?? 1.5;
    const sequentialTransitions = options.sequentialTransitions === true;
    const tracks = new Map();
    let active = null;
    let fallback = null;
    let desired = false;
    let suspended = false;
    let revision = 0;
    let frame = null;
    let lastNotification = -Infinity;
    let destroyed = false;

    function snapshot() {
      const background = tracks.get('background');
      const audible = entry => Boolean(desired && !suspended && entry && !entry.audio.paused
        && entry.status === 'playing' && entry.gain > 0);
      return {
        desired, suspended, target: active?.kind || null, trackId: active?.trackId || null,
        state: active?.status || 'idle', error: active?.error || null,
        playing: [...tracks.values()].some(audible), backgroundPlaying: audible(background),
        photoPlaying: Boolean(active?.kind === 'photo' && audible(active)),
        currentTime: active?.audio.currentTime || 0, duration: active?.audio.duration || 0,
        backgroundTime: background?.audio.currentTime || 0,
        backgroundDuration: background?.audio.duration || 0,
        backgroundState: background?.status || 'idle', backgroundError: background?.error || null
      };
    }
    function notify() { if (!destroyed) onChange(snapshot()); }
    function clearPlaybackTimer(entry) {
      if (entry.timer !== null) clearTimer(entry.timer);
      entry.timer = null;
    }
    function tail(entry) {
      const duration = entry.audio.duration;
      if (!Number.isFinite(duration) || duration <= 0 || endFadeSeconds <= 0) return 1;
      return Math.max(0, Math.min(1, (duration - entry.audio.currentTime) / endFadeSeconds));
    }
    function applyVolume(entry) {
      try { entry.audio.volume = Math.max(0, Math.min(1, entry.gain * tail(entry))); } catch {}
    }
    function finishAtEnd(entry) {
      const duration = entry.audio.duration;
      if (!Number.isFinite(duration) || duration <= 0 || entry.audio.currentTime < duration - 0.001) return false;
      clearPlaybackTimer(entry);
      entry.fade = null;
      entry.status = 'ended';
      entry.gain = 0;
      entry.audio.pause();
      applyVolume(entry);
      return true;
    }
    function scheduleFrame() {
      if (!destroyed && frame === null) frame = requestFrame(tick);
    }
    function tick(timestamp) {
      frame = null;
      let needed = false;
      for (const entry of tracks.values()) {
        if (entry.status !== 'ended' && finishAtEnd(entry)) notify();
        if (entry.fade) {
          const fade = entry.fade;
          const progress = Math.min(1, Math.max(0, (timestamp - fade.startedAt) / fade.duration));
          const eased = progress * progress * (3 - 2 * progress);
          entry.gain = fade.from + (fade.to - fade.from) * eased;
          if (progress === 1) {
            entry.fade = null;
            if (fade.pause && fade.token === revision) {
              entry.audio.pause();
              if (entry.status !== 'ended' && entry.status !== 'error') entry.status = 'paused';
              notify();
            }
          } else needed = true;
        }
        applyVolume(entry);
        if (!entry.audio.paused && !entry.audio.ended && desired && !suspended) needed = true;
      }
      if (timestamp - lastNotification >= 200) { lastNotification = timestamp; notify(); }
      if (needed) scheduleFrame();
    }
    function fade(entry, level, duration, pause = false) {
      entry.fade = null;
      // iOS controls media volume in hardware; avoid two full-volume sources.
      if (sequentialTransitions) duration = 0;
      if (duration <= 0 || entry.audio.paused) {
        entry.gain = level;
        applyVolume(entry);
        if (pause) {
          entry.audio.pause();
          if (entry.status !== 'ended' && entry.status !== 'error') entry.status = 'paused';
        }
        return;
      }
      entry.fade = { from: entry.gain, to: level, startedAt: now(), duration, pause, token: revision };
      scheduleFrame();
    }
    function cancelFades() {
      for (const entry of tracks.values()) entry.fade = null;
      if (frame !== null) cancelFrame(frame);
      frame = null;
    }
    function canStart(entry) {
      return !destroyed && desired && !suspended && active === entry
        && entry.status !== 'error' && entry.status !== 'ended';
    }
    function startPlaying(entry) {
      if (!canStart(entry)) { entry.audio.pause(); return; }
      clearPlaybackTimer(entry);
      if (entry.status !== 'playing') {
        entry.status = 'playing';
        for (const other of tracks.values()) {
          if (other !== entry) fade(other, 0, fadeDuration, true);
        }
        fade(entry, entry.level, fadeDuration);
      }
      scheduleFrame();
      notify();
    }
    function fail(entry, error, token) {
      if (token !== revision || active !== entry) return;
      revision += 1;
      cancelFades();
      clearPlaybackTimer(entry);
      entry.fade = null;
      entry.status = 'error';
      entry.error = error;
      entry.audio.pause();
      entry.gain = 0;
      applyVolume(entry);
      // Retain at most one earlier track if the replacement failed to start.
      for (const other of tracks.values()) {
        if (other === entry) continue;
        if (other === fallback && !other.audio.paused && desired && !suspended) {
          fade(other, other.level, fadeDuration);
        } else fade(other, 0, pauseDuration, true);
      }
      notify();
    }
    function register(key, kind, trackId, audio, level) {
      audio.loop = false;
      audio.preload = 'none';
      audio.removeAttribute?.('crossorigin');
      const entry = { key, kind, trackId, audio, level, gain: 0, fade: null,
        status: 'idle', error: null, timer: null, listeners: [] };
      tracks.set(key, entry);
      function listen(name, handler) {
        audio.addEventListener(name, handler);
        entry.listeners.push([name, handler]);
      }
      listen('playing', () => startPlaying(entry));
      listen('waiting', () => {
        if (!canStart(entry)) return;
        entry.status = 'loading';
        clearPlaybackTimer(entry);
        const token = revision;
        entry.timer = setTimer(() => fail(entry, 'unavailable', token), 12000);
        notify();
      });
      listen('pause', () => {
        if (entry.audio.paused && entry.status === 'playing') entry.status = 'paused';
        notify();
      });
      listen('ended', () => {
        clearPlaybackTimer(entry);
        entry.fade = null;
        entry.status = 'ended';
        entry.gain = 0;
        applyVolume(entry);
        notify();
      });
      listen('error', () => fail(entry, 'unavailable', revision));
      listen('timeupdate', () => { finishAtEnd(entry); applyVolume(entry); notify(); });
      listen('loadedmetadata', () => {
        if (entry.restoreTime !== undefined) {
          try { entry.audio.currentTime = entry.restoreTime; } catch {}
          delete entry.restoreTime;
        }
        applyVolume(entry);
        notify();
      });
      return entry;
    }
    const background = options.background
      ? register('background', 'background', null, options.background, options.backgroundVolume ?? 0.48) : null;

    async function select(entry, { explicit = false } = {}) {
      if (destroyed || !entry) return false;
      if (active === entry && desired && !suspended
        && (entry.status === 'playing' || entry.status === 'loading')) return true;
      revision += 1;
      const token = revision;
      const earlier = active;
      cancelFades();
      fallback = earlier && earlier !== entry && !earlier.audio.paused && earlier.status === 'playing'
        ? earlier : [...tracks.values()].find(other => other !== entry && !other.audio.paused && other.status === 'playing') || null;
      active = entry;
      desired = true;
      const retryMediaError = entry.status === 'error' && entry.error === 'unavailable';
      entry.error = null;
      for (const other of tracks.values()) {
        clearPlaybackTimer(other);
        if (other !== entry && other.status === 'loading') {
          other.audio.pause();
          other.status = 'paused';
          other.gain = 0;
          applyVolume(other);
        } else if (other !== entry && other !== fallback) {
          fade(other, 0, pauseDuration, true);
        }
      }
      if (retryMediaError && typeof entry.audio.load === 'function') {
        entry.restoreTime = entry.audio.currentTime || 0;
        try { entry.audio.load(); } catch {}
        if (token !== revision) return false;
      }
      if (entry.status === 'ended' || entry.audio.ended) {
        if (!explicit) {
          entry.status = 'ended';
          for (const other of tracks.values()) if (other !== entry) fade(other, 0, fadeDuration, true);
          notify();
          return false;
        }
        try { entry.audio.currentTime = 0; } catch {}
        entry.gain = 0;
        entry.status = 'paused';
      }
      if (suspended) { notify(); return false; }
      if (!entry.audio.paused) {
        entry.status = 'loading';
        startPlaying(entry);
        return true;
      }
      entry.status = 'loading';
      entry.gain = 0;
      applyVolume(entry);
      if (sequentialTransitions) {
        for (const other of tracks.values()) if (other !== entry) fade(other, 0, 0, true);
      }
      notify();
      entry.timer = setTimer(() => fail(entry, 'unavailable', token), 12000);
      try {
        await entry.audio.play();
        if (token !== revision) {
          // Keep a newer request on this same element; silence obsolete play promises.
          if (!canStart(entry)) entry.audio.pause();
          return false;
        }
        startPlaying(entry);
        return true;
      } catch (error) {
        if (token === revision) fail(entry, error?.name === 'NotAllowedError' ? 'blocked' : 'unavailable', token);
        return false;
      }
    }
    function pause({ immediate = false } = {}) {
      revision += 1;
      desired = false;
      fallback = null;
      cancelFades();
      for (const entry of tracks.values()) {
        clearPlaybackTimer(entry);
        if (entry.status === 'loading') entry.status = 'paused';
        fade(entry, 0, immediate ? 0 : pauseDuration, true);
      }
      notify();
    }
    function suspend() {
      revision += 1;
      suspended = true;
      fallback = null;
      cancelFades();
      for (const entry of tracks.values()) {
        clearPlaybackTimer(entry);
        fade(entry, 0, 0, true);
      }
      notify();
    }
    function resumeFromSuspension() {
      suspended = false;
      if (desired && active) return select(active);
      notify();
      return Promise.resolve(false);
    }
    function playPhoto(trackId, source, settings) {
      const key = 'photo:' + trackId;
      let entry = tracks.get(key);
      if (!entry) {
        const audio = makeAudio();
        audio.src = source;
        entry = register(key, 'photo', String(trackId), audio, options.photoVolume ?? 0.65);
      }
      return select(entry, settings);
    }
    function destroy() {
      pause({ immediate: true });
      destroyed = true;
      cancelFades();
      for (const entry of tracks.values()) {
        entry.listeners.forEach(([name, handler]) => entry.audio.removeEventListener(name, handler));
      }
      tracks.clear();
    }
    return {
      playBackground: settings => select(background, settings), playPhoto, pause, suspend,
      resumeFromSuspension, resume: settings => select(active || background, settings),
      getState: snapshot, destroy
    };
  }
  return { createController };
});
