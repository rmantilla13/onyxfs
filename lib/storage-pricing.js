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
    // Deleting by name on B2's S3 API hides a file rather than removing it
    // (the app's deletes and moves name no version), so the lifecycle
    // decides whether the bytes go.
    terms: 'Downloads up to three times what is stored, and API calls, cost nothing more. '
      + 'A B2 bucket keeps, and bills for, the old version of each file deleted, renamed or moved here '
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
 * does. `bill` is the account it is taken to be billed to (estimateStorageCost).
 * Nothing secret is kept, not even which key reaches it.
 */
export function storageLocation(cfg) {
  const provider = detectPreset(cfg?.endpoint);
  const host = endpointHost(cfg?.endpoint);
  const bucket = String(cfg?.bucket || '').trim();
  const region = provider === 'aws' ? String(cfg?.region || '').trim().toLowerCase() : '';
  return {
    key: [provider, host, bucket, region].join('|'),
    bill: [provider, host, region].join('|'),
    provider,
    name: providerName(provider),
    bucket,
    region,
  };
}

/** Files kept in Vercel Blob: stored, but not in a bucket this prices. */
export const BLOB_LOCATION = Object.freeze({
  key: 'blob', bill: 'blob', provider: 'blob', name: providerName('blob'), bucket: '', region: '',
});

/**
 * The price of storage at a location, in bytes and dollars, or null where
 * there is no list price: another service, or an AWS region not listed.
 * `bands` are the rate's volume steps, each up to `upTo` bytes.
 */
export function priceFor(location, prices = STORAGE_PRICES) {
  const p = prices[location?.provider];
  if (!p) return null;
  const rates = p.regions ? p.regions[location.region] : [p.rate];
  if (!Array.isArray(rates) || !rates.length || !rates.every((r) => r > 0)) return null;
  const limits = p.bands || [];
  return {
    provider: location.provider,
    name: providerName(location.provider),
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
 * → { lines: [{ key, location, price, bytes, billBytes, usd }], usd, bytes,
 *     unpricedBytes, checked }. `usd` is null for a line without a price, and
 * for the whole when nothing has one; `checked` is the oldest price's date.
 */
export function estimateStorageCost(parts = [], prices = STORAGE_PRICES) {
  const lines = new Map();
  for (const part of parts) {
    const loc = part?.location;
    if (!loc?.key) continue;
    if (!lines.has(loc.key)) {
      lines.set(loc.key, { key: loc.key, location: loc, price: priceFor(loc, prices), bytes: 0, billBytes: 0, usd: null });
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
  const dates = list.map((l) => l.price?.checked).filter(Boolean).sort();
  return {
    lines: list,
    usd,
    bytes: list.reduce((n, l) => n + l.bytes, 0),
    unpricedBytes: list.filter((l) => !l.price).reduce((n, l) => n + l.bytes, 0),
    checked: dates[0] || null,
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

// ── Saying it ───────────────────────────────────────────────────────────────

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const RATE = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 5 });
const DAY = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

/** 18.2663 → "$18.27"; a positive amount under half a cent → "under $0.01"; no figure → "". */
export function fmtUsd(n) {
  const v = n == null ? NaN : Number(n);
  if (!Number.isFinite(v)) return '';
  if (v > 0 && v < 0.005) return 'under $0.01';
  return USD.format(v);
}

/** A rate as it is quoted: 6.95 → "$6.95", 0.023 → "$0.023", 5 → "$5". */
export const fmtRate = (n) => RATE.format(Number(n) || 0);

/** "2026-09-28" → "Sep 28, 2026". */
export function fmtPriceDate(iso) {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? DAY.format(t) : '';
}

/** A size in a price's own units: what is stored, or a round amount a price names ("1 TB", not "1.0 TB"). */
export const billedSize = (bytes, price) => (fmtSize(bytes, { base: price?.base || BINARY }) || '0 B').replace(/\.0 /, ' ');

/**
 * How a line's figure was reached, in a phrase: what is stored, in the
 * provider's units, and the rate, with the allowance, minimum or plan that
 * applies. Worded so it holds whether or not the minimum bites, since that
 * depends on the whole account. Without a price, why not.
 */
export function lineNote(line) {
  const { price, location } = line || {};
  if (!price) {
    const size = fmtSize(line?.bytes) || '0 B';
    if (location?.provider === 'blob') return `${size}, uploaded before a bucket was set up`;
    if (location?.provider === 'aws') return `${size}, in a region with no list price here`;
    return `${size}, on a service with no list price`;
  }
  const size = billedSize(line.bytes, price);
  const rate = `${fmtRate(price.bands[0].rate)} per ${price.unit}`;
  if (price.fee) {
    return `${size}: ${fmtRate(price.fee)} a month covers ${billedSize(price.includedBytes, price)}, then ${rate}`;
  }
  const extra = [];
  if (price.freeBytes) extra.push(`the first ${billedSize(price.freeBytes, price)} free`);
  if (price.minimumBytes) extra.push(`at least ${billedSize(price.minimumBytes, price)} billed`);
  if (price.bands.length > 1 && line.billBytes > price.bands[0].upTo) extra.push(`less past ${billedSize(price.bands[0].upTo, price)}`);
  return `${size} at ${rate}${extra.length ? `, ${extra.join(', ')}` : ''}`;
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
