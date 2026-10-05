// lib/preview-jobs.js: which files a browser draws, what a file lacks, and
// the cheapest job that makes it — the rules Admin → Previews and a file's
// "Regenerate thumbnail" share. The SQL that says the same is held to these
// in test/previews-db.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  previewClass, drawnClasses, kindsFor, siblingsExpected, posterExpected, imagePreviewExpected, previewGaps, cannotDraw, previewJob,
  skipReason, jobOutcome, failureReason, redrawOffered, readPreviewScope, previewScopeQuery,
} from '../lib/preview-jobs.js';
import { drawableKind, THUMB_SOURCE_MAX_BYTES } from '../lib/media.js';

const OURS = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.webp';
const POSTER = '_thumbs/0f8fad5b-d9cb-469f-a165-70867728950e.poster.webp';
const OLD = 'files/abc-thumb-photo.jpg';
const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';

// A picture of ours with nothing missing, to take things away from.
const whole = (over = {}) => ({
  id: 'f1', name: 'photo.jpg', mime: 'image/jpeg', kind: 'image', size: 2_000_000, storage: 's3',
  url: 'https://s3.test/b/photo.jpg', thumbnailKey: OURS, thumbnailUrl: 'https://s3.test/b/t.webp', thumbSizes: ['sm', 'xs'],
  posterKey: POSTER, metadata: { width: 4000, height: 3000, placeholder: PH }, ...over,
});
const clip = (over = {}) => whole({
  name: 'clip.mp4', mime: 'video/mp4', kind: 'video', posterKey: POSTER,
  metadata: { width: 1920, height: 1080, placeholder: PH }, ...over,
});

describe('which files a browser draws', () => {
  const SAMPLES = [
    [{ mime: 'image/jpeg', name: 'a.jpg', kind: 'image' }, 'image'],
    [{ mime: '', name: 'b.PNG', kind: 'other' }, 'image'],
    [{ mime: 'image/heic', name: 'c.heic', kind: 'image' }, 'heic'],
    [{ mime: 'application/octet-stream', name: 'IMG_1.HEIC', kind: 'other' }, 'heic'],
    [{ mime: 'image/tiff', name: 'scan.tif', kind: 'image' }, 'tiff'],
    [{ mime: 'image/x-canon-cr2', name: 'raw.cr2', kind: 'image' }, 'never'],
    [{ mime: 'image/svg+xml', name: 'logo.svg', kind: 'image' }, 'never'],
    [{ mime: 'video/quicktime', name: 'take.mov', kind: 'video' }, 'video'],
    [{ mime: 'video/x-msvideo', name: 'old.avi', kind: 'video' }, 'never'],
    [{ mime: '', name: 'a.webm', kind: null }, 'video'],
    [{ mime: '', name: 'a.mkv', kind: null }, null],
    [{ mime: 'image/jpeg', name: 'photo.heic', kind: 'image' }, 'image'],
    [{ mime: 'application/pdf', name: 'a.pdf', kind: 'doc' }, null],
    [{ mime: 'audio/mpeg', name: 'a.mp3', kind: 'audio' }, null],
  ];

  test('each class, as drawableKind decides it with and without Safari’s formats', () => {
    for (const [file, want] of SAMPLES) {
      assert.equal(previewClass(file), want, JSON.stringify(file));
      assert.equal(['image', 'video'].includes(want), !!drawableKind(file), `${file.name}: drawn everywhere`);
      if (want === 'heic') assert.equal(drawableKind(file, { probe: { heic: true } }), 'image', file.name);
      if (want === 'tiff') assert.equal(drawableKind(file, { probe: { tiff: true } }), 'image', file.name);
    }
  });

  test('the classes a browser draws, and the kinds a choice covers', () => {
    assert.deepEqual(drawnClasses({}), ['image', 'video']);
    assert.deepEqual(drawnClasses({ heic: true, tiff: true }), ['image', 'video', 'heic', 'tiff']);
    assert.deepEqual(kindsFor('images'), ['image']);
    assert.deepEqual(kindsFor('videos'), ['video']);
    assert.deepEqual(kindsFor('both'), ['image', 'video']);
    assert.deepEqual(kindsFor('nonsense'), ['image', 'video']);
  });
});

describe('what a file lacks', () => {
  test('smaller sizes, unless the picture is too small for any; a size not on record expects them', () => {
    assert.equal(siblingsExpected({}), true);
    assert.equal(siblingsExpected({ width: 4000, height: 3000 }), true);
    assert.equal(siblingsExpected({ width: 250, height: 180 }), true, 'an xs is still made');
    assert.equal(siblingsExpected({ width: 200, height: 150 }), false, 'the xs would be 0.8 of it: none');
    assert.equal(siblingsExpected({ width: 120, height: 90 }), false);
  });

  test('a player poster, unless the frame is barely bigger than its thumbnail', () => {
    assert.equal(posterExpected({}), true);
    assert.equal(posterExpected({ width: 1920, height: 1080 }), true);
    assert.equal(posterExpected({ width: 640, height: 360 }), false);
  });

  test('an image’s large preview, unless it animates or the original serves; a size not on record expects one', () => {
    assert.equal(imagePreviewExpected(whole()), true, '4000x3000');
    assert.equal(imagePreviewExpected(whole({ metadata: {} })), true);
    assert.equal(imagePreviewExpected(whole({ metadata: { width: 900, height: 600 } })), false, 'within 1.25x its thumbnail');
    assert.equal(imagePreviewExpected(whole({ size: 1_000_000, metadata: { width: 2400, height: 1600 } })), false, 'light enough to be its own');
    assert.equal(imagePreviewExpected(whole({ size: 5_000_000, metadata: { width: 2400, height: 1600 } })), true, 'too heavy to be');
    assert.equal(imagePreviewExpected(whole({ size: 1_000_000, metadata: { width: 3000, height: 2000 } })), true, 'too many pixels to be');
    assert.equal(imagePreviewExpected(whole({ name: 'a.gif', mime: 'image/gif' })), false);
    assert.equal(imagePreviewExpected(whole({ name: 'a.GIF', mime: '', metadata: {} })), false, 'a GIF known by its name');
  });

  test('no thumbnail of ours is lacking all of it; one of ours lacks what it lacks', () => {
    assert.deepEqual(previewGaps(whole({ thumbnailKey: null, thumbnailUrl: null })), ['thumbnail']);
    assert.deepEqual(previewGaps(whole({ thumbnailKey: OLD })), ['thumbnail'], 'an old one cannot have siblings or a placeholder');
    assert.deepEqual(previewGaps(whole()), []);
    assert.deepEqual(previewGaps(whole({ thumbSizes: [] })), ['sizes']);
    assert.deepEqual(previewGaps(whole({ metadata: { width: 4000, height: 3000 } })), ['placeholder']);
    assert.deepEqual(previewGaps(whole({ thumbSizes: [], metadata: { width: 120, height: 90, placeholder: PH } })), [], 'too small for siblings');
    assert.deepEqual(previewGaps(clip()), []);
    assert.deepEqual(previewGaps(clip({ posterKey: null })), ['poster']);
    assert.deepEqual(previewGaps(clip({ posterKey: null, metadata: { width: 640, height: 360, placeholder: PH } })), [], 'too small for a poster');
    assert.deepEqual(previewGaps(whole({ posterKey: null })), ['poster'], 'a picture that opens from its original');
    assert.deepEqual(previewGaps(whole({ posterKey: null, name: 'a.gif', mime: 'image/gif' })), [], 'a GIF is its own');
    assert.deepEqual(previewGaps(whole({ posterKey: null, size: 400_000, metadata: { width: 1600, height: 1200, placeholder: PH } })), [], 'and so is a light one');
  });
});

describe('the cheapest job', () => {
  test('missing only: a thumbnail or a poster is drawn whole; sizes and a placeholder from the thumbnail', () => {
    assert.equal(previewJob(whole({ thumbnailKey: null, thumbnailUrl: null })), 'redraw');
    assert.equal(previewJob(whole({ thumbnailKey: OLD })), 'redraw');
    assert.equal(previewJob(whole({ thumbSizes: [] })), 'sizes');
    assert.equal(previewJob(whole({ thumbSizes: [], metadata: { width: 4000, height: 3000 } })), 'sizes', 'the sizes job draws the placeholder too');
    assert.equal(previewJob(whole({ metadata: { width: 4000, height: 3000 } })), 'placeholder');
    assert.equal(previewJob(clip({ posterKey: null })), 'redraw', 'a poster is the thumbnail’s own frame');
    assert.equal(previewJob(clip({ posterKey: null, thumbSizes: [] })), 'redraw');
    assert.equal(previewJob(whole()), null);
    assert.equal(previewJob(whole({ thumbSizes: [], thumbnailUrl: null })), 'redraw', 'nothing to draw the small ones from');
    assert.equal(previewJob(whole({ posterKey: null })), 'redraw', 'an image’s large preview, with the rest');
  });

  test('a picture too big for a tab, lacking only its large preview, is the server’s', () => {
    const big = whole({ posterKey: null, size: THUMB_SOURCE_MAX_BYTES + 1 });
    assert.deepEqual(previewGaps(big), ['poster']);
    assert.equal(previewJob(big), null);
    assert.match(skipReason(big), /The server draws these on its own/);
  });

  test('everything: every file this browser draws, whatever it has', () => {
    assert.equal(previewJob(whole(), { mode: 'everything' }), 'redraw');
    assert.equal(previewJob(clip(), { mode: 'everything' }), 'redraw');
    assert.equal(previewJob(whole({ name: 'a.heic', mime: 'image/heic' }), { mode: 'everything' }), null);
    assert.equal(previewJob(whole({ name: 'a.heic', mime: 'image/heic' }), { mode: 'everything', decodes: { heic: true } }), 'redraw');
  });

  test('what this browser cannot draw still gets what is drawn from its thumbnail', () => {
    const heic = { name: 'IMG_1.heic', mime: 'image/heic' };
    assert.equal(previewJob(whole({ ...heic, thumbnailKey: null, thumbnailUrl: null })), null);
    assert.equal(skipReason(whole({ ...heic, thumbnailKey: null, thumbnailUrl: null })), 'This browser cannot decode HEIC. Safari can.');
    assert.equal(previewJob(whole({ ...heic, thumbnailKey: null, thumbnailUrl: null }), { decodes: { heic: true } }), 'redraw');
    assert.equal(previewJob(whole({ ...heic, metadata: { width: 4000, height: 3000 } })), 'placeholder', 'made by the Mac app, with no placeholder');
    const raw = { name: 'a.avi', mime: 'video/x-msvideo', kind: 'video' };
    assert.equal(previewJob(clip({ ...raw, posterKey: null, metadata: { width: 1920, height: 1080 } })), 'placeholder', 'no poster, but a placeholder');
    assert.equal(previewJob(clip({ ...raw, posterKey: null })), null);
    assert.match(skipReason(clip({ ...raw, posterKey: null })), /No browser decodes this format/);
  });

  test('a picture too big to decode here is left to the Mac app, but not its small jobs', () => {
    const big = { size: THUMB_SOURCE_MAX_BYTES + 1 };
    assert.equal(previewJob(whole({ ...big, thumbnailKey: null, thumbnailUrl: null })), null);
    assert.match(cannotDraw(whole(big)), /^Over 50 MB/);
    assert.equal(previewJob(whole({ ...big, thumbSizes: [] })), 'sizes');
    assert.equal(cannotDraw(whole({ storage: 'blob' })), 'Not in the bucket, where previews are kept.');
    assert.equal(cannotDraw(whole()), null);
  });

  test('a file made meanwhile is skipped as such', () => {
    assert.equal(skipReason(whole()), 'Nothing missing any more: it was made meanwhile.');
  });
});

describe('outcomes and reasons, in words', () => {
  test('a small job’s answer', () => {
    const row = { id: 'f1' };
    assert.deepEqual(jobOutcome('sizes', { file: row }), { outcome: 'done', row });
    assert.equal(jobOutcome('sizes', { skip: true }).reason, 'No smaller sizes to make from its thumbnail.');
    assert.equal(jobOutcome('placeholder', { skip: true }).reason, 'No placeholder could be drawn from its thumbnail.');
    assert.equal(jobOutcome('sizes', { stale: true }).reason, 'Its thumbnail changed while the run went on.');
    assert.equal(jobOutcome('placeholder', {}).outcome, 'skipped');
    assert.equal(jobOutcome('placeholder', null).outcome, 'skipped');
  });

  test('an error, as the list at the end says it', () => {
    assert.match(failureReason(new TypeError('Failed to fetch')), /CORS rule/);
    assert.equal(failureReason(new Error('HTTP 403')), 'The bucket refused the download (HTTP 403).');
    assert.equal(failureReason(new Error('HTTP 404')), 'Its original is not in the bucket (HTTP 404).');
    assert.equal(failureReason(new Error('This browser cannot decode the video.'), { name: 'Take 1.MOV' }), 'This browser cannot decode this video — ProRes, say. Safari can.');
    assert.equal(failureReason(new Error('No video track this browser can decode.'), { name: 'a.mp4' }), 'This browser cannot decode this video.');
    assert.equal(failureReason(new Error('The source image cannot be decoded.')), 'This browser cannot decode this picture.');
    assert.equal(failureReason(new Error('Timed out decoding the file.')), 'Decoding it took too long.');
    assert.equal(failureReason(new Error('That preview belongs to another file.')), 'That preview belongs to another file.');
    assert.equal(failureReason(null), 'Something went wrong.');
  });
});

describe('Regenerate thumbnail, offered', () => {
  test('for a picture or a video in the bucket this browser can draw', () => {
    assert.equal(redrawOffered(whole()), true);
    assert.equal(redrawOffered(clip()), true);
    assert.equal(redrawOffered(whole({ storage: 'blob' })), false);
    assert.equal(redrawOffered(whole({ size: THUMB_SOURCE_MAX_BYTES + 1 })), false);
    assert.equal(redrawOffered({ storage: 's3', name: 'a.pdf', mime: 'application/pdf', kind: 'doc' }), false);
    assert.equal(redrawOffered({ storage: 's3', name: 'a.cr2', mime: 'image/x-canon-cr2', kind: 'image' }), false);
  });

  test('HEIC and TIFF until the probe says this browser cannot', () => {
    const heic = whole({ name: 'a.heic', mime: 'image/heic' });
    assert.equal(redrawOffered(heic, { decodes: null }), true);
    assert.equal(redrawOffered(heic, { decodes: { heic: false, tiff: false } }), false);
    assert.equal(redrawOffered(heic, { decodes: { heic: true, tiff: false } }), true);
  });
});

describe('a run’s scope', () => {
  test('read from a query, anything unknown the default — never everything', () => {
    assert.deepEqual(readPreviewScope(new URLSearchParams('')), {
      drive: null, folder: null, kinds: 'both', mode: 'missing', decodes: { heic: false, tiff: false },
    });
    assert.deepEqual(readPreviewScope(new URLSearchParams('drive=d1&folder=/Campaigns//Spring/ &kinds=videos&mode=everything&heic=1&tiff=true')), {
      drive: 'd1', folder: 'Campaigns/Spring', kinds: 'videos', mode: 'everything', decodes: { heic: true, tiff: true },
    });
    assert.equal(readPreviewScope(new URLSearchParams('mode=destroy&kinds=all')).mode, 'missing');
    assert.equal(readPreviewScope({ kinds: 'images' }).kinds, 'images');
  });

  test('and written back the same, with a page’s cursor', () => {
    const scope = { drive: 'd1', folder: 'A/B', kinds: 'images', mode: 'everything', decodes: { heic: true, tiff: false } };
    const q = new URLSearchParams(previewScopeQuery(scope, { after: 'f9', limit: 50 }));
    assert.deepEqual(readPreviewScope(q), scope);
    assert.equal(q.get('after'), 'f9');
    assert.equal(q.get('limit'), '50');
    assert.equal(new URLSearchParams(previewScopeQuery({})).get('mode'), 'missing');
  });
});
