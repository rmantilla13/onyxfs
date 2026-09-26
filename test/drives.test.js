// Drives as permission boundaries (lib/drive-access.js), as the listing query,
// the single-file write rule and the upload routes apply them — and the
// storage report's arithmetic, which describes what is in them.
//
// The boundary is the part where a mistake is silent: a drive that leaks shows
// nothing wrong to the people it leaks to. So each rule is pinned from both
// sides — who gets in, and who does not.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { drivesHolding, driveAccess, drivePatterns, canWriteDrive, prefixOverlap } from '../lib/drive-access.js';
import { buildFileQuery } from '../lib/file-query.js';
import { drivePrefixFor } from '../lib/folder-ops.js';
import {
  kindBreakdown, keeperOf, groupDuplicates, copiesToRemove, bytesOf, formatLabel, TRASH_RETENTION_DAYS,
} from '../lib/storage-report.js';

delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
const { fileWriteDecision } = await import('../lib/db.js');
const { etagOf } = await import('../lib/storage.js');

const drives = [
  { id: 'brand', prefix: 'brand-assets' },
  { id: 'clients', prefix: 'clients' },
  { id: 'acme', prefix: 'clients/acme' }, // a drive inside another
];

describe('which drives hold a key', () => {
  test('by prefix, and only at a folder boundary', () => {
    assert.deepEqual(drivesHolding('brand-assets/logo.png', drives).map((d) => d.id), ['brand']);
    assert.deepEqual(drivesHolding('brand-assets-old/logo.png', drives), [], 'a longer name is not inside');
    assert.deepEqual(drivesHolding('brand-assets', drives), [], 'the prefix itself is not a file in it');
    assert.deepEqual(drivesHolding('files/logo.png', drives), []);
    assert.deepEqual(drivesHolding('', drives), []);
    assert.deepEqual(drivesHolding(null, drives), []);
  });

  test('a drive inside another: both hold its files', () => {
    assert.deepEqual(drivesHolding('clients/acme/brief.pdf', drives).map((d) => d.id).sort(), ['acme', 'clients']);
  });
});

describe('what membership allows', () => {
  test('outside every drive, the library decides', () => {
    assert.deepEqual(driveAccess('files/a.png', { drives, roles: {} }), { inDrive: false, read: true, write: true });
  });

  test('a non-member sees nothing in a drive', () => {
    assert.deepEqual(driveAccess('brand-assets/a.png', { drives, roles: { clients: 'owner' } }), { inDrive: true, read: false, write: false });
  });

  test('a viewer reads and does not write; editors and owners do both', () => {
    assert.deepEqual(driveAccess('brand-assets/a.png', { drives, roles: { brand: 'viewer' } }), { inDrive: true, read: true, write: false });
    for (const role of ['editor', 'owner']) {
      assert.deepEqual(driveAccess('brand-assets/a.png', { drives, roles: { brand: role } }), { inDrive: true, read: true, write: true });
    }
  });

  test('admins reach every drive', () => {
    assert.deepEqual(driveAccess('brand-assets/a.png', { drives, roles: {}, isAdmin: true }), { inDrive: true, read: true, write: true });
  });

  test('nested: belonging to either drive counts', () => {
    const key = 'clients/acme/brief.pdf';
    assert.equal(driveAccess(key, { drives, roles: { clients: 'viewer' } }).read, true, 'the outer drive reaches in');
    assert.equal(driveAccess(key, { drives, roles: { acme: 'editor' } }).write, true, 'the inner drive is enough');
    // …but the inner drive does not open the rest of the outer one.
    assert.equal(driveAccess('clients/globex/brief.pdf', { drives, roles: { acme: 'owner' } }).read, false);
  });

  test('the write roles', () => {
    assert.equal(canWriteDrive('viewer'), false);
    assert.equal(canWriteDrive('editor'), true);
    assert.equal(canWriteDrive('owner'), true);
    assert.equal(canWriteDrive(undefined), false);
    assert.equal(canWriteDrive('viewer', true), true, 'admins');
  });
});

describe('the listing query', () => {
  const viewer = { isAdmin: false, email: 'someone@example.com', roleId: 'member', folderGrants: [] };
  const withDrives = (roles) => ({
    ...viewer,
    drivePatterns: {
      all: drivePatterns(drives),
      mine: drivePatterns(drives.filter((d) => roles[d.id])),
    },
  });

  test('patterns are prefixes with LIKE escaped', () => {
    assert.deepEqual(drivePatterns([{ prefix: '/brand_assets/' }, { prefix: '100%' }, { prefix: '' }]), ['brand\\_assets/%', '100\\%/%']);
    assert.deepEqual(drivePatterns([{ prefix: 'a' }, { prefix: 'a/' }]), ['a/%'], 'one pattern per prefix');
  });

  test('with drives, a non-admin is kept out of the ones they are not in', () => {
    const { text, params } = buildFileQuery({ opts: {}, principal: withDrives({ brand: 'viewer' }) });
    assert.match(text, /NOT \(coalesce\(f\.storage_key, ''\) LIKE ANY\(\$\d+::text\[\]\)\)/);
    assert.ok(params.some((p) => Array.isArray(p) && p.includes('brand-assets/%') && p.includes('clients/%')), 'every drive is fenced');
    assert.ok(params.some((p) => Array.isArray(p) && p.length === 1 && p[0] === 'brand-assets/%'), 'their own drive is let back in');
  });

  test('belonging to no drive fences every drive, with no way back in but a file grant', () => {
    const { text } = buildFileQuery({ opts: {}, principal: withDrives({}) });
    const clause = text.slice(text.indexOf('NOT (coalesce(f.storage_key'));
    assert.equal((clause.match(/LIKE ANY/g) || []).length, 1, 'no member clause when they belong to none');
    assert.ok(clause.includes('file_acl'), 'a grant on the file itself still opens it');
  });

  test('every placeholder still has its parameter', () => {
    const { text, params } = buildFileQuery({ opts: { q: 'x' }, principal: withDrives({ brand: 'owner', acme: 'viewer' }) });
    const used = new Set([...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(used.size, params.length, 'each parameter is referenced');
    for (const n of used) assert.ok(n >= 1 && n <= params.length);
  });

  test('no drives, or an admin: no drive clause at all', () => {
    assert.ok(!buildFileQuery({ opts: {}, principal: viewer }).text.includes('LIKE ANY'));
    assert.ok(!buildFileQuery({ opts: {}, principal: { isAdmin: true, drivePatterns: { all: ['x/%'], mine: [] } } }).text.includes('LIKE ANY'));
  });
});

describe('writing a file in a drive', () => {
  const file = { id: 'f1', name: 'a.png', folder: '', createdBy: 'me@example.com', visibility: 'org' };
  const me = { email: 'me@example.com', isAdmin: false, roleId: 'member' };

  test('its editors may change anything in it, not only their own files', () => {
    const d = fileWriteDecision({ file: { ...file, createdBy: 'someone@else.com' }, principal: me, drive: { inDrive: true, read: true, write: true } });
    assert.deepEqual(d, { allowed: true, reason: 'drive-editor' });
  });

  test('its viewers change nothing — not even what they uploaded', () => {
    const d = fileWriteDecision({ file, principal: me, drive: { inDrive: true, read: true, write: false } });
    assert.deepEqual(d, { allowed: false, reason: 'drive-viewer' });
  });

  test('a folder grant does not reach into a drive; a grant on the file does', () => {
    const drive = { inDrive: true, read: false, write: false };
    assert.equal(fileWriteDecision({ file, principal: me, folderRoles: ['owner'], drive }).allowed, false);
    assert.equal(fileWriteDecision({ file, principal: me, drive }).reason, 'not-a-member');
    assert.deepEqual(fileWriteDecision({ file, principal: me, fileAccess: 'editor', drive }), { allowed: true, reason: 'file-grant' });
  });

  test('outside a drive nothing changes, and platform viewers and admins are as before', () => {
    assert.equal(fileWriteDecision({ file, principal: me, drive: { inDrive: false, read: true, write: true } }).reason, 'creator');
    assert.equal(fileWriteDecision({ file, principal: { ...me, roleId: 'viewer' }, drive: { inDrive: true, write: true } }).allowed, false);
    assert.equal(fileWriteDecision({ file, principal: { ...me, isAdmin: true }, drive: { inDrive: true, write: false } }).reason, 'admin');
  });
});

describe('a new drive’s folder in the bucket', () => {
  test('from its name', () => {
    assert.equal(drivePrefixFor('Brand Assets (2026)'), 'brand-assets-2026');
    assert.equal(drivePrefixFor('Café Déjà Vu'), 'cafe-deja-vu');
    assert.equal(drivePrefixFor('  ///  '), '');
    assert.ok(!drivePrefixFor(`${'a'.repeat(59)} b`).endsWith('-'), 'never ends on a hyphen after trimming');
  });
});

describe('where a self-serve drive may go', () => {
  // Its creator becomes owner of everything under the prefix, and membership
  // of either of two nested drives counts. So a drive around another hands
  // over the inner one, and a drive inside another sits in someone else's.
  const admins = [{ id: 'c26', name: 'Campaigns 2026', prefix: 'drives/campaigns/2026', bucket: 'b' }];

  test('around an existing drive is refused: it would own that drive’s files', () => {
    assert.equal(prefixOverlap('drives/campaigns', admins)?.around?.id, 'c26');
    // …and it is exactly what driveAccess would have granted.
    const r = driveAccess('drives/campaigns/2026/x.mov', { drives: [...admins, { id: 'mine', prefix: 'drives/campaigns' }], roles: { mine: 'owner' } });
    assert.deepEqual(r, { inDrive: true, read: true, write: true });
  });

  test('inside or equal to an existing drive is refused', () => {
    assert.equal(prefixOverlap('drives/campaigns/2026', admins)?.inside?.id, 'c26');
    assert.equal(prefixOverlap('drives/campaigns/2026/q1', admins)?.inside?.id, 'c26');
    assert.equal(prefixOverlap('/drives/campaigns/2026/', admins)?.inside?.id, 'c26');
  });

  test('only at a folder boundary, and whatever the bucket', () => {
    assert.equal(prefixOverlap('drives/campaigns-2', admins), null);
    assert.equal(prefixOverlap('drives/campaign', admins), null);
    // Which drive holds a key is decided from the key alone, so another
    // bucket's drive at the same place still counts.
    assert.equal(prefixOverlap('drives/campaigns', [{ ...admins[0], bucket: 'other' }])?.around?.id, 'c26');
  });

  test('a parent folder inside a drive is reported as inside', () => {
    assert.equal(prefixOverlap('team', [{ id: 't', prefix: 'team' }])?.inside?.id, 't');
    assert.equal(prefixOverlap('', admins), null);
  });
});

describe('content hashes', () => {
  test('the ETag, unquoted and lowercased; nothing that is not an MD5', () => {
    assert.equal(etagOf('"D41D8CD98F00B204E9800998ECF8427E"'), 'd41d8cd98f00b204e9800998ecf8427e');
    assert.equal(etagOf('"9b2cf535f27731c974343645a3985328-12"'), '9b2cf535f27731c974343645a3985328-12', 'multipart');
    assert.equal(etagOf('W/"d41d8cd98f00b204e9800998ecf8427e"'), 'd41d8cd98f00b204e9800998ecf8427e');
    // A provider whose ETag is a counter or a random id must not make two
    // different files look the same — so anything unexpected is no hash at all.
    assert.equal(etagOf('"1"'), null);
    assert.equal(etagOf(''), null);
    assert.equal(etagOf(undefined), null);
  });
});

describe('the storage report', () => {
  test('every kind, biggest first, with shares of the total', () => {
    const rows = [{ kind: 'image', files: 3, bytes: 300 }, { kind: 'video', files: 1, bytes: 700 }, { kind: 'weird', files: 2, bytes: 0 }];
    const k = kindBreakdown(rows, 1000);
    assert.deepEqual(k.map((r) => r.kind), ['video', 'image', 'audio', 'doc', 'other'], 'by bytes, then in the usual order');
    assert.equal(k[0].share, 0.7);
    assert.equal(k.length, 5, 'all five kinds, even the empty ones');
    assert.equal(k.find((r) => r.kind === 'other').files, 2, 'an unknown kind counts as other');
    assert.equal(kindBreakdown([], 0).every((r) => r.share === 0), true, 'an empty library is all zeros, not NaN');
  });

  test('formats read as people say them', () => {
    assert.equal(formatLabel('mov'), 'MOV');
    assert.equal(formatLabel(null), 'No extension');
  });

  test('the trash keeps files for a month', () => {
    assert.equal(TRASH_RETENTION_DAYS, 30);
  });
});

describe('duplicates', () => {
  const f = (id, hash, size, createdAt) => ({ id, contentHash: hash, size, createdAt, name: `${id}.mov` });
  const rows = [
    f('a1', 'aaa', 100, 3), f('a2', 'aaa', 100, 1), f('a3', 'aaa', 100, 2),
    f('b1', 'bbb', 5000, 1), f('b2', 'bbb', 5000, 2),
    f('c1', 'aaa', 999, 1), // same hash, different size: not a copy
    f('d1', null, 100, 1), f('d2', null, 100, 1), // no hash: never grouped
  ];

  test('sets are the same hash AND size, worst first, keeping the oldest', () => {
    const g = groupDuplicates(rows);
    assert.deepEqual(g.map((x) => x.key), ['bbb:5000', 'aaa:100']);
    assert.equal(g[0].reclaim, 5000);
    assert.equal(g[1].reclaim, 200);
    assert.equal(g[1].keep, 'a2', 'the oldest copy is kept by default');
    assert.equal(keeperOf([f('x', 'h', 1, 5), f('w', 'h', 1, 5)]).id, 'w', 'a tie goes to the lower id, so it is stable');
  });

  test('a clean-up removes every copy but the kept one, and never a whole set', () => {
    const g = groupDuplicates(rows);
    assert.deepEqual(copiesToRemove(g).map((x) => x.id).sort(), ['a1', 'a3', 'b2']);
    assert.deepEqual(copiesToRemove(g, { 'aaa:100': 'a3' }).map((x) => x.id).sort(), ['a1', 'a2', 'b2'], 'a chosen keeper');
    assert.deepEqual(copiesToRemove(g, { 'aaa:100': 'zzz' }).map((x) => x.id).sort(), ['a1', 'a3', 'b2'], 'a keeper not in the set falls back to the default');
    assert.equal(bytesOf(copiesToRemove(g)), 5200);
  });
});
