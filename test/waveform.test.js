// A sound's waveform (lib/waveform.js): drawn from samples, stored as a short
// string, checked when a client sends one, and resampled to draw.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  waveformFromSamples, encodeWaveform, decodeWaveform, waveformFacts, waveformBars, WAVEFORM_BARS,
} from '../lib/waveform.js';
import { uploadFields, sharedFile } from '../lib/media.js';

/** `seconds` of a sine at `amp`, at 8 kHz. */
const tone = (seconds, amp, rate = 8000) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => amp * Math.sin(i / 3));

describe('drawing one', () => {
  test('loudness per stretch, the loudest 255', () => {
    // Quiet, loud, silent: a quarter, a half, a quarter.
    const samples = new Float32Array([...tone(1, 0.1), ...tone(2, 0.8), ...new Float32Array(8000)]);
    const bars = waveformFromSamples([samples], 4);
    assert.equal(bars.length, 4);
    assert.equal(bars[1], 255);
    assert.equal(bars[2], 255);
    assert.equal(bars[3], 0, 'silence is nothing');
    assert.ok(Math.abs(bars[0] - 255 / 8) <= 1, `a tone an eighth as loud draws an eighth as tall (${bars[0]})`);
  });

  test('channels fold together, so stereo and its mono mix look alike', () => {
    const left = tone(2, 0.5);
    const stereo = waveformFromSamples([left, left]);
    const mono = waveformFromSamples([left]);
    assert.deepEqual([...stereo], [...mono]);
    assert.equal(stereo.length, WAVEFORM_BARS);
  });

  test('silence is all zeros; nothing is null; fewer samples than bars is that many bars', () => {
    assert.ok(waveformFromSamples([new Float32Array(10000)]).every((v) => v === 0));
    assert.equal(waveformFromSamples([]), null);
    assert.equal(waveformFromSamples([new Float32Array(0)]), null);
    assert.equal(waveformFromSamples([tone(0.005, 0.5)]).length, 40);
  });

  test('a stretch with a sample that is not a number draws as silence, rather than poisoning the file', () => {
    const samples = tone(1, 0.5);
    samples[10] = NaN;
    const bars = waveformFromSamples([samples], 16);
    assert.equal(bars[0], 0);
    assert.equal(Math.max(...bars), 255);
  });
});

describe('storing one', () => {
  const bars = Uint8Array.from({ length: 256 }, (_, i) => i);

  test('round-trips through its string, which is short', () => {
    const s = encodeWaveform(bars);
    assert.match(s, /^1:[A-Za-z0-9+/]+=*$/);
    assert.equal(s.length, 2 + 344);
    assert.deepEqual([...decodeWaveform(s)], [...bars]);
  });

  test('only a waveform is written', () => {
    assert.equal(encodeWaveform(new Uint8Array(8)), null, 'too few bars');
    assert.equal(encodeWaveform(new Uint8Array(2000)), null, 'too many');
    assert.equal(encodeWaveform([...bars.slice(0, 20), 300]), null, 'past a byte');
    assert.equal(encodeWaveform(null), null);
  });

  test('a client’s is kept only when it reads, and written again as this module writes it', () => {
    const s = encodeWaveform(bars);
    assert.equal(waveformFacts(s), s);
    for (const bad of [null, 1, {}, '', '1:', '1:@@@@', '2:' + s.slice(2), s + ' ', `1:${btoa('short')}`, `1:${'A'.repeat(5000)}`]) {
      assert.equal(waveformFacts(bad), null, JSON.stringify(bad));
    }
  });

  test('uploadFields keeps a sound’s, from the body alone, and no one else’s', () => {
    const s = encodeWaveform(bars);
    assert.equal(uploadFields({ name: 'a.m4a', mime: 'audio/mp4', waveform: s }).metadata.waveform, s);
    assert.equal(uploadFields({ name: 'a.mov', mime: 'video/quicktime', waveform: s }).metadata.waveform, undefined);
    assert.equal(uploadFields({ name: 'a.m4a', mime: 'audio/mp4', metadata: { waveform: s } }).metadata.waveform, undefined,
      'a media key, never taken from metadata as sent');
    assert.equal(uploadFields({ name: 'a.m4a', mime: 'audio/mp4', waveform: 'junk' }).metadata.waveform, undefined);
  });

  test('a share link hands it out with the other media facts', () => {
    const s = encodeWaveform(bars);
    const out = sharedFile({ id: 'f', name: 'a.m4a', metadata: { waveform: s, duration: 30, client: 'Acme' } });
    assert.deepEqual(out.metadata, { duration: 30, waveform: s });
  });
});

describe('drawing it at a size', () => {
  test('fewer bars are the loudness of what they cover, the loudest filling the height', () => {
    const bars = Uint8Array.from([0, 200, 0, 0, 40, 0, 0, 0]);
    const four = waveformBars(bars, 4);
    assert.equal(four[0], 1);
    assert.ok(Math.abs(four[2] - 0.2) < 1e-12, 'a fifth as loud as the loudest');
    assert.deepEqual([four[1], four[3]], [0, 0]);
    assert.deepEqual(waveformBars(bars, 1), [1]);
    // Speech — loud words, quiet gaps — keeps its shape at ten bars rather
    // than every bar reaching the top.
    const speech = Uint8Array.from({ length: 256 }, (_, i) => (i % 16 < 10 ? 255 : 10) * (i < 128 ? 1 : 0.4));
    const ten = waveformBars(speech, 10);
    assert.ok(ten.slice(6).every((v) => v < 0.5), JSON.stringify(ten));
  });

  test('more than there are is the bars as they are', () => {
    const bars = Uint8Array.from([0, 255, 51]);
    assert.deepEqual(waveformBars(bars, 10), [0, 1, 0.2]);
    assert.deepEqual(waveformBars(null, 10), []);
  });
});
