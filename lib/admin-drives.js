/**
 * How Admin → Drives describes a drive, kept apart from the query
 * (listDrivesWithUsage in lib/db.js) and the page so it is tested without
 * either. Client-safe and pure.
 *
 * The input is one row of listDrivesWithUsage: the drive with its member and
 * owner counts and the files stored under its prefix, all from one grouped
 * query rather than a count per drive.
 */

import { fmtSize } from './media.js';
import { endpointHost } from './storage-presets.js';

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
  // The bucket half is prose when it is the Storage bucket ("Default
  // bucket") and an identifier otherwise; the page sets the two apart, so
  // they travel apart. `location` is the whole, for sorting and titles.
  const bucketLabel = isDefaultBucket || !bucket ? 'Default bucket' : bucket;
  return {
    id: d?.id,
    name: String(d?.name || ''),
    bucket,
    prefix,
    isDefaultBucket: isDefaultBucket || !bucket,
    bucketLabel,
    location: `${bucketLabel} / ${prefix}`,
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

/**
 * The POST body for "New drive" (app/components/drives/NewDriveDialog.js),
 * the same from the files page and from Admin → Drives: { body } or
 * { error }.
 *
 * The folder in the bucket is derived from the name until someone types
 * one (drivePrefixFor, passed in so this stays free of the folder code);
 * the advanced fields are sent only when filled, so a blank bucket still
 * means the Storage bucket, and keys go as a pair or not at all.
 */
export function newDriveRequest(form = {}, derive = (n) => n) {
  const name = String(form.name || '').trim();
  const prefix = clean(form.prefixTouched ? form.prefix : derive(name));
  if (!name) return { error: 'Give the drive a name.' };
  if (!prefix) return { error: 'Give the drive a folder in the bucket.' };
  const body = { name, prefix };
  for (const k of ['bucket', 'region', 'endpoint', 'roleArn', 'accessKeyId']) {
    const v = String(form[k] ?? '').trim();
    if (v) body[k] = v;
  }
  const secret = String(form.secretAccessKey ?? '');
  if (secret.trim()) body.secretAccessKey = secret;
  if (!!body.accessKeyId !== !!body.secretAccessKey) {
    return { error: 'Give both the access key ID and its secret, or neither to use the Storage keys.' };
  }
  // Keys of its own are for a bucket apart from Storage, so the Storage
  // bucket is no default for them: the route refuses the pair without one.
  if (body.accessKeyId && !body.bucket) {
    return { error: 'A drive with its own keys needs its bucket named: the Storage bucket may not be reachable with them.' };
  }
  return { body };
}

/**
 * What saving a drive's settings would repoint, from the drive as stored
 * (`before`) to the drive as it would be saved (`after`). Files are
 * catalogued by key and read from wherever the drive points NOW, so:
 *
 *   fixed    'bucket', 'prefix' — never while files are stored under it
 *            (the route refuses; the form disables them).
 *   confirm  'service' (another endpoint host), 'keys' (another key ID),
 *            'keys-off' (back to the Storage keys, forgetting its own),
 *            'keys-on' (keys of its own for the first time) — allowed with
 *            files stored, but only once someone has said so: rotating a key
 *            for the same bucket is routine, keys for another account strand
 *            every file.
 *
 * A new secret for the same key ID is a rotation and is neither.
 */
export function driveLocationChange(before = {}, after = {}) {
  const str = (v) => String(v ?? '').trim();
  const fixed = [];
  if (str(before.bucket) !== str(after.bucket)) fixed.push('bucket');
  if (clean(before.prefix) !== clean(after.prefix)) fixed.push('prefix');
  const confirm = [];
  const kb = str(before.accessKeyId);
  const ka = str(after.accessKeyId);
  if (kb && !ka) confirm.push('keys-off');
  else if (!kb && ka) confirm.push('keys-on');
  else if (kb !== ka) confirm.push('keys');
  if (endpointHost(before.endpoint) !== endpointHost(after.endpoint)) confirm.push('service');
  return { fixed, confirm };
}

/**
 * The confirm in front of a `confirm` change on a drive that holds files
 * (the drive drawer), and the 409's sentence for anything that skipped it.
 */
export function driveMoveWarning(drive = {}, confirm = [], files = 0) {
  const where = [String(drive.bucket || '').trim(), clean(drive.prefix)].filter(Boolean).join('/');
  const lines = [`${count(files, 'file')} ${Number(files) === 1 ? 'is' : 'are'} stored under ${where || 'its folder'}, and ${Number(files) === 1 ? 'it does' : 'they do'} not move.`];
  if (confirm.includes('service')) lines.push('Pointing the drive at another service sends new uploads there; the files already stored open only if the same bucket is there too.');
  if (confirm.includes('keys-off')) lines.push('Without keys of its own the drive uses the Storage keys, and the keys saved for it are forgotten. If the Storage keys cannot reach this bucket, its files stop opening.');
  if (confirm.includes('keys-on')) lines.push('With keys of its own the drive reads its bucket through them. If they cannot reach this bucket, its files stop opening.');
  if (confirm.includes('keys')) lines.push('New keys for the same bucket are fine — rotating a key, say. Keys for another account leave the files already stored unopenable.');
  return { title: 'Change how this drive reaches its files?', lines, confirmLabel: 'Change it anyway' };
}

/**
 * The drive a stored file is in, from its storage key: the drive with the
 * longest prefix the key sits under (a drive inside another is the inner
 * one), or null for a file outside every drive.
 */
export function driveForKey(drives = [], storageKey = '') {
  const key = String(storageKey || '');
  let best = null;
  for (const d of Array.isArray(drives) ? drives : []) {
    const p = clean(d?.prefix);
    if (p && key.startsWith(`${p}/`) && (!best || p.length > clean(best.prefix).length)) best = d;
  }
  return best;
}

const count = (n, one, many = `${one}s`) => `${(Number(n) || 0).toLocaleString('en-US')} ${Number(n) === 1 ? one : many}`;

/**
 * What deleting a drive does, from GET /api/admin/filespaces?summary=<id>,
 * in the sentences the confirm shows (DeleteDriveConfirm). The part people
 * miss is the last: the files stay, and without the drive around them the
 * library's own rules decide who sees them — which for most files is
 * everyone who can see All files.
 */
export function deleteDriveConsequence(s = {}) {
  const files = Number(s.files) || 0;
  const members = Number(s.members) || 0;
  const where = [String(s.bucket || '').trim(), clean(s.prefix)].filter(Boolean).join('/');
  const lines = [];
  lines.push(members === 0
    ? 'It has no members, so no one loses access to it.'
    : `${count(members, 'member')} ${members === 1 ? 'loses' : 'lose'} it on the files page and in the desktop app. Desktop mounts of it stop within the hour.`);
  lines.push(files === 0
    ? `Nothing is stored under ${where || 'its folder'}.`
    : `Its ${count(files, 'file')} (${fmtSize(s.bytes) || '0 B'}) stay in storage and become visible to everyone who can see All files, unless a file is private or inside another drive.`);
  if (s.ownKeys) lines.push('The access keys saved for this drive are forgotten.');
  lines.push('Nothing in the bucket is deleted.');
  return lines;
}
