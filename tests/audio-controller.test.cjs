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

function fixture({ deferred = false, sequentialTransitions = false, volumeUnsupported = false,
  backgroundGain = false, makeAudioContext } = {}) {
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
    backgroundGain,
    ...(makeAudioContext ? { makeAudioContext } : {}),
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

function contextFixture(failures = {}) {
  const contexts = [];
  const trace = [];
  const makeAudioContext = () => {
    if (failures.construction) throw new Error('Audio context unavailable');
    const context = {
      state: 'suspended', currentTime: 0, destination: {}, sourceCalls: 0,
      resumeCalls: 0, closeCalls: 0, directConnections: 0, samples: [],
      createGain() {
        const parameter = {
          value: 1,
          setValueAtTime(value) {
            if (failures.gainWrite) throw new Error('Gain update unavailable');
            this.value = value;
            context.samples.push({ value });
          }
        };
        context.gainNode = {
          gain: parameter,
          connect() { if (failures.destination) throw new Error('Destination unavailable'); },
          disconnect() {}
        };
        return context.gainNode;
      },
      createMediaElementSource(audio) {
        context.sourceCalls += 1;
        assert.equal(context.sourceCalls, 1, 'A media element can only be attached once.');
        context.audio = audio;
        return {
          connect(target) {
            if (target === context.destination) {
              if (failures.direct) throw new Error('Direct output unavailable');
              context.directConnections += 1;
            } else if (failures.sourceGain) throw new Error('Gain connection unavailable');
          },
          disconnect() {}
        };
      },
      resume() {
        context.resumeCalls += 1;
        trace.push('context.resume');
        if (failures.resume) return Promise.reject(Object.assign(new Error('Gesture required'), {
          name: 'NotAllowedError'
        }));
        if (failures.deferredResume) return new Promise(resolve => {
          context.finishResume = () => { context.state = 'running'; resolve(); };
        });
        context.state = 'running';
        return Promise.resolve();
      },
      close() { context.closeCalls += 1; context.state = 'closed'; return Promise.resolve(); }
    };
    contexts.push(context);
    return context;
  };
  const media = fixture({ backgroundGain: true, makeAudioContext,
    sequentialTransitions: true, volumeUnsupported: true });
  return { ...media, contexts, trace, failures };
}

test('local background gain is lazy, begins at zero and fades on hardware-volume platforms', async () => {
  const { controller, background, clock, contexts, trace } = contextFixture();
  assert.equal(contexts.length, 0, 'No context should exist before a playback gesture.');
  background.beforePlay = () => {
    trace.push('media.play');
    near(contexts[0].gainNode.gain.value, 0);
    assert.equal(contexts[0].audio, background);
  };
  assert.equal(await controller.playBackground({ explicit: true }), true);
  const context = contexts[0];
  assert.deepEqual(trace, ['context.resume', 'media.play']);
  near(context.gainNode.gain.value, 0);
  clock.advance(450);
  near(context.gainNode.gain.value, 0.24);
  clock.advance(450);
  near(context.gainNode.gain.value, 0.48);
  assert.equal(background.volume, 1, 'Gain is applied once, outside hardware-controlled media volume.');
  monotonic(context.samples, true);
  assert.equal(controller.getState().backgroundPlaying, true);
  controller.destroy();
  assert.equal(context.closeCalls, 1);
});

test('gain pause and suspension preserve position and reuse the source when the context resumes', async () => {
  const { controller, background, clock, contexts } = contextFixture();
  await controller.playBackground();
  clock.advance(900);
  const context = contexts[0];
  background.currentTime = 18.5;
  controller.pause();
  clock.advance(175);
  near(context.gainNode.gain.value, 0.24);
  assert.equal(background.paused, false);
  clock.advance(175);
  near(context.gainNode.gain.value, 0);
  assert.equal(background.paused, true);
  context.state = 'suspended';
  await controller.resume();
  clock.advance(900);
  near(context.gainNode.gain.value, 0.48);
  assert.equal(context.resumeCalls, 2);
  assert.equal(background.currentTime, 18.5);
  controller.suspend();
  near(context.gainNode.gain.value, 0);
  assert.equal(background.paused, true);
  context.state = 'suspended';
  await controller.resumeFromSuspension();
  clock.advance(900);
  assert.equal(context.resumeCalls, 3);
  assert.equal(context.sourceCalls, 1);
  assert.equal(contexts.length, 1);
  assert.deepEqual(background.seeks, [18.5]);
  controller.destroy();
});

test('a full-length background uses the gain node for its tail and waits for explicit replay', async () => {
  const { controller, background, clock, contexts } = contextFixture();
  background.duration = 290.325;
  await controller.playBackground();
  clock.advance(900);
  const context = contexts[0];
  background.currentTime = background.duration - 0.75;
  background.dispatchEvent(new Event('timeupdate'));
  near(context.gainNode.gain.value, 0.24);
  background.finish();
  near(context.gainNode.gain.value, 0);
  assert.equal(await controller.playBackground(), false);
  assert.equal(background.playCalls, 1);
  background.beforePlay = () => assert.equal(background.currentTime, 0);
  assert.equal(await controller.playBackground({ explicit: true }), true);
  assert.equal(context.sourceCalls, 1);
  clock.advance(900);
  near(context.gainNode.gain.value, 0.48);
  controller.destroy();
});

test('remote photos stay native and iOS transitions pause outgoing media before playing', async () => {
  const { controller, background, photos, clock, contexts, playbackStarts } = contextFixture();
  await controller.playPhoto('remote', 'preview-remote', { explicit: true });
  assert.equal(contexts.length, 0, 'A third-party preview must not create a Web Audio context.');
  await controller.playBackground();
  clock.advance(900);
  assert.equal(photos[0].paused, true);
  near(contexts[0].gainNode.gain.value, 0.48);
  await controller.playPhoto('remote', 'preview-remote');
  assert.equal(background.paused, true);
  near(contexts[0].gainNode.gain.value, 0);
  assert.equal(photos[0].paused, false);
  assert.equal(contexts[0].sourceCalls, 1);
  assert.ok(playbackStarts.every(start => start.activeCount === 0));
  controller.destroy();
});

test('unavailable context and destination construction retain native playback', async () => {
  const absent = fixture({ backgroundGain: true, makeAudioContext: () => null });
  assert.equal(await absent.controller.playBackground(), true);
  absent.clock.advance(900);
  near(absent.background.volume, 0.48);
  absent.controller.destroy();

  const failed = contextFixture({ destination: true });
  assert.equal(await failed.controller.playBackground(), true);
  assert.equal(failed.contexts[0].sourceCalls, 0,
    'An incomplete destination must not capture the media element.');
  assert.equal(failed.contexts[0].closeCalls, 1);
  assert.equal(failed.background.paused, false);
  assert.equal(failed.controller.getState().backgroundPlaying, true);
  failed.controller.destroy();
});

test('a failed gain connection keeps attached media audible through a direct route', async () => {
  const { controller, contexts, background } = contextFixture({ sourceGain: true });
  assert.equal(await controller.playBackground(), true);
  const context = contexts[0];
  assert.equal(context.sourceCalls, 1);
  assert.equal(context.directConnections, 1);
  assert.equal(background.paused, false);
  assert.equal(controller.getState().backgroundPlaying, true);
  controller.pause({ immediate: true });
  await controller.resume();
  assert.equal(context.sourceCalls, 1);
  assert.equal(context.directConnections, 1);
  controller.destroy();
});

test('context permission failure is recoverable and does not misreport silent playback', async () => {
  const { controller, contexts, background, failures, clock } = contextFixture({ resume: true });
  assert.equal(await controller.playBackground(), false);
  assert.equal(controller.getState().error, 'blocked');
  assert.equal(controller.getState().playing, false);
  assert.equal(background.paused, true);
  near(contexts[0].gainNode.gain.value, 0);
  failures.resume = false;
  assert.equal(await controller.playBackground({ explicit: true }), true);
  assert.equal(contexts[0].sourceCalls, 1);
  assert.equal(background.loadCalls, 0, 'Output permission failure must not discard media position.');
  clock.advance(900);
  assert.equal(controller.getState().backgroundPlaying, true);
  controller.destroy();
});

test('a late context resume cannot revive media after mute', async () => {
  const { controller, contexts, background, clock } = contextFixture({ deferredResume: true });
  const playback = controller.playBackground();
  assert.equal(controller.getState().state, 'loading');
  assert.equal(controller.getState().playing, false);
  controller.pause({ immediate: true });
  contexts[0].finishResume();
  assert.equal(await playback, false);
  clock.advance(1000);
  assert.equal(background.paused, true);
  near(contexts[0].gainNode.gain.value, 0);
  assert.equal(controller.getState().desired, false);
  controller.destroy();
});

test('a gain update failure reroutes attached media without throwing from the animation frame', async () => {
  const { controller, contexts, clock, failures, background } = contextFixture();
  await controller.playBackground();
  clock.advance(900);
  failures.gainWrite = true;
  assert.doesNotThrow(() => clock.advance(25));
  assert.equal(contexts[0].directConnections, 1);
  assert.equal(background.paused, false);
  assert.equal(controller.getState().backgroundPlaying, true);
  controller.destroy();
});

test('a completely unavailable output reports an error and never claims silent playback', async () => {
  const { controller, contexts, failures, clock, background } = contextFixture();
  await controller.playBackground();
  clock.advance(900);
  failures.gainWrite = true;
  failures.direct = true;
  assert.doesNotThrow(() => clock.advance(25));
  assert.equal(contexts[0].sourceCalls, 1);
  assert.equal(controller.getState().state, 'error');
  assert.equal(controller.getState().error, 'unavailable');
  assert.equal(controller.getState().playing, false);
  assert.equal(background.paused, true);
  controller.destroy();
});

test('an interrupted context that never resumes times out even while media remains unpaused', async () => {
  const { controller, contexts, failures, clock, background } = contextFixture();
  await controller.playBackground();
  clock.advance(900);
  background.currentTime = 24.5;
  contexts[0].state = 'suspended';
  failures.deferredResume = true;
  const resumed = controller.playBackground();
  assert.equal(controller.getState().state, 'loading');
  assert.equal(background.paused, false);
  clock.advance(12000);
  assert.equal(controller.getState().state, 'error');
  assert.equal(controller.getState().error, 'unavailable');
  assert.equal(controller.getState().playing, false);
  assert.equal(background.paused, true);
  near(contexts[0].gainNode.gain.value, 0);
  contexts[0].finishResume();
  assert.equal(await resumed, false, 'Late recovery must not undo the timeout.');
  assert.equal(background.paused, true);
  assert.equal(background.currentTime, 24.5);
  controller.destroy();
});

test('canceling a pending photo keeps audible background and prevents a stale photo from starting', async () => {
  const { controller, background, photos, clock } = fixture();
  await controller.playBackground();
  clock.advance(900);
  background.currentTime = 10.5;
  const backgroundPauseCount = background.pauseTransitions;
  const oldPhoto = controller.playPhoto('old', 'preview-old');
  // Its initial synchronous play is complete, so force a buffering request.
  const photo = photos[0];
  photo.deferred = true;
  photo.dispatchEvent(new Event('waiting'));
  controller.cancelPending();
  assert.equal(background.paused, false);
  assert.equal(controller.getState().backgroundPlaying, true);
  assert.equal(controller.getState().target, 'background');
  photo.paused = false;
  photo.dispatchEvent(new Event('playing'));
  assert.equal(photo.paused, true);
  assert.equal(await oldPhoto, false);
  clock.advance(900);
  assert.equal(background.pauseTransitions, backgroundPauseCount);
  assert.equal(background.currentTime, 10.5);
  assert.equal(controller.getState().backgroundPlaying, true);
  controller.destroy();
});

test('canceling deferred media before the next selection cannot revive the old photo', async () => {
  const { controller, photos, clock } = fixture({ deferred: true });
  const oldPhoto = controller.playPhoto('old', 'preview-old');
  controller.cancelPending();
  const newPhoto = controller.playPhoto('new', 'preview-new');
  photos[1].pending[0].resolve();
  assert.equal(await newPhoto, true);
  photos[0].pending[0].resolve();
  assert.equal(await oldPhoto, false);
  clock.advance(900);
  assert.equal(photos[0].paused, true);
  assert.equal(photos[1].paused, false);
  assert.equal(controller.getState().trackId, 'new');
  controller.destroy();
});

test('iOS photo preparation contains only silence and reuses the element for its actual track', async () => {
  const { controller, photos, background } = fixture({ sequentialTransitions: true, volumeUnsupported: true });
  controller.preparePhoto('123');
  const photo = photos[0];
  const pcm = Buffer.from(photo.src.split(',')[1], 'base64');
  assert.equal(pcm.toString('ascii', 0, 4), 'RIFF');
  assert.equal(pcm.readUInt32LE(4) + 8, pcm.length, 'The silent WAV must remain valid.');
  assert.equal(pcm.readUInt16LE(34), 8);
  assert.equal(pcm.readUInt32LE(40), 400);
  assert.ok(pcm.subarray(44).every(value => value === 128), 'All PCM samples must be digital silence.');
  assert.equal(controller.getState().playing, false, 'Preparation must not appear as a playing photo.');
  await Promise.resolve();
  assert.equal(photo.paused, true);
  assert.equal(await controller.playPhoto('123', 'preview-123'), true);
  assert.equal(photos.length, 1);
  assert.equal(photo.src, 'preview-123');
  assert.equal(photo.loadCalls, 1);
  assert.equal(photo.playCalls, 2);
  assert.equal(background.playCalls, 0);
  photo.metadata();
  photo.currentTime = 7.25;
  controller.pause({ immediate: true });
  controller.preparePhoto('123');
  await controller.playPhoto('123', 'preview-123');
  assert.equal(photo.currentTime, 7.25);
  assert.equal(photo.loadCalls, 1, 'An already loaded song must keep its saved position.');
  controller.destroy();
});

test('late silence completion cannot pause the actual photo track', async () => {
  const { controller, photos } = fixture({ deferred: true, sequentialTransitions: true });
  controller.preparePhoto('123');
  const photo = photos[0];
  const playback = controller.playPhoto('123', 'preview-123');
  photo.pending[1].resolve();
  assert.equal(await playback, true);
  photo.currentTime = 4.25;
  photo.pending[0].resolve();
  await Promise.resolve();
  assert.equal(photo.paused, false);
  assert.equal(photo.currentTime, 4.25);
  assert.equal(controller.getState().trackId, '123');
  assert.equal(photos.length, 1);
  controller.destroy();
});

test('canceling photo preparation silences its delayed playback without changing the current selection', async () => {
  const { controller, photos, background } = fixture({ deferred: true, sequentialTransitions: true });
  controller.preparePhoto('123');
  const photo = photos[0];
  controller.cancelPreparation();
  photo.pending[0].resolve();
  await Promise.resolve();
  assert.equal(photo.paused, true);
  assert.equal(controller.getState().target, null);
  assert.equal(controller.getState().playing, false);
  assert.equal(background.playCalls, 0);
  const playback = controller.playPhoto('123', 'preview-123');
  assert.equal(photo.loadCalls, 1, 'A canceled silent resource must not leave its old ended/error state.');
  photo.pending[1].resolve();
  assert.equal(await playback, true);
  controller.destroy();
});

test('mute cancels preparation and the following real media promise', async () => {
  const { controller, photos } = fixture({ deferred: true, sequentialTransitions: true });
  controller.preparePhoto('123');
  const photo = photos[0];
  const playback = controller.playPhoto('123', 'preview-123');
  controller.pause({ immediate: true });
  photo.pending[0].resolve();
  photo.pending[1].resolve();
  assert.equal(await playback, false);
  await Promise.resolve();
  assert.equal(photo.paused, true);
  assert.equal(controller.getState().desired, false);
  assert.equal(controller.getState().playing, false);
  controller.destroy();
});

test('native-volume browsers do not need a silent preparation resource', () => {
  const { controller, photos } = fixture();
  controller.preparePhoto('123');
  assert.equal(photos.length, 0);
  controller.destroy();
});
