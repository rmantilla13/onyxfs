// lib/multipart-client.js — browser side of the resumable upload.
//
// Splits a file into parts, signs them in batches, uploads several at a time
// with retry, and completes. Resumable: S3 remembers which parts landed, so a
// reload asks `status` and skips them rather than starting over.
//
// Deliberately framework-free — the same module drives the web uploader and
// can be reused by anything else that needs to move a large file.

const DEFAULT_CONCURRENCY = 4;
const SIGN_BATCH = 50;
const MAX_ATTEMPTS = 4;

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
 * Upload one part, with retry.
 *
 * Backs off exponentially: a part failing is usually the network rather than
 * the request, and hammering a struggling connection makes it worse. Each
 * attempt re-signs, because a signature that expired mid-upload would
 * otherwise fail identically forever.
 */
async function putPart({ blob, partNumber, uploadId, signal, onProgress }) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      const { parts } = await api({ action: 'sign', id: uploadId, partNumbers: [partNumber] });
      const url = parts?.[0]?.url;
      if (!url) throw new Error('No signed URL returned');

      // S3 returns the part's ETag in a header. It is not strictly needed —
      // completion reads the manifest from S3 — but it confirms the part
      // landed rather than being silently swallowed by a proxy.
      const etag = await putToBucket(url, blob, { signal });
      onProgress?.(blob.size);
      return { partNumber, etag };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      lastError = e;
      // A refusal (bad keys, no permission, a rejected request) comes back
      // the same on every attempt; only a dropped connection is worth the wait.
      if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) break;
      if (attempt < MAX_ATTEMPTS) await sleep(2 ** attempt * 500);
    }
  }
  throw lastError || new Error(`Part ${partNumber} failed`);
}

/** Run `tasks` with at most `limit` in flight, preserving nothing but errors. */
async function pool(tasks, limit, signal) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const task = queue.shift();
      await task();
    }
  });
  await Promise.all(workers);
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
  folder, filespaceId, resumeId = null, concurrency = DEFAULT_CONCURRENCY,
  signal, onProgress, onStart,
} = {}) {
  let id = resumeId;
  let partSize;
  let total = file.size;
  let done = new Set();
  let uploaded = 0;

  if (id) {
    // Resume: S3 tells us what it already holds.
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

  const bump = (bytes) => {
    uploaded += bytes;
    onProgress?.({ uploaded, total, pct: total ? Math.round((uploaded / total) * 100) : 0 });
  };

  try {
    // Sign in batches as we go rather than all upfront: a large file is
    // thousands of parts and a presigned URL starts expiring when minted.
    for (let i = 0; i < pending.length; i += SIGN_BATCH) {
      const slice = pending.slice(i, i + SIGN_BATCH);
      await pool(
        slice.map((partNumber) => () => {
          const start = (partNumber - 1) * partSize;
          const blob = file.slice(start, Math.min(start + partSize, file.size));
          return putPart({ blob, partNumber, uploadId: id, signal, onProgress: bump });
        }),
        concurrency,
        signal
      );
    }
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
