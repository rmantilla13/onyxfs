/**
 * How Admin → Drives describes a drive, kept apart from the query
 * (listDrivesWithUsage in lib/db.js) and the page so it is tested without
 * either. Client-safe and pure.
 *
 * The input is one row of listDrivesWithUsage: the drive with its member and
 * owner counts and the files stored under its prefix, all from one grouped
 * query rather than a count per drive.
 */

const clean = (p) => String(p || '').replace(/^\/+|\/+$/g, '');

/** Does the drive carry its own access keys (a bucket of its own, apart from Storage)? */
export const hasOwnKeys = (d) => !!(d && d.accessKeyId && d.hasSecret);

/**
 * One drive as the list shows it.
 *
 * `defaultBucket` is the Storage bucket. A drive in it reads "Default bucket"
 * — unless it has its own keys, where the same name can be a different
 * bucket on a different service.
 */
export function driveRow(d, { defaultBucket = '' } = {}) {
  const bucket = String(d?.bucket || '').trim();
  const prefix = clean(d?.prefix);
  const ownKeys = hasOwnKeys(d);
  const isDefaultBucket = !ownKeys && !!defaultBucket && bucket === String(defaultBucket).trim();
  const members = Number(d?.memberCount) || 0;
  const owners = Number(d?.ownerCount) || 0;
  const tags = [];
  if (ownKeys) tags.push({ key: 'own-keys', label: 'Own keys', tone: 'accent' });
  if (owners === 0) tags.push({ key: 'no-owner', label: 'No owner', tone: 'warning' });
  return {
    id: d?.id,
    name: String(d?.name || ''),
    bucket,
    prefix,
    isDefaultBucket,
    location: `${isDefaultBucket ? 'Default bucket' : bucket || 'Default bucket'} / ${prefix}`,
    members,
    owners,
    files: Number(d?.files) || 0,
    bytes: Number(d?.bytes) || 0,
    ownKeys,
    tags,
  };
}

/** Every drive as the list shows it, in name order. */
export function driveRows(drives = [], opts = {}) {
  return (Array.isArray(drives) ? drives : [])
    .map((d) => driveRow(d, opts))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || String(a.id).localeCompare(String(b.id)));
}

/**
 * The fields of a drive that may reach a browser: never its secret, only
 * whether one is stored. getFilespaceById returns the secret for the
 * credential code; this is the line it does not cross.
 */
export function publicDrive(fs) {
  if (!fs) return null;
  return {
    id: fs.id,
    name: fs.name,
    bucket: fs.bucket || '',
    prefix: clean(fs.prefix),
    region: fs.region || '',
    roleArn: fs.roleArn || '',
    endpoint: fs.endpoint || '',
    accessKeyId: fs.accessKeyId || '',
    hasSecret: !!(fs.hasSecret || fs.secretAccessKey),
    createdBy: fs.createdBy || null,
    createdAt: fs.createdAt || null,
    updatedAt: fs.updatedAt || null,
  };
}

/**
 * The PATCH body for a drive's settings form: only what changed, and the
 * secret only when one was typed (blank keeps the stored one — the route
 * and updateFilespace both read it that way).
 */
export function driveSettingsPatch(saved = {}, form = {}) {
  const out = {};
  for (const k of ['name', 'bucket', 'prefix', 'region', 'endpoint', 'roleArn', 'accessKeyId']) {
    const a = String(saved[k] ?? '').trim();
    const b = String(form[k] ?? '').trim();
    if (k === 'prefix' ? clean(a) !== clean(b) : a !== b) out[k] = k === 'prefix' ? clean(b) : b;
  }
  if (String(form.secretAccessKey || '').trim()) out.secretAccessKey = String(form.secretAccessKey);
  return out;
}
