// lib/thumbnail-offthread.js — image previews drawn off the page's thread.
//
// makeThumbnail (lib/thumbnail-client.js) offers every image here first. A
// worker (lib/thumbnail-worker.js) draws its previews (lib/thumbnail-render.js),
// one picture per worker at a time. Workers are started as pictures come and
// reused, up to WORKERS: within one worker Chrome decodes and encodes one
// picture after another, and the uploader draws three at once — three
// 24-megapixel photos took 918 ms in one worker and 378 in three, against 565
// on the page, which held its thread for a quarter of a second of it. Each is
// let go after IDLE_MS with nothing to do.
//
// What comes back is what the page would have made, or null, and the page
// draws the picture itself as it always has:
//   - this browser has no Worker, OffscreenCanvas or createImageBitmap, or
//     the worker's probe finds it short of what the page does: decoding
//     straight to a smaller size, turning a picture upright by its EXIF
//     first, and encoding what the page's own canvas encodes — WebP where it
//     does, JPEG where it does not (Safari), never one where the page would
//     make the other;
//   - the worker cannot draw this picture as the page would (a header it
//     does not read, a decode that fails), or has not within JOB_MS;
//   - a worker failed to start or died: from then on, for every picture.
// A thumbnail is never lost to a worker. At worst it is drawn twice.

// As many as the uploader draws at once, and fewer than the machine has cores.
const WORKERS = Math.max(1, Math.min(3, (globalThis.navigator?.hardwareConcurrency || 2) - 1));
const IDLE_MS = 30_000;
const PROBE_MS = 5_000;
// Far longer than a picture should take, and short of makeThumbnail's own
// TIMEOUT_MS, so a worker that is stuck leaves the page time to draw it.
const JOB_MS = 12_000;

/**
 * Whether pictures go to the worker, from its probe (`caps`, workerCaps) and
 * whether the page's canvas encodes WebP: only when it can do all of it, and
 * its thumbnails would be in the format the page's are.
 */
export function offThreadUsable(caps, pageWebp) {
  if (!caps) return false;
  const able = caps.offscreen && caps.encode && caps.resize && caps.orientation;
  return !!able && !!caps.webp === !!pageWebp;
}

function spawnWorker() {
  if (typeof Worker !== 'function' || typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return null;
  try {
    return new Worker(new URL('./thumbnail-worker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

function canvasEncodesWebp() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    return canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    return false;
  }
}

const aborted = () => new DOMException('The thumbnail was given up on.', 'AbortError');

/**
 * The queue in front of the workers. `spawn()` starts one, or returns null
 * where none can run; `pageWebp()` says whether the page's canvas encodes
 * WebP; `workers` is the most at once. Returns { draw(blob, facts, signal) }:
 * the previews, or null when the page is to draw them. It rejects only when
 * `signal` aborts first.
 */
export function createOffThread({
  spawn = spawnWorker, pageWebp = canvasEncodesWebp, workers = WORKERS, idleMs = IDLE_MS, probeMs = PROBE_MS, jobMs = JOB_MS,
} = {}) {
  const pool = [];     // { worker, job, idle }: a worker, the picture it has, its idle timer
  const queue = [];
  let most = workers;
  let usable = null;   // Promise<boolean>, once asked
  let broken = false;  // a worker failed: the page draws every picture from now on
  let ids = 0;

  const settle = (job, data) => {
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.onAbort);
    job.resolve(data);
  };

  const stop = (slot) => {
    clearTimeout(slot.idle);
    slot.worker.onmessage = null;
    slot.worker.onerror = null;
    slot.worker.onmessageerror = null;
    slot.worker.terminate();
    const i = pool.indexOf(slot);
    if (i >= 0) pool.splice(i, 1);
  };

  const fail = () => {
    broken = true;
    const jobs = [...pool.map((slot) => slot.job), ...queue.splice(0)].filter(Boolean);
    for (const slot of [...pool]) stop(slot);
    for (const job of jobs) settle(job, null);
  };

  const start = () => {
    const worker = spawn();
    if (!worker) return null;
    const slot = { worker, job: null, idle: null };
    worker.onmessage = ({ data }) => {
      const job = slot.job;
      if (!job || data?.id !== job.id) return;
      slot.job = null;
      settle(job, data);
      next();
    };
    // It did not load, threw, or sent what cannot be read: none is asked again.
    worker.onerror = (e) => { e?.preventDefault?.(); fail(); };
    worker.onmessageerror = () => fail();
    pool.push(slot);
    return slot;
  };

  function next() {
    while (queue.length) {
      let slot = pool.find((s) => !s.job);
      if (!slot && pool.length < most && !broken) {
        slot = start();
        // None will start: the ones running take the rest, and with none the page draws them.
        if (!slot) { most = pool.length; broken ||= !most; }
      }
      if (!slot) break;
      const job = queue.shift();
      clearTimeout(slot.idle);
      slot.idle = null;
      slot.job = job;
      job.slot = slot;
      job.timer = setTimeout(() => {
        // Stuck, or far slower than it should be: that worker goes, and the page draws this one.
        if (slot.job !== job) return;
        stop(slot);
        settle(job, null);
        next();
      }, job.ms);
      slot.worker.postMessage(job.message);
    }
    if (broken) for (const job of queue.splice(0)) settle(job, null);
    for (const slot of pool) {
      if (slot.job || slot.idle) continue;
      slot.idle = setTimeout(() => { if (!slot.job) stop(slot); }, idleMs);
      slot.idle.unref?.(); // Node's, in the tests: nothing to keep the process up for
    }
  }

  const send = (message, { signal = null, ms = jobMs } = {}) => new Promise((resolve, reject) => {
    const id = ++ids;
    const job = { id, message: { ...message, id }, resolve, signal, ms, timer: null, slot: null };
    job.onAbort = () => {
      const i = queue.indexOf(job);
      if (i >= 0) queue.splice(i, 1);
      else if (job.slot?.job === job) {
        // Its result is not wanted, and a worker cannot be told to stop one
        // picture: that worker goes, and the next picture has another.
        stop(job.slot);
        next();
      } else return;
      clearTimeout(job.timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', job.onAbort, { once: true });
    queue.push(job);
    next();
  });

  const ready = () => {
    usable ||= send({ type: 'probe' }, { ms: probeMs }).then((data) => {
      const ok = !!data?.caps && offThreadUsable(data.caps, pageWebp());
      if (!ok) {
        broken = true;
        for (const slot of [...pool]) stop(slot);
      }
      return ok;
    });
    return usable;
  };

  async function draw(blob, facts, signal) {
    if (signal?.aborted) throw aborted();
    if (broken || typeof Blob === 'undefined' || !(blob instanceof Blob) || !(await ready())) return null;
    if (signal?.aborted) throw aborted();
    const data = await send({ type: 'image', blob, facts }, { signal });
    if (signal?.aborted) throw aborted();
    return data?.result || null;
  }

  return { draw };
}

let shared = null;

/**
 * makeThumbnail's result for the image in `blob` — { blob, poster?, siblings,
 * placeholder?, media } — drawn in a worker, or null: the page draws it.
 * `facts` are renderImage's. Rejects only when `signal` aborts first.
 */
export function drawImageOffThread(blob, facts, signal) {
  shared ||= createOffThread();
  return shared.draw(blob, facts, signal);
}
