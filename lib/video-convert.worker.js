// lib/video-convert.worker.js — a video's "Download as…" copy, off the page's
// thread (lib/video-convert.js does the work). Started when the dialog opens
// for a video and terminated when it closes, so what it held — the
// original's index, a copy in memory — goes with it, and a cancel stops at
// once.
//
// In:  { type: 'probe', src, bytes, refreshUrl }   open the original, say what it is
//      { type: 'convert', plan, handle? }         make the copy; into the file
//                                                 `handle` names (a
//                                                 FileSystemFileHandle), else in
//                                                 memory
//      { type: 'cancel' }                         stop, throw away what was written
// Out: { type: 'progress', phase, fraction, done }
//      { type: 'probe', result }                  result.reason 'unsupported': no
//                                                 WebCodecs in a worker here — the
//                                                 page does it instead
//      { type: 'done', blob, bytes }              blob null when written to disk
//      { type: 'error', code, message }  { type: 'cancelled' }

import { VideoJob, memorySink, fileSink, refresher, VideoConvertError } from './video-convert.js';

const job = new VideoJob();
const post = (m) => self.postMessage(m);
const progress = (p) => post({ type: 'progress', ...p });

const failed = (e) => {
  if (e?.name === 'AbortError') post({ type: 'cancelled' });
  else post({ type: 'error', code: e?.code || 'convert', message: e?.message || 'The conversion failed.' });
};

self.onmessage = async ({ data }) => {
  if (data?.type === 'cancel') {
    await job.cancel();
    post({ type: 'cancelled' });
    return;
  }
  if (data?.type === 'probe') {
    try {
      const result = await job.probe({ src: data.src, bytes: data.bytes, refresh: refresher(data.refreshUrl), onProgress: progress });
      post({ type: 'probe', result });
    } catch (e) {
      failed(e);
    }
    return;
  }
  if (data?.type === 'convert') {
    let sink = null;
    try {
      if (data.handle) {
        let writable;
        try {
          writable = await data.handle.createWritable();
        } catch {
          throw new VideoConvertError('write', 'The file could not be opened for writing.');
        }
        sink = fileSink(writable);
      } else {
        sink = memorySink();
      }
      const { bytes } = await job.convert(data.plan, { sink, onProgress: progress });
      post({ type: 'done', blob: data.handle ? null : sink.blob(), bytes });
    } catch (e) {
      await sink?.discard?.();
      failed(e);
    }
  }
};
