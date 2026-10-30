// Putting a trashed file back (lib/trash-restore.js), at the edges only a
// stub can reach: the object's move to the trash (lib/trash-move.js) landing
// between the restore's read of the row and its write. Restored as "never
// moved" then, the row would come back at a key the mover goes on to empty.
// The rule kept: whatever lands in between, the row ends up pointing at its
// bytes, and nothing is written over.
//
// The routes' side — the Trash list and restore, the Undo straight after a
// delete — is test/mac-writes-api.test.js's, over the real routes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const { restoreTrashed, restoreTrashedFiles } = await import('../lib/trash-restore.js');

const CFG = { provider: 's3', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's' };

/**
 * A row and a bucket, and the calls made on them. `onRestore(row)`, when
 * given, runs before restoreFile decides — what a mover does in between.
 */
function world(row, { objects = [], others = [], onRestore = null } = {}) {
  const file = { ...row };
  const bucket = new Set(objects);
  const calls = [];
  const deps = {
    getFileById: async () => ({ ...file }),
    storageKeyInUse: async (key) => others.includes(key),
    storageForKey: async (cfg) => cfg,
    s3ObjectExists: async (_cfg, key) => bucket.has(key),
    s3UniqueKey: async (_cfg, key) => {
      const dot = key.lastIndexOf('.');
      for (let n = 2; ; n++) {
        const k = `${key.slice(0, dot)} (${n})${key.slice(dot)}`;
        if (!bucket.has(k) && !others.includes(k)) return k;
      }
    },
    s3MoveObject: async (_cfg, from, to) => {
      if (!bucket.has(from)) throw new Error(`NoSuchKey ${from}`);
      if (bucket.has(to)) throw new Error(`would overwrite ${to}`);
      bucket.delete(from);
      bucket.add(to);
      calls.push(`move ${from} → ${to}`);
    },
    restoreFile: async (id, { storageKey = null, name = null, trashKey } = {}) => {
      if (onRestore) { const run = onRestore; onRestore = null; run(file, bucket); }
      if (!file.deletedAt) return null;
      if (trashKey !== undefined && (file.trashKey ?? null) !== (trashKey ?? null)) {
        calls.push('restore missed');
        return null;
      }
      Object.assign(file, { deletedAt: null, trashKey: null, storageKey: storageKey ?? file.storageKey, name: name ?? file.name });
      calls.push('restore');
      return { ...file };
    },
  };
  return { file, bucket, calls, deps };
}

const KEY = 'team/Cuts/Take 1.mov';
const TRASH = `_trash/f1/${KEY}`;
const trashed = (over = {}) => ({ id: 'f1', name: 'Take 1.mov', storage: 's3', storageKey: KEY, size: 10, deletedAt: 1000, trashKey: null, ...over });

describe('restoreTrashed', () => {
  test('not moved yet: the row comes back, and its object is where it always was', async () => {
    const w = world(trashed(), { objects: [KEY] });
    const out = await restoreTrashed(trashed(), { cfg: CFG, deps: w.deps });
    assert.deepEqual(out, { id: 'f1', name: 'Take 1.mov', movedTo: null, restored: true });
    assert.deepEqual(w.calls, ['restore']);
    assert.ok(w.bucket.has(KEY));
  });

  test('moved: the copy goes back to its key', async () => {
    const w = world(trashed({ trashKey: TRASH }), { objects: [TRASH] });
    const out = await restoreTrashed(trashed({ trashKey: TRASH }), { cfg: CFG, deps: w.deps });
    assert.equal(out.movedTo, null);
    assert.deepEqual(w.calls, [`move ${TRASH} → ${KEY}`, 'restore']);
    assert.equal(w.file.storageKey, KEY);
  });

  test('the mover points the row at its copy, and empties the key, between the read and the restore', async () => {
    // Decided on "not moved"; meanwhile the copy landed, the row was pointed
    // at it and the original deleted. Restored as it was decided, the row
    // would be live at a key with nothing in it.
    const w = world(trashed(), {
      objects: [KEY],
      onRestore: (file, bucket) => { bucket.add(TRASH); file.trashKey = TRASH; bucket.delete(KEY); },
    });
    const out = await restoreTrashed(trashed(), { cfg: CFG, deps: w.deps });
    assert.deepEqual(out, { id: 'f1', name: 'Take 1.mov', movedTo: null, restored: true });
    assert.deepEqual(w.calls, ['restore missed', `move ${TRASH} → ${KEY}`, 'restore']);
    assert.equal(w.file.storageKey, KEY);
    assert.ok(w.bucket.has(KEY) && !w.bucket.has(TRASH), 'the row points at its bytes');
  });

  test('…and the original not deleted yet: the copy comes back beside it, renamed, never over it', async () => {
    const w = world(trashed(), {
      objects: [KEY],
      onRestore: (file, bucket) => { bucket.add(TRASH); file.trashKey = TRASH; },
    });
    const out = await restoreTrashed(trashed(), { cfg: CFG, deps: w.deps });
    assert.equal(out.movedTo, 'team/Cuts/Take 1 (2).mov');
    assert.equal(out.name, 'Take 1 (2).mov');
    assert.equal(w.file.storageKey, 'team/Cuts/Take 1 (2).mov');
    assert.ok(w.bucket.has('team/Cuts/Take 1 (2).mov'), 'its bytes are where the row says, whatever the mover deletes next');
  });

  test('a name taken by a newer file: beside it, under the name the key has', async () => {
    const row = trashed({ name: 'Café.jpg', storageKey: 'team/Caf_.jpg', trashKey: '_trash/f1/team/Caf_.jpg' });
    const w = world(row, { objects: ['_trash/f1/team/Caf_.jpg', 'team/Caf_.jpg'], others: ['team/Caf_.jpg'] });
    const out = await restoreTrashed(row, { cfg: CFG, deps: w.deps });
    assert.equal(out.movedTo, 'team/Caf_ (2).jpg');
    assert.equal(out.name, 'Café (2).jpg');
    assert.equal(w.file.name, 'Café (2).jpg');
  });

  test('restored by someone else meanwhile: not restored, and nothing moved', async () => {
    const w = world(trashed(), { objects: [KEY], onRestore: (file) => { file.deletedAt = null; } });
    const out = await restoreTrashed(trashed(), { cfg: CFG, deps: w.deps });
    assert.equal(out.restored, false);
    assert.deepEqual(w.calls, []);
  });

  test('a moved object with no S3 to move it back in: refused, and the row left trashed', async () => {
    const w = world(trashed({ trashKey: TRASH }), { objects: [TRASH] });
    await assert.rejects(restoreTrashed(trashed({ trashKey: TRASH }), { cfg: { provider: 'blob' }, deps: w.deps }), /not configured for S3/);
    assert.ok(w.file.deletedAt);
  });
});

describe('restoreTrashedFiles', () => {
  test('each answered; one storage refuses is a failure with its reason, and the rest go on', async () => {
    const ok = world(trashed(), { objects: [KEY] });
    const bad = world(trashed({ id: 'f2', trashKey: '_trash/f2/x.mov' }), { objects: [] });
    const deps = {
      ...ok.deps,
      getFileById: async (id) => (id === 'f2' ? bad.deps.getFileById(id) : ok.deps.getFileById(id)),
      restoreFile: async (id, o) => (id === 'f2' ? bad.deps.restoreFile(id, o) : ok.deps.restoreFile(id, o)),
    };
    const out = await restoreTrashedFiles([trashed(), trashed({ id: 'f2', storageKey: 'x.mov', trashKey: '_trash/f2/x.mov' })], { cfg: CFG, deps });
    assert.deepEqual(out.restored.map((r) => r.id), ['f1']);
    assert.equal(out.failed.length, 1);
    assert.equal(out.failed[0].id, 'f2');
    assert.match(out.failed[0].error, /NoSuchKey/);
  });
});
