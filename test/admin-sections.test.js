// The admin sections' rules: where the old addresses go, what the rail
// shows (and that it never links to a page that does not exist), how a
// table sorts, what "Needs attention" lists, the request queue's filters,
// the new-drive request, what deleting a drive says, the move warning,
// and the health rows' version line.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { legacyAdminTab, legacyStoragePath, LEGACY_ADMIN_TABS } from '../lib/admin-redirects.js';
import { ADMIN_NAV, railGroups } from '../app/admin/nav.js';
import { activeHref } from '../lib/section-nav.js';
import { compareValues, sortRows, nextSort } from '../lib/admin-table.js';
import { attentionItems } from '../lib/admin-overview.js';
import { requestFilter, requestCounts, requestsFor, askedLabel, REQUEST_FILTERS } from '../lib/admin-requests.js';
import { newDriveRequest, deleteDriveConsequence } from '../lib/admin-drives.js';
import { moveWarning } from '../lib/storage-presets.js';
import { healthChecks } from '../lib/health-checks.js';
import { drivePrefixFor } from '../lib/folder-ops.js';

const ROOT = new URL('..', import.meta.url).pathname;

describe('redirects: the old addresses land on their sections', () => {
  test('every old ?tab= has a section', () => {
    assert.equal(legacyAdminTab('storage'), '/admin/storage');
    assert.equal(legacyAdminTab('filespaces'), '/admin/drives');
    assert.equal(legacyAdminTab('access'), '/admin/requests');
    assert.equal(legacyAdminTab('health'), '/admin/health');
    assert.equal(legacyAdminTab(['HEALTH']), '/admin/health', 'a repeated or shouted param still lands');
  });

  test('anything else stays on the Overview', () => {
    for (const t of [undefined, null, '', 'features', 'brand', '__proto__', 'toString', 'constructor']) {
      assert.equal(legacyAdminTab(t), null, String(t));
    }
  });

  test('/storage and /storage/duplicates, with their query, and nothing else', () => {
    assert.equal(legacyStoragePath('/storage'), '/admin/usage');
    assert.equal(legacyStoragePath('/storage/'), '/admin/usage');
    assert.equal(legacyStoragePath('/storage/duplicates', '?x=1'), '/admin/usage/duplicates?x=1');
    assert.equal(legacyStoragePath('/storage', '?'), '/admin/usage');
    assert.equal(legacyStoragePath('/storage/other'), null);
    assert.equal(legacyStoragePath('/files'), null);
  });

  test('every redirect target is a page that exists', () => {
    const targets = [...Object.values(LEGACY_ADMIN_TABS), legacyStoragePath('/storage'), legacyStoragePath('/storage/duplicates')];
    for (const t of targets) assert.ok(existsSync(join(ROOT, 'app', t, 'page.js')), `${t} has no page`);
  });

  test('the old storage routes redirect and render nothing of their own', () => {
    for (const p of ['app/storage', 'app/storage/duplicates']) {
      assert.equal(existsSync(join(ROOT, p, 'page.js')), false, `${p}/page.js should be gone`);
      assert.match(readFileSync(join(ROOT, p, 'route.js'), 'utf8'), /legacyStoragePath/);
    }
  });
});

describe('rail: the admin sections', () => {
  const items = ADMIN_NAV.flatMap((g) => g.items);

  test('no dead links: every item is a page in app/admin', () => {
    for (const { href } of items) assert.ok(existsSync(join(ROOT, 'app', href, 'page.js')), `${href} has no page`);
  });

  test('groups in the design order; unbuilt sections are left out, not shown disabled', () => {
    assert.deepEqual(ADMIN_NAV.map((g) => g.label || ''), ['', 'People', 'Content', 'Storage', 'AI', 'System']);
    assert.deepEqual(items.map((i) => i.href), [
      '/admin', '/admin/requests', '/admin/drives', '/admin/usage', '/admin/usage/duplicates', '/admin/storage', '/admin/health',
    ]);
    assert.equal(items.some((i) => i.disabled), false);
  });

  test('the pending badge, and none at zero', () => {
    const withCount = railGroups({ pendingRequests: 3 }).flatMap((g) => g.items).find((i) => i.href === '/admin/requests');
    assert.equal(withCount.count, 3);
    assert.equal(withCount.countLabel, '3 waiting');
    assert.equal('badge' in withCount, false, 'the badge key is the layout’s business, not the link’s');
    const none = railGroups({ pendingRequests: 0 }).flatMap((g) => g.items).find((i) => i.href === '/admin/requests');
    assert.equal(none.count, undefined);
  });

  test('each section lights its own item, a drawer its list', () => {
    assert.equal(activeHref('/admin', items), '/admin');
    assert.equal(activeHref('/admin/drives/abc', items), '/admin/drives');
    assert.equal(activeHref('/admin/usage/duplicates', items), '/admin/usage/duplicates');
    assert.equal(activeHref('/admin/requests?status=denied', items), '/admin/requests');
  });
});

describe('the admin files follow the design rules', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const files = [
    ...walk(join(ROOT, 'app/admin')),
    ...walk(join(ROOT, 'app/components/drives')),
    join(ROOT, 'app/components/ui/SectionRail.js'),
    join(ROOT, 'app/components/ui/SectionRail.css'),
  ].filter((f) => /\.(js|css)$/.test(f));

  test('no colour literals: tokens only', () => {
    for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /#[0-9a-fA-F]{3,6}\b/, f);
  });

  test('no product name in the panel: the brand comes from loadBrand()', () => {
    for (const f of files.filter((x) => x.includes('/app/admin/'))) assert.doesNotMatch(readFileSync(f, 'utf8'), /Onyx/, f);
  });
});

describe('tables: sorting', () => {
  test('numbers as numbers, text as a person reads it, blanks last either way', () => {
    assert.ok(compareValues(2, 10) < 0);
    assert.ok(compareValues('Drive 2', 'Drive 10') < 0, 'digits in numeric order');
    assert.equal(compareValues('brand', 'Brand'), 0, 'case does not decide');
    assert.ok(compareValues('', 'a', 'asc') > 0);
    assert.ok(compareValues('', 'a', 'desc') > 0);
    assert.ok(compareValues(null, 0, 'desc') > 0);
  });

  test('sorts by the column’s own value, and keeps the server’s order on ties', () => {
    const cols = [{ key: 'name' }, { key: 'size', num: true, value: (r) => r.bytes }];
    const rows = [{ id: 1, name: 'b', bytes: 5 }, { id: 2, name: 'a', bytes: 9 }, { id: 3, name: 'c', bytes: 5 }];
    assert.deepEqual(sortRows(rows, cols, { key: 'name', dir: 'asc' }).map((r) => r.id), [2, 1, 3]);
    assert.deepEqual(sortRows(rows, cols, { key: 'size', dir: 'desc' }).map((r) => r.id), [2, 1, 3]);
    assert.deepEqual(sortRows(rows, cols, { key: 'size', dir: 'asc' }).map((r) => r.id), [1, 3, 2]);
    assert.deepEqual(sortRows(rows, cols, null).map((r) => r.id), [1, 2, 3]);
    assert.deepEqual(sortRows(rows, cols, { key: 'missing', dir: 'asc' }).map((r) => r.id), [1, 2, 3]);
  });

  test('a header click: a new column starts in its natural order, the same one flips', () => {
    assert.deepEqual(nextSort(null, { key: 'name' }), { key: 'name', dir: 'asc' });
    assert.deepEqual(nextSort(null, { key: 'bytes', num: true }), { key: 'bytes', dir: 'desc' }, 'biggest first');
    assert.deepEqual(nextSort({ key: 'name', dir: 'asc' }, { key: 'name' }), { key: 'name', dir: 'desc' });
    assert.deepEqual(nextSort({ key: 'name', dir: 'desc' }, { key: 'name' }), { key: 'name', dir: 'asc' });
  });
});

describe('overview: needs attention', () => {
  test('nothing to do is an empty list', () => {
    assert.deepEqual(attentionItems({}), []);
    assert.deepEqual(attentionItems({ health: { checks: [{ id: 'database', status: 'pass', label: 'Database' }] } }), []);
  });

  test('failures first, then warnings; storage goes to Backend, the rest to Health', () => {
    const items = attentionItems({
      pending: [{ email: 'a@x.com', name: 'Ann' }, { email: 'b@x.com' }],
      drivesWithoutOwner: [{ id: 'd1', name: 'Archive' }, { id: 'd2', name: 'Acme' }],
      health: { checks: [
        { id: 'cron', status: 'warn', label: 'Scheduled maintenance', detail: 'CRON_SECRET is not set.' },
        { id: 'storage', status: 'fail', label: 'Storage', detail: 'Bucket is not answering.', fix: 'Run the diagnostics.' },
      ] },
    });
    assert.deepEqual(items.map((i) => i.id), ['health-storage', 'health-cron', 'requests', 'drives-no-owner']);
    assert.equal(items[0].href, '/admin/storage');
    assert.equal(items[0].detail, 'Bucket is not answering. Run the diagnostics.');
    assert.equal(items[1].href, '/admin/health');
    assert.equal(items[2].title, '2 people are waiting for access');
    assert.equal(items[2].detail, 'Ann, b@x.com');
  });

  test('one drive with no owner links to its members', () => {
    const [item] = attentionItems({ drivesWithoutOwner: [{ id: 'a b', name: 'Archive' }] });
    assert.equal(item.href, '/admin/drives/a%20b#members');
    assert.equal(item.title, '“Archive” has no owner');
    const [one] = attentionItems({ pending: [{ email: 'a@x.com' }] });
    assert.equal(one.title, '1 person is waiting for access');
  });

  test('long lists are cut short', () => {
    const pending = Array.from({ length: 5 }, (_, i) => ({ email: `p${i}@x.com` }));
    assert.equal(attentionItems({ pending })[0].detail, 'p0@x.com, p1@x.com, p2@x.com and 2 more');
  });
});

describe('access requests', () => {
  const rows = [
    { id: 1, email: 'a@x.com', status: 'pending', requestedAt: 100 },
    { id: 2, email: 'b@x.com', status: 'pending', requestedAt: 300 },
    { id: 3, email: 'c@x.com', status: 'denied', requestedAt: 50, reviewedAt: 400 },
    { id: 4, email: 'd@x.com', status: 'approved', requestedAt: 10, reviewedAt: 20 },
    { id: 5, email: 'e@x.com', status: 'approved', requestedAt: 900, reviewedAt: 950 },
    { id: 6, email: 'f@x.com', status: 'banned', requestedAt: 1 },
  ];

  test('the filter a ?status= asks for; anything else is the queue', () => {
    assert.equal(requestFilter('denied'), 'denied');
    assert.equal(requestFilter(['APPROVED']), 'approved');
    for (const v of [undefined, '', 'banned', 'all']) assert.equal(requestFilter(v), 'pending');
    assert.deepEqual(REQUEST_FILTERS.map((f) => f.key), ['pending', 'denied', 'approved']);
  });

  test('counts per filter; other statuses are not counted', () => {
    assert.deepEqual(requestCounts(rows), { pending: 2, denied: 1, approved: 2 });
    assert.deepEqual(requestCounts(null), { pending: 0, denied: 0, approved: 0 });
  });

  test('newest first: the queue by when they asked, the rest by when they were decided', () => {
    assert.deepEqual(requestsFor(rows, 'pending').map((r) => r.id), [2, 1]);
    assert.deepEqual(requestsFor(rows, 'approved').map((r) => r.id), [5, 4]);
  });

  test('"Asked N times" only when there is a count above one', () => {
    assert.equal(askedLabel({}), '');
    assert.equal(askedLabel({ requestCount: 1 }), '');
    assert.equal(askedLabel({ requestCount: 3 }), 'Asked 3 times');
  });
});

describe('drives: making and deleting', () => {
  test('the folder follows the name until typed, as on the files page', () => {
    assert.deepEqual(newDriveRequest({ name: ' Brand Assets ' }, drivePrefixFor), { body: { name: 'Brand Assets', prefix: 'brand-assets' } });
    assert.deepEqual(
      newDriveRequest({ name: 'Brand', prefix: '/clients/acme/', prefixTouched: true }, drivePrefixFor).body,
      { name: 'Brand', prefix: 'clients/acme' },
    );
  });

  test('a name and a folder are required', () => {
    assert.equal(newDriveRequest({ name: '' }, drivePrefixFor).error, 'Give the drive a name.');
    assert.equal(newDriveRequest({ name: '!!!' }, drivePrefixFor).error, 'Give the drive a folder in the bucket.');
  });

  test('advanced fields only when filled; keys as a pair or not at all', () => {
    const base = { name: 'Archive' };
    assert.deepEqual(Object.keys(newDriveRequest({ ...base, bucket: '  ', region: 'eu-west-1' }, drivePrefixFor).body), ['name', 'prefix', 'region']);
    assert.match(newDriveRequest({ ...base, accessKeyId: 'AK' }, drivePrefixFor).error, /both/);
    assert.match(newDriveRequest({ ...base, secretAccessKey: 's' }, drivePrefixFor).error, /both/);
    assert.deepEqual(
      newDriveRequest({ ...base, accessKeyId: ' AK ', secretAccessKey: ' s3cret ', endpoint: 'https://e' }, drivePrefixFor).body,
      { name: 'Archive', prefix: 'archive', endpoint: 'https://e', accessKeyId: 'AK', secretAccessKey: ' s3cret ' },
    );
  });

  test('deleting says who loses it, that the files stay, and who then sees them', () => {
    const lines = deleteDriveConsequence({ bucket: 'main', prefix: 'brand', files: 1204, bytes: 5 * 1024 ** 3, members: 3, ownKeys: true });
    assert.equal(lines[0], '3 members lose it on the files page and in the desktop app. Desktop mounts of it stop within the hour.');
    assert.equal(lines[1], 'Its 1,204 files (5.0 GB) stay in storage and become visible to everyone who can see All files, unless a file is private or inside another drive.');
    assert.ok(lines.includes('The access keys saved for this drive are forgotten.'));
    assert.equal(lines.at(-1), 'Nothing in the bucket is deleted.');
  });

  test('an empty drive with no members', () => {
    const lines = deleteDriveConsequence({ bucket: 'main', prefix: '/brand/', files: 0, members: 0 });
    assert.equal(lines[0], 'It has no members, so no one loses access to it.');
    assert.equal(lines[1], 'Nothing is stored under main/brand.');
    assert.equal(lines.some((l) => l.includes('keys')), false);
  });
});

describe('storage: the move warning', () => {
  const s3 = { provider: 's3', bucket: 'acme-media', endpoint: '' };

  test('names what is stored, where, and that it stays', () => {
    const w = moveWarning(s3, { ...s3, bucket: 'new-bucket' }, 18402);
    assert.equal(w.body, 'This library has 18,402 files in the bucket “acme-media”. They will not move. Switching to the bucket “new-bucket” sends new uploads there, and the files already stored stop opening until they are copied across by hand.');
    assert.equal(w.confirmLabel, 'Change it anyway');
  });

  test('provider and service changes, and one file', () => {
    assert.match(moveWarning(s3, { provider: 'blob' }, 1).body, /^This library has 1 file in the bucket “acme-media”\. .*Switching to Vercel Blob .*the file already stored stops opening until it is copied/);
    assert.match(moveWarning({ provider: 'blob' }, s3, 2).body, /2 files in Vercel Blob\. .*Switching to an S3 bucket/);
    assert.match(moveWarning(s3, { ...s3, endpoint: 'https://s3.us-west-004.backblazeb2.com' }, 2).body, /Switching to another service/);
  });
});

describe('health: the version line', () => {
  test('the build label already carries the version, so it is not said twice', () => {
    const row = (b) => healthChecks(b).checks.find((c) => c.id === 'version')?.detail;
    assert.equal(row({ version: '0.1.0', build: '0.1.0 · dev' }), '0.1.0 · dev');
    assert.equal(row({ version: '0.1.0', build: '0.1.0 · 3f2c1ab' }), '0.1.0 · 3f2c1ab');
    assert.equal(row({ version: '0.1.0' }), '0.1.0');
    assert.equal(row({ version: '0.2.0', build: 'custom' }), '0.2.0 · custom');
  });
});
