// GET /api/admin/previews/candidates, run for real with no database: lib/db.js
// resolves to the in-memory rows of test/fixtures/previews-stubs.mjs (which
// applies lib/preview-jobs.js's rules, the ones the SQL is held to in
// test/previews-db.test.js), and '@/auth' is whoever the test says is signed
// in. Everything between — requireAdmin and the session, readPreviewScope,
// lib/storage.js's presigning — is the code that runs in production.
//
// What matters: nobody but an admin gets anything, and not before the gate;
// the scope asked for is the scope listed; each page's rows come signed and
// carry nothing a run does not need; and the pages go through every file
// once.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

process.env.ADMIN_EMAILS = 'boss@pv.test';
process.env.SUPER_ADMIN_EMAILS = '';
process.env.AUTH_SECRET = 'previews-route-test-secret-0123456789';
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const DB_STUB = new URL('./fixtures/previews-stubs.mjs', import.meta.url).href;
const AUTH_STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__pv?.session || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: AUTH_STUB, shortCircuit: true };
    const r = next(specifier, context);
    if (r.url.endsWith('/lib/db.js') && context.parentURL !== DB_STUB) return { url: DB_STUB, shortCircuit: true };
    return r;
  },
});

const route = await import('../app/api/admin/previews/candidates/route.js');

const STORAGE = { provider: 's3', bucket: 'onyx', accessKeyId: 'k', secretAccessKey: 's', region: 'us-east-1', endpoint: 'http://s3.test', prefix: 'files' };
const BOSS = 'boss@pv.test';
const MEMBER = 'member@pv.test';
const OURS = (n) => `_thumbs/${String(n).padStart(8, '0')}-d9cb-469f-a165-70867728950e.webp`;
const PH = 'data:image/webp;base64,UklGRkQAAABXRUJQVlA4IDgAAAAQAwCdASoYABIAPtFiqk+oJaOiKAgBABoJZQDKABanFAAA/uX6P+HPtj97JX/VR2OO4YxZAAAAAA==';

/** A row as lib/db.js shapes it. `lacks`: 'thumbnail' (none), 'placeholder', or nothing. */
function row(id, key, { lacks = 'thumbnail', folder = '', name = `${id}.jpg`, mime = 'image/jpeg', kind = 'image', ...over } = {}) {
  const n = Number(id.replace(/\D/g, '')) || 1;
  return {
    id, name, mime, kind, size: 1000, storage: 's3', storageKey: key, folder, url: `http://s3.test/onyx/${key}`,
    thumbnailKey: lacks === 'thumbnail' ? null : OURS(n), thumbnailUrl: null, thumbSizes: lacks === 'thumbnail' ? [] : ['sm', 'xs'],
    posterKey: null, filmstripKey: null, createdBy: 'someone@pv.test', tags: ['secret-tag'], deletedAt: null,
    metadata: { width: 4000, height: 3000, client: 'Acme', ...(lacks === 'thumbnail' || lacks === 'placeholder' ? {} : { placeholder: PH }) },
    ...over,
  };
}

function reset() {
  globalThis.__pv = {
    session: null,
    settings: new Map([['storage.config', STORAGE]]),
    approved: new Set([MEMBER]),
    drives: [{ id: 'd1', name: 'Team', prefix: 'team' }],
    calls: [],
    files: [
      row('f01', 'files/a.jpg'),
      row('f02', 'files/Campaigns/b.jpg', { folder: 'Campaigns' }),
      row('f03', 'team/Campaigns/c.jpg', { folder: 'Campaigns' }),
      row('f04', 'team/Campaigns/Spring/d.jpg', { folder: 'Campaigns/Spring' }),
      row('f05', 'team/CampaignsOld/e.jpg', { folder: 'CampaignsOld' }),
      row('f06', 'team/Campaigns/clip.mp4', { folder: 'Campaigns', name: 'clip.mp4', mime: 'video/mp4', kind: 'video' }),
      row('f07', 'team/Campaigns/g.jpg', { folder: 'Campaigns', lacks: 'placeholder' }),
      row('f08', 'team/Campaigns/h.jpg', { folder: 'Campaigns', lacks: 'nothing' }),
      row('f09', 'team/Campaigns/i.heic', { folder: 'Campaigns', name: 'i.heic', mime: 'image/heic' }),
      row('f10', 'files/notes.pdf', { name: 'notes.pdf', mime: 'application/pdf', kind: 'doc' }),
    ],
  };
}
beforeEach(reset);

async function get(query = '', who = BOSS) {
  globalThis.__pv.session = who ? { user: { email: who } } : null;
  const res = await route.GET(new Request(`http://app.test/api/admin/previews/candidates${query ? `?${query}` : ''}`));
  return { status: res.status, body: await res.json().catch(() => null) };
}
const dbCalls = () => globalThis.__pv.calls.filter(([name]) => name !== 'sessionRowFor');
const argsOf = (name) => globalThis.__pv.calls.find(([n]) => n === name)?.[1];
const ids = (body) => body.files.map((f) => f.id);

describe('only an admin, and the gate first', () => {
  test('no session: 401, before anything is read', async () => {
    const r = await get('', null);
    assert.equal(r.status, 401);
    assert.deepEqual(dbCalls(), []);
  });

  test('a signed-in member: 403, before anything is read', async () => {
    const r = await get('mode=everything', MEMBER);
    assert.equal(r.status, 403);
    assert.deepEqual(dbCalls(), []);
  });
});

describe('what an admin gets', () => {
  test('the whole library, missing only, by default — pictures and videos this browser draws', async () => {
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(argsOf('listPreviewCandidates'), {
      classes: ['image', 'video'], kinds: ['image', 'video'], prefix: null, folder: null, mode: 'missing', after: '', limit: 50,
    });
    assert.deepEqual(ids(r.body), ['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07'], 'not the complete one, the HEIC or the PDF');
    assert.deepEqual(r.body.counts, { total: 7, heic: 1, tiff: 0, never: 0 });
    assert.equal(r.body.done, true);
    assert.equal(r.body.after, 'f07');
  });

  test('each row signed, with only what a run reads', async () => {
    const { body } = await get('mode=everything');
    const g = body.files.find((f) => f.id === 'f07');
    for (const f of body.files) assert.match(f.url, /X-Amz-Signature=/, `${f.id}'s original`);
    assert.match(g.thumbnailUrl, /X-Amz-Signature=/);
    assert.match(g.smUrl, /X-Amz-Signature=/);
    assert.match(g.xsUrl, /X-Amz-Signature=/);
    assert.ok(new URL(g.xsUrl).pathname.endsWith('.xs.webp'));
    assert.deepEqual(g.metadata, { width: 4000, height: 3000 }, 'the media facts, not the library’s fields');
    for (const k of ['createdBy', 'tags', 'storageKey', 'filmstripKey']) assert.equal(k in g, false, k);
    assert.deepEqual(Object.keys(g).sort(), [
      'folder', 'id', 'kind', 'metadata', 'mime', 'name', 'posterKey', 'size', 'smUrl', 'storage', 'thumbSizes', 'thumbnailKey', 'thumbnailUrl', 'url', 'xsUrl',
    ]);
  });

  test('the scope asked for: a drive, a folder with the ones in it, a kind, everything, Safari’s formats', async () => {
    const r = await get('drive=d1&folder=%2FCampaigns%2F&kinds=images&mode=everything&heic=1');
    assert.equal(r.status, 200);
    assert.deepEqual(argsOf('listPreviewCandidates'), {
      classes: ['image', 'video', 'heic'], kinds: ['image'], prefix: 'team', folder: 'Campaigns', mode: 'everything', after: '', limit: 50,
    });
    assert.deepEqual(ids(r.body), ['f03', 'f04', 'f07', 'f08', 'f09'], 'not the library’s Campaigns, CampaignsOld or the video');
    assert.deepEqual(r.body.counts, { total: 5, heic: 0, tiff: 0, never: 0 });
  });

  test('a drive that is not there: 404, and nothing listed', async () => {
    const r = await get('drive=gone');
    assert.equal(r.status, 404);
    assert.equal(argsOf('listPreviewCandidates'), undefined);
  });

  test('anything else unknown is the default, never everything', async () => {
    const r = await get('mode=destroy&kinds=all&heic=maybe');
    assert.equal(r.status, 200);
    assert.deepEqual(argsOf('listPreviewCandidates'), {
      classes: ['image', 'video'], kinds: ['image', 'video'], prefix: null, folder: null, mode: 'missing', after: '', limit: 50,
    });
  });
});

describe('paging', () => {
  test('page by page from `after`, each file once, the counts with the first page only', async () => {
    const seen = [];
    let after = '';
    const pages = [];
    for (let i = 0; i < 10; i += 1) {
      const r = await get(`mode=everything&limit=3${after ? `&after=${after}` : ''}`);
      assert.equal(r.status, 200);
      pages.push(r.body);
      seen.push(...ids(r.body));
      after = r.body.after;
      if (r.body.done) break;
    }
    assert.deepEqual(seen, ['f01', 'f02', 'f03', 'f04', 'f05', 'f06', 'f07', 'f08']);
    assert.deepEqual(pages.map((p) => p.files.length), [3, 3, 2]);
    assert.deepEqual(pages.map((p) => 'counts' in p), [true, false, false]);
    assert.equal(pages[0].counts.total, 8);
    assert.equal(pages[0].counts.heic, 1);
  });
});
