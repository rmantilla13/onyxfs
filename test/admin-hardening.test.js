// The admin panel's review fixes, each pinned where it can regress: no drive
// secret in a list, every admin page and title gated before it reads data,
// moves that fail closed, a drive's endpoint and keys guarded like its
// bucket, the old ?tab= links redirected before anything renders, and the
// wording that replaced a tooltip or a sentence said twice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { shapeFilespace } from '../lib/db.js';
import { guardMove } from '../lib/move-guard.js';
import { driveLocationChange, driveMoveWarning, driveForKey, driveRow } from '../lib/admin-drives.js';
import { legacyAdminUrl } from '../lib/admin-redirects.js';
import { revokeBlockedReason } from '../lib/admin-requests.js';
import { sectionLabel } from '../app/admin/nav.js';
import { CARD_BELOW } from '../lib/admin-table.js';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('no drive secret leaves the server in a list', () => {
  const row = { id: 'a', name: 'A', bucket: 'b', prefix: 'p', access_key: 'AK', secret_key: 'shh' };

  test('only a literal true includes the secret — not a map index', () => {
    assert.equal(shapeFilespace(row, true).secretAccessKey, 'shh');
    assert.equal(shapeFilespace(row).hasSecret, true);
    for (const i of [0, 1, 2, 'x', {}]) {
      assert.equal('secretAccessKey' in shapeFilespace(row, i), false, `index ${JSON.stringify(i)}`);
    }
    // What `rows.map(shapeFilespace)` did: the second row onwards carried it.
    const mapped = [row, row, row].map(shapeFilespace);
    assert.equal(mapped.some((f) => 'secretAccessKey' in f), false);
  });

  test('lib/db.js never hands shapeFilespace to .map() by reference', () => {
    assert.doesNotMatch(read('lib/db.js'), /\.map\(\s*shapeFilespace\s*\)/);
  });

  test('GET /api/admin/filespaces strips the secret itself as well', () => {
    const src = read('app/api/admin/filespaces/route.js');
    assert.match(src, /\(await listFilespaces\(\)\)\.map\(\(\{ secretAccessKey, \.\.\.f \}\) => f\)/);
  });
});

describe('every admin page, layout and title is gated before it reads data', () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(page|layout)\.js$/.test(name)) files.push(p);
    }
  };
  walk(join(ROOT, 'app/admin'));

  // The names a file imports from the modules that read the database.
  const dataNames = (src) => {
    const out = [];
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'@\/lib\/(db|storage|brand-config)'/g)) {
      for (const n of m[1].split(',')) {
        const name = n.trim().split(/\s+as\s+/).pop();
        if (name) out.push(name);
      }
    }
    return out;
  };
  // The body of `export [default] async function <name>(…) { … }`.
  const body = (src, header) => {
    const at = src.search(header);
    if (at < 0) return null;
    let i = src.indexOf('(', at);
    for (let depth = 0; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')' && --depth === 0) break;
    }
    const open = src.indexOf('{', i);
    let depth = 0;
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === '{') depth += 1;
      else if (src[j] === '}' && --depth === 0) return src.slice(open, j + 1);
    }
    return null;
  };
  const firstCall = (code, names) => Math.min(...names.map((n) => {
    const m = new RegExp(`\\b${n}\\s*\\(`).exec(code);
    return m ? m.index : Infinity;
  }));

  test('the scan found the sections', () => {
    assert.ok(files.length >= 9, files.map((f) => relative(ROOT, f)).join(', '));
  });

  for (const file of files) {
    const rel = relative(ROOT, file);
    test(rel, () => {
      const src = readFileSync(file, 'utf8');
      const names = dataNames(src);
      const main = body(src, /export default async function/);
      if (names.length) {
        assert.ok(main, `${rel} reads data but has no async default export to gate it`);
      }
      if (main && names.length) {
        const gate = main.indexOf('requireAdminPage(');
        assert.ok(gate >= 0, `${rel}: no requireAdminPage()`);
        assert.ok(gate < firstCall(main, names), `${rel}: reads data before requireAdminPage()`);
      }
      const meta = body(src, /export async function generateMetadata/);
      if (meta) {
        const gate = Math.min(...['viewerIsAdmin(', 'requireAdminPage('].map((g) => {
          const k = meta.indexOf(g);
          return k < 0 ? Infinity : k;
        }));
        assert.ok(gate < Infinity, `${rel}: generateMetadata is not gated`);
        assert.ok(gate < firstCall(meta, names), `${rel}: generateMetadata reads data before the gate`);
      }
    });
  }
});

describe('a move is refused unless confirmed, and fails closed', () => {
  const message = (n) => `${n} stranded`;

  test('no change, or a literal true, goes through without counting', async () => {
    let counted = 0;
    const count = async () => { counted += 1; return { files: 10 }; };
    assert.equal(await guardMove({ changed: false, confirmed: false, count, message }), null);
    assert.equal(await guardMove({ changed: true, confirmed: true, count, message }), null);
    assert.equal(counted, 0);
  });

  test('files stored and no confirm: 409 confirm_move; "true" as a string is no confirm', async () => {
    for (const confirmed of [undefined, false, 'true', 1, 'yes']) {
      const r = await guardMove({ changed: true, confirmed, count: async () => ({ files: 3 }), message });
      assert.equal(r.status, 409, String(confirmed));
      assert.deepEqual(r.body, { error: '3 stranded', code: 'confirm_move', files: 3 });
    }
  });

  test('nothing stored: nothing to strand', async () => {
    assert.equal(await guardMove({ changed: true, confirmed: false, count: async () => ({ files: 0 }), message }), null);
  });

  test('a count that cannot be read saves nothing (503), never reads as empty', async () => {
    const r = await guardMove({ changed: true, confirmed: false, count: async () => { throw new Error('lock timeout'); }, message });
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'count_failed');
    assert.equal(r.body.detail, 'lock timeout');
    const odd = await guardMove({ changed: true, confirmed: false, count: async () => ({}), message });
    assert.equal(odd.status, 503, 'a count with no number is not zero');
  });

  test('both routes go through it', () => {
    assert.match(read('app/api/admin/storage/route.js'), /guardMove\(/);
    assert.doesNotMatch(read('app/api/admin/storage/route.js'), /libraryUsage\(\)\.catch\(\(\) => \(\{ files: 0 \}\)\)/, 'a failed count is not an empty library');
    assert.match(read('app/api/admin/filespaces/route.js'), /guardMove\(/);
  });
});

describe('a drive that holds files: where it points and with which keys', () => {
  const before = { bucket: 'onyx', prefix: 'archive', endpoint: 'http://127.0.0.1:56210', accessKeyId: 'AK1' };

  test('bucket and folder are fixed; nothing else is', () => {
    assert.deepEqual(driveLocationChange(before, { ...before, name: 'Renamed', region: 'eu-west-1', roleArn: 'arn' }), { fixed: [], confirm: [] });
    assert.deepEqual(driveLocationChange(before, { ...before, bucket: 'other' }).fixed, ['bucket']);
    assert.deepEqual(driveLocationChange(before, { ...before, prefix: '/archive/' }).fixed, [], 'the same folder, written with slashes');
    assert.deepEqual(driveLocationChange(before, { ...before, prefix: 'archive2' }).fixed, ['prefix']);
  });

  test('another service, other keys, or dropping its own keys needs a confirm', () => {
    assert.deepEqual(driveLocationChange(before, { ...before, endpoint: 'https://s3.example.com' }).confirm, ['service']);
    assert.deepEqual(driveLocationChange(before, { ...before, endpoint: 'HTTP://127.0.0.1:56210/' }).confirm, [], 'the same host, spelled differently');
    assert.deepEqual(driveLocationChange(before, { ...before, accessKeyId: 'AK2' }).confirm, ['keys']);
    assert.deepEqual(driveLocationChange(before, { ...before, accessKeyId: null, endpoint: null }).confirm, ['keys-off', 'service']);
    assert.deepEqual(driveLocationChange({ ...before, accessKeyId: '' }, { ...before }).confirm, ['keys-on']);
    assert.deepEqual(driveLocationChange(before, { ...before, secretAccessKey: 'new' }).confirm, [], 'a new secret for the same key is a rotation');
  });

  test('the confirm says what stays and what each change does', () => {
    const w = driveMoveWarning(before, ['keys-off', 'service'], 1);
    assert.equal(w.lines[0], '1 file is stored under onyx/archive, and it does not move.');
    assert.ok(w.lines.some((l) => /keys saved for it are forgotten/.test(l)));
    assert.ok(w.lines.some((l) => /another service/.test(l)));
    assert.equal(driveMoveWarning(before, ['keys'], 2).lines[0], '2 files are stored under onyx/archive, and they do not move.');
  });

  test('the PATCH route refuses the fixed and asks for the rest', () => {
    const src = read('app/api/admin/filespaces/route.js');
    assert.match(src, /driveLocationChange\(/);
    assert.match(src, /confirmed: body\.confirmMove/);
    assert.match(src, /code: 'not_empty'/);
  });
});

describe('the drive a file is in', () => {
  const drives = [
    { id: 'a', name: 'Clients', prefix: 'client-work' },
    { id: 'b', name: 'Acme', prefix: 'client-work/acme' },
    { id: 'c', name: 'Archive', prefix: '/archive/' },
  ];
  test('the longest prefix wins; a file outside every drive is in none', () => {
    assert.equal(driveForKey(drives, 'client-work/acme/spot-30s.mov')?.name, 'Acme');
    assert.equal(driveForKey(drives, 'client-work/other.mov')?.name, 'Clients');
    assert.equal(driveForKey(drives, 'archive/2023-reel.mov')?.name, 'Archive');
    assert.equal(driveForKey(drives, 'archived/x.mov'), null, 'a folder that only starts the same is not inside');
    assert.equal(driveForKey(drives, 'uploads/x.mov'), null);
    assert.equal(driveForKey(null, 'x'), null);
  });
});

describe('where a drive lives, in words and in mono', () => {
  test('the default bucket is prose and travels apart from the folder', () => {
    const r = driveRow({ bucket: 'main', prefix: 'brand' }, { defaultBucket: 'main' });
    assert.equal(r.bucketLabel, 'Default bucket');
    assert.equal(r.isDefaultBucket, true);
    assert.equal(r.prefix, 'brand');
    const other = driveRow({ bucket: 'archive', prefix: 'brand' }, { defaultBucket: 'main' });
    assert.equal(other.isDefaultBucket, false);
    assert.equal(other.bucketLabel, 'archive');
  });
});

describe('old /admin?tab= links: a redirect before anything renders', () => {
  test('each tab goes to its section, keeping any other query and dropping the tab', () => {
    assert.equal(legacyAdminUrl('/admin', '?tab=storage'), '/admin/storage');
    assert.equal(legacyAdminUrl('/admin/', '?tab=ACCESS'), '/admin/requests');
    assert.equal(legacyAdminUrl('/admin', '?tab=access&status=denied'), '/admin/requests?status=denied');
    assert.equal(legacyAdminUrl('/admin', '?tab=filespaces'), '/admin/drives');
  });

  test('anything else is left to render', () => {
    assert.equal(legacyAdminUrl('/admin', ''), null);
    assert.equal(legacyAdminUrl('/admin', '?tab=features'), null);
    assert.equal(legacyAdminUrl('/admin/drives', '?tab=storage'), null);
    assert.equal(legacyAdminUrl('/files', '?tab=storage'), null);
  });

  test('middleware does it, with nothing that reaches the database', () => {
    const mw = read('middleware.js');
    assert.match(mw, /legacyAdminUrl\(/);
    assert.match(mw, /NextResponse\.redirect\([^)]*\), 307\)/);
    assert.doesNotMatch(mw, /lib\/db|@\/auth['"]/);
    assert.doesNotMatch(read('lib/admin-redirects.js'), /^import /m, 'Edge-safe: imports nothing');
    assert.doesNotMatch(read('app/admin/page.js'), /legacyAdminTab|redirect\(/, 'the page no longer redirects after rendering');
  });
});

describe('wording', () => {
  test('why an approved person cannot be revoked is text, not a tooltip', () => {
    assert.equal(revokeBlockedReason({ self: true, envAdmin: true }), 'This is you');
    assert.equal(revokeBlockedReason({ envAdmin: true }), 'Admin, set in ADMIN_EMAILS');
    assert.equal(revokeBlockedReason({ email: 'a@x.com' }), null);
  });

  test('a failed section still says which section it is', () => {
    assert.equal(sectionLabel('/admin'), 'Overview');
    assert.equal(sectionLabel('/admin/drives/3a54'), 'Drives');
    assert.equal(sectionLabel('/admin/usage/duplicates'), 'Duplicates');
    assert.equal(sectionLabel('/admin/storage'), 'Backend');
    assert.equal(sectionLabel('/files'), null);
  });

  test('the table switches to cards at one width, said in one place for CSS and JS', () => {
    const css = read('app/admin/admin.css');
    assert.match(css, new RegExp(`@container \\(max-width: ${CARD_BELOW - 1}\\.98px\\)`));
    assert.doesNotMatch(css, /@media \(max-width: 720px\) \{\s*\.dt,/, 'not on the window any more');
  });

  test('a sheet styles its own head, body and foot, not a confirm opened inside it', () => {
    const css = read('app/admin/admin.css');
    assert.doesNotMatch(css, /dialog\.dialog-sheet \.dialog-(head|body|foot)/);
    assert.match(css, /dialog\.dialog-sheet > \.dialog-body/);
  });
});
