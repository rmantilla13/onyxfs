// The monthly storage estimate on Admin → Usage (lib/storage-pricing.js).
//
// A figure people will hold a bill up against, so the arithmetic is pinned
// to the providers' own terms: each counts in its own units (Backblaze a GB
// of 10⁹ bytes, AWS one of 2³⁰), gives away its own allowance, and charges its
// own minimum. A wrong unit is a silent 7–10%; a minimum counted once per
// bucket instead of once per account is a whole extra month's fee.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_PRICES, storageLocation, priceFor, monthlyCost, estimateStorageCost, storageParts, BLOB_LOCATION,
  fmtUsd, fmtRate, fmtPriceDate, lineNote, unitsNote, billedSize,
} from '../lib/storage-pricing.js';
import { heldByDrive, TRASH_RETENTION_DAYS } from '../lib/storage-report.js';
import { STORAGE_PRESETS } from '../lib/storage-presets.js';
import { storageProvider, cfgForDrive } from '../lib/storage.js';
import { fmtSize } from '../lib/media.js';

const GB = 1e9;
const TB = 1e12;
const GiB = 2 ** 30;
const TiB = 2 ** 40;
const cents = (n) => Math.round(n * 100) / 100;

const at = (endpoint, bucket = 'onyx', region = '') => storageLocation({ endpoint, bucket, region });
const B2 = 'https://s3.us-west-004.backblazeb2.com';
const WASABI = 'https://s3.us-east-1.wasabisys.com';
const SPACES = 'https://nyc3.digitaloceanspaces.com';
const R2 = 'https://0123abcd.r2.cloudflarestorage.com';
const price = (endpoint, region = '') => priceFor(at(endpoint, 'onyx', region));

describe('the price list', () => {
  test('every named service but "other" has a price, with its source and the day it was read', () => {
    for (const p of STORAGE_PRESETS) {
      if (p.id === 'other') { assert.equal(STORAGE_PRICES.other, undefined); continue; }
      const entry = STORAGE_PRICES[p.id];
      assert.ok(entry, `${p.id} has no price`);
      assert.match(entry.source, /^https:\/\/[a-z0-9.-]+\//, `${p.id} source`);
      assert.match(entry.checked, /^\d{4}-\d{2}-\d{2}$/, `${p.id} checked`);
      assert.ok(fmtPriceDate(entry.checked), `${p.id} date parses`);
      assert.ok([1000, 1024].includes(entry.base), `${p.id} base`);
      assert.ok(entry.terms, `${p.id} says what it leaves out`);
    }
  });

  test('Wasabi’s 90 days are counted against the trash’s own retention', () => {
    // The trash is a copy made on removal, purged TRASH_RETENTION_DAYS later.
    assert.match(STORAGE_PRICES.wasabi.terms, new RegExp(`after ${TRASH_RETENTION_DAYS} is billed for ${90 - TRASH_RETENTION_DAYS} more`));
  });

  test('the rates as published on the day they were checked', () => {
    assert.equal(STORAGE_PRICES.b2.rate, 6.95);
    assert.equal(STORAGE_PRICES.r2.rate, 0.015);
    assert.equal(STORAGE_PRICES.spaces.rate, 0.02);
    assert.equal(STORAGE_PRICES.spaces.fee, 5);
    assert.equal(STORAGE_PRICES.wasabi.rate, 7.99);
    assert.deepEqual(STORAGE_PRICES.aws.regions['us-east-1'], [0.023, 0.022, 0.021]);
    assert.deepEqual(STORAGE_PRICES.aws.regions['us-east-2'], [0.023, 0.022, 0.021]);
    assert.deepEqual(STORAGE_PRICES.aws.regions['sa-east-1'], [0.0405, 0.039, 0.037]);
  });

  test('every AWS region steps down with volume, and is a real rate', () => {
    for (const [region, rates] of Object.entries(STORAGE_PRICES.aws.regions)) {
      assert.equal(rates.length, 3, region);
      assert.ok(rates.every((r) => r > 0.01 && r < 0.05), `${region}: ${rates}`);
      assert.ok(rates[0] > rates[1] && rates[1] > rates[2], `${region} steps down`);
    }
  });
});

describe('where the bytes are', () => {
  test('the service is the server’s own answer', () => {
    // storageProvider decides the credential ladder; the estimate must not
    // price a bucket as a different service from the one it is.
    for (const endpoint of ['', B2, R2, SPACES, WASABI, 'https://minio.internal:9000']) {
      assert.equal(storageLocation({ endpoint, bucket: 'b' }).provider, storageProvider({ endpoint }), endpoint || '(blank)');
    }
  });

  test('the region only where the price depends on it', () => {
    assert.equal(at('', 'b', 'EU-West-1').region, 'eu-west-1', 'AWS: lowercased, as stored');
    assert.equal(at(B2, 'b', 'us-west-004').region, '', 'B2 costs the same everywhere');
    assert.notEqual(at('', 'b', 'us-east-1').key, at('', 'b', 'us-west-2').key);
  });

  test('names the service, the bucket and nothing else', () => {
    const loc = storageLocation({ endpoint: B2, bucket: ' media ', region: 'us-west-004', accessKeyId: 'KEY', secretAccessKey: 'SECRET' });
    assert.equal(loc.name, 'Backblaze B2');
    assert.equal(loc.bucket, 'media');
    assert.ok(!JSON.stringify(loc).includes('KEY'), 'no key, not even its id');
    assert.ok(!JSON.stringify(loc).includes('SECRET'));
  });

  test('a drive is priced where its objects are read from', () => {
    const cfg = { provider: 's3', bucket: 'main', endpoint: B2, accessKeyId: 'k', secretAccessKey: 's' };
    assert.equal(cfgForDrive(cfg, null), cfg);
    assert.equal(cfgForDrive(cfg, { prefix: 'team', bucket: 'main' }), cfg, 'the Storage bucket');
    const other = cfgForDrive(cfg, { prefix: 'x', bucket: 'archive' });
    assert.equal(storageLocation(other).bucket, 'archive');
    assert.equal(storageLocation(other).provider, 'b2', 'the Storage keys and endpoint: the same service');
    const own = cfgForDrive(cfg, { prefix: 'y', bucket: 'client', accessKeyId: 'k2', secretAccessKey: 's2', endpoint: '', region: 'us-east-1' });
    assert.equal(storageLocation(own).provider, 'aws', 'keys of its own, no endpoint: AWS');
    assert.equal(storageLocation(own).region, 'us-east-1');
  });
});

describe('what a month costs', () => {
  test('Backblaze B2: decimal terabytes, the first 10 GB free', () => {
    const b2 = price(B2);
    assert.equal(cents(monthlyCost(2.4 * TB, b2)), 16.61, '(2.4 TB − 10 GB) × $6.95');
    // What this page shows as "2.4 TB" is 2.4 × 2⁴⁰ bytes: 2.64 TB to Backblaze.
    assert.equal(cents(monthlyCost(2.4 * TiB, b2)), 18.27);
    assert.equal(monthlyCost(0, b2), 0);
    assert.equal(monthlyCost(10 * GB, b2), 0, 'all of it inside the allowance');
    assert.equal(cents(monthlyCost(11 * GB, b2) * 1000), 6.95, '1 GB over: $0.00695');
  });

  test('Amazon S3: binary gigabytes, by region, cheaper past 50 TB and past 500 TB', () => {
    const east = price('', 'us-east-1');
    assert.equal(cents(monthlyCost(1 * TiB, east)), 23.55, '1,024 GB × $0.023');
    assert.equal(cents(monthlyCost(60 * TiB, east)), cents(51200 * 0.023 + 10240 * 0.022));
    assert.equal(cents(monthlyCost(600 * TiB, east)), cents(51200 * 0.023 + 460800 * 0.022 + 102400 * 0.021));
    assert.equal(cents(monthlyCost(1 * TiB, price('', 'sa-east-1'))), cents(1024 * 0.0405));
    assert.equal(monthlyCost(0, east), 0);
  });

  test('Amazon S3 with no region, or one not on the list, has no price rather than a guess', () => {
    assert.equal(price('', ''), null);
    assert.equal(price('', 'mars-north-1'), null);
    assert.equal(monthlyCost(TiB, null), null);
  });

  test('Cloudflare R2: the first 10 GB free', () => {
    const r2 = price(R2);
    assert.equal(cents(monthlyCost(100 * GB, r2)), 1.35, '90 GB × $0.015');
    assert.equal(monthlyCost(5 * GB, r2), 0);
  });

  test('DigitalOcean Spaces: $5 covers 250 GB, even of nothing', () => {
    const sp = price(SPACES);
    assert.equal(monthlyCost(0, sp), 5);
    assert.equal(monthlyCost(250 * GiB, sp), 5);
    assert.equal(cents(monthlyCost(300 * GiB, sp)), 6, '$5 + 50 GB × $0.02');
  });

  test('Wasabi: at least 1 TB, of 1,024 GB', () => {
    const w = price(WASABI);
    assert.equal(monthlyCost(0, w), 7.99);
    assert.equal(monthlyCost(500 * GiB, w), 7.99);
    assert.equal(cents(monthlyCost(2 * TiB, w)), 15.98);
  });

  test('anything else has no list price', () => {
    assert.equal(price('https://minio.internal:9000'), null);
    assert.equal(priceFor(BLOB_LOCATION), null);
  });
});

describe('the estimate', () => {
  test('parts in one place are one line, and the total is its cost', () => {
    const loc = at(B2);
    const est = estimateStorageCost([{ location: loc, bytes: 2 * TB }, { location: loc, bytes: 0.4 * TB }]);
    assert.equal(est.lines.length, 1);
    assert.equal(est.lines[0].bytes, 2.4 * TB);
    assert.equal(cents(est.usd), 16.61);
    assert.equal(cents(est.lines[0].usd), 16.61);
    assert.equal(est.checked, STORAGE_PRICES.b2.checked);
  });

  test('two buckets on one account share its allowance, split by what each holds', () => {
    const est = estimateStorageCost([
      { location: at(B2, 'main'), bytes: 300 * GB },
      { location: at(B2, 'archive'), bytes: 100 * GB },
    ]);
    assert.equal(est.lines.length, 2);
    assert.equal(cents(est.usd), cents(390 * 0.00695), 'one 10 GB allowance, not two');
    assert.deepEqual(est.lines.map((l) => l.location.bucket), ['main', 'archive'], 'biggest first');
    assert.equal(cents(est.lines[0].usd), cents(est.usd * 0.75));
    assert.equal(cents(est.lines[0].usd + est.lines[1].usd), cents(est.usd));
  });

  test('one Wasabi minimum per account, not per bucket', () => {
    const est = estimateStorageCost([
      { location: at(WASABI, 'a'), bytes: 100 * GiB },
      { location: at(WASABI, 'b'), bytes: 300 * GiB },
    ]);
    assert.equal(est.usd, 7.99);
    assert.equal(cents(est.lines.find((l) => l.location.bucket === 'b').usd), cents(7.99 * 0.75));
  });

  test('another endpoint is another bill, and another region at AWS is another price', () => {
    const est = estimateStorageCost([
      { location: at(B2, 'main'), bytes: 5 * GB },
      { location: at('https://s3.eu-central-003.backblazeb2.com', 'eu'), bytes: 15 * GB },
      { location: at('', 'east', 'us-east-1'), bytes: TiB },
      { location: at('', 'west', 'us-west-1'), bytes: TiB },
    ]);
    const usd = Object.fromEntries(est.lines.map((l) => [l.location.bucket, cents(l.usd)]));
    assert.equal(usd.main, 0, 'its own allowance covers it');
    assert.equal(usd.eu, cents(5 * 0.00695));
    assert.equal(usd.east, cents(1024 * 0.023));
    assert.equal(usd.west, cents(1024 * 0.026));
  });

  test('a service with no price is listed, and left out of the total', () => {
    const est = estimateStorageCost([
      { location: at(B2), bytes: TB },
      { location: at('https://minio.internal:9000', 'm'), bytes: 50 * GB },
      { location: BLOB_LOCATION, bytes: GB },
    ]);
    assert.equal(est.lines.length, 3);
    assert.equal(cents(est.usd), cents(990 * 0.00695));
    assert.equal(est.unpricedBytes, 51 * GB);
    const minio = est.lines.find((l) => l.location.provider === 'other');
    assert.equal(minio.price, null);
    assert.equal(minio.usd, null);
  });

  test('nothing priced is no figure at all, not $0', () => {
    const est = estimateStorageCost([{ location: at('https://minio.internal:9000'), bytes: TB }]);
    assert.equal(est.usd, null);
    assert.equal(est.checked, null);
    assert.equal(est.lines.length, 1);
  });

  test('zero bytes: nothing to list, unless a minimum or a plan is still owed', () => {
    const empty = estimateStorageCost([{ location: at(B2), bytes: 0 }, { location: BLOB_LOCATION, bytes: 0 }]);
    assert.deepEqual(empty.lines, []);
    assert.equal(empty.usd, 0);
    assert.equal(empty.bytes, 0);
    const owed = estimateStorageCost([{ location: at(WASABI), bytes: 0 }, { location: at(SPACES), bytes: 0 }]);
    assert.equal(owed.lines.length, 2);
    assert.equal(cents(owed.usd), 12.99);
    assert.deepEqual(estimateStorageCost([]), { lines: [], usd: null, bytes: 0, unpricedBytes: 0, checked: null });
  });
});

describe('what each drive holds', () => {
  const u = (files, bytes) => ({ files, bytes });

  test('a drive inside another is not counted twice', () => {
    // What listDrivesWithUsage reports: everything under each prefix.
    const held = heldByDrive([
      { id: 'clients', prefix: 'clients', live: u(10, 1000), trash: u(2, 50) },
      { id: 'acme', prefix: 'clients/acme', live: u(4, 400), trash: u(1, 20) },
      { id: 'acme-raw', prefix: 'clients/acme/raw', live: u(1, 100), trash: u(0, 0) },
      { id: 'brand', prefix: 'brand', live: u(3, 300), trash: u(0, 0) },
    ]);
    assert.deepEqual(held.get('clients'), { live: u(6, 600), trash: u(1, 30) });
    assert.deepEqual(held.get('acme'), { live: u(3, 300), trash: u(1, 20) }, 'less only the drive directly inside it');
    assert.deepEqual(held.get('acme-raw'), { live: u(1, 100), trash: u(0, 0) });
    assert.deepEqual(held.get('brand'), { live: u(3, 300), trash: u(0, 0) });
  });

  test('a prefix is a whole segment', () => {
    const held = heldByDrive([
      { id: 'a', prefix: 'team', live: u(1, 10) },
      { id: 'b', prefix: 'team-old', live: u(1, 20) },
    ]);
    assert.equal(held.get('a').live.bytes, 10);
    assert.equal(held.get('b').live.bytes, 20);
  });

  test('two drives on one prefix: the first by id holds the files, once', () => {
    const held = heldByDrive([
      { id: 'z', prefix: 'shared', live: u(2, 200) },
      { id: 'y', prefix: '/shared/', live: u(2, 200) },
    ]);
    assert.equal(held.get('y').live.bytes, 200);
    assert.equal(held.get('z').live.bytes, 0);
  });

  test('counts read a moment apart never go below nothing', () => {
    const held = heldByDrive([
      { id: 'outer', prefix: 'a', live: u(1, 100) },
      { id: 'inner', prefix: 'a/b', live: u(2, 150) },
    ]);
    assert.deepEqual(held.get('outer').live, u(0, 0));
  });
});

describe('storageParts: the measurement, put where it is kept', () => {
  const base = { provider: 's3', bucket: 'main', endpoint: B2, accessKeyId: 'k', secretAccessKey: 's' };
  const own = new Map([
    ['outer', { id: 'outer', prefix: 'team', bucket: 'main' }],
    ['inner', { id: 'inner', prefix: 'team/client', bucket: 'client-bucket', accessKeyId: 'k2', secretAccessKey: 's2', endpoint: '', region: 'us-east-1' }],
    ['archive', { id: 'archive', prefix: 'archive', bucket: 'cold' }],
  ]);
  const locate = (d) => storageLocation(cfgForDrive(base, d ? own.get(d.id) : null));
  const drives = [
    { id: 'outer', prefix: 'team', files: 30, bytes: 3000 },
    { id: 'inner', prefix: 'team/client', files: 10, bytes: 1000 },
    { id: 'archive', prefix: 'archive', files: 5, bytes: 500 },
  ];
  const stored = {
    live: { files: 50, bytes: 5000 },
    trash: { files: 6, bytes: 600 },
    blob: { files: 2, bytes: 70 },
    trashByDrive: { outer: { files: 3, bytes: 300 }, inner: { files: 1, bytes: 100 } },
    proxies: { files: 1, bytes: 40, unsized: 0 },
  };

  test('each byte once, in the bucket it is kept in', () => {
    const est = estimateStorageCost(storageParts({ stored, drives, locate }));
    const by = Object.fromEntries(est.lines.map((l) => [l.location.bucket || l.location.provider, l.bytes]));
    // The inner drive keeps its files (and their trash) in a bucket of its own.
    assert.equal(by['client-bucket'], 1000 + 100);
    // The archive drive, in another bucket reached with the Storage keys.
    assert.equal(by.cold, 500);
    // Everything else — the outer drive's own files, the library outside any
    // drive, the rest of the trash, and the proxies — in the Storage bucket.
    assert.equal(by.main, (5000 + 600) - 1100 - 500 + 40);
    assert.equal(by.blob, 70);
    assert.equal(est.bytes, 5000 + 600 + 40 + 70, 'nothing counted twice, nothing lost');
  });

  test('the drive in another bucket on the same account shares the Storage bill', () => {
    const est = estimateStorageCost(storageParts({ stored, drives, locate }));
    const cold = est.lines.find((l) => l.location.bucket === 'cold');
    const main = est.lines.find((l) => l.location.bucket === 'main');
    assert.equal(cold.location.bill, main.location.bill);
    assert.equal(cold.billBytes, main.billBytes);
  });

  test('without a measurement there is nothing to estimate', () => {
    assert.deepEqual(storageParts({ stored: null, drives, locate }), []);
  });

  test('no drives: the whole bucket, the trash and the proxies in one place', () => {
    const est = estimateStorageCost(storageParts({ stored: { ...stored, trashByDrive: {} }, drives: [], locate }));
    assert.equal(est.lines.find((l) => l.location.bucket === 'main').bytes, 5000 + 600 + 40);
  });
});

describe('saying it', () => {
  test('dollars, and rates as they are quoted', () => {
    assert.equal(fmtUsd(16.6105), '$16.61');
    assert.equal(fmtUsd(0), '$0.00');
    assert.equal(fmtUsd(0.003), 'under $0.01');
    assert.equal(fmtUsd(1234.5), '$1,234.50');
    assert.equal(fmtUsd(null), '');
    assert.equal(fmtRate(6.95), '$6.95');
    assert.equal(fmtRate(0.023), '$0.023');
    assert.equal(fmtRate(5), '$5');
    assert.equal(fmtPriceDate('2026-09-28'), 'Sep 28, 2026');
    assert.equal(fmtPriceDate('not a date'), '');
  });

  test('sizes in the provider’s own units', () => {
    assert.equal(billedSize(2.4 * TiB, price(B2)), '2.6 TB', 'decimal, as Backblaze bills');
    assert.equal(billedSize(2.4 * TiB, price('', 'us-east-1')), '2.4 TB', 'binary, as AWS bills');
    assert.equal(billedSize(TiB, price(WASABI)), '1 TB', 'a round amount, not "1.0 TB"');
    assert.equal(fmtSize(2.4 * TiB), '2.4 TB', 'the rest of the page is unchanged');
    assert.equal(fmtSize(1.5 * TB, { base: 1000 }), '1.5 TB');
    assert.deepEqual([1536, 2048].map(fmtSize), ['1.5 KB', '2.0 KB'], 'a map index is not a base');
  });

  test('a line says how its figure was reached', () => {
    const line = (endpoint, bytes, region = '') => estimateStorageCost([{ location: at(endpoint, 'b', region), bytes }]).lines[0];
    assert.equal(lineNote(line(B2, 2.4 * TiB)), '2.6 TB at $6.95 per TB, the first 10 GB free');
    assert.equal(lineNote(line('', 120 * GiB, 'us-east-1')), '120 GB at $0.023 per GB');
    assert.equal(lineNote(line('', 60 * TiB, 'us-east-1')), '60 TB at $0.023 per GB, less past 50 TB');
    assert.equal(lineNote(line(WASABI, 300 * GiB)), '300 GB at $7.99 per TB, at least 1 TB billed');
    assert.equal(lineNote(line(SPACES, 300 * GiB)), '300 GB: $5 a month covers 250 GB, then $0.02 per GB');
    assert.equal(lineNote(line(R2, 100 * GB)), '100 GB at $0.015 per GB, the first 10 GB free');
  });

  test('and where there is no price, why not', () => {
    const line = (location, bytes) => estimateStorageCost([{ location, bytes }]).lines[0];
    assert.equal(lineNote(line(at('https://minio.internal:9000'), 50 * GiB)), '50 GB, on a service with no list price');
    assert.equal(lineNote(line(at('', 'b', 'mars-north-1'), 50 * GiB)), '50 GB, in a region with no list price here');
    assert.equal(lineNote(line(BLOB_LOCATION, 1.2 * GiB)), '1.2 GB, uploaded before a bucket was set up');
  });

  test('a decimal price says its sizes read larger than the page’s', () => {
    assert.match(unitsNote(price(B2)), /decimal/);
    assert.match(unitsNote(price(R2)), /decimal/);
    assert.equal(unitsNote(price('', 'us-east-1')), '');
    assert.equal(unitsNote(price(WASABI)), '');
    assert.equal(unitsNote(null), '');
  });
});
