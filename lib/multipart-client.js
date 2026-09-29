// lib/multipart-client.js — browser side of the resumable upload.
//
// Splits a file into parts, signs them in batches ahead of need, uploads them
// through the page's few connections to the bucket with retry, and completes.
// Resumable: S3 remembers which parts landed, so a reload asks `status` and
// skips them rather than starting over.
//
// Deliberately framework-free — the same module drives the web uploader and
// can be reused by anything else that needs to move a large file.

const MAX_ATTEMPTS = 4;
const MiB = 1024 * 1024;

// Part PUTs in flight at once — across every upload on the page, not per
// file. A browser opens six connections to a host that speaks HTTP/1.1, as
// B2's S3 API does, and every request to the bucket waits for one of them:
// the parts, a small file's single PUT, a thumbnail. Four parts a file with
// three files going was twelve, half of them queued in the browser on a
// signed URL. Five keeps the connections busy and one free for the rest.
export const PARTS_AT_ONCE = 5;
// Part URLs signed ahead, per upload, in one call: enough that every slot
// has its next URL in hand while the call for more is out. It was a call to
// the server per part.
const SIGN_AHEAD = PARTS_AT_ONCE * 2;
// How long a signed part URL is trusted here. They are good for an hour
// (lib/storage.js s3PresignUploadParts); one that has waited longer than
// this — a slow link, large parts, a laptop asleep — is signed again rather
// than sent to be refused.
const URL_FRESH_MS = 40 * 60 * 1000;

/**
 * The part size the web asks for (multipart `create`; lib/storage.js
 * partSizeFor decides). Each part is a request — a signature, a PUT, a round
 * trip — and a slice of a File costs the browser no memory however large, so
 * a big file goes in parts of up to 64 MiB: a 20 GB master is some three
 * hundred requests, not two and a half thousand. A smaller file keeps about
 * sixteen parts, enough for every connection (PARTS_AT_ONCE), and never
 * parts under the 8 MiB floor. A resume uses whatever was settled on at
 * create, whatever this says now.
 */
export function partSizeHint(size) {
  const n = Number(size) || 0;
  return Math.min(64 * MiB, Math.max(8 * MiB, Math.ceil(n / 16 / MiB) * MiB));
}

async function api(body) {
  const r = await fetch('/api/files/upload/multipart', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(json.error || `Request failed (${r.status})`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why the bucket refused a PUT, in words that say what to change.
 *
 * A browser reports a CORS refusal as a network error with no status and no
 * body, so status 0 is the one case with nothing to quote. Everything else
 * carries S3's XML error, whose <Code> names the problem.
 */
export function describeBucketError(status, body = '') {
  if (!status) {
    return 'Could not reach the bucket. If you are online, the bucket is refusing uploads from this site (CORS): open Admin → Storage and click Apply CORS.';
  }
  const code = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(body)?.[1];
  if (code === 'SignatureDoesNotMatch' || code === 'InvalidAccessKeyId') {
    return `The bucket rejected the storage keys (${code}). Check the key ID and secret in Admin → Storage.`;
  }
  if (code === 'AccessDenied') {
    return 'The storage key is not allowed to write to this bucket (AccessDenied). Use a key with write access in Admin → Storage.';
  }
  if (code === 'NoSuchBucket') {
    return 'The bucket does not exist (NoSuchBucket). Check the bucket name in Admin → Storage.';
  }
  return `The bucket rejected the upload (${code || `HTTP ${status}`}${message ? `: ${message}` : ''}).`;
}

function bucketError(status, body) {
  const err = new Error(describeBucketError(status, body));
  err.status = status;
  return err;
}

/**
 * PUT a body to a presigned URL, reporting bytes sent.
 *
 * XMLHttpRequest rather than fetch: fetch has no upload progress, and a
 * several-hundred-megabyte PUT with no movement reads as nothing happening.
 * Resolves with the response's ETag; rejects with describeBucketError's text.
 */
export function putToBucket(url, body, { contentType, headers, signal, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    if (contentType) xhr.setRequestHeader('content-type', contentType);
    for (const [name, value] of Object.entries(headers || {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(e.loaded, e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300
      ? resolve(xhr.getResponseHeader('etag'))
      : reject(bucketError(xhr.status, xhr.responseText)));
    xhr.onerror = () => reject(bucketError(0));
    xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(body);
  });
}

/**
 * At most `limit` of something at once, first come first served:
 * `take(signal)` resolves once one is free, or rejects with an AbortError
 * when `signal` aborts while it waits, and `give()` hands one back.
 * `run(work, signal)` is `work()` in a slot of its own.
 */
export function slots(limit) {
  let free = limit;
  const waiting = [];
  const aborted = () => new DOMException('Aborted', 'AbortError');
  const take = (signal) => {
    if (signal?.aborted) return Promise.reject(aborted());
    if (free > 0) {
      free -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const w = {
        go: () => { signal?.removeEventListener('abort', w.stop); resolve(); },
        stop: () => {
          const i = waiting.indexOf(w);
          if (i >= 0) waiting.splice(i, 1);
          reject(aborted());
        },
      };
      signal?.addEventListener('abort', w.stop, { once: true });
      waiting.push(w);
    });
  };
  const give = () => {
    const next = waiting.shift();
    if (next) next.go();
    else free += 1;
  };
  const run = async (work, signal) => {
    await take(signal);
    try { return await work(); } finally { give(); }
  };
  return { take, give, run };
}

// The page's connections to the bucket, as far as parts go (PARTS_AT_ONCE).
const partSlots = slots(PARTS_AT_ONCE);

/**
 * The signed URLs for one upload's parts (`order`, the order they go in),
 * fetched ahead. `url(n)` resolves part n's: from a batch already signed,
 * or by signing n and the parts after it that have none, SIGN_AHEAD in one
 * call — and once fewer than a slot's worth are left in hand past n, the
 * next batch is asked for in the background, so no part waits on a call.
 * A URL older than URL_FRESH_MS counts as none. `renew(n)` forgets n's, for
 * a part whose URL the bucket refused.
 */
function partUrls(id, order) {
  const signed = new Map(); // part number → { ready: Promise<url>, at: when it was signed, once it is }
  const place = new Map(order.map((n, i) => [n, i]));
  const usable = (e) => !!e && (e.at == null || Date.now() - e.at <= URL_FRESH_MS);

  const sign = (from) => {
    const want = [];
    for (let i = place.get(from); i < order.length && want.length < SIGN_AHEAD; i++) {
      if (!usable(signed.get(order[i]))) want.push(order[i]);
    }
    const call = api({ action: 'sign', id, partNumbers: want })
      .then(({ parts }) => new Map((parts || []).map((p) => [Number(p.partNumber), p.url])));
    for (const n of want) {
      const entry = { at: null };
      entry.ready = call.then((urls) => {
        if (!urls.get(n)) throw new Error('No signed URL returned');
        entry.at = Date.now();
        return urls.get(n);
      });
      // A batch that failed is asked for again by whoever needs it next.
      entry.ready.catch(() => { if (signed.get(n) === entry) signed.delete(n); });
      signed.set(n, entry);
    }
  };

  /** How many parts past n have a URL in hand or on its way, and the first that has none. */
  const ahead = (n) => {
    let count = 0;
    for (let i = place.get(n) + 1; i < order.length; i++) {
      if (!usable(signed.get(order[i]))) return { count, next: order[i] };
      count += 1;
    }
    return { count, next: null };
  };

  return {
    async url(n) {
      if (!usable(signed.get(n))) sign(n);
      const url = await signed.get(n).ready;
      const { count, next } = ahead(n);
      if (next != null && count < PARTS_AT_ONCE) sign(next);
      return url;
    },
    renew(n) { signed.delete(n); },
  };
}

/**
 * Upload one part, with retry.
 *
 * Backs off exponentially: a part failing is usually the network rather than
 * the request, and hammering a struggling connection makes it worse. The URL
 * is one signed ahead (partUrls), and a retry keeps it — it is still good —
 * unless the bucket refused it: a signature that expired mid-upload would
 * otherwise fail identically forever.
 */
async function putPart({ blob, partNumber, urls, signal, onProgress, onPartial }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const url = await urls.url(partNumber);

      // S3 returns the part's ETag in a header. It is not strictly needed —
      // completion reads the manifest from S3 — but it confirms the part
      // landed rather than being silently swallowed by a proxy.
      const etag = await putToBucket(url, blob, { signal, onProgress: onPartial });
      onProgress?.(blob.size);
      return { partNumber, etag };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      onPartial?.(0); // the retry sends the part again from the start
      lastError = e;
      // A first 403 is taken for a signature that expired while its part
      // waited — or a clock the bucket disagrees with — and tried again at
      // once, signed afresh. A second is a refusal.
      if (e.status === 403) {
        urls.renew(partNumber);
        if (attempt === 1) continue;
      }
      // A refusal (bad keys, no permission, a rejected request) comes back
      // the same on every attempt; only a dropped connection is worth the wait.
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) break;
      if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 500);
    }
  }
  throw lastError || new Error(`Part ${partNumber} failed`);
}

/**
 * Put every part in `order` (`putOne(n)`), each in one of the page's part
 * slots as soon as one is free — one pipeline to the end, however many parts.
 * It went fifty at a time, and every fifty waited for the slowest of them.
 * The first failure stops new parts; those in flight finish, since their
 * bytes count when the upload is resumed, and then it is thrown.
 */
async function runParts(order, putOne, signal) {
  const running = new Set();
  let failure = null;
  for (const n of order) {
    if (failure) break;
    try {
      await partSlots.take(signal);
    } catch (e) {
      failure ||= e;
      break;
    }
    if (failure) {
      partSlots.give();
      break;
    }
    const task = putOne(n)
      .catch((e) => { failure ||= e; })
      .finally(() => {
        running.delete(task);
        partSlots.give();
      });
    running.add(task);
  }
  await Promise.all(running);
  if (failure) throw failure;
}

/**
 * Upload a File, resumably.
 *
 * `onProgress({ uploaded, total, pct })` fires as parts land. Pass `resumeId`
 * to continue an upload started earlier.
 *
 * Returns { key, publicUrl, name, size, mime } — the caller still records the
 * catalog row, so the database entry is always written by us rather than
 * inferred from the storage.
 */
export async function uploadFileMultipart(file, {
  folder, filespaceId, resumeId = null, signal, onProgress, onStart,
} = {}) {
  let id = resumeId;
  let partSize;
  let total = file.size;
  let done = new Set();
  let uploaded = 0;

  if (id) {
    // Resume: S3 tells us what it already holds, and the upload the part
    // size it was created with — the file is cut the same way again.
    const status = await api({ action: 'status', id });
    partSize = status.upload.partSize;
    total = status.upload.size || file.size;
    done = new Set((status.parts || []).map((p) => p.partNumber));
    uploaded = status.uploaded || 0;
  } else {
    const created = await api({
      action: 'create',
      filename: file.name,
      size: file.size,
      mime: file.type || 'application/octet-stream',
      folder,
      filespaceId,
      partSize: partSizeHint(file.size),
    });
    id = created.id;
    partSize = created.partSize;
  }

  onStart?.({ id, partSize });
  onProgress?.({ uploaded, total, pct: total ? Math.round((uploaded / total) * 100) : 0 });

  const count = Math.max(1, Math.ceil(file.size / partSize));
  const pending = [];
  for (let n = 1; n <= count; n++) {
    if (done.has(n)) continue;
    pending.push(n);
  }

  // Bytes of parts still in flight count too, so a file split into 64 MB
  // parts moves smoothly instead of in part-sized jumps.
  const inflight = new Map();
  const report = () => {
    let sent = uploaded;
    for (const n of inflight.values()) sent += n;
    onProgress?.({ uploaded: sent, total, pct: total ? Math.round((sent / total) * 100) : 0 });
  };
  const bump = (partNumber, bytes) => {
    inflight.delete(partNumber);
    uploaded += bytes;
    report();
  };

  try {
    // Signed a batch ahead as we go rather than all upfront: a large file
    // is thousands of parts and a presigned URL starts expiring when minted.
    const urls = partUrls(id, pending);
    await runParts(pending, (partNumber) => {
      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));
      return putPart({
        blob, partNumber, urls, signal,
        onProgress: (bytes) => bump(partNumber, bytes),
        onPartial: (loaded) => { inflight.set(partNumber, loaded); report(); },
      });
    }, signal);
    return await api({ action: 'complete', id });
  } catch (e) {
    if (e?.name === 'AbortError') {
      // A pause leaves the upload resumable on purpose — the row and the
      // parts stay so the caller can come back to it with this id.
      const err = new Error('Upload paused');
      err.name = 'AbortError';
      err.uploadId = id;
      throw err;
    }
    // A real failure keeps the upload too: retrying is almost always better
    // than re-sending gigabytes. The maintenance sweep aborts what is truly
    // abandoned, so nothing accumulates forever.
    e.uploadId = id;
    throw e;
  }
}

/** Discard an upload and its parts. */
export async function abortUpload(id) {
  try { await api({ action: 'abort', id }); return true; } catch { return false; }
}

/** Resumable uploads belonging to the signed-in user. */
export async function listResumableUploads() {
  const r = await fetch('/api/files/upload/multipart');
  if (!r.ok) return [];
  const json = await r.json().catch(() => ({}));
  return json.uploads || [];
}
