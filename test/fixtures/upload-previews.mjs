// Stand-in for lib/thumbnail-client.js and lib/filmstrip-client.js as
// lib/upload-client.js sees them, for test/upload-late-previews.test.js. The
// previews an upload draws are whatever the test hands over, whenever it
// does (globalThis.__up) — drawing them takes a canvas — and everything
// about recording them, now or later, is the real code: the `?real` imports
// are the modules themselves, loaded apart from the redirect.

export { attachThumbnail, thumbnailFromUpload, createThumbnailBackfill } from '../../lib/thumbnail-client.js?real';
export { attachFilmstrip } from '../../lib/filmstrip-client.js?real';

export const thumbnailForUpload = (file) => globalThis.__up.thumb(file);
export const filmstripForUpload = (file) => globalThis.__up.strip(file);
