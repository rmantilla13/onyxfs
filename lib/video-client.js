// lib/video-client.js — the page's side of a video's "Download as…" copy.
// Loaded by the dialog when it opens for a video (app/components/download/
// DownloadAs.js), never with the page.
//
// A session per dialog: the original is opened once (probe) and the copy
// made from what was read (convert). The work is lib/video-convert.js's, in
// a worker of its own (lib/video-convert.worker.js) where the browser has
// WebCodecs in workers — Chrome, Edge, Safari 16.4 and later, Firefox 130
// and later all do — else on the page, which it gives back between frames.
// Closing the dialog terminates the worker: everything it held goes with it.
//
// Where the copy goes: a Blob, handed to lib/download-client.js saveBlob as
// a picture's copy is, when it fits in memory; else a file the person picks,
// written as it is made, where the browser can (the File System Access API:
// Chrome and Edge). The picker must be asked for in the click that started
// it, so the dialog asks (pickSaveFile) before anything else happens.
//
// lib/video-convert.js — mediabunny, half a megabyte — is loaded here only
// when the page does the work itself; in a worker it is the worker's alone.

const aborted = () => new DOMException('The download was cancelled.', 'AbortError');
// A worker that has not answered a cancel by now is stopped regardless.
const CANCEL_GRACE_MS = 1500;

/** As lib/video-convert.js VideoConvertError, without loading it: `code` says why. */
function failure(code, message) {
  const e = new Error(message);
  e.name = 'VideoConvertError';
  e.code = code;
  return e;
}

/** Whether the page itself has what a copy is made with. */
const codecsHere = () => typeof VideoDecoder === 'function' && typeof VideoEncoder === 'function' && typeof VideoFrame === 'function';

/**
 * A session for the video at `src` (`bytes` long, if known). `refreshUrl`:
 * where a signed-in person's page re-reads the file's record for a freshly
 * signed address; null for a share link's guest (the page signed it for six
 * hours as it loaded).
 *
 *   probe({ onProgress })              → lib/video-convert.js VideoJob.probe's result,
 *                                        plus `where`: 'worker' | 'page'
 *   convert(plan, { handle, onProgress }) → { blob, bytes }: blob null when
 *                                        written to the file `handle` names
 *   cancel()                           stops what is under way
 *   close()                            lets everything go
 */
export function videoSession({ src, bytes = null, refreshUrl = null }) {
  let worker = null;
  let job = null;
  let convert = null;
  let where = null;
  let pending = null;

  const settle = (fn, value) => {
    const p = pending;
    pending = null;
    if (p) fn === 'resolve' ? p.resolve(value) : p.reject(value);
  };
  const ask = (message, onProgress, transfer = []) => new Promise((resolve, reject) => {
    pending = { resolve, reject, onProgress };
    try {
      worker.postMessage(message, transfer);
    } catch {
      pending = null;
      reject(failure('unsupported', 'This could not be handed to the converter.'));
    }
  });

  const startWorker = () => {
    if (typeof Worker !== 'function') return false;
    try {
      worker = new Worker(new URL('./video-convert.worker.js', import.meta.url));
    } catch {
      worker = null;
      return false;
    }
    worker.onmessage = ({ data }) => {
      if (!data) return;
      if (data.type === 'progress') pending?.onProgress?.(data);
      else if (data.type === 'probe') settle('resolve', data.result);
      else if (data.type === 'done') settle('resolve', { blob: data.blob || null, bytes: data.bytes });
      else if (data.type === 'cancelled') settle('reject', aborted());
      else if (data.type === 'error') settle('reject', failure(data.code, data.message));
    };
    // A worker that fails to load, or dies (out of memory, say).
    worker.onerror = (ev) => {
      ev?.preventDefault?.();
      settle('reject', failure('unsupported', 'The converter stopped.'));
    };
    return true;
  };

  const stopWorker = () => {
    worker?.terminate();
    worker = null;
  };

  const onPage = async (onProgress) => {
    stopWorker();
    where = 'page';
    if (!codecsHere()) return { ok: false, reason: 'webcodecs', where };
    convert = await import('./video-convert.js');
    job = new convert.VideoJob({ onPage: true });
    return { ...(await job.probe({ src, bytes, refresh: convert.refresher(refreshUrl), onProgress })), where };
  };

  return {
    async probe({ onProgress = null } = {}) {
      if (startWorker()) {
        where = 'worker';
        try {
          const result = await ask({ type: 'probe', src, bytes, refreshUrl }, onProgress);
          if (result?.reason !== 'unsupported') return { ...result, where };
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          // The worker could not do it at all: the page tries.
        }
      }
      return onPage(onProgress);
    },

    async convert(plan, { handle = null, onProgress = null } = {}) {
      if (where === 'worker' && worker) {
        return ask({ type: 'convert', plan, handle }, onProgress);
      }
      if (!job) throw failure('read', 'The original has not been opened.');
      let sink = null;
      try {
        if (handle) {
          let writable;
          try {
            writable = await handle.createWritable();
          } catch {
            throw failure('write', 'The file could not be opened for writing.');
          }
          sink = convert.fileSink(writable);
        } else {
          sink = convert.memorySink();
        }
        const { bytes: made } = await job.convert(plan, { sink, onProgress });
        return { blob: handle ? null : sink.blob(), bytes: made };
      } catch (e) {
        await sink?.discard?.();
        throw e;
      }
    },

    async cancel() {
      if (worker) {
        // The worker throws away what it wrote and says so; one that does
        // not answer in time is stopped regardless.
        const w = worker;
        const route = w.onmessage;
        const answered = new Promise((resolve) => {
          w.onmessage = (ev) => {
            if (['cancelled', 'error', 'done'].includes(ev.data?.type)) resolve();
            route?.(ev);
          };
        });
        w.postMessage({ type: 'cancel' });
        await Promise.race([answered, new Promise((resolve) => setTimeout(resolve, CANCEL_GRACE_MS))]);
        stopWorker();
        settle('reject', aborted());
        return;
      }
      await job?.cancel();
      settle('reject', aborted());
    },

    close() {
      stopWorker();
      job?.dispose();
      job = null;
      if (pending) settle('reject', aborted());
    },

    get where() { return where; },
  };
}

/**
 * Asks where to save `name`: a FileSystemFileHandle, or null when the person
 * closed the picker. Must be called in the click that asked for the copy —
 * this module is loaded by then (the probe loaded it), so nothing is awaited
 * first. Where the browser can (lib/download-probe.js canSaveToDisk).
 */
export async function pickSaveFile(name) {
  try {
    return await window.showSaveFilePicker({
      suggestedName: name,
      types: [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }],
    });
  } catch (e) {
    if (e?.name === 'AbortError') return null;
    throw failure('write', 'The file could not be chosen to save into.');
  }
}

/** Removes the file a cancelled or failed copy was being written to, where the browser can. */
export async function removeSaveFile(handle) {
  try { await handle?.remove?.(); } catch { /* left as the picker made it */ }
}
