// billableStorage() against a real Postgres: the trash under each drive
// (a drive inside another counting toward both, as listDrivesWithUsage counts
// live files), Vercel Blob apart from the bucket, and proxies by their
// reported size — then the estimate's parts from those, each byte once, in
// the bucket it is kept in.
//
// Runs only with TEST_DATABASE_URL (a database you can write to), and skips
// cleanly without one, like the other database tests. Every row is under a
// random prefix and removed at the end. Other test files may write to the
// same database at the same time, so the library-wide totals are checked
// only for holding at least this file's rows; the per-drive figures exactly.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

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

const T = `bs${Math.random().toString(36).slice(2, 8)}`;

describeDb('what a provider bills for (database)', () => {
  let db; let pricing; let storage;
  const made = { files: [], filespaces: [] };
  let outer; let inner;

  before(async () => {
    process.env.DATABASE_URL = URL_;
    process.env.SCHEMA_MANAGED = '0';
    db = await import('../lib/db.js');
    const results = await db.ensureSchema();
    assert.deepEqual(results.filter((r) => !r.ok), [], 'every guard runs on this database');
    pricing = await import('../lib/storage-pricing.js');
    storage = await import('../lib/storage.js');

    outer = await db.createFilespace({ name: `Outer ${T}`, bucket: 'main', prefix: T });
    inner = await db.createFilespace({
      name: `Inner ${T}`, bucket: `client-${T}`, prefix: `${T}/client`,
      accessKeyId: 'AKIAINNER', secretAccessKey: 'inner-secret', region: 'us-east-1',
    });
    made.filespaces.push(outer.id, inner.id);

    const file = async (key, size, { storage: backend = 's3', trashed = false } = {}) => {
      const f = await db.createFile({
        name: key ? key.split('/').pop() : `blob-${T}.jpg`, url: `https://x.test/${key || T}`,
        size, storage: backend, storageKey: key,
      });
      made.files.push(f.id);
      if (trashed) await db.softDeleteFile(f.id, { trashKey: `_trash/${f.id}/${key}` });
      return f;
    };
    const a = await file(`${T}/a.mov`, 100);
    await file(`${T}/b.mov`, 200);
    await file(`${T}/client/c.mov`, 1000);
    await file(`${T}/client/d.mov`, 50, { trashed: true });
    await file(`${T}/e.mov`, 30, { trashed: true });
    await file(`files-${T}/f.mov`, 5);
    await file(null, 7, { storage: 'blob' });

    await db.sql`INSERT INTO proxies (file_id, status, proxy_key, size) VALUES (${a.id}, 'done', ${`_thumbs/${randomUUID()}.proxy.mp4`}, 40)`;
    const b = await file(`${T}/g.mov`, 1);
    await db.sql`INSERT INTO proxies (file_id, status, proxy_key) VALUES (${b.id}, 'done', ${`_thumbs/${randomUUID()}.proxy.mp4`})`;
  });

  after(async () => {
    if (!db) return;
    for (const id of made.files) await db.deleteFile(id).catch(() => {});
    for (const id of made.filespaces) await db.deleteFilespace(id).catch(() => {});
    await db.sql.end({ timeout: 5 }).catch(() => {});
  });

  test('the trash under each drive, a drive inside another counting toward both', async () => {
    const b = await db.billableStorage();
    assert.deepEqual(b.trashByDrive[outer.id], { files: 2, bytes: 80 });
    assert.deepEqual(b.trashByDrive[inner.id], { files: 1, bytes: 50 });
  });

  test('the bucket, Vercel Blob and the proxies, each at least what this file stored', async () => {
    const b = await db.billableStorage();
    assert.ok(b.live.bytes >= 100 + 200 + 1000 + 5 + 1);
    assert.ok(b.trash.bytes >= 80);
    assert.ok(b.blob.bytes >= 7 && b.blob.files >= 1);
    assert.ok(b.proxies.bytes >= 40, 'a proxy by its reported size');
    assert.ok(b.proxies.unsized >= 1, 'and one reported without a size, counted apart');
  });

  test('each byte once, in the bucket it is kept in', async () => {
    const [stored, own, all] = await Promise.all([db.billableStorage(), db.listDriveStorage(), db.listDrivesWithUsage()]);
    const drives = all.filter((d) => made.filespaces.includes(d.id));
    assert.equal(drives.find((d) => d.id === outer.id).bytes, 1301, 'listDrivesWithUsage: everything under the prefix');

    const cfg = { provider: 's3', bucket: 'main', endpoint: 'https://s3.us-west-004.backblazeb2.com', accessKeyId: 'k', secretAccessKey: 's' };
    const byId = new Map(own.map((d) => [d.id, d]));
    const locate = (d) => pricing.storageLocation(storage.cfgForDrive(cfg, d ? byId.get(d.id) : null));
    const est = pricing.estimateStorageCost(pricing.storageParts({ stored, drives, locate }));

    const client = est.lines.find((l) => l.location.bucket === `client-${T}`);
    assert.equal(client.bytes, 1000 + 50, 'the inner drive’s files and trash, in its own bucket');
    assert.equal(client.location.provider, 'aws', 'its own keys and no endpoint: AWS');
    assert.equal(client.location.region, 'us-east-1');
    const main = est.lines.find((l) => l.location.bucket === 'main');
    assert.ok(main.bytes >= 100 + 200 + 30 + 1 + 5 + 40, 'the rest of the drive, the library and the proxies');
    assert.ok(!JSON.stringify(est).includes('inner-secret'), 'no secret in the estimate');
    assert.ok(!JSON.stringify(est).includes('AKIAINNER'), 'nor a key id');
  });
});
