// lib/storage-presets.js — the provider knowledge the admin form needs.
//
// Deliberately free of server imports. The Storage tab is a client component,
// so anything it imports is bundled into the browser; pulling lib/storage.js
// in would drag the AWS SDK along with it. Everything here is pure data and
// pure functions, which also makes it testable without a bucket.

/**
 * The providers worth naming, in the order an admin is likely to want them.
 *
 * `endpoint` is a template with {region} where the provider puts its region
 * into the hostname. `scoped` says whether Onyx can mint per-mount
 * credentials there, which decides whether read-only members can mount at
 * all — the single most consequential difference between these, and the one
 * least visible from the outside.
 */
export const STORAGE_PRESETS = [
  {
    id: 'aws',
    label: 'Amazon S3',
    endpoint: '',
    regionPlaceholder: 'us-east-1',
    scoped: true,
    note: 'Scoped credentials via STS. Leave the endpoint blank.',
  },
  {
    id: 'b2',
    label: 'Backblaze B2',
    endpoint: 'https://s3.{region}.backblazeb2.com',
    regionPlaceholder: 'us-west-004',
    scoped: true,
    note: 'Scoped credentials via B2 application keys. Use a non-master key — B2 rejects the master key on the S3 API — and give it the writeKeys capability so per-mount keys can be minted.',
  },
  {
    id: 'r2',
    label: 'Cloudflare R2',
    endpoint: 'https://{account}.r2.cloudflarestorage.com',
    regionPlaceholder: 'auto',
    scoped: false,
    note: 'No scoped rung wired up yet, so read-only members cannot mount. Replace {account} with your Cloudflare account id.',
  },
  {
    id: 'spaces',
    label: 'DigitalOcean Spaces',
    endpoint: 'https://{region}.digitaloceanspaces.com',
    regionPlaceholder: 'nyc3',
    scoped: false,
    note: 'No scoped rung: read-only members cannot mount.',
  },
  {
    id: 'wasabi',
    label: 'Wasabi',
    endpoint: 'https://s3.{region}.wasabisys.com',
    regionPlaceholder: 'us-east-1',
    scoped: false,
    note: 'No scoped rung: read-only members cannot mount.',
  },
  {
    id: 'other',
    label: 'Other S3-compatible',
    endpoint: '',
    regionPlaceholder: 'us-east-1',
    scoped: false,
    note: 'MinIO, Ceph, anything else. Enter the endpoint by hand.',
  },
];

export const presetById = (id) => STORAGE_PRESETS.find((p) => p.id === id) || null;

/**
 * Which preset a saved config matches, from its endpoint.
 *
 * Mirrors storageProvider() in lib/storage.js — the server's answer is the
 * one that counts, and the form must not disagree with it about which
 * provider the admin is looking at.
 */
export function detectPreset(endpoint) {
  const e = String(endpoint || '').toLowerCase();
  if (!e) return 'aws';
  if (e.includes('backblazeb2')) return 'b2';
  if (e.includes('r2.cloudflarestorage')) return 'r2';
  if (e.includes('digitaloceanspaces')) return 'spaces';
  if (e.includes('wasabisys')) return 'wasabi';
  return 'other';
}

/**
 * Fill in endpoint and region for a chosen preset, keeping anything the admin
 * already typed.
 *
 * Never overwrites a non-empty field: picking a preset by accident should not
 * silently discard a hand-typed endpoint. The {region} placeholder is
 * substituted only when a region is actually known, so the template stays
 * visible and obviously incomplete rather than resolving to
 * `s3.undefined.backblazeb2.com`.
 */
export function applyPreset(form, presetId) {
  const preset = presetById(presetId);
  if (!preset) return form;
  const next = { ...form, provider: 's3' };

  // Resolve the region FIRST: the endpoint template is built from it, and
  // filling the region afterwards would leave a literal {region} in the
  // hostname — which fails later as a DNS error that says nothing about a
  // placeholder.
  const typedRegion = String(form.region || '').trim();
  const region = typedRegion || (preset.id === 'other' ? '' : preset.regionPlaceholder || '');
  if (region) next.region = region;

  if (preset.id === 'aws') {
    // AWS is the one provider identified by the ABSENCE of an endpoint, so
    // switching to it has to clear whatever was there.
    next.endpoint = '';
  } else if (preset.endpoint && !String(form.endpoint || '').trim()) {
    next.endpoint = region ? preset.endpoint.replace('{region}', region) : preset.endpoint;
  }
  return next;
}

/** Tally a diagnostics run, for the one-line summary above the detail. */
export function summarizeChecks(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const failed = list.filter((c) => c.status === 'fail').length;
  const warned = list.filter((c) => c.status === 'warn').length;
  const passed = list.filter((c) => c.status === 'pass').length;
  return {
    total: list.length,
    passed,
    warned,
    failed,
    ok: failed === 0 && list.length > 0,
    label: !list.length
      ? 'Nothing checked.'
      : failed
        ? `${failed} of ${list.length} checks failed.`
        : warned
          ? `All checks passed, ${warned} with a warning.`
          : `All ${list.length} checks passed.`,
  };
}

// ── Moving the library ──────────────────────────────────────────────────────
// Files are catalogued by key, not by bucket: every row's storage_key is read
// from whichever bucket the config names NOW. So pointing the config at
// another bucket, another service or from Blob to S3 does not move a single
// file — the ones already stored stay where they are, and this deployment
// starts looking for them somewhere they are not. That is worth a sentence
// and a confirm before it happens, and a refusal from the server if the
// sentence was skipped (PUT /api/admin/storage without confirmMove).

const hostOf = (endpoint) => String(endpoint || '').trim().toLowerCase()
  .replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/\/+$/, '');

/**
 * What saving `next` over `current` would repoint: 'provider' (Blob ⇄ S3),
 * 'bucket', or 'service' (another endpoint — another provider, region or
 * host). Returns { changed, changes }. A bucket filled in for the first time
 * on an S3 config that never had one is setting up, not moving.
 */
export function storageLocationChange(current = {}, next = {}) {
  const prov = (c) => (c?.provider === 's3' ? 's3' : 'blob');
  const changes = [];
  if (prov(current) !== prov(next)) {
    changes.push('provider');
  } else if (prov(next) === 's3') {
    const a = String(current?.bucket || '').trim();
    const b = String(next?.bucket || '').trim();
    if (a && a !== b) changes.push('bucket');
    if (a && hostOf(current?.endpoint) !== hostOf(next?.endpoint)) changes.push('service');
  }
  return { changed: changes.length > 0, changes };
}

/** Must this save be confirmed first? Only when there is something already stored to strand. */
export function moveNeedsConfirm(current, next, storedFiles) {
  return (Number(storedFiles) || 0) > 0 && storageLocationChange(current, next).changed;
}

/**
 * What the confirm in front of a move says (Admin → Storage → Backend):
 * how much is stored where, and that it stays there. The server's 409 says
 * the same in fewer words, for anything that skipped this.
 */
export function moveWarning(current = {}, next = {}, storedFiles = 0) {
  const n = Number(storedFiles) || 0;
  const { changes } = storageLocationChange(current, next);
  const files = `${n.toLocaleString('en-US')} ${n === 1 ? 'file' : 'files'}`;
  const where = current?.provider === 's3' ? `the bucket “${String(current.bucket || '').trim()}”` : 'Vercel Blob';
  const change = changes.includes('provider')
    ? (next?.provider === 's3' ? 'Switching to an S3 bucket' : 'Switching to Vercel Blob')
    : changes.includes('bucket')
      ? `Switching to the bucket “${String(next?.bucket || '').trim()}”`
      : 'Switching to another service';
  return {
    title: 'Change where files are kept?',
    body: `This library has ${files} in ${where}. They will not move. ${change} sends new uploads there, and the ${n === 1 ? 'file already stored stops' : 'files already stored stop'} opening until ${n === 1 ? 'it is' : 'they are'} copied across by hand.`,
    confirmLabel: 'Change it anyway',
  };
}
