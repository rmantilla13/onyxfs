// lib/upload-queue.js — the web uploader's queue, and the files inside a
// dropped folder or an <input type=file>.
//
// Split from lib/upload-client.js so the files page can take a drop, show the
// queue and hold its place without carrying the transfer code (multipart,
// thumbnails, filmstrips, the MP4 probe): `run` loads that when the first
// file starts. Framework-free; the page renders the queue's snapshots.

// Files at once. Each large file already runs four parts in parallel, so this
// is enough to fill a fast uplink without a hundred small files starving it.
const CONCURRENCY = 3;

// OS droppings that come along with a dragged folder. The listing hides them;
// uploading them is only wasted requests.
const JUNK = /^(\.DS_Store|\.localized|Thumbs\.db|desktop\.ini|\._.*)$/;

/** `base` and a relative directory joined into a library folder path. */
export function joinFolder(base, rel) {
  return [base, rel].map((p) => String(p || '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/');
}

function readAll(reader) {
  // readEntries hands back at most ~100 entries per call; keep asking until it
  // returns none, or a big folder silently loses everything after the first page.
  return new Promise((resolve, reject) => {
    const out = [];
    const next = () => reader.readEntries((batch) => {
      if (!batch.length) resolve(out);
      else { out.push(...batch); next(); }
    }, reject);
    next();
  });
}

// Returns how many entries it added, so a directory that added none is known
// to be empty and is recorded as { file: null, dir } — an empty folder to make.
async function walk(entry, dir, out) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    if (JUNK.test(file.name)) return 0;
    out.push({ file, dir });
    return 1;
  }
  if (!entry.isDirectory) return 0;
  const sub = joinFolder(dir, entry.name);
  let added = 0;
  for (const child of await readAll(entry.createReader())) added += await walk(child, sub, out);
  if (!added) { out.push({ file: null, dir: sub }); return 1; }
  return added;
}

/**
 * Files in a drop, with the directory each came from relative to the drop,
 * so a dropped folder lands as the same tree. Empty directories come back as
 * `{ file: null, dir }`. Must be called synchronously in
 * the drop handler: the DataTransfer is emptied once the event returns, so the
 * entries are taken first and walked afterwards.
 */
export function filesFromDrop(dataTransfer) {
  const entries = [...(dataTransfer?.items || [])]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  const loose = entries.length ? [] : [...(dataTransfer?.files || [])].map((file) => ({ file, dir: '' }));
  return (async () => {
    const out = [...loose];
    for (const entry of entries) await walk(entry, '', out);
    return out;
  })();
}

/** Files from an <input type=file>, keeping the folders of a webkitdirectory pick. */
export function filesFromInput(fileList) {
  return [...(fileList || [])]
    .filter((file) => !JUNK.test(file.name))
    .map((file) => {
      const rel = file.webkitRelativePath || '';
      return { file, dir: rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '' };
    });
}

/**
 * A bounded upload queue. `run(item, { signal, onProgress, onResumable })`
 * uploads one item; `onChange(snapshot)` is called, at most once a frame,
 * whenever anything moves. Items: queued → uploading → done | error | canceled.
 */
export function createUploadQueue({ run, onChange, onSettled, concurrency = CONCURRENCY, now = () => Date.now(), schedule }) {
  const items = [];
  const samples = []; // [time, bytes sent across all items], for speed
  let seq = 0;
  let pending = false;
  const frame = schedule || ((fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16)));

  function snapshot() {
    const active = items.filter((i) => i.status !== 'canceled');
    const total = active.reduce((n, i) => n + i.total, 0);
    const sent = active.reduce((n, i) => n + (i.status === 'done' ? i.total : i.sent), 0);
    const t = now();
    while (samples.length > 1 && t - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0] || [t, sent];
    const speed = t - t0 > 500 ? Math.max(0, ((sent - b0) / (t - t0)) * 1000) : 0;
    const running = items.some((i) => i.status === 'queued' || i.status === 'uploading');
    return {
      items: items.map(({ controller, ...rest }) => rest),
      total,
      sent,
      speed,
      eta: running && speed > 0 ? (total - sent) / speed : null,
      running,
      counts: {
        done: items.filter((i) => i.status === 'done').length,
        error: items.filter((i) => i.status === 'error').length,
        active: items.filter((i) => i.status === 'queued' || i.status === 'uploading').length,
        all: active.length,
      },
    };
  }

  function notify(immediate = false) {
    const sent = items.reduce((n, i) => n + (i.status === 'done' ? i.total : i.sent), 0);
    samples.push([now(), sent]);
    if (immediate) { pending = false; onChange?.(snapshot()); return; }
    if (pending) return;
    pending = true;
    frame(() => { pending = false; onChange?.(snapshot()); });
  }

  async function start(item) {
    item.status = 'uploading';
    item.error = null;
    item.controller = new AbortController();
    notify();
    try {
      item.result = await run(item, {
        signal: item.controller.signal,
        onProgress: (sent) => { item.sent = Math.min(sent, item.total); notify(); },
        onResumable: (id) => { item.resumeId = id; },
      });
      // A cancel that arrives after the bytes landed is too late: the file is
      // in the library, so the row says so.
      item.status = 'done';
      item.sent = item.total;
      item.resumeId = null;
    } catch (e) {
      if (item.status !== 'canceled') {
        item.status = 'error';
        item.error = e?.message || 'Upload failed.';
      }
    }
    item.controller = null;
    notify(true);
    pump();
  }

  function pump() {
    const busy = items.filter((i) => i.status === 'uploading').length;
    const next = items.filter((i) => i.status === 'queued').slice(0, Math.max(0, concurrency - busy));
    for (const item of next) start(item);
    if (!busy && !next.length && !items.some((i) => i.status === 'queued')) onSettled?.(snapshot());
  }

  return {
    /** Queue `entries` ([{ file, folder }]). */
    add(entries) {
      // A new batch after a quiet spell should not average in the idle time.
      if (!items.some((i) => i.status === 'queued' || i.status === 'uploading')) samples.length = 0;
      for (const { file, folder } of entries) {
        items.push({ id: ++seq, file, name: file.name, folder: folder || '', total: file.size || 0, sent: 0, status: 'queued', error: null, resumeId: null });
      }
      notify(true);
      pump();
    },
    cancel(id) {
      const item = items.find((i) => i.id === id);
      if (!item || (item.status !== 'queued' && item.status !== 'uploading')) return;
      item.status = 'canceled';
      item.resumeId = null; // a cancel discards the multipart parts
      item.controller?.abort();
      samples.length = 0; // its bytes leave the total; do not read that as a slowdown
      notify(true);
      pump();
    },
    retry(id) {
      const item = items.find((i) => i.id === id);
      if (!item || (item.status !== 'error' && item.status !== 'canceled')) return;
      item.status = 'queued';
      item.error = null;
      item.sent = 0;
      notify(true);
      pump();
    },
    /** Drop finished, failed and canceled rows. */
    clear() {
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].status !== 'queued' && items[i].status !== 'uploading') items.splice(i, 1);
      }
      samples.length = 0;
      notify(true);
    },
    snapshot,
  };
}
