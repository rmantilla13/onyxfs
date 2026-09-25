// Every listing sort, paged to the end against a real database. Runs only with
// TEST_DATABASE_URL pointing at a throwaway database.
//
// The pure tests in file-query.test.js check the SQL text; this checks what
// the text does, which is where NULLs bite: a keyset comparison against a
// NULL is neither true nor false, and a sort that pages through NULLs wrongly
// loses rows silently rather than failing.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { SORT_KEYS } from '../lib/file-query.js';

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
const db = await import('../lib/db.js');
const skip = !live && 'TEST_DATABASE_URL not reachable';

const T = `sort${Date.now().toString(36)}`;

after(async () => {
  if (live) await db.sql`DELETE FROM files WHERE folder = ${T}`.catch(() => {});
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

// Sizes and types with gaps, and duplicates so the id tiebreaker matters.
const SEED = [
  ['c.png', 'image/png', 300], ['a.mov', 'video/quicktime', null], ['e.txt', null, 10],
  ['b.png', 'image/png', 300], ['d.pdf', 'application/pdf', null], ['f.bin', null, null],
  ['g.png', 'image/png', 20],
];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// What each sort should produce, NULLs as the lowest value.
const EXPECT = {
  new: (a, b) => cmp(b.createdAt, a.createdAt) || cmp(b.id, a.id),
  old: (a, b) => cmp(a.createdAt, b.createdAt) || cmp(a.id, b.id),
  name: (a, b) => cmp(a.name, b.name) || cmp(a.id, b.id),
  name_desc: (a, b) => cmp(b.name, a.name) || cmp(b.id, a.id),
  size: (a, b) => cmp(b.size ?? -1, a.size ?? -1) || cmp(b.id, a.id),
  small: (a, b) => cmp(a.size ?? -1, b.size ?? -1) || cmp(a.id, b.id),
  type: (a, b) => cmp(a.mime ?? '', b.mime ?? '') || cmp(a.id, b.id),
  type_desc: (a, b) => cmp(b.mime ?? '', a.mime ?? '') || cmp(b.id, a.id),
  modified: (a, b) => cmp(b.updatedAt, a.updatedAt) || cmp(b.id, a.id),
  modified_old: (a, b) => cmp(a.updatedAt, b.updatedAt) || cmp(a.id, b.id),
};

test('every sort pages through NULLs without losing or repeating a row', { skip }, async () => {
  assert.deepEqual(Object.keys(EXPECT).sort(), [...SORT_KEYS].sort(), 'a new sort needs an expectation here');
  const made = [];
  for (const [i, [name, mime, size]] of SEED.entries()) {
    made.push(await db.createFile({
      name, mime, size, folder: T, storage: 'blob', url: `http://blob.test/${T}/${name}`,
      createdBy: 'test@example.com', createdAt: 1_700_000_000_000 + (i % 3) * 1000, updatedAt: 1_700_000_000_000 + ((i * 5) % 7) * 1000,
    }));
  }
  const rows = (await db.sql`SELECT id, name, mime, size, created_at, updated_at FROM files WHERE folder = ${T}`)
    .map((r) => ({ id: r.id, name: r.name, mime: r.mime, size: r.size == null ? null : Number(r.size), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) }));
  assert.equal(rows.length, SEED.length);
  assert.ok(rows.some((r) => r.size == null) && rows.some((r) => r.mime == null), 'the seed must contain NULLs');

  for (const sort of SORT_KEYS) {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 20; page++) {
      const res = await db.listFilesForUser({ folder: T, sort, limit: 2, cursor }, { isAdmin: true });
      seen.push(...res.files.map((f) => f.id));
      if (!res.cursor) break;
      // The cursor survives the URL round trip the route puts it through.
      cursor = JSON.parse(JSON.stringify(res.cursor));
    }
    const want = [...rows].sort(EXPECT[sort]).map((r) => r.id);
    assert.deepEqual(seen, want, `sort "${sort}"`);
  }
});
