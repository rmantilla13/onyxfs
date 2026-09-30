// lib/waveform.js — a sound's shape, small enough to ride in its row.
//
// An audio file's waveform is WAVEFORM_BARS loudness values, one byte each:
// the RMS of the samples in that stretch of the file, scaled so the loudest
// stretch is 255. RMS rather than the peak sample because a mastered track
// peaks at full scale nearly everywhere, and a row of full-height bars says
// nothing; loudness shows the intro, the verses, the gaps between words.
//
// Stored in the row's metadata as "1:<base64>" — 344 characters for 256
// bars — so the listing that draws a tile already has it: no second request
// per tile, no object in the bucket, nothing to presign. The leading "1" is
// the format, so a later one (more bars, a second value per bar) can be told
// apart from this one by everything that reads it.
//
// It is one of the media keys (lib/media.js MEDIA_KEYS): the server's to fill
// in from what it has checked (waveformFacts), never a metadata edit's, and
// cleared with the rest when a file's contents are replaced.
//
// Plain functions with no imports, shared by the server (checking what a
// client sends), the browser (making one, drawing one) and the tests. Onyx
// for Mac and iOS read and make the same format (OnyxKit Waveform.swift).

/** The format this module writes. */
export const WAVEFORM_FORMAT = 1;

/** How many bars a waveform is made with. Anything drawing one resamples it (waveformBars). */
export const WAVEFORM_BARS = 256;

// What a stored waveform may be: fewer bars than this is not a shape, more
// is not something any surface draws.
const MIN_BARS = 16;
const MAX_BARS = 1024;

const PATTERN = /^1:([A-Za-z0-9+/]+={0,2})$/;

/**
 * Loudness bars from decoded samples: `channels` is one Float32Array per
 * channel (an AudioBuffer's getChannelData), all the same length. Channels
 * are folded together — the RMS of every sample in the stretch, whichever
 * channel it is in — so a stereo file and its mono mix draw alike.
 *
 * → a Uint8Array of `bars` values (fewer for a sound with fewer samples than
 * that), the loudest 255; all zeros for silence; null for no samples.
 */
export function waveformFromSamples(channels, bars = WAVEFORM_BARS) {
  const list = (Array.isArray(channels) ? channels : [channels]).filter((c) => c && c.length > 0);
  if (!list.length) return null;
  const length = Math.min(...list.map((c) => c.length));
  const n = Math.max(1, Math.min(Math.floor(bars), length));
  const sums = new Float64Array(n);
  const counts = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * length) / n));
    let sum = 0;
    for (const c of list) {
      for (let j = from; j < to; j++) sum += c[j] * c[j];
    }
    sums[i] = sum;
    counts[i] = (to - from) * list.length;
  }
  return waveformFromEnergy(sums, counts);
}

/**
 * Loudness bars from what a reader that never holds the whole sound adds up
 * as it goes (lib/waveform-client.js reading a WAV in pieces): for each bar,
 * the sum of its samples' squares and how many samples that is, in any
 * consistent unit — the bars are scaled to the loudest anyway. A bar with no
 * samples, or one that is not a number, is silence.
 */
export function waveformFromEnergy(sums, counts) {
  const n = Math.min(sums?.length || 0, counts?.length || 0);
  if (!n) return null;
  const rms = new Float64Array(n);
  let loudest = 0;
  for (let i = 0; i < n; i++) {
    const v = counts[i] > 0 ? Math.sqrt(sums[i] / counts[i]) : 0;
    rms[i] = Number.isFinite(v) ? v : 0;
    if (rms[i] > loudest) loudest = rms[i];
  }
  const out = new Uint8Array(n);
  if (loudest > 0) for (let i = 0; i < n; i++) out[i] = Math.round((rms[i] / loudest) * 255);
  return out;
}

/** Bars → the stored string, or null when they are not a waveform's. */
export function encodeWaveform(bars) {
  if (!bars || typeof bars.length !== 'number' || bars.length < MIN_BARS || bars.length > MAX_BARS) return null;
  let binary = '';
  for (let i = 0; i < bars.length; i++) {
    const v = Number(bars[i]);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    binary += String.fromCharCode(v);
  }
  return `${WAVEFORM_FORMAT}:${btoa(binary)}`;
}

/** The stored string → its bars (a Uint8Array), or null when it is not one this reads. */
export function decodeWaveform(value) {
  if (typeof value !== 'string' || value.length > 8 + Math.ceil(MAX_BARS / 3) * 4) return null;
  const m = PATTERN.exec(value);
  if (!m) return null;
  let binary;
  try {
    binary = atob(m[1]);
  } catch {
    return null;
  }
  if (binary.length < MIN_BARS || binary.length > MAX_BARS) return null;
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * A waveform a client sends, kept only when it decodes to one: the string as
 * this module would write it, or null. Written again from its bars rather
 * than stored as sent, so padding or any other slack in the base64 never
 * reaches a row.
 */
export function waveformFacts(input) {
  const bars = decodeWaveform(input);
  return bars ? encodeWaveform(bars) : null;
}

/**
 * `bars` resampled to `count` for drawing, as numbers from 0 to 1. Fewer:
 * each is the loudness of the stretch it covers — the RMS of its bars, which
 * is the RMS of their samples, since each bar is one — and all are scaled
 * again so the loudest fills the height, as it does at full size. The
 * loudest of each group would be simpler, and would draw ten bars of speech
 * as a solid block. More than there are: the bars as they are — stretching
 * them would only draw the same shape wider.
 */
export function waveformBars(bars, count) {
  if (!bars || !bars.length) return [];
  const want = Math.max(1, Math.floor(count));
  if (want >= bars.length) return Array.from(bars, (v) => v / 255);
  const out = new Array(want);
  let loudest = 0;
  for (let i = 0; i < want; i++) {
    const from = Math.floor((i * bars.length) / want);
    const to = Math.max(from + 1, Math.floor(((i + 1) * bars.length) / want));
    let sum = 0;
    for (let j = from; j < to; j++) sum += bars[j] * bars[j];
    out[i] = Math.sqrt(sum / (to - from));
    if (out[i] > loudest) loudest = out[i];
  }
  return out.map((v) => (loudest > 0 ? v / loudest : 0));
}
