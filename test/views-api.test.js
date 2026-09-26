// The saved-views routes (/api/views, /api/views/[id]) run for real, with no
// database: '@/lib/db' and '@/lib/authz' resolve to the in-memory stand-in
// in test/fixtures/views-stubs.mjs. Everything between — the validation in
// lib/views.js, the drive check, the owner check, the limits — is the code
// that runs in production. The principals are real (principalFrom), so a
// member's drives are the ones their capped role reaches.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const STUB = new URL('./fixtures/views-stubs.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/lib/db' || specifier === '@/lib/authz') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});

const { principalFrom } = await import('../lib/authz.js');
const { DEFAULT_FLAGS } = await import('../lib/features.js');
const { LIMITS } = await import('../lib/views.js');
const listRoute = await import('../app/api/views/route.js');
const oneRoute = await import('../app/api/views/[id]/route.js');

const NORTHWIND = { id: 'nw', name: 'Northwind', prefix: 'northwind' };
const SECRET = { id: 'sec', name: 'Secret', prefix: 'secret' };
const DRIVES = [NORTHWIND, SECRET];

const who = (email, { roles = { nw: 'editor' }, isAdmin = false, roleId = 'member' } = {}) => principalFrom({
  email, isAdmin, person: { roleId }, globalFlags: DEFAULT_FLAGS, grants: { drives: DRIVES, roles },
});
const ANA = 'ana@views.test';
const BEN = 'ben@views.test';
const BOSS = 'boss@views.test';

function reset() {
  globalThis.__views = { actor: null, drives: DRIVES, rows: new Map(), seq: 0, drivesAsked: [] };
}
const as = (email, opts) => { globalThis.__views.actor = email ? who(email, opts) : null; };

async function call(handler, { method = 'GET', id, body, raw, headers = {} } = {}) {
  const init = { method, headers: { 'content-type': 'application/json', ...headers } };
  if (raw !== undefined) init.body = raw;
  else if (body !== undefined) init.body = JSON.stringify(body);
  const url = `http://app.test/api/views${id ? `/${id}` : ''}`;
  const res = await handler(new Request(url, init), { params: id ? { id } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const list = () => call(listRoute.GET);
const create = (body, extra) => call(listRoute.POST, { method: 'POST', body, ...extra });
const patch = (id, body, extra) => call(oneRoute.PATCH, { method: 'PATCH', id, body, ...extra });
const remove = (id) => call(oneRoute.DELETE, { method: 'DELETE', id });

beforeEach(reset);

describe('signed out', () => {
  test('every method is a 401', async () => {
    as(null);
    assert.equal((await list()).status, 401);
    assert.equal((await create({ name: 'x' })).status, 401);
    assert.equal((await patch('view-1', { name: 'y' })).status, 401);
    assert.equal((await remove('view-1')).status, 401);
    assert.equal(globalThis.__views.rows.size, 0);
  });
});

describe('saving a view', () => {
  test('a view is saved as validated and listed back, with nothing about its owner', async () => {
    as(ANA);
    const r = await create({
      name: 'Hero shots',
      filters: { kinds: ['image'], facets: { project: ['Spring'] }, tags: ['Hero'], q: 'beach' },
      sort: 'size',
      display: { layout: 'tile', fields: ['dimensions'], thumb: 'fit', size: 'l', flatten: true },
    });
    assert.equal(r.status, 201);
    assert.equal(r.body.view.name, 'Hero shots');
    assert.deepEqual(r.body.view.filters.tags, ['hero']);
    assert.equal(r.body.view.ownerEmail, undefined);
    const stored = [...globalThis.__views.rows.values()][0];
    assert.equal(stored.ownerEmail, ANA, 'the owner is the session');
    const got = await list();
    assert.equal(got.status, 200);
    assert.deepEqual(got.body.views.map((v) => v.name), ['Hero shots']);
    assert.equal(got.body.views[0].display.layout, 'tile');
  });

  test('bad input is refused with what was wrong, and nothing is stored', async () => {
    as(ANA);
    for (const [body, status, pattern] of [
      [{}, 400, /name/],
      [{ name: 'x', display: { layout: 'mosaic' } }, 400, /layout/],
      [{ name: 'x', filters: { kinds: ['movies'] } }, 400, /kinds/],
      [{ name: 'x', ownerEmail: BEN }, 400, /not part of a view/],
      [{ name: 'x', sort: 'random' }, 400, /sort/],
    ]) {
      const r = await create(body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.match(r.body.error, pattern);
    }
    const notJson = await create(undefined, { raw: '{"name": "x",' });
    assert.equal(notJson.status, 400);
    assert.match(notJson.body.error, /JSON/);
    const empty = await create(undefined, { raw: '' });
    assert.equal(empty.status, 400);
    const huge = await create({ name: 'x', filters: { q: 'q'.repeat(40 * 1024) } });
    assert.equal(huge.status, 413, 'refused before it is parsed, by size');
    assert.equal(globalThis.__views.rows.size, 0);
  });

  test('names are one per person, and the number of views is bounded', async () => {
    as(ANA);
    assert.equal((await create({ name: 'Selects' })).status, 201);
    const again = await create({ name: '  selects ' });
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already have a view/);
    as(BEN);
    assert.equal((await create({ name: 'Selects' })).status, 201, 'someone else may use the same name');

    as(ANA);
    for (let i = 1; i < LIMITS.views; i++) assert.equal((await create({ name: `View ${i}` })).status, 201);
    const over = await create({ name: 'One too many' });
    assert.equal(over.status, 409);
    assert.match(over.body.error, /most one person can keep/);
  });
});

describe('ownership', () => {
  test('nobody else can list, change or delete a view', async () => {
    as(ANA);
    const { body } = await create({ name: 'Mine', display: { layout: 'list' } });
    const id = body.view.id;
    as(BEN);
    assert.deepEqual((await list()).body.views, []);
    const p = await patch(id, { name: 'Taken' });
    assert.equal(p.status, 404, 'someone else’s view is missing, not forbidden');
    assert.equal((await remove(id)).status, 404);
    as(BOSS, { isAdmin: true });
    assert.deepEqual((await list()).body.views, [], 'an admin does not see other people’s views either');
    assert.equal((await patch(id, { name: 'Admin was here' })).status, 404);
    as(ANA);
    const mine = (await list()).body.views;
    assert.equal(mine.length, 1);
    assert.equal(mine[0].name, 'Mine', 'unchanged');
  });

  test('the owner can rename, change and delete; what is not sent stays', async () => {
    as(ANA);
    const { body } = await create({ name: 'Draft', sort: 'name', display: { layout: 'column', fields: ['size'] } });
    const id = body.view.id;
    const renamed = await patch(id, { name: 'Final' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.view.name, 'Final');
    assert.equal(renamed.body.view.sort, 'name', 'the sort was not sent, so it stays');
    assert.equal(renamed.body.view.display.layout, 'column');
    const changed = await patch(id, { display: { layout: 'grid', size: 's' }, filters: { q: 'take 2' } });
    assert.equal(changed.body.view.display.layout, 'grid');
    assert.deepEqual(changed.body.view.display.fields, ['size', 'type', 'modified'], 'display is replaced whole');
    assert.equal(changed.body.view.filters.q, 'take 2');
    assert.equal((await patch(id, { colour: 'red' })).status, 400);
    assert.equal((await patch(id, { name: '' })).status, 400);
    assert.equal((await remove(id)).status, 200);
    assert.deepEqual((await list()).body.views, []);
    assert.equal((await remove(id)).status, 404, 'gone is gone');
  });

  test('a rename cannot take another of their names', async () => {
    as(ANA);
    await create({ name: 'One' });
    const two = (await create({ name: 'Two' })).body.view.id;
    const r = await patch(two, { name: 'ONE' });
    assert.equal(r.status, 409);
    assert.equal((await patch(two, { name: 'Two' })).status, 200, 'its own name is not a clash');
  });
});

describe('drive scope', () => {
  test('a view can be scoped only to a drive the person can open', async () => {
    as(ANA, { roles: { nw: 'viewer' } });
    const inDrive = await create({ name: 'Northwind selects', driveId: 'nw' });
    assert.equal(inDrive.status, 201, 'viewing a drive is enough to keep a view of it');
    assert.equal(inDrive.body.view.driveId, 'nw');
    const notMine = await create({ name: 'Peek', driveId: 'sec' });
    assert.equal(notMine.status, 400);
    const missing = await create({ name: 'Peek', driveId: 'no-such-drive' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, notMine.body.error, 'a drive not theirs and no drive at all read the same');
    const moved = await patch(inDrive.body.view.id, { driveId: 'sec' });
    assert.equal(moved.status, 400);
    const everywhere = await patch(inDrive.body.view.id, { driveId: null });
    assert.equal(everywhere.status, 200);
    assert.equal(everywhere.body.view.driveId, null);
  });

  test('a view of a drive someone was taken off is not returned, nor changeable', async () => {
    as(ANA, { roles: { nw: 'editor' } });
    const scoped = (await create({ name: 'Northwind only', driveId: 'nw' })).body.view.id;
    await create({ name: 'Everywhere' });
    as(ANA, { roles: {} });
    assert.deepEqual((await list()).body.views.map((v) => v.name), ['Everywhere']);
    assert.equal((await patch(scoped, { name: 'Back door' })).status, 404);
    assert.equal((await remove(scoped)).status, 404);
    assert.equal(globalThis.__views.rows.get(scoped).name, 'Northwind only', 'kept, for if they are let back in');
    as(ANA, { roles: { nw: 'viewer' } });
    assert.deepEqual((await list()).body.views.map((v) => v.name), ['Northwind only', 'Everywhere']);
  });

  test('a view of a deleted drive disappears the same way', async () => {
    as(ANA, { roles: { nw: 'editor' } });
    await create({ name: 'Northwind only', driveId: 'nw' });
    globalThis.__views.drives = [SECRET];
    assert.deepEqual((await list()).body.views, []);
  });

  test('an admin may scope to any drive, as they may open any', async () => {
    as(BOSS, { isAdmin: true });
    assert.equal((await create({ name: 'Secret review', driveId: 'sec' })).status, 201);
    assert.equal((await list()).body.views.length, 1);
  });
});
