import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMediaPlaybackController } from '../src/media-playback.ts';

class FakeMedia extends EventTarget {
  readyState = 0;
  duration = 120;
  paused = true;
  ended = false;
  seeking = false;
  time = 0;
  playTimes = [];
  load() {}
  get currentTime() { return this.time; }
  set currentTime(value) {
    assert.ok(this.readyState >= 1, 'seek must wait for metadata');
    this.time = value;
    this.seeking = true;
  }
  metadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event('loadedmetadata'));
  }
  settleSeek() {
    this.seeking = false;
    this.readyState = 2;
    this.dispatchEvent(new Event('seeked'));
  }
  async play() {
    assert.equal(this.seeking, false, 'play must wait for restored frame');
    this.playTimes.push(this.time);
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
}
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
  const media = new FakeMedia();
  let creations = 0;
  let destructions = 0;
  const controller = createMediaPlaybackController({
    durationFallback: 120,
    createElement: async () => { creations++; return media; },
    destroyElement: () => { destructions++; media.pause(); },
    ...options,
  });
  return { ...controller, media, creations: () => creations, destructions: () => destructions };
}

test('first seek loads media without playing and displays target immediately', async () => {
  const f = fixture();
  const seeking = f.controls.seek(42);
  assert.equal(f.controls.currentTime(), 42);
  await flush();
  assert.equal(f.creations(), 1);
  assert.equal(f.media.time, 0);
  f.media.metadata();
  await flush();
  assert.equal(f.media.time, 42);
  f.media.settleSeek();
  await seeking;
  assert.equal(f.controls.currentTime(), 42);
  assert.equal(f.controls.isPlaying(), false);
  assert.deepEqual(f.media.playTimes, []);
  f.destroy();
});

test('saved position is displayed before loading and restored before play', async () => {
  const f = fixture({ initialTime: 31.75 });
  assert.equal(f.controls.currentTime(), 31.75);
  assert.equal(f.controls.duration(), 120);
  const playing = f.controls.toggle();
  await flush();
  f.media.metadata();
  await flush();
  assert.deepEqual(f.media.playTimes, []);
  f.media.settleSeek();
  await playing;
  assert.deepEqual(f.media.playTimes, [31.75]);
  f.destroy();
});

test('latest drag target wins during both metadata loading and an in-flight seek', async () => {
  const f = fixture();
  const first = f.controls.seek(10);
  const second = f.controls.seek(20);
  await flush();
  f.media.metadata();
  await flush();
  assert.equal(f.media.time, 20);
  const third = f.controls.seek(80);
  assert.equal(f.controls.currentTime(), 80);
  f.media.settleSeek();
  await flush();
  assert.equal(f.media.time, 80);
  f.media.settleSeek();
  await Promise.all([first, second, third]);
  assert.equal(f.creations(), 1);
  assert.equal(f.controls.currentTime(), 80);
  f.destroy();
});

test('destroy while waiting for metadata cancels playback and releases the element', async () => {
  const f = fixture({ initialTime: 20 });
  const playing = f.controls.toggle();
  await flush();
  f.destroy();
  await playing;
  assert.equal(f.destructions(), 1);
  assert.deepEqual(f.media.playTimes, []);
});

test('destroy while waiting for seek completion never plays', async () => {
  const f = fixture({ initialTime: 20 });
  const playing = f.controls.toggle();
  await flush();
  f.media.metadata();
  await flush();
  f.destroy();
  await playing;
  assert.deepEqual(f.media.playTimes, []);
});

test('late element creation is destroyed after switching away', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const f = fixture({ createElement: () => pending });
  const playing = f.controls.toggle();
  await flush();
  f.destroy();
  resolve(f.media);
  await playing;
  assert.equal(f.destructions(), 1);
  assert.deepEqual(f.media.playTimes, []);
});

test('pause during restoration cancels the requested playback', async () => {
  const f = fixture({ initialTime: 20 });
  const playing = f.controls.toggle();
  await flush();
  await f.controls.toggle();
  f.media.metadata();
  await flush();
  f.media.settleSeek();
  await playing;
  assert.deepEqual(f.media.playTimes, []);
  f.destroy();
});

test('media failure rejects and a later attempt can recreate the element', async () => {
  const f = fixture();
  const failed = f.controls.seek(20);
  const rejection = assert.rejects(failed, /媒体加载失败/);
  await flush();
  f.media.dispatchEvent(new Event('error'));
  await rejection;
  assert.equal(f.controls.isLoading(), false);
  const retry = f.controls.seek(30);
  await flush();
  f.media.metadata();
  await flush();
  f.media.settleSeek();
  await retry;
  assert.equal(f.creations(), 2);
  assert.equal(f.controls.currentTime(), 30);
  f.destroy();
});

test('a video at the end restarts from zero before playing again', async () => {
  const f = fixture({ initialTime: 0 });
  f.media.readyState = 2;
  await f.controls.toggle();
  f.media.pause();
  f.media.time = 120;
  f.media.ended = true;
  f.media.dispatchEvent(new Event('ended'));
  assert.equal(f.controls.currentTime(), 0);
  const replay = f.controls.toggle();
  await flush();
  assert.equal(f.media.time, 0);
  f.media.ended = false;
  f.media.settleSeek();
  await replay;
  assert.deepEqual(f.media.playTimes, [0, 0]);
  f.destroy();
});

test('seeking while playing preserves playback and pause preserves its position', async () => {
  const f = fixture();
  f.media.readyState = 2;
  await f.controls.toggle();
  const seek = f.controls.seek(55);
  await flush();
  f.media.settleSeek();
  await seek;
  assert.equal(f.controls.isPlaying(), true);
  await f.controls.toggle();
  assert.equal(f.controls.isPlaying(), false);
  assert.equal(f.controls.currentTime(), 55);
  f.destroy();
});

test('play waits for a new seek started by the previous seek completion notification', async () => {
  const f = fixture({ initialTime: 5 });
  let queued;
  let didQueue = false;
  f.controls.subscribe(() => {
    if (!didQueue && f.media.time === 5 && !f.media.seeking) {
      didQueue = true;
      queued = f.controls.seek(20);
    }
  });
  const playing = f.controls.toggle();
  await flush();
  f.media.metadata();
  await flush();
  f.media.settleSeek();
  await flush();
  assert.equal(f.media.time, 20);
  assert.deepEqual(f.media.playTimes, []);
  f.media.settleSeek();
  await Promise.all([playing, queued]);
  assert.deepEqual(f.media.playTimes, [20]);
  f.destroy();
});

test('failure after metadata during a seek releases the failed element and retries with a new one', async () => {
  const first = new FakeMedia();
  const second = new FakeMedia();
  const elements = [first, second];
  let destroyed = 0;
  const f = fixture({
    createElement: async () => elements.shift(),
    destroyElement: () => { destroyed++; },
  });
  const failed = f.controls.seek(20);
  const rejection = assert.rejects(failed, /媒体加载失败/);
  await flush();
  first.metadata();
  await flush();
  first.dispatchEvent(new Event('error'));
  await rejection;
  assert.equal(destroyed, 1);
  const retry = f.controls.toggle();
  await flush();
  second.metadata();
  await flush();
  second.settleSeek();
  await retry;
  assert.deepEqual(second.playTimes, [20]);
  f.destroy();
});

test('saved duration longer than actual media clamps the displayed target before seeked listeners run', async () => {
  const f = fixture({ durationFallback: 200 });
  f.media.duration = 60;
  let displayedAtSeeked;
  f.media.addEventListener('seeked', () => { displayedAtSeeked = f.controls.currentTime(); });
  const seeking = f.controls.seek(180);
  await flush();
  f.media.metadata();
  await flush();
  assert.equal(f.media.time, 59.95);
  f.media.settleSeek();
  await seeking;
  assert.equal(displayedAtSeeked, f.media.time);
  assert.equal(f.controls.currentTime(), 59.95);
  assert.equal(f.controls.isPlaying(), false);
  f.destroy();
});
