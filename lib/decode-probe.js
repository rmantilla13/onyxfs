// lib/decode-probe.js — can this browser draw a HEIC or a TIFF?
//
// Safari 17+ decodes both in an <img>; Chrome and Firefox decode neither.
// Rather than guess from the user agent, each is tried once per session on a
// tiny embedded sample, which fails in milliseconds where it is unsupported.
// A browser that passes makes every rendition for those formats at upload
// and for backfills, and may show an original that has none; one that fails
// never downloads an original it cannot draw.
//
// The samples: an 8x8 HEIC written by macOS `sips -s format heic`, and a 1x1
// uncompressed TIFF written by sharp.

const HEIC_SAMPLE = 'data:image/heic;base64,AAAAJGZ0eXBoZWljAAAAAG1pZjFNaVBybWlhZk1pSEJoZWljAAABw21ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAAADnBpdG0AAAAAAAEAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAAABAABodmMxAAAAABVpbmZlAgAAAQACAABFeGlmAAAAABppcmVmAAAAAAAAAA5jZHNjAAIAAQABAAAA5mlwcnAAAADFaXBjbwAAABNjb2xybmNseAACAAIABoAAAAAMY2xsaQDLAEAAAAAUaXNwZQAAAAAAAAAIAAAACAAAAAlpcm90AAAAABBwaXhpAAAAAAMICAgAAABxaHZjQwEDcAAAALAAAAAAAB7wAPz9+PgAAAsDoAABABdAAQwB//8DcAAAAwCwAAADAAADAB5wJKEAAQAjQgEBA3AAAAMAsAAAAwAAAwAeoBQgQcCbDuIe5FlU3AgIGAKiAAEACUQBwGFyyERTZAAAABlpcG1hAAAAAAAAAAEAAQaBAgMFhoQAAAAsaWxvYwAAAABEAAACAAEAAAABAAACQwAAAD4AAgAAAAEAAAH3AAAATAAAAAFtZGF0AAAAAAAAAJoAAAAGRXhpZgAATU0AKgAAAAgAAwEaAAUAAAABAAAAMgEbAAUAAAABAAAAOgEoAAMAAAABAAIAAAAAAAAAAAAZAAAAAQAAABkAAAABAAAAOigBr6L6RoF8//yFJ//25fsvsyo9V/+FB8j5u7L/cFD3TLJn+iD5wjnJKhDmc+/xVQi9hX4K3CEmyK4=';
const TIFF_SAMPLE = 'data:image/tiff;base64,SUkqAAwAAADIPBQADwAAAQMAAQAAAAEAAAABAQMAAQAAAAEAAAACAQMAAwAAANYAAAADAQMAAQAAAAEAAAAGAQMAAQAAAAIAAAARAQQAAQAAAAgAAAASAQMAAQAAAAEAAAAVAQMAAQAAAAMAAAAWAQMAAQAAAAABAAAXAQQAAQAAAAMAAAAaAQUAAQAAAMYAAAAbAQUAAQAAAM4AAAAcAQMAAQAAAAEAAAAoAQMAAQAAAAIAAABTAQMAAwAAANwAAAAAAAAAMzPLAAAACAAzM8sAAAAIAAgACAAIAAEAAQABAA==';

let result = null;
let settled = null;

function decodes(src) {
  if (typeof Image === 'undefined') return Promise.resolve(false);
  return new Promise((resolve) => {
    const img = new Image();
    const done = (ok) => { img.onload = null; img.onerror = null; resolve(ok); };
    img.onload = () => done(img.naturalWidth > 0);
    img.onerror = () => done(false);
    setTimeout(() => done(false), 1500);
    img.src = src;
  });
}

/** { heic, tiff }: what this browser decodes. Tried once per page load; the answer is shared. */
export function decodeProbe() {
  result ||= Promise.all([decodes(HEIC_SAMPLE), decodes(TIFF_SAMPLE)])
    .then(([heic, tiff]) => { settled = { heic, tiff }; return settled; });
  return result;
}

/** The answer, if the probe has already settled; null before (it never blocks). */
export function probedNow() {
  return settled;
}
