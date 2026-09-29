// lib/storage-pricing.js — what keeping the library costs a month, by where
// its bytes are kept.
//
// The list price of storage at each service Admin → Storage names, as the
// service itself publishes it, and the arithmetic from bytes to dollars. Pure
// data and pure functions, free of server imports like lib/storage-presets.js,
// so it is tested without a bucket and the Usage page decides what reaches
// the browser: the figures, never a key.
//
// Storage alone. Downloads (egress) and API requests are billed too, often at
// nothing up to a point, and depend on how the library is used, which nothing
// here measures. Each price says what it leaves out in `terms`.

import { presetById, detectPreset, endpointHost } from './storage-presets.js';
import { heldByDrive, TRASH_RETENTION_DAYS } from './storage-report.js';
import { fmtSize } from './media.js';

// How a provider counts. Backblaze bills a GB as 10⁹ bytes; AWS says outright
// that its GB is 2³⁰ ("also known as a gibibyte"), DigitalOcean prices in GiB,
// and Wasabi divides its TB price by 1,024 GB. A size is shown in the
// provider's own units, so it reads as it will on the invoice.
const DECIMAL = 1000;
const BINARY = 1024;
const GB = (n, base) => n * base ** 3;
const TB = (n, base) => n * base ** 4;

/**
 * S3 Standard in USD per GB a month, by region: the first 50 TB, the next
 * 450 TB, and everything over 500 TB. Read from the AWS Price List API
 * (pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/region_index.json,
 * published 2026-09-28, in effect from 2026-09-01), which is what
 * aws.amazon.com/s3/pricing shows region by region.
 */
const S3_STANDARD = {
  'af-south-1': [0.0274, 0.0262, 0.025],
  'ap-east-1': [0.025, 0.024, 0.023],
  'ap-east-2': [0.0225, 0.0216, 0.0207],
  'ap-northeast-1': [0.025, 0.024, 0.023],
  'ap-northeast-2': [0.025, 0.024, 0.023],
  'ap-northeast-3': [0.025, 0.024, 0.023],
  'ap-south-1': [0.025, 0.024, 0.023],
  'ap-south-2': [0.025, 0.024, 0.023],
  'ap-southeast-1': [0.025, 0.024, 0.023],
  'ap-southeast-2': [0.025, 0.024, 0.023],
  'ap-southeast-3': [0.025, 0.024, 0.023],
  'ap-southeast-4': [0.025, 0.024, 0.023],
  'ap-southeast-5': [0.0225, 0.0216, 0.0207],
  'ap-southeast-6': [0.02625, 0.0252, 0.02415],
  'ap-southeast-7': [0.0225, 0.0216, 0.0207],
  'ca-central-1': [0.025, 0.024, 0.023],
  'ca-west-1': [0.025, 0.024, 0.023],
  'eu-central-1': [0.0245, 0.0235, 0.0225],
  'eu-central-2': [0.02695, 0.02585, 0.02475],
  'eu-north-1': [0.023, 0.022, 0.021],
  'eu-south-1': [0.024, 0.023, 0.022],
  'eu-south-2': [0.023, 0.022, 0.021],
  'eu-west-1': [0.023, 0.022, 0.021],
  'eu-west-2': [0.024, 0.023, 0.022],
  'eu-west-3': [0.024, 0.023, 0.022],
  'il-central-1': [0.025, 0.024, 0.023],
  'me-central-1': [0.025, 0.024, 0.023],
  'me-south-1': [0.025, 0.024, 0.023],
  'mx-central-1': [0.02415, 0.0231, 0.02205],
  'sa-east-1': [0.0405, 0.039, 0.037],
  'us-east-1': [0.023, 0.022, 0.021],
  'us-east-2': [0.023, 0.022, 0.021],
  'us-gov-east-1': [0.039, 0.037, 0.0355],
  'us-gov-west-1': [0.039, 0.037, 0.0355],
  'us-west-1': [0.026, 0.025, 0.024],
  'us-west-2': [0.023, 0.022, 0.021],
};

/**
 * List prices for storage, by provider (the ids of lib/storage-presets.js),
 * each with the page it was read from and the day it was read.
 *
 *   base      1000 or 1024: how the provider counts a GB
 *   unit      what `rate` is quoted per, in those units
 *   rate      USD per unit a month; `regions` instead where it varies by region
 *   free      bytes a month that cost nothing
 *   minimum   bytes billed however little is stored
 *   fee       USD a month for a plan, which covers `included` bytes
 *   terms     what else the list price charges for, or does not
 *   caveat    how the service behaves that changes what is stored, whatever
 *             the price: said even where an account has a price of its own
 *
 * Allowances, minimums and plans are per account (estimateStorageCost).
 * 'other' is not here: MinIO, Ceph and the rest have no list price to use.
 */
export const STORAGE_PRICES = {
  b2: {
    // $6.95 from 1 May 2026, when API calls became free as well.
    base: DECIMAL,
    unit: 'TB',
    rate: 6.95,
    free: GB(10, DECIMAL),
    source: 'https://www.backblaze.com/cloud-storage/pricing',
    checked: '2026-09-28',
    terms: 'Downloads up to three times what is stored, and API calls, cost nothing more.',
    // Deleting by name on B2's S3 API hides a file rather than removing it
    // (the app's deletes and moves name no version), so the lifecycle
    // decides whether the bytes go.
    caveat: 'A B2 bucket keeps, and bills for, the old version of each file deleted, renamed or moved here '
      + 'unless its lifecycle is set to keep only the last version.',
  },
  aws: {
    base: BINARY,
    unit: 'GB',
    regions: S3_STANDARD,
    bands: [TB(50, BINARY), TB(500, BINARY)],
    source: 'https://aws.amazon.com/s3/pricing/',
    checked: '2026-09-28',
    terms: 'Priced as S3 Standard. Downloads and requests are billed on top, by region.',
  },
  r2: {
    // Cloudflare does not say which GB it means; the decimal one is the larger
    // count, so the estimate errs high rather than low.
    base: DECIMAL,
    unit: 'GB',
    rate: 0.015,
    free: GB(10, DECIMAL),
    source: 'https://developers.cloudflare.com/r2/pricing/',
    checked: '2026-09-28',
    terms: 'Priced as R2 Standard. Downloads are free; requests are billed by the million past a free allowance each month.',
  },
  spaces: {
    base: BINARY,
    unit: 'GB',
    rate: 0.02,
    fee: 5,
    included: GB(250, BINARY),
    source: 'https://docs.digitalocean.com/products/spaces/details/pricing/',
    checked: '2026-09-28',
    terms: 'The $5 plan also includes 1,024 GB of downloads a month, then $0.01 per GB.',
  },
  wasabi: {
    // $7.99 from 1 July 2026, in every region. The 90 days are a minimum
    // storage duration, and the trash is a copy made when a file is removed,
    // so every purge is early.
    base: BINARY,
    unit: 'TB',
    rate: 7.99,
    minimum: TB(1, BINARY),
    source: 'https://wasabi.com/pricing/faq',
    checked: '2026-09-28',
    terms: 'Downloads and requests cost nothing more while downloads stay within what is stored. '
      + `Wasabi bills every object for at least 90 days, so a file purged from the trash after ${TRASH_RETENTION_DAYS} `
      + `is billed for ${90 - TRASH_RETENTION_DAYS} more.`,
  },
};

const NAMES = { blob: 'Vercel Blob' };
export const providerName = (id) => NAMES[id] || presetById(id)?.label || presetById('other').label;

/**
 * Where a storage config keeps its objects, as the estimate groups them: the
 * service (from the endpoint, as lib/storage.js storageProvider tells it),
 * the bucket, and the region where the price depends on it — only AWS's
 * does. `bill` is the account it is taken to be billed to (estimateStorageCost),
 * and what a price of our own is set for. Nothing secret is kept, not even
 * which key reaches it.
 */
export function storageLocation(cfg) {
  const provider = detectPreset(cfg?.endpoint);
  const host = endpointHost(cfg?.endpoint);
  const bucket = String(cfg?.bucket || '').trim();
  const region = provider === 'aws' ? String(cfg?.region || '').trim().toLowerCase() : '';
  return {
    key: [provider, host, bucket, region].join('|'),
    bill: accountKey({ provider, host, region }),
    provider,
    name: providerName(provider),
    host,
    bucket,
    region,
  };
}

/** Files kept in Vercel Blob: stored, but not in a bucket this prices. */
export const BLOB_LOCATION = Object.freeze({
  key: 'blob', bill: 'blob', provider: 'blob', name: providerName('blob'), host: '', bucket: '', region: '',
});

/**
 * The price of storage at a location, in bytes and dollars: ours when the
 * account has one (`overrides`, from pricesByAccount), else the list price,
 * else null — another service, or an AWS region not listed. `bands` are the
 * rate's volume steps, each up to `upTo` bytes. `own` says which it is.
 */
export function priceFor(location, { prices = STORAGE_PRICES, overrides = null } = {}) {
  const ours = location?.bill && overrides instanceof Map ? overrides.get(location.bill) : null;
  if (ours) return ownPrice(location, ours, prices);
  const p = prices[location?.provider];
  if (!p) return null;
  const rates = p.regions ? p.regions[location.region] : [p.rate];
  if (!Array.isArray(rates) || !rates.length || !rates.every((r) => r > 0)) return null;
  const limits = p.bands || [];
  return {
    provider: location.provider,
    name: providerName(location.provider),
    own: false,
    base: p.base,
    unit: p.unit,
    unitBytes: p.unit === 'TB' ? TB(1, p.base) : GB(1, p.base),
    bands: rates.map((rate, i) => ({ rate, upTo: limits[i] ?? Infinity })),
    freeBytes: p.free || 0,
    minimumBytes: p.minimum || 0,
    fee: p.fee || 0,
    includedBytes: p.included || 0,
    source: p.source,
    checked: p.checked,
    terms: p.terms,
    caveat: p.caveat || null,
  };
}

/**
 * A price of our own (a storage_prices row, lib/db.js) in priceFor's shape.
 * One rate, however much is stored: a contract that steps down with volume
 * is entered at the rate it is paying now. Its free storage covers what a
 * plan's fee includes, so there is no `includedBytes` to set. The list
 * price's terms may not hold under a contract and are left out; how the
 * service behaves (its caveat) is the same whatever is paid.
 */
function ownPrice(location, own, prices) {
  const unit = own.unit === 'GB' ? 'GB' : 'TB';
  const base = own.base === DECIMAL ? DECIMAL : BINARY;
  return {
    provider: location.provider,
    name: providerName(location.provider),
    own: true,
    base,
    unit,
    unitBytes: unit === 'TB' ? TB(1, base) : GB(1, base),
    bands: [{ rate: Math.max(0, Number(own.rate) || 0), upTo: Infinity }],
    freeBytes: Math.max(0, Number(own.freeBytes) || 0),
    minimumBytes: Math.max(0, Number(own.minimumBytes) || 0),
    fee: Math.max(0, Number(own.fee) || 0),
    includedBytes: 0,
    note: own.note || null,
    setAt: own.setAt ?? null,
    setBy: own.setBy ?? null,
    source: null,
    checked: null,
    terms: null,
    caveat: prices[location.provider]?.caveat || null,
  };
}

/**
 * Dollars a month to store `bytes` at `price` (from priceFor): less the free
 * allowance, at least the minimum, the plan's fee covering what it includes,
 * and each band's rate for the bytes that fall in it.
 */
export function monthlyCost(bytes, price) {
  if (!price) return null;
  const stored = Math.max(0, Number(bytes) || 0);
  const billed = Math.max(stored - price.freeBytes, price.minimumBytes, 0);
  let left = Math.max(billed - price.includedBytes, 0);
  let usd = price.fee;
  let from = 0;
  for (const band of price.bands) {
    if (left <= 0) break;
    const inBand = Math.min(left, band.upTo - from);
    usd += (inBand / price.unitBytes) * band.rate;
    left -= inBand;
    from = band.upTo;
  }
  return usd;
}

/**
 * The monthly estimate: `parts` ({ location, bytes }) summed into one line per
 * location, each priced, biggest first.
 *
 * A free allowance, a minimum and a plan are each per account, and so are
 * AWS's volume bands (per region), so buckets on one account are priced
 * together and the figure shared among them by what each holds. Which
 * account is not something a key says, so buckets behind one endpoint are
 * taken to share one: so it is at Backblaze, where an account keeps its data
 * in the region it was opened in, and at Cloudflare, whose endpoint names the
 * account; elsewhere it is the usual case.
 *
 * An account with a price of our own (`overrides`, from pricesByAccount) is
 * priced by it, list price or none.
 *
 * → { lines: [{ key, location, price, bytes, billBytes, usd }], usd, bytes,
 *     unpricedBytes, checked, own }. `usd` is null for a line without a
 * price, and for the whole when nothing has one. `checked` is the oldest date
 * among the list prices used (null when none is), and `own` whether any
 * line is at a price of our own.
 */
export function estimateStorageCost(parts = [], { prices = STORAGE_PRICES, overrides = null } = {}) {
  const lines = new Map();
  for (const part of parts) {
    const loc = part?.location;
    if (!loc?.key) continue;
    if (!lines.has(loc.key)) {
      lines.set(loc.key, { key: loc.key, location: loc, price: priceFor(loc, { prices, overrides }), bytes: 0, billBytes: 0, usd: null });
    }
    lines.get(loc.key).bytes += Math.max(0, Number(part.bytes) || 0);
  }

  const bills = new Map();
  for (const line of lines.values()) {
    if (!line.price) continue;
    const id = line.location.bill || line.key;
    if (!bills.has(id)) bills.set(id, { price: line.price, bytes: 0, lines: [] });
    const bill = bills.get(id);
    bill.bytes += line.bytes;
    bill.lines.push(line);
  }
  let usd = null;
  for (const bill of bills.values()) {
    const cost = monthlyCost(bill.bytes, bill.price);
    usd = (usd || 0) + cost;
    for (const line of bill.lines) {
      line.billBytes = bill.bytes;
      line.usd = bill.bytes > 0 ? cost * (line.bytes / bill.bytes) : cost / bill.lines.length;
    }
  }

  // A line with nothing in it and nothing to pay is only noise; one with a
  // minimum or a plan to pay for is not.
  const list = [...lines.values()]
    .filter((l) => l.bytes > 0 || l.usd > 0)
    .sort((a, b) => b.bytes - a.bytes || (b.usd || 0) - (a.usd || 0) || (a.key < b.key ? -1 : 1));
  const dates = list.map((l) => (l.price && !l.price.own ? l.price.checked : null)).filter(Boolean).sort();
  return {
    lines: list,
    usd,
    bytes: list.reduce((n, l) => n + l.bytes, 0),
    unpricedBytes: list.filter((l) => !l.price).reduce((n, l) => n + l.bytes, 0),
    checked: dates[0] || null,
    own: list.some((l) => l.price?.own),
  };
}

/**
 * The parts to estimate from what lib/db.js measured — billableStorage() and
 * listDrivesWithUsage() — each put where it is kept.
 *
 * `locate(drive)` is the location of that drive's objects (null: the Storage
 * bucket's). A file is held by the deepest drive it sits in (heldByDrive);
 * what no drive holds is in the Storage bucket, and so are the proxies, which
 * the app writes there whichever drive the file is in. The trash stays in the
 * bucket its file was in until it is purged.
 */
export function storageParts({ stored, drives = [], locate }) {
  if (!stored) return [];
  const held = heldByDrive(drives.map((d) => ({
    id: d.id,
    prefix: d.prefix,
    live: { files: d.files, bytes: d.bytes },
    trash: stored.trashByDrive?.[d.id],
  })));
  const base = locate(null);
  let rest = (Number(stored.live?.bytes) || 0) + (Number(stored.trash?.bytes) || 0);
  const parts = [];
  for (const d of drives) {
    const h = held.get(d.id);
    const bytes = (h?.live.bytes || 0) + (h?.trash.bytes || 0);
    parts.push({ location: locate(d), bytes });
    rest -= bytes;
  }
  parts.push({ location: base, bytes: Math.max(0, rest) });
  parts.push({ location: base, bytes: Number(stored.proxies?.bytes) || 0 });
  parts.push({ location: BLOB_LOCATION, bytes: Number(stored.blob?.bytes) || 0 });
  return parts;
}

// ── Prices of our own ───────────────────────────────────────────────────────
// Where what storage costs this organisation is not the list price — a
// negotiated rate, a contract, a service with no list price at all — an
// admin says so on Admin → Storage → Prices, and the account's row in
// storage_prices (lib/db.js) replaces the list price in the estimate.

const PROVIDERS = new Set(['aws', 'b2', 'r2', 'spaces', 'wasabi', 'other']);

/**
 * The most a price of our own may say, so that a slip is refused rather than
 * estimated from: a dollar a GB a month is several times the dearest storage
 * any of these services lists, and $1,000 a TB is the same figure per TB —
 * over either, the likelier story is a price per TB entered as per GB. The
 * amounts stay well inside what a JavaScript number counts exactly.
 */
export const PRICE_LIMITS = Object.freeze({ perTB: 1000, perGB: 1, feeUsd: 100000, amountTB: 1000, note: 200 });

/** An account as storage_prices keys it: "provider|host|region", as storageLocation makes its `bill`. */
export function accountKey({ provider, host = '', region = '' } = {}) {
  return [provider, host, region].join('|');
}

/**
 * An account key back into its parts, or null when it is not one: a service
 * the app knows, an endpoint's host for every service but AWS (which is the
 * one with none), and a region only for AWS, where the price depends on it.
 */
export function parseAccount(key) {
  if (typeof key !== 'string' || !key || key.length > 400) return null;
  // No whitespace or control characters: a key is made from a hostname and a region.
  if (/[\s\u0000-\u001f\u007f]/.test(key)) return null;
  const parts = key.split('|');
  if (parts.length !== 3) return null;
  const [provider, host, region] = parts;
  if (!PROVIDERS.has(provider)) return null;
  if (provider === 'aws' ? host !== '' : !host) return null;
  if (region && (provider !== 'aws' || !/^[a-z0-9-]{1,40}$/.test(region))) return null;
  return { provider, host, region };
}

// A number from a form: a number, or a string of one. Blank is null; the rest NaN.
const numberFrom = (v) => {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  if (typeof v === 'number') return v;
  return typeof v === 'string' ? Number(v.trim()) : NaN;
};

/**
 * A price of our own as an admin sent it (PUT /api/admin/storage-prices),
 * checked, into what storage_prices keeps. → { account, price } or { error },
 * the error a sentence for the form.
 *
 *   account      the account key (parseAccount)
 *   rate, unit   USD a month, per 'TB' or per 'GB'
 *   base         1000 or 1024: how the provider counts a TB
 *   free, freeUnit, minimum, minimumUnit
 *                storage free each month, and the least billed, each in
 *                'GB' or 'TB'; blank is none
 *   fee          a flat USD a month on top; blank is none
 *   note         what the price is from, for whoever reads it next
 *
 * Amounts become bytes here, in the provider's own counting, so the
 * estimate never has to know which unit was typed.
 */
export function validateStoragePrice(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send the price as an object of its fields.' };
  const account = parseAccount(input.account);
  if (!account) return { error: 'Say which account the price is for.' };
  const unit = input.unit === 'TB' || input.unit === 'GB' ? input.unit : null;
  if (!unit) return { error: 'Say whether the price is per TB or per GB.' };
  const base = Number(input.base);
  if (base !== DECIMAL && base !== BINARY) return { error: 'Say how the provider counts a TB: as 1,000 GB or as 1,024 GB.' };

  const rate = numberFrom(input.rate);
  if (rate == null) return { error: 'Enter the price, in US dollars.' };
  if (!Number.isFinite(rate) || rate < 0) return { error: 'The price must be a number of dollars, 0 or more.' };
  if (rate > (unit === 'TB' ? PRICE_LIMITS.perTB : PRICE_LIMITS.perGB)) {
    return { error: `No storage costs more than $${PRICE_LIMITS.perTB.toLocaleString('en-US')} a TB a month ($${PRICE_LIMITS.perGB} a GB). Check the price, and whether it is per TB or per GB.` };
  }

  const amounts = {};
  for (const [field, label] of [['free', 'The free storage'], ['minimum', 'The least billed']]) {
    const n = numberFrom(input[field]);
    if (n != null && (!Number.isFinite(n) || n < 0)) return { error: `${label} must be a number, 0 or more.` };
    const amount = n || 0;
    const u = input[`${field}Unit`] ?? 'GB';
    if (u !== 'TB' && u !== 'GB') return { error: `Say whether ${label.toLowerCase()} is in GB or TB.` };
    const bytes = Math.round(amount * (u === 'TB' ? TB(1, base) : GB(1, base)));
    if (bytes > TB(PRICE_LIMITS.amountTB, base)) return { error: `${label} is over ${PRICE_LIMITS.amountTB.toLocaleString('en-US')} TB. Check the amount and its unit.` };
    amounts[field] = bytes;
  }

  const fee = numberFrom(input.fee);
  if (fee != null && (!Number.isFinite(fee) || fee < 0)) return { error: 'The monthly fee must be a number of dollars, 0 or more.' };
  if ((fee || 0) > PRICE_LIMITS.feeUsd) return { error: `A monthly fee over $${PRICE_LIMITS.feeUsd.toLocaleString('en-US')} is not one for storage. Check the amount.` };

  if (input.note != null && typeof input.note !== 'string') return { error: 'The note must be text.' };
  const note = String(input.note ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (note.length > PRICE_LIMITS.note) return { error: `Keep the note under ${PRICE_LIMITS.note} characters.` };

  return {
    account: accountKey(account),
    price: { rate, unit, base, freeBytes: amounts.free, minimumBytes: amounts.minimum, fee: fee || 0, note: note || null },
  };
}

/** storage_prices rows (lib/db.js listStoragePrices) as priceFor takes them: a Map by account. */
export function pricesByAccount(rows = []) {
  return new Map((Array.isArray(rows) ? rows : []).filter((r) => r?.account).map((r) => [r.account, r]));
}

/**
 * The accounts a library is billed on, for the Prices page: each distinct
 * `bill` among `uses` — { location, drive }, the drive null for the Storage
 * bucket's — with its buckets and what keeps files in each. The Storage
 * bucket's account first, then by service and host.
 */
export function storageAccounts(uses = []) {
  const byBill = new Map();
  for (const { location, drive = null } of uses) {
    if (!location?.bill || location.provider === 'blob') continue;
    if (!byBill.has(location.bill)) {
      byBill.set(location.bill, {
        account: location.bill,
        provider: location.provider,
        name: location.name,
        host: location.host || '',
        region: location.region || '',
        location,
        storage: false,
        buckets: new Map(),
      });
    }
    const a = byBill.get(location.bill);
    if (!a.buckets.has(location.bucket)) a.buckets.set(location.bucket, { bucket: location.bucket, storage: false, drives: [] });
    const b = a.buckets.get(location.bucket);
    if (drive) b.drives.push(String(drive.name || ''));
    else { a.storage = true; b.storage = true; }
  }
  return [...byBill.values()]
    .map((a) => ({ ...a, buckets: [...a.buckets.values()].map((b) => ({ ...b, drives: b.drives.sort((x, y) => x.localeCompare(y)) })) }))
    .sort((a, b) => Number(b.storage) - Number(a.storage) || a.name.localeCompare(b.name) || a.account.localeCompare(b.account));
}

/**
 * Bytes as an amount and unit for a form: whole terabytes as TB, anything
 * else as GB, in the provider's counting. 10 GB → { 10, 'GB' }, 1 TB → { 1, 'TB' }.
 */
export function amountOf(bytes, base = BINARY) {
  const b = Math.max(0, Number(bytes) || 0);
  const tb = TB(1, base);
  if (b >= tb && b % tb === 0) return { amount: b / tb, unit: 'TB' };
  return { amount: Math.round((b / GB(1, base)) * 1000) / 1000, unit: 'GB' };
}

/**
 * What the Prices form starts from for an account: its price of our own
 * when it has one, else the list price (its first rate, where it steps down
 * with volume), else blanks. A plan's included storage is our price's free
 * storage — with the fee, it prices the same.
 */
export function priceFormValues(price) {
  if (!price) return { rate: '', unit: 'TB', base: BINARY, free: '', freeUnit: 'GB', minimum: '', minimumUnit: 'TB', fee: '', note: '' };
  const free = amountOf((price.freeBytes || 0) + (price.includedBytes || 0), price.base);
  const minimum = amountOf(price.minimumBytes || 0, price.base);
  return {
    rate: price.bands?.[0]?.rate ?? '',
    unit: price.unit,
    base: price.base,
    free: free.amount || '',
    freeUnit: free.amount ? free.unit : 'GB',
    minimum: minimum.amount || '',
    minimumUnit: minimum.amount ? minimum.unit : 'TB',
    fee: price.fee || '',
    note: price.own ? price.note || '' : '',
  };
}

// ── Saying it ───────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const RATE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 5 });
const WHOLE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** 18.2663 → "$18.27"; a positive amount under half a cent → "under $0.01"; no figure → "". */
export function fmtUsd(n) {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return '';
  if (v > 0 && v < 0.005) return 'under $0.01';
  return USD.format(v);
}

/** A rate as it is quoted: 6.95 → "$6.95", 0.023 → "$0.023", 5.5 → "$5.50", 5 → "$5". */
export function fmtRate(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? WHOLE.format(v) : RATE.format(v);
}

/** "2026-09-28" → "Sep 28, 2026". */
export function fmtPriceDate(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? DAY.format(t) : '';
}

/** A size in a price's own units: what is stored, or a round amount a price names ("1 TB", not "1.0 TB"). */
export const billedSize = (bytes, price) => (fmtSize(bytes, { base: price?.base || BINARY }) || '0 B').replace(/\.0 /, ' ');

/**
 * A price's rate and what changes it. `kind` is 'plan' for a fee that
 * covers some storage before the rate starts (DigitalOcean's), 'flat' for a
 * fee and no rate, 'none' for neither, and otherwise 'rate', with `extras`:
 * the free storage, the minimum, the volume steps (every one, or with
 * `billBytes` only whether they are reached), and a fee on top.
 */
function pricePhrases(price, { billBytes = null } = {}) {
  const first = price.bands[0].rate;
  const rate = `${fmtRate(first)} per ${price.unit}`;
  if (price.fee && price.includedBytes) {
    return { kind: 'plan', text: `${fmtRate(price.fee)} a month covers ${billedSize(price.includedBytes, price)}, then ${rate}` };
  }
  if (!first) return price.fee ? { kind: 'flat', text: `a flat ${fmtRate(price.fee)} a month` } : { kind: 'none' };
  const extras = [];
  if (price.freeBytes) extras.push(`the first ${billedSize(price.freeBytes, price)} free`);
  if (price.minimumBytes) extras.push(`at least ${billedSize(price.minimumBytes, price)} billed`);
  if (price.bands.length > 1) {
    if (billBytes == null) {
      extras.push(price.bands.slice(1).map((b, i) => `${fmtRate(b.rate)} past ${billedSize(price.bands[i].upTo, price)}`).join(', '));
    } else if (billBytes > price.bands[0].upTo) {
      extras.push(`less past ${billedSize(price.bands[0].upTo, price)}`);
    }
  }
  if (price.fee) extras.push(`plus ${fmtRate(price.fee)} a month`);
  return { kind: 'rate', text: rate, extras };
}

const withExtras = (text, extras = []) => (extras.length ? `${text}, ${extras.join(', ')}` : text);

/**
 * How a line's figure was reached, in a phrase: what is stored, in the
 * provider's units, and the rate, with the allowance, minimum or plan that
 * applies, and "Our price" first when it is ours rather than the list's.
 * Worded so it holds whether or not the minimum bites, since that depends
 * on the whole account. Without a price, why not.
 */
export function lineNote(line) {
  const { price, location } = line || {};
  if (!price) {
    const size = fmtSize(line?.bytes) || '0 B';
    if (location?.provider === 'blob') return `${size}, uploaded before a bucket was set up`;
    if (location?.provider === 'aws') return `${size}: no list price for this region, until we set one`;
    return `${size}: no list price for this service, until we set one`;
  }
  const size = billedSize(line.bytes, price);
  const p = pricePhrases(price, { billBytes: line.billBytes || 0 });
  const said = p.kind === 'plan' ? `${size}: ${p.text}`
    : p.kind === 'flat' ? `${size} for ${p.text}`
      : p.kind === 'none' ? `${size}, at no charge`
        : `${size} at ${withExtras(p.text, p.extras)}`;
  return price.own ? `Our price: ${said}` : said;
}

/**
 * A price in words, with no size, for the Prices page: "$6.95 per TB a
 * month, the first 10 GB free"; every volume step where there are several.
 */
export function priceSummary(price) {
  if (!price) return '';
  const p = pricePhrases(price);
  if (p.kind === 'plan') return p.text;
  if (p.kind === 'flat') return `A${p.text.slice(1)}`;
  if (p.kind === 'none') return 'No charge';
  return withExtras(`${p.text} a month`, p.extras);
}

/** How a price counts a TB, for someone who has not met the difference: "1,000 GB to the TB". */
export const countsLabel = (base) => (base === DECIMAL ? '1,000 GB to the TB' : '1,024 GB to the TB');

/** When a price of our own was set: ms → "Sep 29, 2026". */
export function fmtDay(ms) {
  const t = Number(ms);
  return Number.isFinite(t) && t > 0 ? DAY.format(t) : '';
}

/**
 * What the Storage cost card says under a service's lines: for a list price,
 * what else it charges for; for our own, who set it and when, and its note;
 * then how the service behaves, whatever is paid, and for decimal counting
 * why its sizes read larger. → { text, source }, `source` the list price's
 * page to link the service's name to (none for our own).
 */
export function serviceNote(price) {
  if (!price) return { text: '', source: null };
  let lead = price.terms || '';
  if (price.own) {
    lead = `At our price${price.note ? ` (${price.note})` : ''}`;
    if (price.setBy) lead += `, set by ${price.setBy}`;
    if (fmtDay(price.setAt)) lead += `${price.setBy ? '' : ', set'} on ${fmtDay(price.setAt)}`;
    lead += '.';
  }
  return {
    text: [lead, price.caveat, unitsNote(price)].filter(Boolean).join(' '),
    source: price.own ? null : price.source || null,
  };
}

/**
 * The sentence a price in decimal units needs: its sizes are counted as it
 * bills them, so they read larger than the same bytes elsewhere on the page,
 * which counts 1,024 to the step. Empty for the rest.
 */
export function unitsNote(price) {
  return price?.base === DECIMAL
    ? 'Sizes on its line are decimal, 10⁹ bytes to the GB, so they read larger than elsewhere on this page.'
    : '';
}
