// Prices of our own (Admin → Storage → Prices): what storage costs this
// organisation where it is not the list price, and how the Usage estimate
// takes it. The table and the route run against a real Postgres in
// test/storage-prices-db.test.js.
//
// A price is per account — the allowance, the minimum and the fee are — so
// what is pinned here is that a price reaches every bucket on its account
// and no other, that a service with no list price is priced once one is set,
// that the "as of" date speaks only for list prices actually used, and that
// the form's fields are refused, with a sentence, whenever they would put a
// wrong figure on the page.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_PRICES, PRICE_LIMITS, storageLocation, priceFor, estimateStorageCost, validateStoragePrice, parseAccount,
  accountKey, pricesByAccount, storageAccounts, amountOf, priceFormValues, priceSummary, lineNote, serviceNote,
  countsLabel, fmtDay,
} from '../lib/storage-pricing.js';

const GB = 1e9;
const TB = 1e12;
const GiB = 2 ** 30;
const TiB = 2 ** 40;
const cents = (n) => Math.round(n * 100) / 100;

const B2 = 'https://s3.us-west-004.backblazeb2.com';
const B2_EU = 'https://s3.eu-central-003.backblazeb2.com';
const WASABI = 'https://s3.us-east-1.wasabisys.com';
const SPACES = 'https://nyc3.digitaloceanspaces.com';
const R2 = 'https://0123abcd.r2.cloudflarestorage.com';
const MINIO = 'https://minio.internal:9000';
const at = (endpoint, bucket = 'onyx', region = '') => storageLocation({ endpoint, bucket, region });

/** A row as listStoragePrices returns it. */
const row = (account, over = {}) => ({
  account, rate: 5, unit: 'TB', base: 1000, freeBytes: 0, minimumBytes: 0, fee: 0, note: null,
  setAt: Date.UTC(2026, 8, 29), setBy: 'admin@example.com', ...over,
});
const priced = (...rows) => ({ overrides: pricesByAccount(rows) });

/** What the form sends, for an account, with the fields given. */
const form = (account, over = {}) => ({
  account, rate: '5.50', unit: 'TB', base: 1000, free: '10', freeUnit: 'GB', minimum: '', minimumUnit: 'TB', fee: '', note: 'Contract 2026', ...over,
});

describe('which account a price is for', () => {
  test('a location’s bill is an account key, and reads back into its parts', () => {
    const cases = [
      [at(B2), { provider: 'b2', host: 's3.us-west-004.backblazeb2.com', region: '' }],
      [at('', 'b', 'us-east-1'), { provider: 'aws', host: '', region: 'us-east-1' }],
      [at('', 'b', ''), { provider: 'aws', host: '', region: '' }],
      [at(R2), { provider: 'r2', host: '0123abcd.r2.cloudflarestorage.com', region: '' }],
      [at(MINIO), { provider: 'other', host: 'minio.internal:9000', region: '' }],
    ];
    for (const [loc, parts] of cases) {
      assert.deepEqual(parseAccount(loc.bill), parts, loc.bill);
      assert.equal(accountKey(parts), loc.bill);
    }
  });

  test('anything else is not an account', () => {
    for (const bad of [
      '', null, 42, {}, 'b2', 'b2|host', 'b2|a|b|c', 'azure|host|', 'aws|host.example|us-east-1', 'b2||',
      'b2|s3.example.com|us-west-004', 'aws||US EAST', 'aws||us-east-1\n', 'b2|a b|', `b2|${'x'.repeat(400)}|`,
    ]) assert.equal(parseAccount(bad), null, JSON.stringify(bad));
  });
});

describe('the form, checked on the server', () => {
  const account = at(B2).bill;

  test('a full price, into bytes in the provider’s counting', () => {
    const r = validateStoragePrice(form(account, { free: '10', freeUnit: 'GB', minimum: '1', minimumUnit: 'TB', fee: '2.5' }));
    assert.deepEqual(r, {
      account,
      price: { rate: 5.5, unit: 'TB', base: 1000, freeBytes: 10 * GB, minimumBytes: TB, fee: 2.5, note: 'Contract 2026' },
    });
    const binary = validateStoragePrice(form(account, { base: '1024', free: '1', freeUnit: 'TB' }));
    assert.equal(binary.price.freeBytes, TiB, 'a TB of 1,024 GB');
    assert.equal(binary.price.base, 1024);
  });

  test('blank optional fields are none, and numbers may come as numbers', () => {
    const r = validateStoragePrice({ account, rate: 0.006, unit: 'GB', base: 1000 });
    assert.deepEqual(r.price, { rate: 0.006, unit: 'GB', base: 1000, freeBytes: 0, minimumBytes: 0, fee: 0, note: null });
    assert.equal(validateStoragePrice(form(account, { rate: '0' })).price.rate, 0, 'a flat fee may have no rate');
  });

  test('the note is one plain line', () => {
    assert.equal(validateStoragePrice(form(account, { note: '  Contract\n\t2026  ' })).price.note, 'Contract 2026');
    assert.equal(validateStoragePrice(form(account, { note: '   ' })).price.note, null);
  });

  test('each wrong field is refused with a sentence that says which', () => {
    const refused = (over, pattern) => {
      const r = validateStoragePrice({ ...form(account), ...over });
      assert.ok(r.error, `${JSON.stringify(over)} was accepted`);
      assert.match(r.error, pattern, JSON.stringify(over));
    };
    refused({ account: 'b2|nowhere' }, /which account/);
    refused({ unit: 'PB' }, /per TB or per GB/);
    refused({ base: 1000.5 }, /1,000 GB or as 1,024 GB/);
    refused({ rate: '' }, /Enter the price/);
    refused({ rate: '-1' }, /0 or more/);
    refused({ rate: 'five' }, /0 or more/);
    refused({ rate: 'Infinity' }, /0 or more/);
    refused({ free: '-10' }, /free storage must be a number/);
    refused({ free: '1', freeUnit: 'PB' }, /GB or TB/);
    refused({ minimum: 'lots' }, /least billed must be a number/);
    refused({ minimum: '1001', minimumUnit: 'TB' }, /over 1,000 TB/);
    refused({ fee: '-5' }, /monthly fee must be/);
    refused({ fee: String(PRICE_LIMITS.feeUsd + 1) }, /monthly fee over/);
    refused({ note: 42 }, /must be text/);
    refused({ note: 'x'.repeat(PRICE_LIMITS.note + 1) }, /under 200 characters/);
    for (const bad of [null, [], 'a price']) assert.ok(validateStoragePrice(bad).error);
  });

  test('a price per TB entered as per GB is refused, not estimated from', () => {
    // $6.95 a GB would put a 2 TB library at about $14,000 a month.
    assert.match(validateStoragePrice(form(account, { rate: '6.95', unit: 'GB' })).error, /per TB or per GB/);
    assert.ok(validateStoragePrice(form(account, { rate: '6.95', unit: 'TB' })).price);
    assert.ok(validateStoragePrice(form(account, { rate: '0.023', unit: 'GB' })).price);
    assert.ok(validateStoragePrice(form(account, { rate: String(PRICE_LIMITS.perTB), unit: 'TB' })).price, 'the limit itself is allowed');
  });
});

describe('the estimate with prices of our own', () => {
  test('our price replaces the list price, for every bucket on the account and no other', () => {
    const main = at(B2, 'main');
    const archive = at(B2, 'archive');
    const eu = at(B2_EU, 'eu');
    const est = estimateStorageCost(
      [{ location: main, bytes: 1.5 * TB }, { location: archive, bytes: 0.5 * TB }, { location: eu, bytes: TB }],
      priced(row(main.bill, { rate: 4, freeBytes: 0 })),
    );
    const by = Object.fromEntries(est.lines.map((l) => [l.location.bucket, l]));
    assert.equal(by.main.price.own, true);
    assert.equal(by.archive.price.own, true, 'the same account, the same price');
    assert.equal(cents(by.main.usd + by.archive.usd), 8, '2 TB at $4');
    assert.equal(by.eu.price.own, false, 'another Backblaze account keeps the list price');
    assert.equal(cents(by.eu.usd), cents((TB - 10 * GB) / TB * 6.95));
  });

  test('a service with no list price is priced once we set one', () => {
    const minio = at(MINIO, 'media');
    const without = estimateStorageCost([{ location: minio, bytes: 2 * TB }]);
    assert.equal(without.usd, null);
    assert.equal(without.unpricedBytes, 2 * TB);
    const withOurs = estimateStorageCost([{ location: minio, bytes: 2 * TB }], priced(row(minio.bill, { rate: 3 })));
    assert.equal(withOurs.usd, 6);
    assert.equal(withOurs.unpricedBytes, 0);
    assert.equal(withOurs.lines[0].price.own, true);
  });

  test('so is an AWS region with no list price here', () => {
    const mars = at('', 'b', 'mars-north-1');
    assert.equal(estimateStorageCost([{ location: mars, bytes: TiB }]).usd, null);
    const est = estimateStorageCost([{ location: mars, bytes: TiB }], priced(row(mars.bill, { rate: 0.02, unit: 'GB', base: 1024 })));
    assert.equal(cents(est.usd), cents(1024 * 0.02));
  });

  test('ours and list prices side by side: the total is both, and "as of" speaks only for the list', () => {
    const b2 = at(B2, 'main');
    const aws = at('', 'client', 'us-east-1');
    const est = estimateStorageCost(
      [{ location: b2, bytes: 2 * TB }, { location: aws, bytes: TiB }],
      priced(row(b2.bill, { rate: 5 })),
    );
    assert.equal(cents(est.usd), cents(10 + 1024 * 0.023));
    assert.equal(est.own, true);
    assert.equal(est.checked, STORAGE_PRICES.aws.checked, 'the list price that was used');
    const allOurs = estimateStorageCost([{ location: b2, bytes: 2 * TB }], priced(row(b2.bill)));
    assert.equal(allOurs.checked, null, 'no list price used, no date to give');
    assert.equal(allOurs.own, true);
    const noneOurs = estimateStorageCost([{ location: aws, bytes: TiB }], priced(row(b2.bill)));
    assert.equal(noneOurs.own, false, 'a price for an account with nothing in it changes nothing');
  });

  test('our free storage, minimum and fee are the account’s, as the list’s are', () => {
    const a = at(WASABI, 'a');
    const b = at(WASABI, 'b');
    const own = priced(row(a.bill, { rate: 6, unit: 'TB', base: 1024, minimumBytes: TiB, fee: 1 }));
    const est = estimateStorageCost([{ location: a, bytes: 100 * GiB }, { location: b, bytes: 300 * GiB }], own);
    assert.equal(cents(est.usd), 7, 'one minimum and one fee: 1 TB at $6, plus $1');
    const plan = priced(row(at(SPACES).bill, { rate: 0.02, unit: 'GB', base: 1024, freeBytes: 250 * GiB, fee: 5 }));
    assert.equal(estimateStorageCost([{ location: at(SPACES), bytes: 300 * GiB }], plan).usd, 6, 'free storage under a fee is a plan');
    assert.equal(estimateStorageCost([{ location: at(SPACES), bytes: 0 }], plan).usd, 5, 'the fee, even for nothing');
  });

  test('a flat fee and no rate', () => {
    const loc = at(MINIO);
    const est = estimateStorageCost([{ location: loc, bytes: 80 * TB }], priced(row(loc.bill, { rate: 0, fee: 500 })));
    assert.equal(est.usd, 500);
    assert.equal(lineNote(est.lines[0]), 'Our price: 80 TB for a flat $500 a month');
  });

  test('starting from the list price and saving it changes nothing', () => {
    // The form starts from the list price (priceFormValues); saving it
    // unchanged must give the same figure, or "set our price" would move the
    // estimate before anyone changed a number.
    for (const [endpoint, bytes] of [[B2, 2.4 * TiB], [WASABI, 300 * GiB], [WASABI, 3 * TiB], [SPACES, 300 * GiB], [SPACES, 10 * GiB], [R2, 90 * GB]]) {
      const loc = at(endpoint);
      const list = estimateStorageCost([{ location: loc, bytes }]);
      const saved = validateStoragePrice({ account: loc.bill, ...priceFormValues(priceFor(loc)) });
      assert.ok(saved.price, `${endpoint}: ${saved.error}`);
      const ours = estimateStorageCost([{ location: loc, bytes }], priced({ account: loc.bill, ...saved.price }));
      assert.equal(cents(ours.usd), cents(list.usd), endpoint);
    }
  });
});

describe('saying our price', () => {
  const b2 = at(B2, 'main');
  const ours = priceFor(b2, priced(row(b2.bill, { rate: 5.5, freeBytes: 10 * GB, note: 'Contract 2026' })));

  test('a line at our price says so first', () => {
    const est = estimateStorageCost([{ location: b2, bytes: 2.4 * TiB }], priced(row(b2.bill, { rate: 5.5, freeBytes: 10 * GB })));
    assert.equal(lineNote(est.lines[0]), 'Our price: 2.6 TB at $5.50 per TB, the first 10 GB free');
  });

  test('prices in words, for the Prices page', () => {
    assert.equal(priceSummary(priceFor(b2)), '$6.95 per TB a month, the first 10 GB free');
    assert.equal(priceSummary(priceFor(at('', 'b', 'us-east-1'))), '$0.023 per GB a month, $0.022 past 50 TB, $0.021 past 500 TB');
    assert.equal(priceSummary(priceFor(at(SPACES))), '$5 a month covers 250 GB, then $0.02 per GB');
    assert.equal(priceSummary(priceFor(at(WASABI))), '$7.99 per TB a month, at least 1 TB billed');
    assert.equal(priceSummary(ours), '$5.50 per TB a month, the first 10 GB free');
    assert.equal(priceSummary(priceFor(b2, priced(row(b2.bill, { rate: 0, fee: 40 })))), 'A flat $40 a month');
    assert.equal(priceSummary(priceFor(b2, priced(row(b2.bill, { rate: 0 })))), 'No charge');
    assert.equal(priceSummary(null), '');
    assert.equal(countsLabel(1000), '1,000 GB to the TB');
    assert.equal(countsLabel(1024), '1,024 GB to the TB');
  });

  test('the card’s note: the list’s terms and page, or who set ours and why — and the caveat either way', () => {
    const list = serviceNote(priceFor(b2));
    assert.equal(list.source, STORAGE_PRICES.b2.source);
    assert.match(list.text, /three times what is stored/);
    assert.match(list.text, /old version/, 'how B2 behaves');
    const own = serviceNote(ours);
    assert.equal(own.source, null);
    assert.match(own.text, /^At our price \(Contract 2026\), set by admin@example\.com on Sep 29, 2026\./);
    assert.doesNotMatch(own.text, /three times/, 'the list’s terms may not hold under a contract');
    assert.match(own.text, /old version/, 'the bucket keeps old versions whatever we pay');
    assert.equal(fmtDay(Date.UTC(2026, 8, 29)), 'Sep 29, 2026');
    assert.equal(fmtDay(null), '');
  });
});

describe('the Prices page', () => {
  test('the accounts the library is billed on, with their buckets and what uses them', () => {
    const accounts = storageAccounts([
      { location: at(B2, 'main'), drive: null },
      { location: at(B2, 'cold'), drive: { id: 'd1', name: 'Archive' } },
      { location: at('', 'client', 'us-east-1'), drive: { id: 'd2', name: 'Client X' } },
      { location: at('', 'client', 'us-east-1'), drive: { id: 'd3', name: 'Client A' } },
      { location: at(B2, 'main'), drive: { id: 'd4', name: 'Own keys, same bucket' } },
    ]);
    assert.deepEqual(accounts.map((a) => [a.name, a.storage]), [['Backblaze B2', true], ['Amazon S3', false]], 'the Storage bucket’s account first');
    assert.deepEqual(accounts[0].buckets, [
      { bucket: 'main', storage: true, drives: ['Own keys, same bucket'] },
      { bucket: 'cold', storage: false, drives: ['Archive'] },
    ]);
    assert.deepEqual(accounts[1].buckets, [{ bucket: 'client', storage: false, drives: ['Client A', 'Client X'] }]);
    assert.equal(accounts[1].region, 'us-east-1');
    assert.equal(accounts[0].host, 's3.us-west-004.backblazeb2.com');
    assert.deepEqual(storageAccounts([]), []);
  });

  test('the form starts from our price, else the list price, else blanks', () => {
    assert.deepEqual(priceFormValues(priceFor(at(B2))), {
      rate: 6.95, unit: 'TB', base: 1000, free: 10, freeUnit: 'GB', minimum: '', minimumUnit: 'TB', fee: '', note: '',
    });
    const spaces = priceFormValues(priceFor(at(SPACES)));
    assert.deepEqual([spaces.free, spaces.freeUnit, spaces.fee], [250, 'GB', 5], 'the plan’s storage is its free storage');
    const wasabi = priceFormValues(priceFor(at(WASABI)));
    assert.deepEqual([wasabi.minimum, wasabi.minimumUnit, wasabi.base], [1, 'TB', 1024]);
    const b2 = at(B2);
    assert.equal(priceFormValues(priceFor(b2, priced(row(b2.bill, { note: 'Contract' })))).note, 'Contract');
    assert.equal(priceFormValues(null).rate, '');
  });

  test('amounts as a form shows them', () => {
    assert.deepEqual(amountOf(10 * GB, 1000), { amount: 10, unit: 'GB' });
    assert.deepEqual(amountOf(TiB, 1024), { amount: 1, unit: 'TB' });
    assert.deepEqual(amountOf(1.5 * TiB, 1024), { amount: 1536, unit: 'GB' });
    assert.deepEqual(amountOf(0, 1000), { amount: 0, unit: 'GB' });
  });
});
