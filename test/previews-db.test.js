// Admin → Previews' queries against a real database, held to the rules they
// restate (lib/preview-jobs.js): which files a browser draws, what a file
// lacks — the sizes lib/poster.js draws at included — and the scope, the
// paging and the counts a run is handed. Every row is under a prefix of this
// run's own, and each query is scoped to it, so the other test files writing
// to the same database meanwhile change nothing here. Runs only with
// TEST_DATABASE_URL pointing at a throwaway database.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { previewClass, previewGaps, drawnClasses, kindsFor } from '../lib/preview-jobs.js';
import { effectiveKind } from '../lib/media.js';
import { PREVIEW_ORIGINAL_MAX_BYTES } from '../lib/poster.js';

const URL_ = process.env.TEST_DATABASE_URL;

async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; }
  catch { return false; }
  finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
// No DDL from this file. A guard's ALTER TABLE takes an exclusive lock on
// `files` even when it changes nothing, and test/change-horizon-db.test.js
// holds a transaction on the table open for seconds at a time: an ALTER
// queued behind it queues that test's next write behind itself. The reads
// here still heal a table that is not there yet (lib/db.js withSchemaRetry).
process.env.SCHEMA_MANAGED = '1';
const skip = !live && 'TEST_DATABASE_URL not reachable';
const db = await import('../lib/db.js');

const tag = Math.random().toString(36).slice(2, 8);
const ROOT = `pv-${tag}`;
const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';
const ours = () => `_thumbs/${crypto.randomUUID()}.webp`;
const poster = () => `_thumbs/${crypto.randomUUID()}.poster.webp`;
const made = [];

/** A file row under `dir` (a prefix of ROOT's), as createFile records one. */
async function file(dir, { name, folder = '', ...over } = {}) {
  const row = await db.createFile({
    name, url: `http://s3.test/b/${ROOT}/${dir}/${name}`, size: 1000, storage: 's3',
    storageKey: `${ROOT}/${dir}/${folder ? `${folder}/` : ''}${name}`, folder, createdBy: 'test@previews.test', ...over,
  });
  made.push(row.id);
  return row;
}

const ALL = { classes: ['image', 'video', 'heic', 'tiff', 'never'], kinds: ['image', 'video'] };
/** Every candidate in a scope, paged through. */
async function listAll(args, limit = 200) {
  const out = [];
  let after = '';
  for (let i = 0; i < 100; i += 1) {
    const page = await db.listPreviewCandidates({ ...args, after, limit });
    out.push(...page.files);
    after = page.after;
    if (page.done) return out;
  }
  throw new Error('did not end');
}

after(async () => {
  if (live) {
    await db.sql`DELETE FROM files WHERE id = ANY(${made})`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('which files a browser draws', { skip }, () => {
  const SAMPLES = [
    { name: 'a.jpg', mime: 'image/jpeg', kind: 'image' },
    { name: 'b.PNG', mime: '', kind: 'other' },
    { name: 'c.heic', mime: 'image/heic', kind: 'image' },
    { name: 'IMG_1.HEIC', mime: 'application/octet-stream', kind: 'other' },
    { name: 'scan.tif', mime: 'image/tiff', kind: 'image' },
    { name: 'raw.cr2', mime: 'image/x-canon-cr2', kind: 'image' },
    { name: 'logo.svg', mime: 'image/svg+xml', kind: 'image' },
    { name: 'take.mov', mime: 'video/quicktime', kind: 'video' },
    { name: 'old.avi', mime: 'video/x-msvideo', kind: 'video' },
    { name: 'a.webm', mime: '', kind: null },
    { name: 'photo.heic', mime: 'image/jpeg', kind: 'image' },
    { name: 'clip.M4V', mime: 'video/x-m4v', kind: 'other' },
    { name: 'a.pdf', mime: 'application/pdf', kind: 'doc' },
    { name: 'a.mp3', mime: 'audio/mpeg', kind: 'audio' },
    { name: 'a.mkv', mime: '', kind: null },
  ];
  let rows;
  before(async () => {
    if (!live) return;
    rows = [];
    for (const s of SAMPLES) rows.push(await file('cls', s));
  });

  test('the summary counts each class as previewClass calls it', async () => {
    const summary = await db.previewSummary({ prefix: `${ROOT}/cls` });
    const want = { image: 0, video: 0, heic: 0, tiff: 0, never: 0 };
    for (const r of rows) if (previewClass(r)) want[previewClass(r)] += 1;
    assert.deepEqual(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, v.files])), want);
    assert.ok(want.heic === 2 && want.never === 3, 'the samples cover every class');
  });

  test('a run is handed the classes this browser draws, and no documents or sounds', async () => {
    for (const decodes of [{}, { heic: true }, { heic: true, tiff: true }]) {
      const got = await listAll({ classes: drawnClasses(decodes), kinds: ['image', 'video'], prefix: `${ROOT}/cls`, mode: 'everything' });
      const want = rows.filter((r) => drawnClasses(decodes).includes(previewClass(r))).map((r) => r.id).sort();
      assert.deepEqual(got.map((r) => r.id), want, JSON.stringify(decodes));
    }
  });

  test('pictures or videos: the kind as effectiveKind reads it', async () => {
    for (const choice of ['images', 'videos']) {
      const got = await listAll({ classes: ALL.classes, kinds: kindsFor(choice), prefix: `${ROOT}/cls`, mode: 'everything' });
      const want = rows.filter((r) => previewClass(r) && kindsFor(choice).includes(effectiveKind(r))).map((r) => r.id).sort();
      assert.deepEqual(got.map((r) => r.id), want, choice);
    }
  });
});

describe('what a file lacks', { skip }, () => {
  // Sizes around every threshold lib/poster.js has — the xs sibling at 0.8
  // of the grid poster, the player poster at 1.25 — in four shapes.
  const EDGES = [1, 90, 120, 150, 159, 160, 161, 190, 199, 200, 201, 213, 240, 250, 300, 480, 600, 640, 700, 767, 768, 769, 800, 960, 1000, 1024, 1279, 1280, 1500, 1919, 1920, 2048, 2560, 4000, 8000];
  const SHAPES = [(e) => [e, e], (e) => [e, Math.max(1, Math.round((e * 3) / 4))], (e) => [e, Math.max(1, Math.round((e * 9) / 16))], (e) => [Math.max(1, Math.round((e * 9) / 16)), e]];
  let rows;
  before(async () => {
    if (!live) return;
    rows = [];
    for (const e of EDGES) {
      for (const shape of SHAPES) {
        const [width, height] = shape(e);
        rows.push(await file('gaps', { name: `p-${width}x${height}.jpg`, mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), metadata: { width, height, placeholder: PH } }));
        rows.push(await file('gaps', { name: `v-${width}x${height}.mp4`, mime: 'video/mp4', kind: 'video', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { width, height, placeholder: PH } }));
      }
    }
    // What is on record, or not, beyond the size.
    rows.push(await file('gaps', { name: 'no-size.jpg', mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), metadata: { placeholder: PH } }));
    rows.push(await file('gaps', { name: 'text-size.jpg', mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), metadata: { width: 'wide', height: 100, placeholder: PH } }));
    rows.push(await file('gaps', { name: 'complete.jpg', mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], posterKey: poster(), metadata: { width: 4000, height: 3000, placeholder: PH } }));
    rows.push(await file('gaps', { name: 'no-placeholder.jpg', mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], posterKey: poster(), metadata: { width: 4000, height: 3000 } }));
    rows.push(await file('gaps', { name: 'bare.jpg', mime: 'image/jpeg', kind: 'image' }));
    // An image's large preview turns on its bytes as well as its size — at
    // the edges of 1.25x its grid poster and of the preview's own size, and
    // either side of what an original may weigh to serve as one — and a GIF,
    // known by its type or, with none, by its name, never has one.
    for (const [width, height] of [[960, 720], [961, 721], [2000, 1500], [2400, 1600], [2401, 1600]]) {
      for (const size of [1000, PREVIEW_ORIGINAL_MAX_BYTES, PREVIEW_ORIGINAL_MAX_BYTES + 1]) {
        rows.push(await file('gaps', { name: `b-${width}x${height}-${size}.jpg`, size, mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { width, height, placeholder: PH } }));
      }
    }
    rows.push(await file('gaps', { name: 'anim.gif', mime: 'image/gif', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { width: 4000, height: 3000, placeholder: PH } }));
    rows.push(await file('gaps', { name: 'anim.GIF', mime: '', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { width: 4000, height: 3000, placeholder: PH } }));
    rows.push(await file('gaps', { name: 'anim-unsized.gif', mime: 'image/gif', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { placeholder: PH } }));
    rows.push(await file('gaps', { name: 'poster.mp4', mime: 'video/mp4', kind: 'video', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], posterKey: `_thumbs/${crypto.randomUUID()}.poster.webp`, metadata: { width: 1920, height: 1080, placeholder: PH } }));
    // An old thumbnail: a key the server did not name, or only a URL.
    const legacy = await file('gaps', { name: 'legacy-key.jpg', mime: 'image/jpeg', kind: 'image', metadata: { width: 4000, height: 3000 } });
    await db.sql`UPDATE files SET thumbnail_key = ${`${ROOT}/gaps/x-thumb-legacy.jpg`} WHERE id = ${legacy.id}`;
    const byUrl = await file('gaps', { name: 'legacy-url.jpg', mime: 'image/jpeg', kind: 'image', thumbnailUrl: 'http://s3.test/b/_thumbs/old.jpg', metadata: { width: 4000, height: 3000 } });
    rows.push(await db.getFileById(legacy.id), byUrl);
  });

  test('missing only hands a run exactly the files previewGaps finds lacking', async () => {
    const got = (await listAll({ classes: drawnClasses({}), kinds: ['image', 'video'], prefix: `${ROOT}/gaps`, mode: 'missing' })).map((r) => r.name);
    const want = rows.filter((r) => previewGaps(r).length > 0);
    const names = want.map((r) => r.name);
    assert.deepEqual(
      { onlyInSql: got.filter((n) => !names.includes(n)), onlyInJs: names.filter((n) => !got.includes(n)) },
      { onlyInSql: [], onlyInJs: [] },
    );
    assert.ok(want.some((r) => r.name.startsWith('p-')) && rows.some((r) => r.name.startsWith('p-') && !previewGaps(r).length), 'the sizes fall on both sides of the line');
    assert.ok(want.some((r) => r.name.startsWith('v-')) && rows.some((r) => r.name.startsWith('v-') && !previewGaps(r).length), 'and so do the posters');
    assert.ok(want.some((r) => r.name.startsWith('b-')) && rows.some((r) => r.name.startsWith('b-') && !previewGaps(r).length), 'and an image’s large preview');
    assert.ok(!names.some((n) => n.startsWith('anim')), 'a GIF lacks none');
  });

  test('the summary counts what lacks what, old thumbnails among them', async () => {
    const summary = await db.previewSummary({ prefix: `${ROOT}/gaps` });
    const thumbed = (r) => !!(r.thumbnailKey || r.thumbnailUrl);
    const count = (kind, pred) => rows.filter((r) => effectiveKind(r) === kind && pred(r)).length;
    // With a thumbnail of ours what previewGaps says; with an old one,
    // everything a thumbnail of ours would have — none of it can be there.
    const lacks = (r, gap) => thumbed(r) && (previewGaps(r).includes(gap) || (previewGaps(r).includes('thumbnail') && previewGaps({ ...r, thumbnailKey: ours() }).includes(gap)));
    for (const kind of ['image', 'video']) {
      const s = summary[kind];
      assert.equal(s.files, count(kind, () => true), `${kind} files`);
      assert.equal(s.thumbs, count(kind, thumbed), `${kind} thumbs`);
      assert.equal(s.noSizes, count(kind, (r) => lacks(r, 'sizes')), `${kind} without sizes`);
      assert.equal(s.noPlaceholder, count(kind, (r) => lacks(r, 'placeholder')), `${kind} without a placeholder`);
      assert.equal(s.noPoster, count(kind, (r) => lacks(r, 'poster')), `${kind} without a poster`);
    }
    assert.equal(summary.image.legacy, 2);
    assert.equal(summary.image.files - summary.image.thumbs, 1, 'bare.jpg');
  });
});

describe('a run’s scope and pages', { skip }, () => {
  let drive;
  let rows;
  before(async () => {
    if (!live) return;
    rows = [];
    const add = async (dir, name, folder, over = {}) => rows.push(await file(dir, { name, folder, mime: 'image/jpeg', kind: 'image', ...over }));
    await add('drive', 'a1.jpg', 'A');
    await add('drive', 'a2.jpg', 'A/B');
    await add('drive', 'a3.jpg', 'AB');
    await add('drive', 'q1.jpg', 'Q1_2024');
    await add('drive', 'q2.jpg', 'Q1-2024');
    await add('drive', 'top.jpg', '');
    await add('drive', 'clip.mp4', 'A', { mime: 'video/mp4', kind: 'video' });
    await add('outside', 'a4.jpg', 'A');
    // Not files at all, or not any more: left out wherever they are.
    await add('drive', 'trashed.jpg', 'A', { deletedAt: 1 });
    await db.sql`UPDATE files SET deleted_at = 1 WHERE id = ${rows[rows.length - 1].id}`;
    await add('drive', '._a1.jpg', 'A');
    const shadow = await file('drive', { name: 'shadow.jpg', folder: 'A', mime: 'image/jpeg', kind: 'image' });
    rows.push(shadow);
    rows.push(await file('drive', { name: 'owner.jpg', folder: 'A', mime: 'image/jpeg', kind: 'image', thumbnailKey: shadow.storageKey }));
    drive = { prefix: `${ROOT}/drive` };
  });
  const names = (list) => list.map((r) => r.name).sort();
  const base = { classes: ['image', 'video'], kinds: ['image', 'video'], mode: 'everything' };

  test('a drive’s prefix, and a folder with the folders in it — not one that merely starts the same', async () => {
    assert.deepEqual(names(await listAll({ ...base, prefix: drive.prefix, folder: 'A' })), ['a1.jpg', 'a2.jpg', 'clip.mp4', 'owner.jpg']);
    assert.deepEqual(names(await listAll({ ...base, prefix: drive.prefix, folder: 'A/B' })), ['a2.jpg']);
    assert.deepEqual(names(await listAll({ ...base, prefix: drive.prefix, folder: 'Q1_2024' })), ['q1.jpg'], '_ is a letter, not a wildcard');
    assert.deepEqual(names(await listAll({ ...base, prefix: `${ROOT}/outside`, folder: 'A' })), ['a4.jpg']);
    assert.deepEqual(names(await listAll({ ...base, prefix: drive.prefix, folder: 'A', kinds: ['video'] })), ['clip.mp4']);
  });

  test('the trashed, OS junk and another row’s thumbnail are not files', async () => {
    const got = names(await listAll({ ...base, prefix: drive.prefix }));
    for (const n of ['trashed.jpg', '._a1.jpg', 'shadow.jpg']) assert.ok(!got.includes(n), n);
    assert.equal((await db.previewSummary({ prefix: drive.prefix })).image.files, got.filter((n) => n.endsWith('.jpg')).length);
  });

  // Every page asked for, from the start to `done`.
  async function pages(args) {
    const out = [];
    let after = '';
    for (let i = 0; i < 200; i += 1) {
      const page = await db.listPreviewCandidates({ ...args, after });
      out.push(page);
      if (page.files.length) assert.ok(page.after >= page.files[page.files.length - 1].id, 'the next page starts past this one');
      assert.ok(page.after >= after, 'and never goes back');
      after = page.after;
      if (page.done) return out;
    }
    throw new Error('did not end');
  }

  test('pages in id order, each file once, `done` on the last', async () => {
    const all = (await listAll({ ...base, prefix: drive.prefix })).map((r) => r.id);
    const full = await pages({ ...base, prefix: drive.prefix, limit: 3 });
    const seen = full.flatMap((p) => p.files.map((r) => r.id));
    assert.deepEqual(seen, all);
    assert.deepEqual(seen, [...seen].sort(), 'in id order');
    assert.deepEqual(full.slice(0, -1).map((p) => p.files.length), full.slice(0, -1).map(() => 3), 'a full window fills its pages');
    const last = full[full.length - 1];
    const beyond = await db.listPreviewCandidates({ ...base, prefix: drive.prefix, after: last.after });
    assert.deepEqual(beyond, { files: [], after: last.after, done: true });
  });

  test('a page looks through a window of rows: it may come short, or empty, and not be the last', async () => {
    const all = (await listAll({ ...base, prefix: drive.prefix })).map((r) => r.id);
    const windowed = await pages({ ...base, prefix: drive.prefix, limit: 3, window: 2 });
    assert.deepEqual(windowed.flatMap((p) => p.files.map((r) => r.id)), all, 'each file once, in order');
    assert.ok(windowed.length > Math.ceil(all.length / 3), 'more pages than full ones would take');
    assert.ok(windowed.slice(0, -1).some((p) => p.files.length < 3), 'short pages before the last');
    assert.ok(windowed.slice(0, -1).every((p) => !p.done));
  });
});

describe('what a run comes to', { skip }, () => {
  before(async () => {
    if (!live) return;
    await file('count', { name: 'a.jpg', mime: 'image/jpeg', kind: 'image' });
    await file('count', { name: 'b.jpg', mime: 'image/jpeg', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], posterKey: poster(), metadata: { width: 4000, height: 3000, placeholder: PH } });
    await file('count', { name: 'c.heic', mime: 'image/heic', kind: 'image' });
    await file('count', { name: 'd.heic', mime: 'image/heic', kind: 'image', thumbnailKey: ours(), thumbSizes: ['sm', 'xs'], metadata: { width: 4000, height: 3000 } });
    await file('count', { name: 'e.tif', mime: 'image/tiff', kind: 'image' });
    await file('count', { name: 'f.cr2', mime: 'image/x-canon-cr2', kind: 'image' });
    await file('count', { name: 'g.avi', mime: 'video/x-msvideo', kind: 'video' });
  });
  const scope = { kinds: ['image', 'video'], prefix: null };

  test('missing only: the files it is handed, and what this browser leaves out', async () => {
    const q = { ...scope, prefix: `${ROOT}/count`, mode: 'missing' };
    // a.jpg lacks everything; d.heic only its placeholder, which any browser
    // draws from its thumbnail; c.heic, e.tif, f.cr2 and g.avi need a
    // browser that decodes them. b.jpg lacks nothing.
    assert.deepEqual(await db.countPreviewCandidates({ ...q, classes: drawnClasses({}) }), { total: 2, heic: 1, tiff: 1, never: 2 });
    assert.deepEqual(await db.countPreviewCandidates({ ...q, classes: drawnClasses({ heic: true, tiff: true }) }), { total: 4, heic: 0, tiff: 0, never: 2 });
    const listed = await listAll({ ...q, classes: drawnClasses({}) });
    assert.deepEqual(listed.map((r) => r.name).sort(), ['a.jpg', 'd.heic']);
  });

  test('everything: all this browser draws, and the rest left out', async () => {
    const q = { ...scope, prefix: `${ROOT}/count`, mode: 'everything' };
    assert.deepEqual(await db.countPreviewCandidates({ ...q, classes: drawnClasses({}) }), { total: 2, heic: 2, tiff: 1, never: 2 });
    assert.deepEqual(await db.countPreviewCandidates({ ...q, classes: drawnClasses({ heic: true }), kinds: ['video'] }), { total: 0, heic: 0, tiff: 0, never: 1 });
  });
});
