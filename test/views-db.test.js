// Saved views end to end: the real /api/views routes against a real
// database, with only the session stubbed ('@/auth' → whoever the test
// says). Runs with TEST_DATABASE_URL pointing at a throwaway database, and
// skips without one.
//
// What only a database can show: that the table and its index come from the
// guard, that the owner in the SQL's WHERE holds on its own, that the JSONB
// settings round-trip, and that the drive a view is scoped to is judged by
// the real drive grants (listFilespacesForSpace), not a stand-in.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const URL_ = process.env.TEST_DATABASE_URL;
async function reachable(url) {
  if (!url) return false;
  const { default: postgres } = await import('postgres');
  const probe = postgres(url, { max: 1, connect_timeout: 3, idle_timeout: 1 });
  try { await probe`SELECT 1`; return true; } catch { return false; } finally { await probe.end({ timeout: 2 }).catch(() => {}); }
}
const live = await reachable(URL_);
process.env.DATABASE_URL = live ? URL_ : 'postgres://onyx:onyx@127.0.0.1:1/onyx';
process.env.ADMIN_EMAILS = 'boss@views.test';
const skip = !live && 'TEST_DATABASE_URL not reachable';

const STUB = `data:text/javascript,${encodeURIComponent('export async function auth() { return globalThis.__viewsSession || null; }')}`;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@/auth') return { url: STUB, shortCircuit: true };
    return next(specifier, context);
  },
});
const as = (email) => { globalThis.__viewsSession = email ? { user: { email } } : null; };

const db = await import('../lib/db.js');
const listRoute = await import('../app/api/views/route.js');
const oneRoute = await import('../app/api/views/[id]/route.js');

const tag = Math.random().toString(36).slice(2, 8);
const ANA = `ana-${tag}@views.test`;
const BEN = `ben-${tag}@views.test`;

async function call(handler, { method = 'GET', id, body } = {}) {
  const res = await handler(new Request(`http://app.test/api/views${id ? `/${id}` : ''}`, {
    method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }), { params: id ? { id } : {} });
  return { status: res.status, body: await res.json().catch(() => null) };
}

let drive;
before(async () => {
  if (!live) return;
  await db.ensureSchema();
  drive = await db.createFilespace({ name: `Views ${tag}`, bucket: 'b', prefix: `views-${tag}`, createdBy: 'boss@views.test' });
  await db.grantFilespaceAccess({ filespaceId: drive.id, email: ANA, role: 'viewer' });
  for (const email of [ANA, BEN]) await db.adminAddApprovedInvite({ email, name: email, reviewedBy: 'test' });
});

after(async () => {
  if (live) {
    await db.sql`DELETE FROM saved_views WHERE owner_email IN (${ANA}, ${BEN})`.catch(() => {});
    if (drive) await db.deleteFilespace(drive.id).catch(() => {});
    await db.sql`DELETE FROM invite_requests WHERE email LIKE ${`%-${tag}@views.test`}`.catch(() => {});
  }
  await db.sql.end({ timeout: 5 }).catch(() => {});
});

describe('saved views against a real database', { skip }, () => {
  test('the guard made the table, keyed for one person’s reads', async () => {
    const [t] = await db.sql`SELECT to_regclass('public.saved_views') AS t, to_regclass('public.saved_views_owner_idx') AS i`;
    assert.ok(t.t, 'saved_views');
    assert.ok(t.i, 'saved_views_owner_idx');
  });

  test('a view round-trips through the routes, settings and all', async () => {
    as(ANA);
    const made = await call(listRoute.POST, {
      method: 'POST',
      body: {
        name: 'Northwind stills', driveId: drive.id,
        filters: { kinds: ['image'], facets: { project: ['Spring launch'] }, tags: ['Hero'], q: 'coast' },
        sort: 'modified', display: { layout: 'tile', fields: ['dimensions', 'meta:project'], thumb: 'fit', size: 'l', flatten: true },
      },
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const [row] = await db.sql`SELECT owner_email, drive_id, filters, display FROM saved_views WHERE id = ${made.body.view.id}`;
    assert.equal(row.owner_email, ANA);
    assert.equal(row.drive_id, drive.id);
    assert.deepEqual(row.filters.tags, ['hero']);
    assert.equal(row.display.layout, 'tile');
    const listed = await call(listRoute.GET);
    assert.deepEqual(listed.body.views.map((v) => v.name), ['Northwind stills']);
    assert.deepEqual(listed.body.views[0].display, { layout: 'tile', fields: ['dimensions', 'meta:project'], thumb: 'fit', size: 'l', flatten: true });
  });

  test('the owner in the SQL holds even when a caller does not check', async () => {
    const [view] = await db.listSavedViews(ANA);
    assert.equal(await db.updateSavedView(view.id, BEN, { ...view, name: 'Hijacked' }), null);
    assert.equal(await db.deleteSavedView(view.id, BEN), false);
    const [still] = await db.listSavedViews(ANA);
    assert.equal(still.name, 'Northwind stills');
    as(BEN);
    assert.deepEqual((await call(listRoute.GET)).body.views, []);
    assert.equal((await call(oneRoute.PATCH, { method: 'PATCH', id: view.id, body: { name: 'Hijacked' } })).status, 404);
  });

  test('scoped to the real drive grants: a drive Ben is not in is refused, and Ana’s view goes when she leaves', async () => {
    as(BEN);
    assert.equal((await call(listRoute.POST, { method: 'POST', body: { name: 'Peek', driveId: drive.id } })).status, 400);
    as(ANA);
    await db.revokeFilespaceAccess({ filespaceId: drive.id, email: ANA });
    assert.deepEqual((await call(listRoute.GET)).body.views, []);
    const [view] = await db.listSavedViews(ANA);
    assert.equal((await call(oneRoute.DELETE, { method: 'DELETE', id: view.id })).status, 404);
    await db.grantFilespaceAccess({ filespaceId: drive.id, email: ANA, role: 'viewer' });
    assert.equal((await call(listRoute.GET)).body.views.length, 1, 'back with her access');
    assert.equal((await call(oneRoute.DELETE, { method: 'DELETE', id: view.id })).status, 200);
    assert.deepEqual(await db.listSavedViews(ANA), []);
  });
});
