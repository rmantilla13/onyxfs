// The change feed against a real Postgres: a change that drew its seq first
// and commits last is still delivered, because no cursor is handed out past
// a seq that has not settled (lib/db.js changeHorizon).
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one. Its rows are removed at the end.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

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
const describeDb = live ? describe : describe.skip;
const T = `h${Math.random().toString(36).slice(2, 8)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const admin = { isAdmin: true, email: `admin.${T}@example.com` };

describeDb('the settled change cursor (database)', () => {
  let db, other;
  const made = [];

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    const { default: postgres } = await import('postgres');
    other = postgres(URL_, { max: 1 });
  });

  after(async () => {
    if (!db) return;
    for (const id of made) await db.sql`DELETE FROM files WHERE id = ${id}`.catch(() => {});
    await other?.end({ timeout: 2 }).catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  // Every page from `cursor` until the feed says it is done, as a device reads.
  const drain = async (cursor) => {
    const seen = new Map();
    for (let i = 0; i < 50; i++) {
      const page = await db.listFileChanges({ cursor, limit: 500, principal: admin });
      for (const f of page.changed) seen.set(f.id, f.name);
      assert.ok(page.cursor >= cursor, 'a cursor never goes back');
      cursor = page.cursor;
      if (page.done) break;
    }
    return { cursor, seen };
  };

  test('a change committed after a later one still reaches a device', async () => {
    const mk = async (name) => {
      const f = await db.createFile({ name, url: `https://x/${name}`, storage: 's3', storageKey: `files/${T}/${name}`, folder: T, createdBy: admin.email });
      made.push(f.id);
      return f;
    };
    const a = await mk('a.txt');
    const b = await mk('b.txt');
    // Marks to settle what exists now, and a device caught up to them.
    await db.changeHorizon();
    await sleep(2200);
    let { cursor } = await drain(0);

    // A statement that draws its seq for `a` and holds its commit, like a big
    // folder rename; meanwhile `b` changes and commits with a higher seq.
    const held = other.reserve();
    const conn = await held;
    await conn`BEGIN`;
    await conn`UPDATE files SET name = 'a-renamed.txt', seq = nextval('files_change_seq') WHERE id = ${a.id}`;
    await db.updateFile(b.id, { name: 'b-renamed.txt' });
    await sleep(2200);
    await db.changeHorizon();
    await sleep(2200);

    const during = await drain(cursor);
    assert.equal(during.seen.get(b.id), 'b-renamed.txt', 'the later change is delivered at once');
    const [{ seq: aSeq }] = await db.sql`SELECT (SELECT last_value FROM files_change_seq) AS seq`;
    assert.ok(during.cursor < Number(aSeq), 'but the cursor stays below the change still being written');
    cursor = during.cursor;

    await conn`COMMIT`;
    conn.release();
    await sleep(2200);
    await db.changeHorizon();
    await sleep(2200);
    const afterCommit = await drain(cursor);
    assert.equal(afterCommit.seen.get(a.id), 'a-renamed.txt', 'the held change arrives once it commits');
  });
});
