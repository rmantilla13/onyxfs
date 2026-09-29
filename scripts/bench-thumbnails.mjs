// scripts/bench-thumbnails.mjs — image thumbnails drawn on the page and in the
// worker (lib/thumbnail-offthread.js), side by side, in headless Chrome.
//
//   node scripts/bench-thumbnails.mjs [--runs 5] [--chrome /path/to/chrome]
//
// Makes a few pictures with sharp — a 24-megapixel JPEG, a phone portrait
// stored on its side, a 4K PNG, a 12-megapixel WebP, a small JPEG — and draws
// each one's thumbnails with makeThumbnail, as an upload does, in two fresh
// pages: one with no Worker, where the page draws them as it always has, and
// one where the worker does. For each it prints the time to the result, how
// long the page's own thread was held meanwhile (long tasks, and the longest
// gap between heartbeats), and whether the two made the same thing: sizes,
// formats, the size put on record, and how far apart the pictures are. And,
// for the size the worker needs before it decodes: reading the header against
// decoding the whole picture to measure it.
//
// No server: Chrome loads lib/ from disk (--allow-file-access-from-files), with
// an import map for the extensionless imports webpack resolves, and is driven
// over --remote-debugging-pipe. Numbers from a headless browser are indicative
// — no display, and its own choice of GPU — not a user's.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import sharp from 'sharp';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const RUNS = Number(arg('runs', 5));
const CHROME = arg('chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
const LIB = fileURLToPath(new URL('../lib/', import.meta.url));

// ── pictures ──
// Something like a photograph for the encoders: soft shapes, a gradient, grain.
async function photo(width, height) {
  const small = Buffer.alloc(96 * 64 * 3);
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < small.length; i++) small[i] = 40 + rand() * 180;
  const base = await sharp(small, { raw: { width: 96, height: 64, channels: 3 } }).resize(width, height, { kernel: 'cubic' }).raw().toBuffer();
  const grain = await sharp({ create: { width, height, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 18 } } }).raw().toBuffer();
  for (let i = 0; i < base.length; i++) base[i] = Math.max(0, Math.min(255, base[i] + (grain[i] - 128)));
  return sharp(base, { raw: { width, height, channels: 3 } });
}
async function screenshot(width, height) {
  const px = Buffer.alloc(width * height * 3, 245);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (x < 280) { px[i] = 30; px[i + 1] = 34; px[i + 2] = 40; }                                // a sidebar
      else if (y % 28 < 14 && (x * 7 + y * 3) % 23 < 12 && x % 600 < 520) px.fill(60, i, i + 3); // lines of "text"
    }
  }
  return sharp(px, { raw: { width, height, channels: 3 } });
}

async function fixtures(dir) {
  const out = [
    ['photo-24mp.jpg', 'image/jpeg', (await photo(6000, 4000)).jpeg({ quality: 90 })],
    ['portrait-12mp-turned.jpg', 'image/jpeg', (await photo(4032, 3024)).jpeg({ quality: 90 }).withMetadata({ orientation: 6 })],
    ['screen-4k.png', 'image/png', (await screenshot(3840, 2160)).png()],
    ['photo-12mp.webp', 'image/webp', (await photo(4000, 3000)).webp({ quality: 85 })],
    ['photo-small.jpg', 'image/jpeg', (await photo(1600, 1067)).jpeg({ quality: 82 })],
  ];
  const made = [];
  for (const [name, type, pipeline] of out) {
    const bytes = await pipeline.toBuffer();
    writeFileSync(join(dir, name), bytes);
    made.push({ name, type, url: pathToFileURL(join(dir, name)).href, bytes: bytes.length });
  }
  return made;
}

// ── the page ──
function page(dir) {
  const lib = pathToFileURL(LIB).href;
  const imports = Object.fromEntries(readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => [lib + f.slice(0, -3), lib + f]));
  writeFileSync(join(dir, 'bench.html'), `<!doctype html><meta charset="utf-8"><title>bench</title>
<script type="importmap">${JSON.stringify({ imports })}</script>
<script type="module">
if (new URLSearchParams(location.search).get('mode') === 'page') globalThis.Worker = undefined;
const { makeThumbnail } = await import(${JSON.stringify(`${lib}thumbnail-client.js`)});
const { imageHeaderSize } = await import(${JSON.stringify(`${lib}image-header.js`)});
const { imagePlan } = await import(${JSON.stringify(`${lib}thumbnail-render.js`)});
const load = (url) => new Promise((resolve, reject) => {
  const x = new XMLHttpRequest(); x.open('GET', url); x.responseType = 'blob';
  x.onload = () => resolve(x.response); x.onerror = () => reject(new Error(url)); x.send();
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (a) => a.reduce((s, n) => s + n, 0);

async function timed(file) {
  const tasks = [];
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
  po.observe({ type: 'longtask' });
  let last = performance.now(); let gap = 0; let on = true;
  const beat = () => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; if (on) setTimeout(beat, 0); };
  setTimeout(beat, 0);
  const t0 = performance.now();
  const thumb = await makeThumbnail(file, { name: file.name, mime: file.type, size: file.size });
  const ms = performance.now() - t0;
  on = false;
  await sleep(100);
  po.disconnect();
  return { ms, longest: Math.max(0, ...tasks), blocked: sum(tasks), gap, thumb };
}

async function describe(thumb) {
  const size = async (b) => { const i = await createImageBitmap(b); const s = [i.width, i.height]; i.close(); return s; };
  const out = { media: thumb.media, grid: [thumb.blob.type, ...(await size(thumb.blob)), thumb.blob.size], siblings: {}, placeholder: thumb.placeholder?.length || 0 };
  if (thumb.poster) out.poster = [thumb.poster.type, ...(await size(thumb.poster)), thumb.poster.size];
  for (const [k, b] of Object.entries(thumb.siblings)) out.siblings[k] = [b.type, ...(await size(b)), b.size];
  return out;
}

// Mean and largest difference per channel, 0-255, between two pictures drawn 256px wide.
async function apart(a, b) {
  const px = async (blob) => {
    const i = await createImageBitmap(blob);
    const w = 256; const h = Math.round(256 * i.height / i.width);
    const c = new OffscreenCanvas(w, h); const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(i, 0, 0, w, h); i.close();
    return ctx.getImageData(0, 0, w, h).data;
  };
  const [p, q] = [await px(a), await px(b)];
  if (p.length !== q.length) return { mean: null, max: null };
  let s = 0; let m = 0; let n = 0;
  for (let i = 0; i < p.length; i += 4) for (let k = 0; k < 3; k++) { const d = Math.abs(p[i + k] - q[i + k]); s += d; m = Math.max(m, d); n++; }
  return { mean: +(s / n).toFixed(2), max: m };
}

window.bench = async (fixtures, runs) => {
  const out = {};
  for (const fx of fixtures) {
    const file = new File([await load(fx.url)], fx.name, { type: fx.type });
    await timed(file); // warm: the worker started, the code compiled
    const rows = [];
    let thumb;
    for (let i = 0; i < runs; i++) { const r = await timed(file); thumb = r.thumb; delete r.thumb; rows.push(r); await sleep(50); }
    out[fx.name] = { rows, made: await describe(thumb), thumb };
  }
  window.last = out;
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { rows: v.rows, made: v.made }]));
};

// Three at once, as the uploader draws them: the time to the last, and the page's thread meanwhile.
window.together = async (fx, runs) => {
  const files = await Promise.all([0, 1, 2].map(async (i) => new File([await load(fx.url)], i + fx.name, { type: fx.type })));
  const rows = [];
  for (let r = 0; r < runs; r++) {
    const tasks = [];
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) tasks.push(e.duration); });
    po.observe({ type: 'longtask' });
    let last = performance.now(); let gap = 0; let on = true;
    const beat = () => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; if (on) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const t0 = performance.now();
    await Promise.all(files.map((file) => makeThumbnail(file, { name: file.name, mime: file.type, size: file.size })));
    const ms = performance.now() - t0;
    on = false;
    await sleep(100);
    po.disconnect();
    rows.push({ ms, longest: Math.max(0, ...tasks), blocked: sum(tasks), gap });
  }
  return rows;
};

// The size the worker needs first: from the header, or by decoding it all.
window.measure = async (fixtures, runs) => {
  const out = {};
  for (const fx of fixtures) {
    const blob = await load(fx.url);
    const read = async (s, e) => new Uint8Array(await blob.slice(s, e).arrayBuffer());
    const t = { header: [], whole: [], resized: [] };
    let size; let plan;
    for (let i = 0; i < runs; i++) {
      let t0 = performance.now(); size = await imageHeaderSize(read, { size: blob.size }); t.header.push(performance.now() - t0);
      t0 = performance.now(); const b = await createImageBitmap(blob, { imageOrientation: 'from-image' }); t.whole.push(performance.now() - t0);
      const shown = [b.width, b.height]; b.close();
      plan = imagePlan(size, { bytes: blob.size, mime: fx.type });
      t0 = performance.now();
      const r = await createImageBitmap(blob, { resizeWidth: plan.decode.width, resizeHeight: plan.decode.height, resizeQuality: 'high', imageOrientation: 'from-image' });
      t.resized.push(performance.now() - t0); r.close();
      if (shown[0] !== size.width || shown[1] !== size.height) throw new Error(fx.name + ': header ' + JSON.stringify(size) + ', decoded ' + shown);
    }
    out[fx.name] = { size, decode: plan.decode, t };
  }
  return out;
};

window.compare = async (other) => {
  const out = {};
  for (const [name, mine] of Object.entries(window.last)) {
    const theirs = other[name];
    out[name] = { grid: await apart(mine.thumb.blob, theirs.blob) };
    if (mine.thumb.poster && theirs.poster) out[name].poster = await apart(mine.thumb.poster, theirs.poster);
  }
  return out;
};

window.gpu = () => {
  const gl = document.createElement('canvas').getContext('webgl');
  const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'no WebGL';
};
window.ready = true;
</script>`);
  return pathToFileURL(join(dir, 'bench.html')).href;
}

// ── Chrome, over a pipe ──
async function chrome(profile) {
  const proc = spawn(CHROME, [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--allow-file-access-from-files', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  let id = 0;
  const waiting = new Map();
  const events = new Set();
  let buf = Buffer.alloc(0);
  proc.stdio[4].on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (let i; (i = buf.indexOf(0)) >= 0; buf = buf.subarray(i + 1)) {
      const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
      const w = waiting.get(msg.id);
      if (w) { waiting.delete(msg.id); if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result); } else for (const f of events) f(msg);
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    waiting.set(++id, { resolve, reject });
    proc.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
  const open = async (url) => {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    events.add((m) => {
      if (m.sessionId === sessionId && m.method === 'Runtime.exceptionThrown') console.error('page:', m.params.exceptionDetails?.exception?.description);
    });
    await send('Runtime.enable', {}, sessionId);
    await send('Page.navigate', { url }, sessionId);
    const run = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
      return r.result.value;
    };
    for (let i = 0; !(await run('!!window.ready').catch(() => false)); i++) {
      if (i > 200) throw new Error('the page never loaded');
      await new Promise((r) => setTimeout(r, 50));
    }
    return { run };
  };
  const quit = async () => {
    const gone = new Promise((resolve) => proc.once('exit', resolve));
    await send('Browser.close').catch(() => {});
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
    proc.kill('SIGKILL');
  };
  return { open, quit };
}

// ── report ──
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const ms = (n) => `${Math.round(n)}`.padStart(6);
const dims = (d) => (d ? `${d[0].replace('image/', '')} ${d[1]}x${d[2]} ${Math.round(d[3] / 1024)}K` : '—');

const dir = mkdtempSync(join(tmpdir(), 'onyx-thumb-bench-'));
try {
  console.log(`Making pictures in ${dir} …`);
  const fx = await fixtures(dir);
  const url = page(dir);
  const profile = join(dir, 'profile');
  const browser = await chrome(profile);
  try {
    const pageMode = await browser.open(`${url}?mode=page`);
    const gpu = await pageMode.run('window.gpu()');
    const onPage = await pageMode.run(`window.bench(${JSON.stringify(fx)}, ${RUNS})`);
    const threeOnPage = await pageMode.run(`window.together(${JSON.stringify(fx[0])}, ${RUNS})`);
    const workerMode = await browser.open(`${url}?mode=worker`);
    const inWorker = await workerMode.run(`window.bench(${JSON.stringify(fx)}, ${RUNS})`);
    const threeInWorker = await workerMode.run(`window.together(${JSON.stringify(fx[0])}, ${RUNS})`);
    const sizes = await workerMode.run(`window.measure(${JSON.stringify(fx)}, ${RUNS})`);
    // The page's pictures, compared in the worker's page: handed over as data URLs.
    const theirs = await pageMode.run(`(async () => {
      const url = (b) => new Promise((r) => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(b); });
      const out = {};
      for (const [k, v] of Object.entries(window.last)) out[k] = { blob: await url(v.thumb.blob), poster: v.thumb.poster ? await url(v.thumb.poster) : null };
      return out;
    })()`);
    const apart = await workerMode.run(`(async () => {
      const blob = async (u) => (u ? (await fetch(u)).blob() : null);
      const other = {};
      for (const [k, v] of Object.entries(${JSON.stringify(theirs)})) other[k] = { blob: await blob(v.blob), poster: await blob(v.poster) };
      return window.compare(other);
    })()`);

    console.log(`\nChrome, headless — WebGL renderer: ${gpu}. ${RUNS} runs each after a warm-up; medians, ms.\n`);
    console.log(`${'picture'.padEnd(34)}${'where'.padEnd(8)}${'total'.padStart(6)}${'longest task'.padStart(14)}${'long tasks'.padStart(12)}${'max gap'.padStart(9)}`);
    for (const f of fx) {
      for (const [where, res] of [['page', onPage], ['worker', inWorker]]) {
        const rows = res[f.name].rows;
        console.log(`${(where === 'page' ? `${f.name} (${Math.round(f.bytes / 1024)}K)` : '').padEnd(34)}${where.padEnd(8)}${ms(median(rows.map((r) => r.ms)))}${ms(median(rows.map((r) => r.longest))).padStart(14)}${ms(median(rows.map((r) => r.blocked))).padStart(12)}${ms(median(rows.map((r) => r.gap))).padStart(9)}`);
      }
    }
    for (const [where, rows] of [['page', threeOnPage], ['worker', threeInWorker]]) {
      console.log(`${(where === 'page' ? `three ${fx[0].name} at once` : '').padEnd(34)}${where.padEnd(8)}${ms(median(rows.map((r) => r.ms)))}${ms(median(rows.map((r) => r.longest))).padStart(14)}${ms(median(rows.map((r) => r.blocked))).padStart(12)}${ms(median(rows.map((r) => r.gap))).padStart(9)}`);
    }

    console.log('\nWhat each made (page / worker), and how far apart the pictures are (mean, largest channel difference of 255, at 256px wide):\n');
    for (const f of fx) {
      const [p, w] = [onPage[f.name].made, inWorker[f.name].made];
      const same = JSON.stringify(p.media) === JSON.stringify(w.media);
      console.log(`${f.name}: on record ${p.media.width}x${p.media.height}${same ? '' : ` / ${w.media.width}x${w.media.height}  ← DIFFERENT`}`);
      console.log(`  grid     ${dims(p.grid).padEnd(24)} ${dims(w.grid).padEnd(24)} apart ${apart[f.name].grid.mean} / ${apart[f.name].grid.max}`);
      if (p.poster || w.poster) console.log(`  preview  ${dims(p.poster).padEnd(24)} ${dims(w.poster).padEnd(24)} ${apart[f.name].poster ? `apart ${apart[f.name].poster.mean} / ${apart[f.name].poster.max}` : ''}`);
      for (const k of ['sm', 'xs']) if (p.siblings[k] || w.siblings[k]) console.log(`  ${k.padEnd(8)} ${dims(p.siblings[k]).padEnd(24)} ${dims(w.siblings[k])}`);
      console.log(`  placeholder ${p.placeholder} / ${w.placeholder} characters`);
    }

    console.log('\nThe size before decoding: the header, or decoding it all to measure — and the decode itself, whole or straight to the largest rendition (ms, median):\n');
    for (const f of fx) {
      const s = sizes[f.name];
      console.log(`${f.name.padEnd(26)} ${`${s.size.width}x${s.size.height}`.padEnd(10)} header ${median(s.t.header).toFixed(2).padStart(6)}   whole decode ${ms(median(s.t.whole))}   to ${`${s.decode.width}x${s.decode.height}`.padEnd(9)} ${ms(median(s.t.resized))}`);
    }
  } finally {
    await browser.quit();
  }
} finally {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
