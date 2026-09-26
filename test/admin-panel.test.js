// The admin panel's rules that can be wrong without anything looking wrong:
// which rail item is lit, how a drive is described from the grouped usage
// query, when a storage change has to be confirmed, which origins a bucket's
// CORS rule names, and how /api/health's body — a 503 included — becomes the
// Health checklist.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { activeHref } from '../lib/section-nav.js';
import { driveRow, driveRows, publicDrive, driveSettingsPatch, hasOwnKeys } from '../lib/admin-drives.js';
import { storageLocationChange, moveNeedsConfirm } from '../lib/storage-presets.js';
import { corsOrigins, corsRule } from '../lib/storage-cors.js';
import { healthChecks, isHealthReport } from '../lib/health-checks.js';
import { relativeTime, plural } from '../lib/admin-format.js';

describe('rail: which section is the page', () => {
  const rail = [
    { href: '/admin', exact: true },
    '/admin/requests', '/admin/drives', '/admin/usage', '/admin/usage/duplicates', '/admin/storage', '/admin/health',
  ];

  test('the overview only on its own path', () => {
    assert.equal(activeHref('/admin', rail), '/admin');
    assert.equal(activeHref('/admin/', rail), '/admin');
    assert.equal(activeHref('/admin/people', rail), null, 'a section with no item lights nothing, not Overview');
  });

  test('the longest matching item wins', () => {
    assert.equal(activeHref('/admin/usage', rail), '/admin/usage');
    assert.equal(activeHref('/admin/usage/duplicates', rail), '/admin/usage/duplicates');
  });

  test('a drawer keeps its list lit', () => {
    assert.equal(activeHref('/admin/drives/abc-123', rail), '/admin/drives');
  });

  test('only at a path boundary, and ignoring query and hash', () => {
    assert.equal(activeHref('/admin/storage-old', rail), null);
    assert.equal(activeHref('/admin/drives?x=1', rail), '/admin/drives');
    assert.equal(activeHref('/admin/drives/abc#settings', rail), '/admin/drives');
  });
});

describe('drives: the grouped usage rows as the list shows them', () => {
  const row = {
    id: 'd1', name: 'Brand', bucket: 'main', prefix: '/brand-assets/', memberCount: 3, ownerCount: 1,
    files: '1204', bytes: '4096', accessKeyId: null, hasSecret: false,
  };

  test('counts arrive as strings from bigint and come out as numbers', () => {
    const r = driveRow(row, { defaultBucket: 'main' });
    assert.equal(r.files, 1204);
    assert.equal(r.bytes, 4096);
    assert.equal(r.members, 3);
    assert.equal(r.prefix, 'brand-assets');
  });

  test('"Default bucket" when it is the Storage bucket, the name otherwise', () => {
    assert.equal(driveRow(row, { defaultBucket: 'main' }).location, 'Default bucket / brand-assets');
    assert.equal(driveRow({ ...row, bucket: 'archive' }, { defaultBucket: 'main' }).location, 'archive / brand-assets');
    assert.equal(driveRow(row, {}).location, 'main / brand-assets', 'no Storage bucket: say the name');
  });

  test('own keys: the same bucket name is another bucket, so never "Default"', () => {
    const own = { ...row, accessKeyId: 'AK', hasSecret: true };
    assert.equal(hasOwnKeys(own), true);
    assert.equal(driveRow(own, { defaultBucket: 'main' }).isDefaultBucket, false);
    assert.deepEqual(driveRow(own, { defaultBucket: 'main' }).tags.map((t) => t.label), ['Own keys']);
    assert.equal(hasOwnKeys({ ...row, accessKeyId: 'AK', hasSecret: false }), false, 'a key without its secret is not usable');
  });

  test('no owner is flagged; an empty drive is zero, not missing', () => {
    const r = driveRow({ ...row, ownerCount: 0, files: null, bytes: null });
    assert.deepEqual(r.tags.map((t) => t.key), ['no-owner']);
    assert.equal(r.files, 0);
    assert.equal(r.bytes, 0);
  });

  test('in name order, whatever order the query used', () => {
    const rows = driveRows([{ ...row, id: 'b', name: 'zeta' }, { ...row, id: 'a', name: 'Alpha' }, { ...row, id: 'c', name: 'beta' }]);
    assert.deepEqual(rows.map((r) => r.name), ['Alpha', 'beta', 'zeta']);
    assert.deepEqual(driveRows(null), []);
  });

  test('the secret never reaches the browser, only that there is one', () => {
    const d = publicDrive({ id: 'x', name: 'X', bucket: 'b', prefix: 'p', accessKeyId: 'AK', secretAccessKey: 'shh', hasSecret: true });
    assert.equal('secretAccessKey' in d, false);
    assert.equal(JSON.stringify(d).includes('shh'), false);
    assert.equal(d.hasSecret, true);
  });

  test('a settings save sends only what changed, and a blank secret keeps the stored one', () => {
    const saved = { name: 'Brand', bucket: 'main', prefix: 'brand', region: '', endpoint: '', roleArn: '', accessKeyId: 'AK' };
    assert.deepEqual(driveSettingsPatch(saved, { ...saved, secretAccessKey: '' }), {});
    assert.deepEqual(driveSettingsPatch(saved, { ...saved, name: 'Brand 2', prefix: '/brand/' }), { name: 'Brand 2' });
    assert.deepEqual(driveSettingsPatch(saved, { ...saved, secretAccessKey: 'new' }), { secretAccessKey: 'new' });
    assert.deepEqual(driveSettingsPatch(saved, { ...saved, accessKeyId: '' }), { accessKeyId: '' }, 'clearing the key is a change');
  });
});

describe('storage: a change that strands the library is confirmed first', () => {
  const aws = { provider: 's3', bucket: 'acme-media', endpoint: '', region: 'us-east-1' };

  test('bucket, provider and service changes are moves', () => {
    assert.deepEqual(storageLocationChange(aws, { ...aws, bucket: 'other' }).changes, ['bucket']);
    assert.deepEqual(storageLocationChange(aws, { ...aws, provider: 'blob' }).changes, ['provider']);
    assert.deepEqual(storageLocationChange({ provider: 'blob' }, aws).changes, ['provider']);
    assert.deepEqual(
      storageLocationChange(aws, { ...aws, endpoint: 'https://s3.us-west-004.backblazeb2.com' }).changes,
      ['service'],
    );
  });

  test('what is not a move: keys, region field, prefix, a tidier endpoint', () => {
    assert.equal(storageLocationChange(aws, { ...aws, accessKeyId: 'new', region: 'us-west-2', prefix: 'x' }).changed, false);
    const b2 = { ...aws, endpoint: 'https://s3.us-west-004.backblazeb2.com' };
    assert.equal(storageLocationChange(b2, { ...b2, endpoint: 'S3.us-west-004.backblazeb2.com/' }).changed, false);
  });

  test('filling in a bucket for the first time is setting up, not moving', () => {
    assert.equal(storageLocationChange({ provider: 's3', bucket: '' }, aws).changed, false);
  });

  test('only asked when files are stored', () => {
    assert.equal(moveNeedsConfirm(aws, { ...aws, bucket: 'other' }, 0), false);
    assert.equal(moveNeedsConfirm(aws, { ...aws, bucket: 'other' }, 18402), true);
    assert.equal(moveNeedsConfirm(aws, aws, 18402), false);
    assert.equal(moveNeedsConfirm({ provider: 'blob' }, aws, 3), true, 'files in Blob stay in Blob');
  });
});

describe('storage: CORS names this deployment, not ours', () => {
  const DEFAULT = 'https://onyxfs.io';

  test('the request origin and NEXT_PUBLIC_APP_URL, deduplicated', () => {
    assert.deepEqual(
      corsOrigins({ requestOrigin: 'https://files.acme.com', appUrl: 'https://files.acme.com/', fallbackOrigin: DEFAULT }),
      ['https://files.acme.com'],
    );
  });

  test('an unconfigured white-label deployment does not inherit the default brand origin', () => {
    const o = corsOrigins({ requestOrigin: 'https://files.acme.com', brandOrigin: DEFAULT, fallbackOrigin: DEFAULT });
    assert.deepEqual(o, ['https://files.acme.com']);
  });

  test('a configured brand origin is added; the default counts when it is where we are', () => {
    assert.deepEqual(
      corsOrigins({ requestOrigin: 'https://x.vercel.app', brandOrigin: 'https://files.acme.com', fallbackOrigin: DEFAULT }),
      ['https://x.vercel.app', 'https://files.acme.com'],
    );
    assert.deepEqual(corsOrigins({ requestOrigin: DEFAULT, brandOrigin: DEFAULT, fallbackOrigin: DEFAULT }), [DEFAULT]);
  });

  test('previews only on Vercel; junk and non-http origins are dropped', () => {
    assert.ok(corsOrigins({ requestOrigin: 'https://a.com', vercel: true }).includes('https://*.vercel.app'));
    assert.ok(!corsOrigins({ requestOrigin: 'https://a.com' }).includes('https://*.vercel.app'));
    assert.deepEqual(corsOrigins({ requestOrigin: 'not a url', appUrl: 'ftp://x.com' }), []);
    assert.equal(corsOrigins({ requestOrigin: 'http://localhost:3110' })[0], 'http://localhost:3110');
  });

  test('the manual rule names exactly those origins', () => {
    const [rule] = corsRule(['https://a.com']);
    assert.deepEqual(rule.AllowedOrigins, ['https://a.com']);
    assert.ok(rule.AllowedMethods.includes('PUT'));
    assert.ok(rule.ExposeHeaders.includes('ETag'));
  });
});

describe('health: the body as a checklist', () => {
  const healthy = {
    ok: true,
    version: '0.1.0',
    build: '0.1.0 · dev',
    checks: {
      env: { DATABASE_URL: true, connectionVia: 'DATABASE_URL', AUTH_SECRET: true, RESEND_API_KEY: true, NOTIFY_FROM: true, CRON_SECRET: true },
      database: { ok: true, latencyMs: 12 },
      storage: { ok: true, mode: 's3', bucket: 'onyx', reachable: true },
      integrations: [
        { key: 'postgres', name: 'Postgres', status: 'required', configured: true, vars: [] },
        { key: 'slack', name: 'Slack', status: 'optional', configured: false, vars: [{ key: 'SLACK_WEBHOOK_URL', set: false }] },
      ],
    },
  };

  test('a healthy deployment', () => {
    const h = healthChecks(healthy);
    assert.equal(h.status, 'ok');
    assert.equal(h.label, 'Everything is working.');
    assert.equal(h.checks.find((c) => c.id === 'database').detail, 'Answered in 12 ms · via DATABASE_URL');
    assert.equal(h.checks.find((c) => c.id === 'int-slack').status, 'off', 'an optional service that is off is not a problem');
    assert.equal(h.checks.find((c) => c.id === 'int-postgres'), undefined, 'covered by the database row');
  });

  test('a 503 body names the failing check and its fix', () => {
    const down = {
      ...healthy,
      ok: false,
      checks: { ...healthy.checks, database: { ok: false, error: 'connect ECONNREFUSED' } },
    };
    const h = healthChecks(down);
    assert.equal(h.status, 'fail');
    const db = h.checks.find((c) => c.id === 'database');
    assert.equal(db.status, 'fail');
    assert.match(db.detail, /ECONNREFUSED/);
    assert.ok(db.fix);
    assert.equal(h.label, '1 problem needs fixing.');
  });

  test('warnings: Blob storage, the shared sender, no cron secret', () => {
    const h = healthChecks({
      ...healthy,
      checks: {
        ...healthy.checks,
        env: { ...healthy.checks.env, NOTIFY_FROM: false, CRON_SECRET: false },
        storage: { ok: true, mode: 'blob' },
      },
    });
    assert.equal(h.status, 'warn');
    assert.deepEqual(
      h.checks.filter((c) => c.status === 'warn').map((c) => c.id).sort(),
      ['cron', 'email', 'storage'],
    );
  });

  test('an unreachable bucket and an older server without the newer fields', () => {
    const h = healthChecks({ ok: true, checks: { storage: { ok: true, mode: 's3', bucket: 'b', reachable: false, error: 'timeout' } } });
    assert.equal(h.checks.find((c) => c.id === 'storage').status, 'fail');
    assert.equal(h.checks.some((c) => c.id === 'cron'), false, 'a field the server did not send is not reported missing');
  });

  test('anything but the report reads as failing, never as working', () => {
    // A platform's own 503 (a paused deployment, a proxy) is a page or
    // nothing: the time this page matters most, so it must not say "working".
    for (const body of [null, undefined, '', '<html>503</html>', { error: 'x' }, { ok: true }, { checks: null }, { checks: [] }, [], 42]) {
      const h = healthChecks(body);
      assert.equal(h.status, 'fail', JSON.stringify(body));
      assert.notEqual(h.label, 'Everything is working.');
      assert.equal(h.checks.length, 1);
      assert.equal(h.checks[0].status, 'fail');
      assert.equal(isHealthReport(body), false, JSON.stringify(body));
    }
    assert.match(healthChecks('<html>503</html>').checks[0].detail, /page instead of the checks/);
    assert.equal(healthChecks({ ok: false, checks: {} }).status, 'fail');
    assert.equal(healthChecks({ ok: true, checks: {} }).status, 'ok', 'a report with nothing wrong is working');
    assert.equal(isHealthReport({ ok: false, checks: {} }), true);
  });
});

describe('wording', () => {
  const now = Date.UTC(2026, 8, 25, 12);
  test('relative time', () => {
    assert.equal(relativeTime(now - 10e3, now), 'just now');
    assert.equal(relativeTime(now - 5 * 60e3, now), '5 minutes ago');
    assert.equal(relativeTime(now - 24 * 3600e3, now), 'yesterday');
    assert.equal(relativeTime(now - 3 * 24 * 3600e3, now), '3 days ago');
    assert.equal(relativeTime(now + 2 * 24 * 3600e3, now), 'in 2 days');
    assert.equal(relativeTime(null, now), '');
  });
  test('plural', () => {
    assert.equal(plural(1, 'file'), '1 file');
    assert.equal(plural(1204, 'file'), '1,204 files');
    assert.equal(plural(2, 'copy', 'copies'), '2 copies');
  });
});
