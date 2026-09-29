// A trashed file's object moved to the trash after the delete has answered
// (lib/trash-move.js). The rule the order of steps keeps: whatever else
// happens meanwhile — a restore, a second mover, a read that fails — the file
// never ends up pointing at nothing, and nothing live is deleted.
//
// The routes' side (a delete answering at once, a restore meanwhile, a file
// put back under the same name) is test/mac-writes-api.test.js's, over the
// real routes; this is the edges only a stub can reach.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const {
  moveTrashedObject, vacateTrashedKey, moveLeftoverTrash, moveBlocker, trashKeyFor, MOVE_MAX_BYTES, TRASH_PREFIX,
} = await import('../lib/trash-move.js');

const CFG = { bucket: 'b' };

/** A store of rows and objects, and the calls made on it, in order. */
function world(rows = [], { objects = [] } = {}) {
  const files = new Map(rows.map((r) => [r.id, { ...r }]));
  const bucket = new Set(objects);
  const calls = [];
  const deps = {
    getFileById: async (id) => (files.has(id) ? { ...files.get(id) } : null),
    storageKeyInUse: async (key, { exceptId } = {}) => [...files.values()].some((f) => f.id !== exceptId
      && ((f.storageKey === key && (!f.deletedAt || !f.trashKey)) || f.trashKey === key)),
    setTrashKeyIfUnmoved: async (id, { trashKey, storageKey }) => {
      const f = files.get(id);
      if (!f || !f.deletedAt || f.trashKey || f.storageKey !== storageKey) return false;
      f.trashKey = trashKey;
      calls.push(`point ${trashKey}`);
      return true;
    },
    trashedRowAtKey: async (key) => {
      const all = [...files.values()];
      if (all.some((f) => f.storageKey === key && !f.deletedAt)) return null;
      const hit = all.find((f) => f.storageKey === key && f.deletedAt && !f.trashKey);
      return hit ? { ...hit } : null;
    },
    listUnmovedTrash: async () => [...files.values()].filter((f) => f.deletedAt && !f.trashKey).map((f) => ({ ...f })),
    getStorageConfig: async () => CFG,
    storageForKey: async (cfg) => cfg,
    s3CopyObject: async (_cfg, from, to) => {
      calls.push(`copy ${from} → ${to}`);
      if (!bucket.has(from)) throw new Error(`NoSuchKey ${from}`);
      bucket.add(to);
    },
    s3DeleteObject: async (_cfg, key) => { calls.push(`delete ${key}`); bucket.delete(key); },
  };
  return { files, bucket, calls, deps };
}

const trashed = (over = {}) => ({
  id: 'f1', storage: 's3', storageKey: 'team/Cuts/A.mov', size: 1000, deletedAt: 1, trashKey: null, ...over,
});

describe('what may move', () => {
  test('only a trashed file whose object is still at its key, in the bucket, not too large', () => {
    assert.equal(moveBlocker(null), 'missing');
    assert.equal(moveBlocker(trashed({ deletedAt: null })), 'live');
    assert.equal(moveBlocker(trashed({ trashKey: '_trash/f1/x' })), 'moved');
    assert.equal(moveBlocker(trashed({ storage: 'blob' })), 'not-in-bucket');
    assert.equal(moveBlocker(trashed({ storageKey: null })), 'not-in-bucket');
    assert.equal(moveBlocker(trashed({ size: MOVE_MAX_BYTES + 1 })), 'too-large', 'past CopyObject’s ceiling it waits for the purge');
    assert.equal(moveBlocker(trashed({ size: MOVE_MAX_BYTES })), null);
    assert.equal(moveBlocker(trashed()), null);
  });

  test('the trash key is under the file’s id', () => {
    assert.equal(trashKeyFor('f1', 'team/Cuts/A.mov'), `${TRASH_PREFIX}/f1/team/Cuts/A.mov`);
  });
});

describe('the move', () => {
  test('copy, then point the row, then delete the original — in that order', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    assert.equal(await moveTrashedObject('f1', { deps: w.deps }), 'moved');
    assert.deepEqual(w.calls, [
      'copy team/Cuts/A.mov → _trash/f1/team/Cuts/A.mov',
      'point _trash/f1/team/Cuts/A.mov',
      'delete team/Cuts/A.mov',
    ]);
    assert.deepEqual([...w.bucket], ['_trash/f1/team/Cuts/A.mov']);
  });

  test('restored while it was copied: the copy goes, the original stays', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    const copy = w.deps.s3CopyObject;
    w.deps.s3CopyObject = async (...a) => { await copy(...a); w.files.get('f1').deletedAt = null; };
    assert.equal(await moveTrashedObject('f1', { deps: w.deps }), 'restored');
    assert.deepEqual([...w.bucket], ['team/Cuts/A.mov']);
    assert.equal(w.files.get('f1').trashKey, null);
  });

  test('another mover got there first: its trash copy is the object now, and is left alone', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    const copy = w.deps.s3CopyObject;
    w.deps.s3CopyObject = async (...a) => { await copy(...a); w.files.get('f1').trashKey = trashKeyFor('f1', 'team/Cuts/A.mov'); };
    assert.equal(await moveTrashedObject('f1', { deps: w.deps }), 'moved');
    assert.ok(w.bucket.has('_trash/f1/team/Cuts/A.mov'), 'not deleted from under the row pointing at it');
    assert.ok(!w.calls.includes('delete _trash/f1/team/Cuts/A.mov'));
  });

  test('when the row cannot be read after, the copy is kept rather than risk the only one', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    let reads = 0;
    const read = w.deps.getFileById;
    w.deps.getFileById = async (id) => (++reads === 1 ? read(id) : null);
    w.deps.setTrashKeyIfUnmoved = async () => false;
    assert.equal(await moveTrashedObject('f1', { deps: w.deps }), 'unknown');
    assert.ok(w.bucket.has('_trash/f1/team/Cuts/A.mov'));
    assert.ok(w.bucket.has('team/Cuts/A.mov'));
  });

  test('an object another row shares is not moved, as the delete never moved one', async () => {
    const w = world([trashed(), { id: 'f2', storage: 's3', storageKey: 'team/Cuts/A.mov', deletedAt: null }], { objects: ['team/Cuts/A.mov'] });
    assert.equal(await moveTrashedObject('f1', { deps: w.deps }), 'shared');
    assert.deepEqual(w.calls, []);
  });

  test('a copy that fails leaves the row and the object as they were, to be tried again', async () => {
    const w = world([trashed()], { objects: [] });
    await assert.rejects(() => moveTrashedObject('f1', { deps: w.deps }), /NoSuchKey/);
    assert.equal(w.files.get('f1').trashKey, null);
  });
});

describe('an upload that wants the key', () => {
  test('moves the trashed object out of it first', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    assert.equal(await vacateTrashedKey(CFG, 'team/Cuts/A.mov', { deps: w.deps }), 'moved');
    assert.ok(!w.bucket.has('team/Cuts/A.mov'));
  });

  test('nothing trashed there: nothing to do', async () => {
    const w = world([], { objects: [] });
    assert.equal(await vacateTrashedKey(CFG, 'team/Cuts/A.mov', { deps: w.deps }), 'none');
    assert.equal(await vacateTrashedKey(CFG, '', { deps: w.deps }), 'none');
  });

  test('waits no longer than its budget, and never throws', async () => {
    const w = world([trashed()], { objects: ['team/Cuts/A.mov'] });
    w.deps.s3CopyObject = () => new Promise(() => {});
    assert.equal(await vacateTrashedKey(CFG, 'team/Cuts/A.mov', { deps: w.deps, budgetMs: 20 }), 'late');
    const broken = world([trashed()]);
    broken.deps.trashedRowAtKey = async () => { throw new Error('database down'); };
    assert.equal(await vacateTrashedKey(CFG, 'team/Cuts/A.mov', { deps: broken.deps }), 'failed');
    const failing = world([trashed()], { objects: [] });
    assert.equal(await vacateTrashedKey(CFG, 'team/Cuts/A.mov', { deps: failing.deps }), 'failed');
  });
});

describe('the daily sweep', () => {
  test('moves what is left, and stops at its budget', async () => {
    const rows = [trashed({ id: 'a', storageKey: 'x/a' }), trashed({ id: 'b', storageKey: 'x/b' })];
    const w = world(rows, { objects: ['x/a', 'x/b'] });
    assert.equal(await moveLeftoverTrash({ deps: w.deps }), 2);
    assert.deepEqual([...w.bucket].sort(), ['_trash/a/x/a', '_trash/b/x/b']);

    const slow = world([trashed({ id: 'c', storageKey: 'x/c' }), trashed({ id: 'd', storageKey: 'x/d' })], { objects: ['x/c', 'x/d'] });
    const copy = slow.deps.s3CopyObject;
    slow.deps.s3CopyObject = async (...a) => { await new Promise((r) => setTimeout(r, 30)); return copy(...a); };
    assert.equal(await moveLeftoverTrash({ deps: slow.deps, budgetMs: 10 }), 1, 'one begun inside the budget, none after');
  });
});
