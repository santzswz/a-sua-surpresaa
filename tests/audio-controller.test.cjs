'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createController } = require('../assets/js/audio-controller.js');

class Clock {
  time = 0;
  nextId = 1;
  frames = new Map();
  timers = new Map();

  requestFrame = callback => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };
  cancelFrame = id => this.frames.delete(id);
  now = () => this.time;
  setTimer = (callback, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.time + delay });
    return id;
  };
  clearTimer = id => this.timers.delete(id);

  advance(milliseconds, step = 25) {
    const until = this.time + milliseconds;
    while (this.time < until) {
      this.time = Math.min(until, this.time + step);
      for (const [id, timer] of [...this.timers]) {
        if (timer.due <= this.time) {
          this.timers.delete(id);
          timer.callback();
        }
      }
      const frames = [...this.frames.values()];
      this.frames.clear();
      for (const callback of frames) callback(this.time);
    }
  }
}

class FakeMedia extends EventTarget {
  constructor(clock, deferred = false) {
    super();
    this.clock = clock;
    this.deferred = deferred;
    this.paused = true;
    this.ended = false;
    this.duration = 30;
    this.loop = true;
    this.preload = 'auto';
    this.src = '';
    this.position = 0;
    this.level = 1;
    this.playCalls = 0;
    this.loadCalls = 0;
    this.pauseTransitions = 0;
    this.ignoreVolume = false;
    this.beforePlay = null;
    this.pending = [];
    // Logs contain numeric media state only, never personal content or URLs.
    this.seeks = [];
    this.volumes = [];
  }

  get currentTime() { return this.position; }
  set currentTime(value) {
    this.position = value;
    this.ended = value >= this.duration;
    this.seeks.push(value);
  }
  get volume() { return this.level; }
  set volume(value) {
    assert.ok(Number.isFinite(value) && value >= 0 && value <= 1,
      'Media volume must remain between zero and one.');
    if (!this.ignoreVolume) this.level = value;
    this.volumes.push({ at: this.clock.now(), value });
  }

  removeAttribute() {}

  play() {
    this.beforePlay?.();
    this.playCalls += 1;
    let resolve;
    let reject;
    const result = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    const attempt = {
      resolve: () => {
        // A delayed completion can deliver a stale playback event after pause.
        this.paused = false;
        this.ended = false;
        this.dispatchEvent(new Event('playing'));
        resolve();
      },
      reject
    };
    if (this.deferred) this.pending.push(attempt);
    else attempt.resolve();
    return result;
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    this.pauseTransitions += 1;
    this.dispatchEvent(new Event('pause'));
  }

  load() {
    this.loadCalls += 1;
    this.pause();
    this.position = 0;
    this.ended = false;
    this.duration = NaN;
    this.dispatchEvent(new Event('emptied'));
  }

  metadata(duration = 30) {
    this.duration = duration;
    this.dispatchEvent(new Event('loadedmetadata'));
  }

  finish() {
    this.position = this.duration;
    this.paused = true;
    this.ended = true;
    this.dispatchEvent(new Event('ended'));
  }
}

function fixture({ deferred = false, sequentialTransitions = false, volumeUnsupported = false } = {}) {
  const clock = new Clock();
  const background = new FakeMedia(clock, deferred);
  const photos = [];
  const media = [background];
  const playbackStarts = [];
  function observe(audio) {
    audio.ignoreVolume = volumeUnsupported;
    audio.beforePlay = () => playbackStarts.push({
      id: media.indexOf(audio), activeCount: media.filter(item => !item.paused).length
    });
  }
  observe(background);
  const controller = createController({
    background,
    sequentialTransitions,
    makeAudio: () => {
      const audio = new FakeMedia(clock, deferred);
      photos.push(audio);
      media.push(audio);
      observe(audio);
      return audio;
    },
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  return { clock, background, photos, controller, playbackStarts };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `Expected ${actual} to approach ${expected}.`);
}

function monotonic(samples, increasing) {
  assert.ok(samples.length > 2, 'The fade must contain intermediate volume updates.');
  for (let index = 1; index < samples.length; index += 1) {
    const difference = samples[index].value - samples[index - 1].value;
    assert.ok(increasing ? difference >= -1e-9 : difference <= 1e-9,
      'A fade must move consistently toward its intended volume.');
  }
}

test('background starts with a gradual monotonic fade', async () => {
  const { controller, background, clock } = fixture();
  assert.equal(await controller.playBackground({ explicit: true }), true);
  near(background.volume, 0);
  clock.advance(225);
  assert.ok(background.volume > 0 && background.volume < 0.48);
  clock.advance(675);
  near(background.volume, 0.48);
  monotonic(background.volumes, true);
  assert.equal(background.paused, false);
  assert.equal(controller.getState().backgroundPlaying, true);
  assert.equal(background.loop, false);
});

test('fade-out pauses at the current position and resume keeps that position', async () => {
  const { controller, background, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  background.currentTime = 11.5;
  const start = background.volumes.length;
  controller.pause();
  assert.equal(background.paused, false);
  clock.advance(175);
  assert.ok(background.volume > 0 && background.volume < 0.48);
  clock.advance(175);
  near(background.volume, 0);
  assert.equal(background.paused, true);
  assert.equal(background.currentTime, 11.5);
  monotonic(background.volumes.slice(start), false);
  await controller.resume();
  clock.advance(900);
  assert.equal(background.paused, false);
  assert.equal(background.currentTime, 11.5);
  assert.deepEqual(background.seeks, [11.5]);
});

test('crossfades between photo and background preserve both playback positions', async () => {
  const { controller, background, photos, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  background.currentTime = 7.25;
  await controller.playPhoto('a', 'preview-a', { explicit: true });
  const photo = photos[0];
  clock.advance(450);
  assert.ok(background.volume > 0 && background.volume < 0.48);
  assert.ok(photo.volume > 0 && photo.volume < 0.65);
  assert.equal(background.paused, false);
  assert.equal(photo.paused, false);
  clock.advance(450);
  assert.equal(background.paused, true);
  near(photo.volume, 0.65);
  photo.currentTime = 12.5;
  await controller.playBackground();
  clock.advance(900);
  assert.equal(photo.paused, true);
  assert.equal(background.paused, false);
  assert.equal(background.currentTime, 7.25);
  assert.equal(photo.currentTime, 12.5);
  await controller.playPhoto('a', 'preview-a');
  clock.advance(900);
  assert.equal(photos.length, 1, 'Resuming a photo must reuse its existing audio.');
  assert.equal(photo.currentTime, 12.5);
  assert.deepEqual(background.seeks, [7.25]);
  assert.deepEqual(photo.seeks, [12.5]);
  assert.equal(photo.loop, false);
});

test('finished background stays finished until an explicit restart', async () => {
  const { controller, background, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  background.finish();
  assert.equal(controller.getState().state, 'ended');
  assert.equal(controller.getState().playing, false);
  assert.equal(await controller.playBackground(), false);
  controller.suspend();
  assert.equal(await controller.resumeFromSuspension(), false);
  clock.advance(900);
  assert.equal(background.playCalls, 1);
  assert.equal(background.currentTime, 30);
  assert.equal(await controller.playBackground({ explicit: true }), true);
  clock.advance(900);
  assert.equal(background.playCalls, 2);
  assert.equal(background.currentTime, 0);
  assert.deepEqual(background.seeks, [0]);
  assert.equal(background.paused, false);
});

test('finished photo is not replayed by selection or resume', async () => {
  const { controller, photos, clock } = fixture();
  await controller.playPhoto('a', 'preview-a', { explicit: true });
  clock.advance(900);
  const photo = photos[0];
  photo.finish();
  assert.equal(await controller.playPhoto('a', 'preview-a'), false);
  assert.equal(await controller.resume(), false);
  clock.advance(900);
  assert.equal(photo.playCalls, 1);
  assert.equal(photo.currentTime, 30);
  assert.equal(await controller.playPhoto('a', 'preview-a', { explicit: true }), true);
  clock.advance(900);
  assert.equal(photo.playCalls, 2);
  assert.equal(photo.currentTime, 0);
  assert.equal(photos.length, 1);
});

test('suspension immediately silences and cancels an unfinished fade', async () => {
  const { controller, background, clock } = fixture();
  await controller.playBackground();
  clock.advance(225);
  assert.ok(background.volume > 0 && background.volume < 0.48);
  background.currentTime = 10.125;
  controller.suspend();
  assert.equal(background.paused, true);
  near(background.volume, 0);
  assert.equal(controller.getState().suspended, true);
  clock.advance(2000);
  near(background.volume, 0);
  assert.equal(background.playCalls, 1);
  assert.equal(await controller.resumeFromSuspension(), true);
  clock.advance(225);
  assert.ok(background.volume > 0 && background.volume < 0.48);
  clock.advance(675);
  near(background.volume, 0.48);
  assert.equal(background.currentTime, 10.125);
  assert.deepEqual(background.seeks, [10.125]);
});

test('late play completion cannot revive audio after the final intent is pause', async () => {
  const { controller, background, clock } = fixture({ deferred: true });
  const oldPlayback = controller.playBackground();
  assert.equal(controller.getState().state, 'loading');
  controller.pause();
  background.pending[0].resolve();
  assert.equal(await oldPlayback, false);
  clock.advance(2000);
  assert.equal(background.paused, true);
  near(background.volume, 0);
  assert.equal(controller.getState().desired, false);
  assert.equal(controller.getState().playing, false);
});

test('an older play completion cannot interrupt newer playback on the same element', async () => {
  const { controller, background, clock } = fixture({ deferred: true });
  const oldPlayback = controller.playBackground();
  controller.pause({ immediate: true });
  const newPlayback = controller.playBackground();
  assert.equal(background.pending.length, 2);
  background.pending[1].resolve();
  assert.equal(await newPlayback, true);
  clock.advance(225);
  assert.ok(background.volume > 0);
  background.pending[0].resolve();
  assert.equal(await oldPlayback, false);
  clock.advance(675);
  assert.equal(background.paused, false);
  near(background.volume, 0.48);
  assert.equal(controller.getState().playing, true);
  assert.equal(controller.getState().desired, true);
});

test('reversing a crossfade keeps its current volume and cancels obsolete pauses', async () => {
  const { controller, background, photos, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  await controller.playPhoto('a', 'preview-a', { explicit: true });
  clock.advance(300);
  const photo = photos[0];
  const previousBackground = background.volume;
  const previousPhoto = photo.volume;
  await controller.playBackground();
  near(background.volume, previousBackground);
  near(photo.volume, previousPhoto);
  clock.advance(900);
  assert.equal(background.paused, false);
  assert.equal(photo.paused, true);
  near(background.volume, 0.48);
  near(photo.volume, 0);
  assert.equal(controller.getState().backgroundPlaying, true);
});

test('sequential transitions pause outgoing media before any incoming play when volume cannot change', async () => {
  const { controller, background, photos, playbackStarts, clock } = fixture({
    sequentialTransitions: true, volumeUnsupported: true
  });
  assert.equal(await controller.playBackground(), true);
  background.currentTime = 5.25;
  assert.equal(await controller.playPhoto('a', 'preview-a', { explicit: true }), true);
  const photo = photos[0];
  assert.equal(background.paused, true);
  assert.equal(photo.paused, false);
  photo.currentTime = 12.75;
  assert.equal(await controller.playBackground(), true);
  assert.equal(photo.paused, true);
  assert.equal(background.paused, false);
  assert.equal(await controller.playPhoto('a', 'preview-a'), true);
  clock.advance(1000);
  assert.equal(background.paused, true);
  assert.equal(photo.paused, false);
  assert.equal(background.currentTime, 5.25);
  assert.equal(photo.currentTime, 12.75);
  assert.equal(background.volume, 1, 'The fake hardware ignores requested volume changes.');
  assert.equal(photo.volume, 1);
  assert.deepEqual(playbackStarts.map(start => start.id), [0, 1, 0, 1]);
  assert.ok(playbackStarts.every(start => start.activeCount === 0),
    'Every outgoing source must already be paused before an incoming play is called.');
  assert.equal(photos.length, 1);
});

test('media-error retry reloads and restores position while permission retry does not reload', async () => {
  const { controller, background, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  background.currentTime = 9.375;
  background.dispatchEvent(new Event('error'));
  assert.equal(controller.getState().error, 'unavailable');
  assert.equal(background.paused, true);
  assert.equal(background.loadCalls, 0);
  background.deferred = true;
  const retried = controller.playBackground({ explicit: true });
  assert.equal(background.loadCalls, 1);
  assert.equal(background.currentTime, 0, 'Reload loses the native media position until metadata arrives.');
  background.metadata();
  assert.equal(background.currentTime, 9.375);
  background.pending[0].resolve();
  assert.equal(await retried, true);
  clock.advance(900);
  assert.equal(background.paused, false);
  assert.deepEqual(background.seeks, [9.375, 9.375]);

  const blocked = fixture({ deferred: true });
  blocked.background.currentTime = 6.5;
  const denied = blocked.controller.playBackground({ explicit: true });
  blocked.background.pending[0].reject(Object.assign(new Error('Playback denied'), {
    name: 'NotAllowedError'
  }));
  assert.equal(await denied, false);
  assert.equal(blocked.controller.getState().error, 'blocked');
  const allowed = blocked.controller.playBackground({ explicit: true });
  assert.equal(blocked.background.loadCalls, 0,
    'Permission denial must not discard already loaded media.');
  assert.equal(blocked.background.currentTime, 6.5);
  blocked.background.pending[1].resolve();
  assert.equal(await allowed, true);
  blocked.clock.advance(900);
  assert.equal(blocked.background.paused, false);
  assert.deepEqual(blocked.background.seeks, [6.5]);
});
