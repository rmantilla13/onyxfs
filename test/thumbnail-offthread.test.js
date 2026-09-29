// Image previews drawn in a worker (lib/thumbnail-offthread.js,
// lib/thumbnail-render.js): the renditions the page would have drawn, or none
// and the page draws them.
//
// The browser is stood in for — an <img> that reports a size, canvases that
// record what is drawn onto them and encoded from them, and a Worker that
// runs lib/thumbnail-render.js in this process — so what is checked is every
// step's arithmetic and order: sizes, formats, qualities, what is kept. The
// pixels are the benchmark's (scripts/bench-thumbnails.mjs).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { makeThumbnail } from '../lib/thumbnail-client.js';
import { renderImage, imagePlan, workerCaps } from '../lib/thumbnail-render.js';
import { createOffThread, offThreadUsable } from '../lib/thumbnail-offthread.js';
import { imageHeaderSize } from '../lib/image-header.js';

// makeThumbnail's 20-second race and the like are never waited out here: a
// long timer does not keep this process up once the tests are done.
const setTimeout_ = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = setTimeout_(fn, ms, ...args);
  if (ms >= 10_000) t.unref();
  return t;
};

// ── files ──
const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const orientation = (n) => seg(0xe1, Buffer.from([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, n, 0, 0, 0, 0, 0, 0]));
/** A JPEG's header: `width`x`height` as shown, stored turned when `turn` (EXIF 5–8) says so. */
function jpeg(width, height, turn = 1) {
  const [w, h] = turn >= 5 ? [height, width] : [width, height];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]), ...(turn !== 1 ? [orientation(turn)] : []),
    seg(0xc0, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1])),
    seg(0xda, Buffer.from([3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0])), Buffer.from([1, 2, 3, 0xff, 0xd9]),
  ]);
}
function png(width, height) {
  const chunk = (type, data) => { const b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length); b.write(type, 4, 'latin1'); data.copy(b, 8); return b; };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', ihdr), chunk('IDAT', Buffer.alloc(8)), chunk('IEND', Buffer.alloc(0))]);
}
function webp(width, height) {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(22, 4); b.write('WEBPVP8X', 8, 'latin1'); b.writeUInt32LE(10, 16);
  b.writeUIntLE(width - 1, 24, 3); b.writeUIntLE(height - 1, 27, 3);
  return b;
}
const GIF = Buffer.from('GIF89a\x40\x01\xc8\x00\x80\x00\x00', 'latin1');

// ── the browser ──
// What a canvas hands back: a real 24x18 WebP, a JPEG's bare bones, and the
// PNG a canvas gives for a type it cannot encode.
const BYTES = {
  'image/webp': Buffer.from('UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==', 'base64'),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0, 0xd2, 0xcf, 0x20, 0xff, 0xd9]),
  'image/png': Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'),
};
const kit = { webp: true, log: [] };
const encodes = (type) => ((type === 'image/webp' && !kit.webp) || !['image/webp', 'image/jpeg'].includes(type) ? 'image/png' : type);
const dims = (el) => [el.width ?? el.naturalWidth, el.height ?? el.naturalHeight];

class Canvas {
  constructor(width = 300, height = 150) { this.width = width; this.height = height; }
  getContext() {
    const canvas = this;
    return {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage(src, ...at) {
        kit.log.push({ op: 'draw', on: canvas.kind, from: dims(src), to: [canvas.width, canvas.height], at, smoothing: [this.imageSmoothingEnabled, this.imageSmoothingQuality] });
      },
    };
  }
  encoded(type, quality) {
    kit.log.push({ op: 'encode', on: this.kind, size: [this.width, this.height], type, quality });
    const out = encodes(type);
    return new Blob([BYTES[out]], { type: out });
  }
}
class PageCanvas extends Canvas {
  get kind() { return 'page'; }
  toBlob(done, type, quality) { const b = this.encoded(type, quality); setTimeout(() => done(b), 0); }
  toDataURL(type, quality) { const b = this.encoded(type, quality); return `data:${b.type};base64,${BYTES[b.type].toString('base64')}`; }
}
class WorkerCanvas extends Canvas {
  get kind() { return 'worker'; }
  async convertToBlob({ type, quality } = {}) { return this.encoded(type, quality); }
}

// A file's bytes → its picture's size as the browser shows it: what an <img>
// reports, and what createImageBitmap decodes.
const shown = new Map();
const keyOf = async (blob) => Buffer.from(await blob.arrayBuffer()).toString('base64');
const urls = new Map();
let nurl = 0;
URL.createObjectURL = (blob) => { const u = `blob:test/${++nurl}`; urls.set(u, blob); return u; };
URL.revokeObjectURL = (u) => { urls.delete(u); };

globalThis.Image = class {
  // The decode probe's HEIC and TIFF (lib/decode-probe.js): not here.
  set src(v) { this.url = v; if (v.startsWith('data:')) setTimeout(() => this.onerror?.(), 0); }
  get src() { return this.url; }
  async decode() {
    const size = urls.has(this.url) ? shown.get(await keyOf(urls.get(this.url))) : null;
    if (!size) throw new DOMException('The source image cannot be decoded.', 'EncodingError');
    this.naturalWidth = size.width;
    this.naturalHeight = size.height;
  }
};
globalThis.document = { createElement: () => new PageCanvas() };
globalThis.HTMLCanvasElement = PageCanvas;
globalThis.OffscreenCanvas = WorkerCanvas;
globalThis.createImageBitmap = async (blob, options = {}) => {
  kit.log.push({ op: 'decode', options });
  const size = shown.get(await keyOf(blob));
  if (!size) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
  return { width: options.resizeWidth ?? size.width, height: options.resizeHeight ?? size.height, close() {} };
};

// The worker, run here: what crosses to it and back is cloned, as it would be.
const worker = { mode: 'draw', started: [], told: [] };
globalThis.Worker = class {
  constructor(url, options) { worker.started.push({ url: String(url), options }); }
  postMessage(message) {
    const m = structuredClone(message);
    setTimeout(async () => {
      let reply;
      if (m.type === 'probe') reply = { id: m.id, caps: { offscreen: true, encode: true, webp: kit.webp, resize: true, orientation: true } };
      else {
        worker.told.push(m.facts);
        reply = worker.mode === 'fail'
          ? { id: m.id, error: 'Not a picture it can draw.' }
          : await renderImage(m.blob, m.facts).then((result) => ({ id: m.id, result }), (e) => ({ id: m.id, error: e.message }));
      }
      if (!this.gone) this.onmessage?.({ data: structuredClone(reply) });
    }, 0);
  }
  terminate() { this.gone = true; }
};

async function thumbnail(bytes, file, mode) {
  shown.set(Buffer.from(bytes).toString('base64'), file.shown);
  worker.mode = mode;
  kit.log = [];
  const result = await makeThumbnail(new Blob([bytes], { type: file.mime }), { name: file.name, mime: file.mime, size: file.size });
  return { result, log: kit.log };
}

const shape = (r) => ({
  keys: Object.keys(r).sort(),
  blob: r.blob.type,
  poster: r.poster?.type ?? null,
  siblings: Object.fromEntries(Object.entries(r.siblings).map(([k, b]) => [k, b.type])),
  placeholder: r.placeholder ?? null,
  media: r.media,
});
const plain = (log) => log.map(({ on, ...step }) => step);

const CASES = [
  { shown: { width: 6000, height: 4000 }, size: 9e6 },                  // 24 MP: a 2400px preview
  { shown: { width: 4000, height: 6000 }, size: 9e6 },
  { shown: { width: 3024, height: 4032 }, size: 3e6, turn: 6 },         // a phone's portrait, stored on its side
  { shown: { width: 4032, height: 3024 }, size: 3e6, turn: 3 },
  { shown: { width: 3024, height: 4032 }, size: 3e6, turn: 8 },
  { shown: { width: 1920, height: 1080 }, size: 8e5 },                  // the original serves: no preview
  { shown: { width: 1920, height: 1080 }, size: 2e6 },                  // a preview the picture's own size: decoded whole
  { shown: { width: 2400, height: 1600 }, size: 1e6 },
  { shown: { width: 3000, height: 2000 }, size: 1e6 },
  { shown: { width: 1000, height: 750 }, size: 5e5 },
  { shown: { width: 800, height: 600 }, size: 1e5 },
  { shown: { width: 640, height: 480 }, size: 5e4 },                    // the thumbnail is the whole picture
  { shown: { width: 64, height: 64 }, size: 2e3 },
  { shown: { width: 1, height: 1 }, size: 100 },
  { shown: { width: 12000, height: 2000 }, size: 2e7 },                 // panoramas
  { shown: { width: 2000, height: 12000 }, size: 2e7 },
  { shown: { width: 10000, height: 10 }, size: 1e4 },
  { shown: { width: 5000, height: 5000 }, size: 1e7 },
  { shown: { width: 2048, height: 1536 }, size: 6e6, name: 'a.png', mime: 'image/png', bytes: png },   // may be transparent
  { shown: { width: 4000, height: 3000 }, size: 4e6, name: 'a.webp', mime: 'image/webp', bytes: webp },
];

describe('the worker draws what the page draws', () => {
  test('warming up: the worker is started and asked what it can do', async () => {
    const { result } = await thumbnail(jpeg(300, 200), { shown: { width: 300, height: 200 }, size: 1e4, name: 'w.jpg', mime: 'image/jpeg' }, 'draw');
    assert.deepEqual(result.media, { width: 300, height: 200 });
  });

  for (const webpHere of [true, false]) {
    test(webpHere ? 'as WebP' : 'as JPEG, where there is no WebP encoder', async () => {
      kit.webp = webpHere;
      for (const c of CASES) {
        const file = { name: 'a.jpg', mime: 'image/jpeg', ...c };
        const bytes = (c.bytes || jpeg)(c.shown.width, c.shown.height, c.turn);
        const what = `${c.shown.width}x${c.shown.height} ${file.mime}${c.turn ? ` turned ${c.turn}` : ''} ${c.size} bytes`;
        const page = await thumbnail(bytes, file, 'fail');
        const off = await thumbnail(bytes, file, 'draw');
        assert.ok(page.log.every((s) => s.on === 'page'), `${what}: the page drew it`);
        assert.ok(off.log.every((s) => s.op === 'decode' || s.on === 'worker'), `${what}: the worker drew it, the page nothing`);

        // The page draws the whole picture down through canvases to the
        // largest rendition; the worker decodes straight to that size. From
        // there on, every step is to be the same.
        const { decode } = imagePlan(c.shown, { bytes: c.size, mime: file.mime });
        const reach = page.log.findIndex((s) => s.op === 'draw' && s.to[0] === decode.width && s.to[1] === decode.height);
        assert.ok(reach >= 0, `${what}: the page drew down to ${decode.width}x${decode.height}`);
        assert.deepEqual(page.log[0].from, [c.shown.width, c.shown.height]);
        assert.ok(page.log.slice(0, reach + 1).every((s) => s.op === 'draw'));
        const whole = decode.width === c.shown.width && decode.height === c.shown.height;
        assert.deepEqual(off.log[0], {
          op: 'decode',
          options: whole ? { imageOrientation: 'from-image' }
            : { resizeWidth: decode.width, resizeHeight: decode.height, resizeQuality: 'high', imageOrientation: 'from-image' },
        }, what);
        assert.deepEqual(plain(off.log.slice(1, 2)), [{
          op: 'draw', from: [decode.width, decode.height], to: [decode.width, decode.height], at: [0, 0, decode.width, decode.height], smoothing: [true, 'high'],
        }]);
        assert.deepEqual(plain(off.log.slice(2)), plain(page.log.slice(reach + 1)), `${what}: every step after`);
        assert.deepEqual(shape(off.result), shape(page.result), `${what}: what comes back`);
      }
    });
  }

  test('what the page does with a transparent picture it can only make a JPEG of, the worker does', async () => {
    kit.webp = false;
    const file = { shown: { width: 4000, height: 3000 }, size: 6e6, name: 'a.png', mime: 'image/png' };
    const { result } = await thumbnail(png(4000, 3000), file, 'draw');
    assert.equal(result.poster, undefined, 'no JPEG preview of a PNG: the original serves');
    assert.equal(result.blob.type, 'image/jpeg');
    const photo = await thumbnail(jpeg(4000, 3000), { ...file, name: 'a.jpg', mime: 'image/jpeg' }, 'draw');
    assert.equal(photo.result.poster.type, 'image/jpeg');
    kit.webp = true;
  });
});

describe('what goes to the worker, and what comes of it failing', () => {
  test('it is told what draw() reads off the file', async () => {
    worker.told = [];
    const one = (name, mime) => thumbnail(jpeg(900, 600), { shown: { width: 900, height: 600 }, size: 7e5, name, mime }, 'draw');
    await one('a.jpg', 'image/jpeg');
    await one('b.png', 'image/png');
    await one('c.webp', 'image/webp');
    await one('d.gif', '');
    assert.deepEqual(worker.told, [
      { bytes: 7e5, mime: 'image/jpeg', transparent: false },
      { bytes: 7e5, mime: 'image/png', transparent: true },
      { bytes: 7e5, mime: 'image/webp', transparent: true },
      { bytes: 7e5, mime: 'image/gif', transparent: false }, // the name says GIF; draw() reads it the same way
    ]);
  });

  test('a picture the worker cannot draw is drawn on the page, and the next goes to the worker again', async () => {
    const file = { shown: { width: 320, height: 200 }, size: 5e4, name: 'a.gif', mime: 'image/gif' };
    const gif = await thumbnail(GIF, file, 'draw');
    assert.ok(gif.log.some((s) => s.on === 'page'), 'a GIF: no header the worker reads');
    assert.deepEqual(gif.result.media, { width: 320, height: 200 });
    const next = await thumbnail(jpeg(320, 200), { ...file, name: 'a.jpg', mime: 'image/jpeg' }, 'draw');
    assert.ok(next.log.every((s) => s.op === 'decode' || s.on === 'worker'));
  });

  test('an image the browser cannot decode fails as it always did', async () => {
    worker.mode = 'draw';
    const bytes = jpeg(640, 480);
    shown.delete(Buffer.from(bytes).toString('base64'));
    await assert.rejects(makeThumbnail(new Blob([bytes]), { name: 'x.jpg', mime: 'image/jpeg', size: 1e5 }), { name: 'EncodingError' });
  });

  test('pictures one after another share one worker, started from lib/thumbnail-worker.js as a module', () => {
    assert.equal(worker.started.length, 1);
    assert.match(worker.started[0].url, /\/lib\/thumbnail-worker\.js$/);
    assert.deepEqual(worker.started[0].options, { type: 'module' });
  });
});

describe('renderImage', () => {
  test('a decode of another size than the header says is not used', async () => {
    let closed = false;
    const bytes = jpeg(4000, 3000);
    const env = {
      OffscreenCanvas: WorkerCanvas,
      createImageBitmap: async () => ({ width: 3000, height: 4000, close() { closed = true; } }),
    };
    await assert.rejects(renderImage(new Blob([bytes]), { bytes: 5e6, mime: 'image/jpeg' }, env), /another size/);
    assert.ok(closed);
  });

  test('a header it does not read is never decoded', async () => {
    let decoded = false;
    const env = { OffscreenCanvas: WorkerCanvas, createImageBitmap: async () => { decoded = true; } };
    await assert.rejects(renderImage(new Blob([GIF]), {}, env), /page draws it/);
    assert.equal(decoded, false);
  });

  test('imagePlan: the largest rendition is decoded to, the smallest drawn to a placeholder', () => {
    assert.deepEqual(imagePlan({ width: 6000, height: 4000 }, { bytes: 9e6, mime: 'image/jpeg' }), {
      decode: { width: 2400, height: 1600 }, large: { width: 2400, height: 1600 }, grid: { width: 864, height: 576 },
      sm: { width: 576, height: 384 }, xs: { width: 180, height: 120 }, tiny: { width: 180, height: 120 },
    });
    assert.deepEqual(imagePlan({ width: 640, height: 480 }, { bytes: 5e4 }), {
      decode: { width: 640, height: 480 }, large: null, grid: { width: 640, height: 480 },
      sm: null, xs: { width: 160, height: 120 }, tiny: { width: 160, height: 120 },
    });
    assert.equal(imagePlan({ width: 0, height: 10 }), null);
  });
});

describe('workerCaps: what the worker can do, shown rather than assumed', () => {
  function env({ webp = true, resize = true, knowsQuality = true, turns = true, fails = false } = {}) {
    const seen = [];
    class C {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() {
        return {
          fillRect() {},
          drawImage() {},
          // The probe picture as it came out: upright, red above blue — or
          // not turned, red left of blue.
          getImageData: (x, y) => ({ data: (turns ? y < 4 : x < 2) ? [250, 0, 0, 255] : [0, 0, 250, 255] }),
        };
      }
      async convertToBlob({ type }) { return { type: type === 'image/webp' && !webp ? 'image/png' : type }; }
    }
    return {
      seen,
      OffscreenCanvas: C,
      createImageBitmap: async (blob, given) => {
        // Its options read as a browser reads them: each member it knows, once.
        const known = ['imageOrientation', 'resizeHeight', ...(knowsQuality ? ['resizeQuality'] : []), 'resizeWidth'];
        const o = Object.fromEntries(known.map((k) => [k, given[k]]).filter(([, v]) => v !== undefined));
        seen.push({ blob, o });
        if (fails) throw new TypeError('Failed to execute createImageBitmap');
        return resize ? { width: o.resizeWidth, height: o.resizeHeight, close() {} } : { width: 8, height: 16, close() {} };
      },
    };
  }

  test('everything', async () => {
    const e = env();
    assert.deepEqual(await workerCaps(e), { offscreen: true, encode: true, webp: true, resize: true, orientation: true });
    // The probe picture is what it says: 16x8 stored, 8x16 shown.
    const blob = e.seen[0].blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assert.deepEqual(await imageHeaderSize(async (s, x) => bytes.subarray(s, x), { size: bytes.length }), { type: 'jpeg', width: 8, height: 16 });
    assert.deepEqual(e.seen[0].o, { resizeWidth: 4, resizeHeight: 8, resizeQuality: 'high', imageOrientation: 'from-image' });
  });

  test('whatever is missing is false', async () => {
    assert.deepEqual(await workerCaps(env({ webp: false })), { offscreen: true, encode: true, webp: false, resize: true, orientation: true });
    assert.deepEqual(await workerCaps(env({ resize: false })), { offscreen: true, encode: true, webp: true, resize: false, orientation: false });
    assert.deepEqual(await workerCaps(env({ knowsQuality: false })), { offscreen: true, encode: true, webp: true, resize: false, orientation: false }, 'a resize it would do cheaply');
    assert.deepEqual(await workerCaps(env({ turns: false })), { offscreen: true, encode: true, webp: true, resize: true, orientation: false });
    assert.deepEqual(await workerCaps(env({ fails: true })), { offscreen: true, encode: true, webp: true, resize: false, orientation: false });
    assert.deepEqual(await workerCaps({ createImageBitmap: async () => ({}) }), { offscreen: false, encode: false, webp: false, resize: false, orientation: false });
  });
});

test('offThreadUsable: only what can do all of it, in the page’s own format', () => {
  const all = { offscreen: true, encode: true, webp: true, resize: true, orientation: true };
  assert.equal(offThreadUsable(all, true), true);
  assert.equal(offThreadUsable({ ...all, webp: false }, false), true, 'JPEG, as the page makes (Safari)');
  assert.equal(offThreadUsable({ ...all, webp: false }, true), false, 'JPEG where the page makes WebP');
  assert.equal(offThreadUsable(all, false), false, 'WebP where the page makes JPEG');
  for (const k of ['offscreen', 'encode', 'resize', 'orientation']) assert.equal(offThreadUsable({ ...all, [k]: false }, true), false, k);
  assert.equal(offThreadUsable(null, true), false);
  assert.equal(offThreadUsable(undefined, false), false);
});

describe('the queue in front of the worker', () => {
  const CAPS = { offscreen: true, encode: true, webp: true, resize: true, orientation: true };
  const blob = new Blob(['x'], { type: 'image/jpeg' });
  const until = async (cond, what, ms = 2000) => {
    const end = performance.now() + ms;
    while (!cond()) {
      if (performance.now() > end) throw new Error(`never: ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  function workers(answer = () => {}) {
    const made = [];
    const spawn = () => {
      const w = {
        posted: [], gone: false, onmessage: null, onerror: null, onmessageerror: null,
        postMessage(m) { this.posted.push(m); answer(w, m); },
        terminate() { this.gone = true; },
        reply(data) { if (!this.gone) this.onmessage?.({ data }); },
      };
      made.push(w);
      return w;
    };
    return { spawn, made };
  }
  const probed = (w, m) => { if (m.type === 'probe') setTimeout(() => w.reply({ id: m.id, caps: CAPS }), 0); };
  const posted = (w) => w.posted.filter((m) => m.type === 'image');

  test('no worker here, or one short of anything: the page draws, and it is asked once', async () => {
    const none = createOffThread({ spawn: () => null, pageWebp: () => true });
    assert.equal(await none.draw(blob, {}), null);
    for (const missing of ['offscreen', 'encode', 'resize', 'orientation']) {
      const { spawn, made } = workers((w, m) => setTimeout(() => w.reply({ id: m.id, caps: { ...CAPS, [missing]: false } }), 0));
      const off = createOffThread({ spawn, pageWebp: () => true });
      assert.equal(await off.draw(blob, {}), null, missing);
      assert.equal(await off.draw(blob, {}), null, missing);
      assert.equal(made.length, 1, `${missing}: started once`);
      assert.deepEqual(made[0].posted.map((m) => m.type), ['probe'], `${missing}: no picture sent`);
      assert.ok(made[0].gone);
    }
  });

  test('its thumbnails are in the format the page’s would be, or it draws none', async () => {
    for (const [workerWebp, pageWebp, used] of [[true, true, true], [false, false, true], [true, false, false], [false, true, false]]) {
      const { spawn } = workers((w, m) => setTimeout(() => w.reply(m.type === 'probe' ? { id: m.id, caps: { ...CAPS, webp: workerWebp } } : { id: m.id, result: 'drawn' }), 0));
      const off = createOffThread({ spawn, pageWebp: () => pageWebp });
      assert.equal(await off.draw(blob, {}), used ? 'drawn' : null, `worker ${workerWebp}, page ${pageWebp}`);
    }
  });

  test('one picture per worker, as many workers as it may have; the rest wait their turn', async () => {
    const { spawn, made } = workers(probed);
    const off = createOffThread({ spawn, pageWebp: () => true, workers: 2 });
    const all = Promise.all([1, 2, 3].map((n) => off.draw(blob, { n })));
    await until(() => made.length === 2 && posted(made[1]).length === 1, 'two drawn at once');
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual([posted(made[0]).map((m) => m.facts.n), posted(made[1]).map((m) => m.facts.n)], [[1], [2]], 'the third waits');
    assert.equal(made.length, 2);
    made[0].reply({ id: posted(made[0])[0].id, result: 'one' });
    await until(() => posted(made[0]).length === 2, 'the third, to the worker that is free');
    made[1].reply({ id: posted(made[1])[0].id, error: 'cannot' });
    made[0].reply({ id: posted(made[0])[1].id, result: 'three' });
    assert.deepEqual(await all, ['one', null, 'three'], 'one it cannot draw is the page’s');
    assert.equal(made.length, 2);
  });

  test('no more workers than it may have, each reused; one that will not start leaves the rest to those that did', async () => {
    const answer = (w, m) => setTimeout(() => w.reply(m.type === 'probe' ? { id: m.id, caps: CAPS } : { id: m.id, result: m.facts.n }), 1);
    const many = workers(answer);
    const off = createOffThread({ spawn: many.spawn, pageWebp: () => true, workers: 3 });
    assert.deepEqual(await Promise.all([1, 2, 3, 4, 5, 6, 7].map((n) => off.draw(blob, { n }))), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(many.made.length, 3);
    assert.ok(many.made.every((w) => posted(w).length >= 1));

    const one = workers(answer);
    let starts = 0;
    const off2 = createOffThread({ spawn: () => (starts++ ? null : one.spawn()), pageWebp: () => true, workers: 3 });
    assert.deepEqual(await Promise.all([1, 2, 3].map((n) => off2.draw(blob, { n }))), [1, 2, 3]);
    assert.equal(one.made.length, 1);
    assert.equal(posted(one.made[0]).length, 3);
  });

  test('given up on: never sent while it waits; while drawn, the worker goes with it', async () => {
    const { spawn, made } = workers(probed);
    const off = createOffThread({ spawn, pageWebp: () => true, workers: 1 });
    const first = new AbortController();
    const second = new AbortController();
    const a = off.draw(blob, { n: 1 }, first.signal);
    const b = off.draw(blob, { n: 2 }, second.signal);
    const c = off.draw(blob, { n: 3 });
    await until(() => posted(made[0]).length === 1, 'the first sent');
    second.abort();
    await assert.rejects(b, { name: 'AbortError' });
    first.abort();
    await assert.rejects(a, { name: 'AbortError' });
    assert.ok(made[0].gone, 'a worker cannot be told to stop one picture');
    await until(() => made[1] && posted(made[1]).length === 1, 'the next on a new worker');
    assert.deepEqual(made[1].posted.map((m) => m.facts?.n), [3], 'not asked again what it can do; the given-up one never sent');
    made[1].reply({ id: made[1].posted[0].id, result: 'three' });
    assert.equal(await c, 'three');
    await assert.rejects(off.draw(blob, {}, AbortSignal.abort()), { name: 'AbortError' });
  });

  test('stuck past JOB_MS: let go, the page draws that one, a new worker the next', async () => {
    const { spawn, made } = workers(probed);
    const off = createOffThread({ spawn, pageWebp: () => true, jobMs: 40, workers: 1 });
    const a = off.draw(blob, { n: 1 });
    const b = off.draw(blob, { n: 2 });
    assert.equal(await a, null);
    assert.ok(made[0].gone);
    await until(() => made[1] && posted(made[1]).length === 1, 'the next on a new worker');
    made[1].reply({ id: made[1].posted[0].id, result: 'two' });
    assert.equal(await b, 'two');
  });

  test('a worker that fails is not started again: the page draws from then on', async () => {
    const { spawn, made } = workers(probed);
    const off = createOffThread({ spawn, pageWebp: () => true });
    const all = Promise.all([off.draw(blob, {}), off.draw(blob, {}), off.draw(blob, {}), off.draw(blob, {})]);
    await until(() => posted(made[0]).length === 1, 'the first sent');
    made[0].onerror({ preventDefault() {} });
    assert.deepEqual(await all, [null, null, null, null], 'drawn by it, beside it, or waiting: all the page’s');
    const started = made.length;
    assert.ok(made.every((w) => w.gone));
    assert.equal(await off.draw(blob, {}), null);
    assert.equal(made.length, started, 'never started again');
  });

  test('a probe that never answers: the page draws', async () => {
    const { spawn, made } = workers();
    const off = createOffThread({ spawn, pageWebp: () => true, probeMs: 30 });
    assert.equal(await off.draw(blob, {}), null);
    assert.ok(made[0].gone);
  });

  test('let go after a while with nothing to do, and started again for the next picture', async () => {
    const { spawn, made } = workers((w, m) => setTimeout(() => w.reply(m.type === 'probe' ? { id: m.id, caps: CAPS } : { id: m.id, result: 'ok' }), 0));
    const off = createOffThread({ spawn, pageWebp: () => true, idleMs: 30, workers: 1 });
    assert.equal(await off.draw(blob, {}), 'ok');
    assert.equal(made[0].gone, false);
    await until(() => made[0].gone, 'let go');
    assert.equal(await off.draw(blob, {}), 'ok');
    assert.equal(made.length, 2);
    assert.deepEqual(made[1].posted.map((m) => m.type), ['image'], 'not asked again what it can do');
  });

  test('anything but a Blob is the page’s', async () => {
    const { spawn, made } = workers(probed);
    const off = createOffThread({ spawn, pageWebp: () => true });
    assert.equal(await off.draw('https://bucket.test/a.jpg', {}), null);
    assert.equal(made.length, 0);
  });
});
