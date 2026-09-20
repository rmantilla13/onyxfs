/**
 * Storage layer — where uploaded files physically live.
 *
 * Two backends:
 *   - 'blob' (default): Vercel Blob. Zero config, works out of the box.
 *   - 's3'  (bring-your-own): any S3-COMPATIBLE bucket — AWS S3, Cloudflare R2,
 *     DigitalOcean Spaces, Backblaze B2, MinIO, GCS (interop). One config, set
 *     in Admin → Storage. Activates only when fully configured.
 *
 * The S3 SDK is imported DYNAMICALLY so the Blob path (and the build) never
 * depend on it; once @aws-sdk/* is installed (it's in package.json), the S3
 * path lights up. Secrets live in the settings table and never reach the client
 * (see sanitizeStorageConfig).
 */

import { getSetting, setSetting } from './db.js';

const SETTING_KEY = 'storage.config';

export function defaultStorageConfig() {
  return { provider: 'blob', endpoint: '', region: '', bucket: '', accessKeyId: '', secretAccessKey: '', publicBaseUrl: '', prefix: 'files', roleArn: '', accelerate: false };
}

/** S3Client options, honoring Transfer Acceleration (AWS S3 only, no custom endpoint). */
function s3ClientOpts(cfg) {
  return {
    region: cfg.region || 'auto',
    endpoint: cfg.endpoint || undefined,
    forcePathStyle: !!cfg.endpoint,
    useAccelerateEndpoint: !!cfg.accelerate && !cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
}

/** Fetch an S3 object's raw bytes (for server-side thumbnailing). */
export async function s3GetBytes(cfg, key) {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client(s3ClientOpts(cfg));
  const r = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

/** Write bytes to S3 (used to store generated thumbnails). */
export async function s3PutBytes(cfg, key, body, contentType) {
  const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const client = new S3Client(s3ClientOpts(cfg));
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

/** Enable/disable S3 Transfer Acceleration on the bucket. Requires s3:PutAccelerateConfiguration. */
export async function s3SetAccelerate(cfg, enabled) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  if (cfg.endpoint) throw new Error('Transfer Acceleration is an AWS S3 feature (not available on custom endpoints).');
  let S3Client, PutBucketAccelerateConfigurationCommand;
  try { ({ S3Client, PutBucketAccelerateConfigurationCommand } = await import('@aws-sdk/client-s3')); }
  catch { throw new Error('The S3 SDK isn’t installed on the server yet — redeploy to enable this.'); }
  const client = new S3Client({ region: cfg.region || 'us-east-1', credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  await client.send(new PutBucketAccelerateConfigurationCommand({
    Bucket: cfg.bucket,
    AccelerateConfiguration: { Status: enabled ? 'Enabled' : 'Suspended' },
  }));
  return { enabled: !!enabled };
}

/**
 * Which S3-compatible service a config points at, from its endpoint.
 *
 * This used to be inferred twice and only for rclone's benefit. It now
 * decides two things that matter: which scoped-credential mechanism exists
 * (see credentialPlan) and what the multipart ceilings are. AWS is the only
 * provider with no endpoint — everything else is identified by hostname.
 */
export function storageProvider(cfg) {
  const e = String((cfg && cfg.endpoint) || '').toLowerCase();
  if (!e) return 'aws';
  if (e.includes('backblazeb2')) return 'b2';
  if (e.includes('r2.cloudflarestorage')) return 'r2';
  if (e.includes('digitaloceanspaces')) return 'spaces';
  if (e.includes('wasabisys')) return 'wasabi';
  return 'other';
}

/** B2 endpoints carry their region: s3.us-west-004.backblazeb2.com. */
export function b2RegionFromEndpoint(endpoint) {
  const m = /s3\.([a-z]{2}-[a-z]+-\d+)\.backblazeb2\.com/i.exec(String(endpoint || ''));
  return m ? m[1].toLowerCase() : null;
}

// ExternalId baked into the AssumeRole trust policy condition — a static
// shared secret-shape value that defends against the "confused deputy"
// problem. Must match the role's trust policy Condition in AWS.
export const STS_EXTERNAL_ID = 'onyxfs';

/**
 * The stored storage config, layered over the defaults.
 *
 * Pass { fresh: true } from anything that must not show a stale value — the
 * admin screens, and the checks they run. See the note in getSetting.
 */
export async function getStorageConfig(opts) {
  // strict: let the read failure out. Callers that are about to WRITE the
  // config must not be handed defaults that look like "nothing is
  // configured" — merging a form over those erases the stored secret.
  if (opts?.strict) {
    const saved = await getSetting(SETTING_KEY, opts);
    return { ...defaultStorageConfig(), ...(saved && typeof saved === 'object' ? saved : {}) };
  }
  try {
    const saved = await getSetting(SETTING_KEY, opts);
    return { ...defaultStorageConfig(), ...(saved && typeof saved === 'object' ? saved : {}) };
  } catch {
    return defaultStorageConfig();
  }
}

export async function setStorageConfig(cfg, updatedBy) {
  const clean = { ...defaultStorageConfig(), ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  await setSetting(SETTING_KEY, clean, updatedBy);
  return clean;
}

/** True when a custom S3 bucket is fully wired. */
export function s3Ready(cfg) {
  return !!(cfg && cfg.provider === 's3' && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
}

/** Which backend an upload should use right now. */
export function storageMode(cfg) {
  return s3Ready(cfg) ? 's3' : 'blob';
}

/** Strip secrets before sending config to the browser. */
export function sanitizeStorageConfig(cfg) {
  const { secretAccessKey, ...rest } = cfg || {};
  return { ...rest, hasSecret: !!secretAccessKey, mode: storageMode(cfg) };
}

/** The only keys that belong in a stored storage config. */
const STORAGE_FIELDS = Object.keys(defaultStorageConfig());

/**
 * Clean an admin submission before it is persisted.
 *
 * The form is populated from sanitizeStorageConfig, which adds two DERIVED
 * fields — `hasSecret` and `mode` — for display. Posting the form back
 * unfiltered wrote them into the settings row, so a config with a working
 * secret was stored carrying `hasSecret: false`, and a computed `mode` was
 * shadowed by a stale literal. Whitelisting is the fix, and it also means a
 * future field in the form cannot silently become persisted state.
 *
 * The normalising is the other half: a trailing slash on the endpoint or a
 * leading slash on the prefix each produce keys with a double slash, which
 * S3 accepts and then nothing can find again.
 */
export function sanitizeStorageSubmission(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object') return out;
  for (const key of STORAGE_FIELDS) {
    if (!(key in patch)) continue;
    const v = patch[key];
    if (key === 'accelerate') { out.accelerate = !!v; continue; }
    let str = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    if (key === 'provider') str = str === 's3' ? 's3' : 'blob';
    if (key === 'endpoint') str = str.replace(/\/+$/, '');
    if (key === 'prefix') str = str.replace(/^\/+|\/+$/g, '');
    if (key === 'publicBaseUrl') str = str.replace(/\/+$/, '');
    if (key === 'region') str = str.toLowerCase();
    out[key] = str;
  }
  return out;
}

/** Classify a file for the manager's type filter + icons. */
export function fileKind(mime = '', name = '') {
  const m = (mime || '').toLowerCase();
  const n = (name || '').toLowerCase();
  if (m.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg|avif)$/.test(n)) return 'image';
  if (m.startsWith('video/') || /\.(mp4|webm|mov|m4v|ogv)$/.test(n)) return 'video';
  if (m.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(n)) return 'audio';
  if (/pdf|msword|wordprocessing|spreadsheet|presentation|text\/|csv/.test(m) || /\.(pdf|docx?|xlsx?|csv|txt|pptx?|key|pages)$/.test(n)) return 'doc';
  return 'other';
}

/** The public URL a stored key resolves to, given the bucket config. */
export function publicUrlForKey(cfg, key) {
  if (cfg.publicBaseUrl) return `${cfg.publicBaseUrl.replace(/\/$/, '')}/${key}`;
  if (cfg.endpoint) return `${cfg.endpoint.replace(/\/$/, '')}/${cfg.bucket}/${key}`;
  return `https://${cfg.bucket}.s3.${cfg.region || 'us-east-1'}.amazonaws.com/${key}`;
}

/**
 * Normalize an in-app folder path ("Campaigns/2026") into the path segment of
 * an S3 key. Kept as faithful as possible so the folder name shown in Finder
 * matches the folder name in Onyx, and so the sync route can reverse it back
 * to the same `folder` value. Folder names never contain "/" within a segment
 * (the UI strips it), so we only trim and drop empties here.
 */
export function folderToKeyPath(folder) {
  return String(folder || '')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean)
    .join('/');
}

/**
 * A unique object key under the configured prefix, with the in-app folder baked
 * into the path so the bucket's structure mirrors Onyx's folders (and a mounted
 * drive in Finder shows the same tree). → `<prefix>/<folder>/<rand>-<name>`.
 */
export function buildObjectKey(cfg, filename, folder) {
  // Keep the real filename (no random prefix) so the mounted drive shows the
  // same name as the web. Sanitize to a filesystem/URL-safe set, preserving
  // spaces, parens, dot, dash, underscore. Uniqueness is handled by s3UniqueKey.
  let safe = (filename || 'file').replace(/[^a-zA-Z0-9._ ()-]/g, '_').replace(/\s+/g, ' ').trim().slice(-150);
  if (!safe || safe === '.' || safe === '..') safe = 'file';
  const prefix = (cfg.prefix || 'files').replace(/^\/+|\/+$/g, '');
  const path = folderToKeyPath(folder);
  return path ? `${prefix}/${path}/${safe}` : `${prefix}/${safe}`;
}

/** True if an object with this key already exists in the bucket. */
export async function s3ObjectExists(cfg, key) {
  if (!s3Ready(cfg) || !key) return false;
  let S3Client, HeadObjectCommand;
  try { ({ S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3')); } catch { return false; }
  const client = new S3Client(s3ClientOpts(cfg));
  try { await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: key })); return true; }
  catch { return false; }
}

/** Make a key collision-free by appending " (2)", " (3)", … before the extension. */
export async function s3UniqueKey(cfg, key) {
  if (!(await s3ObjectExists(cfg, key))) return key;
  const slash = key.lastIndexOf('/');
  const dir = key.slice(0, slash + 1), base = key.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 2; i < 50; i++) {
    const cand = `${dir}${stem} (${i})${ext}`;
    if (!(await s3ObjectExists(cfg, cand))) return cand;
  }
  return `${dir}${stem} (${Date.now()})${ext}`;
}

/**
 * Presign a PUT for the custom S3 bucket. Returns { putUrl, publicUrl, key, name }.
 * `name` is the final (deduped) basename — store it so the catalog name matches
 * what the mounted drive shows. Throws a friendly error if misconfigured.
 */
export async function s3PresignPut(cfg, { filename, contentType, folder }) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  let S3Client, PutObjectCommand, getSignedUrl;
  try {
    ({ S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3'));
    ({ getSignedUrl } = await import('@aws-sdk/s3-request-presigner'));
  } catch {
    throw new Error('The S3 SDK isn’t installed on the server yet — redeploy (package.json includes @aws-sdk/client-s3) to enable custom buckets.');
  }
  const client = new S3Client(s3ClientOpts(cfg));
  const key = await s3UniqueKey(cfg, buildObjectKey(cfg, filename, folder));
  const name = key.slice(key.lastIndexOf('/') + 1);
  const cmd = new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType || 'application/octet-stream' });
  const putUrl = await getSignedUrl(client, cmd, { expiresIn: 600 });
  return { putUrl, publicUrl: publicUrlForKey(cfg, key), key, name };
}

/**
 * Write a zero-byte "folder marker" object (`<prefix>/<folder>/`) — the
 * convention rclone and the AWS console use to show an *empty* folder. Without
 * this, a folder created in Onyx that has no files yet is invisible to a
 * mounted drive (S3 has no real directories). Best-effort: returns false if S3
 * isn't ready or the path is empty rather than throwing.
 */
export async function s3PutFolderMarker(cfg, folder) {
  if (!s3Ready(cfg)) return false;
  const path = folderToKeyPath(folder);
  if (!path) return false;
  let S3Client, PutObjectCommand;
  try { ({ S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3')); }
  catch { return false; }
  const prefix = (cfg.prefix || 'files').replace(/^\/+|\/+$/g, '');
  const key = `${prefix}/${path}/`;
  const client = new S3Client(s3ClientOpts(cfg));
  await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: '', ContentLength: 0 }));
  return key;
}

/** Delete one object. Best-effort: returns false if S3 isn't ready / no key. */
export async function s3DeleteObject(cfg, key) {
  if (!s3Ready(cfg) || !key) return false;
  let S3Client, DeleteObjectCommand;
  try { ({ S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3')); }
  catch { return false; }
  const client = new S3Client(s3ClientOpts(cfg));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
  return true;
}

/**
 * Move an object within the bucket (S3 has no rename): server-side CopyObject
 * then delete the source. Used to move a file into the trash prefix (and back
 * on restore). Uses the admin/master creds, which aren't scoped to a single
 * prefix, so it can move objects out of a mounted filespace's view.
 */
export async function s3MoveObject(cfg, fromKey, toKey) {
  if (!s3Ready(cfg) || !fromKey || !toKey || fromKey === toKey) return false;
  let S3Client, CopyObjectCommand, DeleteObjectCommand;
  try { ({ S3Client, CopyObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3')); }
  catch { return false; }
  const client = new S3Client(s3ClientOpts(cfg));
  await client.send(new CopyObjectCommand({
    Bucket: cfg.bucket,
    CopySource: `/${cfg.bucket}/${encodeURIComponent(fromKey).replace(/%2F/g, '/')}`,
    Key: toKey,
  }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: fromKey }));
  return true;
}

/** Lightweight connection check — presign a throwaway key. */
export async function s3TestConnection(cfg) {
  await s3PresignPut(cfg, { filename: '__connection_test__.txt', contentType: 'text/plain' });
  return true;
}

/**
 * Time-limited presigned GET for a private object. The read-side twin of
 * s3PresignPut: with Block Public Access on (the safe default), the stored
 * public-style URL returns AccessDenied — previews must use signed URLs.
 */
export async function s3PresignGet(cfg, key, { expiresIn = 3600, client = null, download = false, filename = null } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  let S3Client, GetObjectCommand, getSignedUrl;
  try {
    ({ S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3'));
    ({ getSignedUrl } = await import('@aws-sdk/s3-request-presigner'));
  } catch {
    throw new Error('The S3 SDK isn’t installed on the server yet — redeploy to enable this.');
  }
  const c = client || new S3Client(s3ClientOpts(cfg));
  // download:true → S3 returns Content-Disposition: attachment so the browser
  // saves the file directly instead of navigating to it.
  const cmdOpts = { Bucket: cfg.bucket, Key: key };
  if (download) {
    const safe = String(filename || key.slice(key.lastIndexOf('/') + 1)).replace(/["\\]/g, '');
    cmdOpts.ResponseContentDisposition = `attachment; filename="${safe}"`;
  }
  return getSignedUrl(c, new GetObjectCommand(cmdOpts), { expiresIn });
}

/**
 * Swap stored public-style URLs for presigned GETs on S3-backed files, so the
 * Library previews/downloads work against a PRIVATE bucket. One chokepoint —
 * call on any file list before returning it to the browser. No-ops for Blob
 * files, when a CDN (publicBaseUrl) fronts the bucket, or on any error
 * (callers still get the original list). Presigning is local HMAC math — no
 * network round-trips, cheap even for hundreds of rows.
 */
export async function presignFileUrls(files, { expiresIn } = {}) {
  try {
    if (!Array.isArray(files) || files.length === 0) return files;
    const cfg = await getStorageConfig();
    if (!s3Ready(cfg) || cfg.publicBaseUrl) return files;
    const s3Files = files.filter((f) => f?.storage === 's3');
    if (s3Files.length === 0) return files;
    const { S3Client } = await import('@aws-sdk/client-s3');
    const client = new S3Client(s3ClientOpts(cfg));
    return await Promise.all(files.map(async (f) => {
      if (!f || f.storage !== 's3') return f;
      // Prefer the stored key; older records may lack it, so recover it from
      // the stored public-style URL so they presign too.
      const key = f.storageKey || keyFromUrl(cfg, f.url);
      const out = { ...f };
      if (key) { try { out.url = await s3PresignGet(cfg, key, { client, ...(expiresIn ? { expiresIn } : {}) }); } catch {} }
      // Sign the small grid thumbnail too (so the private bucket serves it).
      const tkey = f.thumbnailKey || (f.thumbnailUrl ? keyFromUrl(cfg, f.thumbnailUrl) : null);
      if (tkey) { try { out.thumbnailUrl = await s3PresignGet(cfg, tkey, { client }); } catch {} }
      return out;
    }));
  } catch {
    return files;
  }
}

/**
 * Presign a single stored S3 URL (recovers the key and signs a time-limited
 * GET). Returns the original URL unchanged for non-S3 storage, when no bucket
 * is configured, when a CDN fronts the bucket, or on any error. Used to make a
 * private-bucket video playable on a Cue review page minted from a Space file.
 */
export async function presignS3Url(url, { expiresIn = 21600 } = {}) {
  try {
    if (!url) return url;
    const cfg = await getStorageConfig();
    if (!s3Ready(cfg) || cfg.publicBaseUrl) return url;
    const key = keyFromUrl(cfg, url);
    if (!key) return url;
    return await s3PresignGet(cfg, key, { expiresIn });
  } catch { return url; }
}

/**
 * Is this object key one of our generated thumbnails living under the dedicated
 * `_thumbs/` prefix? (Legacy thumbnails scattered next to files are detected
 * precisely instead — by matching keys referenced as a file's thumbnail_key —
 * to avoid mistaking a real file named "thumb-*.jpg" for a thumbnail.)
 */
/** OS junk that shouldn't be catalogued as a file (macOS/Windows write these). */
export function isSystemKey(key) {
  if (!key) return false;
  const base = String(key).slice(String(key).lastIndexOf('/') + 1);
  return base === '.DS_Store' || base === '.localized' || base === 'Thumbs.db' || base === 'desktop.ini' || base.startsWith('._');
}

export function isThumbnailKey(key) {
  if (!key) return false;
  const k = String(key);
  if (k.startsWith('_thumbs/') || k.includes('/_thumbs/')) return true;
  // Legacy thumbnails were named `<rand>-thumb-<name>.<img>` next to files. The
  // `-thumb-` infix is ours (a real upload would be `<rand>-<original>`; only a
  // file literally named "thumb-*.ext" collides, which is acceptably rare).
  const base = k.slice(k.lastIndexOf('/') + 1);
  return /-thumb-[^/]*\.(jpe?g|png|webp)$/i.test(base);
}

/**
 * Derive a storage config scoped to a filespace: same admin keys, but the
 * filespace's bucket/prefix/region. Lets the web Space read/write a specific
 * filespace's slice of the bucket — the same slice the desktop app mounts — so
 * the two stay in sync without hand-managing a global prefix. Keys stay the
 * master keys (full-bucket), which work for any prefix in the same bucket.
 */
export function cfgForFilespace(cfg, fs) {
  if (!fs) return cfg;
  const out = {
    ...cfg,
    bucket: fs.bucket || cfg.bucket,
    region: fs.region || cfg.region,
    prefix: String(fs.prefix || '').replace(/^\/+|\/+$/g, ''),
  };
  // If the filespace carries its OWN bucket keys, use them (a separate bucket
  // with a different key pair / endpoint than the global Storage config). The
  // key itself scopes access, so we drop the role-assume path for this scope.
  if (fs.accessKeyId && fs.secretAccessKey) {
    out.provider = 's3';
    out.accessKeyId = fs.accessKeyId;
    out.secretAccessKey = fs.secretAccessKey;
    out.endpoint = fs.endpoint || '';
    out.accelerate = fs.endpoint ? false : out.accelerate;
    out.roleArn = '';
  }
  return out;
}

/** Inverse of publicUrlForKey — recover the object key from a stored URL. */
function keyFromUrl(cfg, url) {
  try {
    const u = new URL(url);
    let path = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
    // Path-style (custom endpoint): strip the leading "<bucket>/".
    if (cfg.endpoint && cfg.bucket && path.startsWith(cfg.bucket + '/')) {
      path = path.slice(cfg.bucket.length + 1);
    }
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Set the bucket's CORS rule so the browser's direct presigned PUT works —
 * the fix for the classic "Failed to fetch" on upload. Onyx holds the keys
 * server-side, so admins can repair their own bucket with one click instead
 * of needing AWS console/CLI access. Requires s3:PutBucketCors on the key.
 */
export async function s3PutBucketCors(cfg, { origins } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  let S3Client, PutBucketCorsCommand;
  try { ({ S3Client, PutBucketCorsCommand } = await import('@aws-sdk/client-s3')); }
  catch { throw new Error('The S3 SDK isn’t installed on the server yet — redeploy to enable this.'); }
  const client = new S3Client({
    region: cfg.region || 'auto', endpoint: cfg.endpoint || undefined, forcePathStyle: !!cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const allowedOrigins = (origins && origins.length ? origins : ['https://onyxfs.io']).filter(Boolean);
  await client.send(new PutBucketCorsCommand({
    Bucket: cfg.bucket,
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: allowedOrigins,
        AllowedMethods: ['PUT', 'GET', 'HEAD', 'POST'],
        AllowedHeaders: ['*'],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3000,
      }],
    },
  }));
  return { origins: allowedOrigins };
}

/**
 * List objects in the bucket (under the configured prefix). Lets the library show
 * files that were dropped in via a mounted drive / Finder, not just app uploads.
 * Returns [{ key, size, lastModified, url }]. Capped to `max`.
 */
export async function s3ListObjects(cfg, { max = 2000, prefix: prefixOverride } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t configured.');
  let S3Client, ListObjectsV2Command;
  try { ({ S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')); }
  catch { throw new Error('The S3 SDK isn’t installed on the server yet — redeploy to enable bucket sync.'); }
  const client = new S3Client({
    region: cfg.region || 'auto', endpoint: cfg.endpoint || undefined, forcePathStyle: !!cfg.endpoint,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  // A per-filespace prefix override lets the same helper browse a single
  // filespace scope; defaults to the global configured prefix (back-compat).
  const prefix = (prefixOverride != null ? String(prefixOverride) : (cfg.prefix || '')).replace(/^\/+|\/+$/g, '');
  const out = [];
  let token;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: cfg.bucket, Prefix: prefix ? `${prefix}/` : undefined, ContinuationToken: token, MaxKeys: 1000,
    }));
    for (const o of res.Contents || []) {
      if (o.Key && !o.Key.endsWith('/')) out.push({ key: o.Key, size: Number(o.Size) || 0, lastModified: o.LastModified ? new Date(o.LastModified).getTime() : null, url: publicUrlForKey(cfg, o.Key) });
    }
    token = res.IsTruncated ? res.NextContinuationToken : null;
  } while (token && out.length < max);
  return out;
}

/**
 * List folder MARKERS (`<prefix>/<folder>/` zero-byte objects) under a prefix —
 * the empty folders that don't otherwise surface (s3ListObjects skips them).
 * Returns folder paths relative to the prefix. `{ keys: true }` returns the raw
 * marker object keys instead (for deletion).
 */
export async function s3ListFolderMarkers(cfg, { prefix: prefixOverride, under = '', keys = false } = {}) {
  if (!s3Ready(cfg)) return [];
  let S3Client, ListObjectsV2Command;
  try { ({ S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3')); } catch { return []; }
  const client = new S3Client(s3ClientOpts(cfg));
  const prefix = (prefixOverride != null ? String(prefixOverride) : (cfg.prefix || '')).replace(/^\/+|\/+$/g, '');
  const sub = String(under || '').replace(/^\/+|\/+$/g, '');
  const scan = [prefix, sub].filter(Boolean).join('/');
  const listPrefix = scan ? `${scan}/` : undefined;
  const out = [];
  let token;
  try {
    do {
      const res = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: listPrefix, ContinuationToken: token, MaxKeys: 1000 }));
      for (const o of res.Contents || []) {
        if (!o.Key || !o.Key.endsWith('/')) continue;
        if (keys) { out.push(o.Key); continue; }
        let rel = o.Key.replace(/\/+$/, '');
        if (prefix && rel.startsWith(prefix + '/')) rel = rel.slice(prefix.length + 1);
        else if (prefix && rel === prefix) continue;
        if (rel) out.push(rel);
      }
      token = res.IsTruncated ? res.NextContinuationToken : null;
    } while (token && out.length < 4000);
  } catch { /* best-effort */ }
  return out;
}

/**
 * Build the inline IAM session policy that NARROWS an AssumeRole call to a
 * single bucket+prefix. The role's own (broad) policy is intersected with this
 * at the AWS side, so the resulting temp creds can touch nothing else.
 *
 *  - ListBucket is granted on the bucket ARN but conditioned on s3:prefix so a
 *    listing only sees keys under "<prefix>/*". The "/*" glob (not equals) is
 *    required or rclone/FUSE directory listings 403.
 *  - Object actions are scoped by the object ARN "<bucket>/<prefix>/*".
 *  - 'viewer' role drops the write actions (read-only mount).
 */
export function buildFilespaceSessionPolicy({ bucket, prefix, role = 'viewer' }) {
  const p = String(prefix || '').replace(/^\/+|\/+$/g, '');
  // Multipart actions are REQUIRED for large/video uploads via rclone — without
  // AbortMultipartUpload a failed part can't be cleaned up and rclone gets stuck
  // retrying (the desktop drive's transfer indicator spins forever). NOTE: STS
  // can only narrow, never exceed, the underlying IAM role — the role/key behind
  // these creds must also grant these write + multipart actions.
  const objectActions = role === 'viewer'
    ? ['s3:GetObject']
    : ['s3:GetObject', 's3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:ListMultipartUploadParts'];
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ListWithinPrefix',
        Effect: 'Allow',
        Action: ['s3:ListBucket'],
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: { StringLike: { 's3:prefix': [`${p}/*`, `${p}`] } },
      },
      {
        // Own statement — the s3:prefix context key doesn't exist on a
        // GetBucketLocation request, so bundling it under the condition above
        // silently denies it. It leaks nothing (returns only the region).
        Sid: 'BucketLocation',
        Effect: 'Allow',
        Action: ['s3:GetBucketLocation'],
        Resource: `arn:aws:s3:::${bucket}`,
      },
      {
        Sid: 'ObjectsWithinPrefix',
        Effect: 'Allow',
        Action: objectActions,
        Resource: `arn:aws:s3:::${bucket}/${p}/*`,
      },
      // Listing in-progress multipart uploads is a bucket-level action (no
      // s3:prefix scoping available) — editors/owners only.
      ...(role === 'viewer' ? [] : [{
        Sid: 'MultipartUploads',
        Effect: 'Allow',
        Action: ['s3:ListBucketMultipartUploads'],
        Resource: `arn:aws:s3:::${bucket}`,
      }]),
    ],
  };
}

/**
 * Mint short-lived, prefix-scoped AWS credentials for a filespace via STS
 * AssumeRole + an inline session policy. The desktop app feeds the returned
 * creds (incl. sessionToken) to rclone for a FUSE mount and to the aws-sdk
 * file browser. Onyx never sees the file bytes — only issues the credentials.
 *
 * Requires real AWS S3 (rejects custom endpoints — R2/MinIO/Spaces/B2 don't
 * support this STS flow; those degrade to the presigned/master-key installer)
 * and a configured roleArn (global cfg.roleArn, or a per-filespace override).
 *
 * @returns {accessKeyId, secretAccessKey, sessionToken, expiration(epoch-ms),
 *           bucket, prefix, region, remotePath}
 */
export async function s3AssumeRoleForFilespace(cfg, filespace, { role = 'viewer', sessionName, durationSeconds = 3600 } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  if (cfg.endpoint) throw new Error('Scoped credentials need AWS S3 (custom endpoints like R2/MinIO/Spaces aren’t supported for STS).');
  const roleArn = (filespace && filespace.roleArn) || cfg.roleArn;
  if (!roleArn) throw new Error('No IAM role ARN configured. Set storage.config.roleArn in Admin → Storage.');
  const bucket = (filespace && filespace.bucket) || cfg.bucket;
  const prefix = String((filespace && filespace.prefix) || '').replace(/^\/+|\/+$/g, '');
  if (!bucket) throw new Error('Filespace has no bucket.');
  if (!prefix) throw new Error('Filespace has no prefix — refusing to mint bucket-wide credentials.');

  const { STSClient, AssumeRoleCommand } = await loadStsSdk();

  const region = (filespace && filespace.region) || cfg.region || 'us-east-1';
  const client = new STSClient({
    region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const duration = Math.max(900, Math.min(3600, Number(durationSeconds) || 3600));
  const policy = buildFilespaceSessionPolicy({ bucket, prefix, role });
  // Session name must be ≤64 chars, [\w+=,.@-]. Derive from the filespace id.
  const rawName = `onyxfs-${(filespace && filespace.id) || 'fs'}`;
  const RoleSessionName = (sessionName || rawName).replace(/[^\w+=,.@-]/g, '-').slice(0, 64);

  const res = await client.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName,
    DurationSeconds: duration,
    ExternalId: STS_EXTERNAL_ID,
    Policy: JSON.stringify(policy),
  }));
  const c = res.Credentials;
  if (!c) throw new Error('STS returned no credentials.');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration ? new Date(c.Expiration).getTime() : (Date.now() + duration * 1000),
    bucket,
    prefix,
    region,
    remotePath: `${bucket}/${prefix}`,
    mode: 'assume-role',
  };
}

async function loadStsSdk() {
  try { return await import('@aws-sdk/client-sts'); }
  catch {
    // Fallback path: some @aws-sdk versions expose STS via nested-clients.
    try { return await import('@aws-sdk/nested-clients/sts'); }
    catch { throw new Error('The AWS STS SDK isn’t installed on the server yet — redeploy (package.json includes @aws-sdk/client-sts) to enable scoped mounts.'); }
  }
}

function filespaceScope(cfg, filespace) {
  const bucket = (filespace && filespace.bucket) || cfg.bucket;
  const prefix = String((filespace && filespace.prefix) || '').replace(/^\/+|\/+$/g, '');
  if (!bucket) throw new Error('Filespace has no bucket.');
  if (!prefix) throw new Error('Filespace has no prefix — refusing to mint bucket-wide credentials.');
  const region = (filespace && filespace.region) || cfg.region || 'us-east-1';
  return { bucket, prefix, region };
}

/**
 * Mint scoped temporary credentials via STS GetFederationToken — same inline
 * session policy as AssumeRole, but needs NO IAM role: just the configured
 * access key itself, provided that key is allowed sts:GetFederationToken.
 * The federated creds are the INTERSECTION of the key's own permissions and
 * the session policy, so they can't exceed the prefix scope.
 */
export async function s3FederationTokenForFilespace(cfg, filespace, { role = 'viewer', durationSeconds = 3600 } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  if (cfg.endpoint) throw new Error('Scoped credentials need AWS S3.');
  const { bucket, prefix, region } = filespaceScope(cfg, filespace);
  const { STSClient, GetFederationTokenCommand } = await loadStsSdk();

  const client = new STSClient({
    region,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  const duration = Math.max(900, Math.min(3600, Number(durationSeconds) || 3600));
  const policy = buildFilespaceSessionPolicy({ bucket, prefix, role });
  // Federation Name is ≤32 chars, [\w+=,.@-].
  const Name = `space-${(filespace && filespace.id) || 'fs'}`.replace(/[^\w+=,.@-]/g, '-').slice(0, 32);

  const res = await client.send(new GetFederationTokenCommand({
    Name,
    DurationSeconds: duration,
    Policy: JSON.stringify(policy),
  }));
  const c = res.Credentials;
  if (!c) throw new Error('STS returned no credentials.');
  return {
    accessKeyId: c.AccessKeyId,
    secretAccessKey: c.SecretAccessKey,
    sessionToken: c.SessionToken,
    expiration: c.Expiration ? new Date(c.Expiration).getTime() : (Date.now() + duration * 1000),
    bucket,
    prefix,
    region,
    remotePath: `${bucket}/${prefix}`,
    mode: 'federation',
  };
}

/**
 * Last-resort mode: hand back the configured static key, scoped only by the
 * mount target (bucket/prefix), not by IAM. Used when the key can't call STS
 * at all, and for non-AWS endpoints (R2/MinIO/Spaces — no STS there). The
 * desktop additionally mounts read-only for viewers.
 */
export function s3StaticCredsForFilespace(cfg, filespace) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  const { bucket, prefix, region } = filespaceScope(cfg, filespace);
  return {
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    sessionToken: null,
    expiration: null,
    bucket,
    prefix,
    region,
    remotePath: `${bucket}/${prefix}`,
    mode: 'static',
  };
}

// ─── Backblaze B2: scoped credentials without STS ───────────────────────────
//
// B2 has no STS, which is why every non-AWS provider used to fall straight to
// the static key and viewers were refused outright. But B2's native API has
// b2_create_key, which mints an application key restricted to one bucket, one
// name prefix, and a lifetime — the same three guarantees AssumeRole gives.
// The resulting key works against B2's S3-compatible endpoint, so nothing
// downstream (presigning, multipart, rclone) has to know where it came from.
//
// Two differences from STS worth knowing:
//
//   - There is no session token. A B2 application key is a real key pair, so
//     the credential we hand out is { accessKeyId, secretAccessKey } with
//     sessionToken null. SigV4 works the same way.
//   - The key is a persistent object until it expires. B2 removes expired
//     keys itself, which is why the duration is always set and capped well
//     below B2's 1000-day maximum — an unbounded key here would accumulate
//     one row per mount, forever.

const B2_API = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';
// An hour by default, a day at most. Long enough that a desktop mount is not
// constantly re-minting, short enough that a leaked key is not interesting.
const B2_MAX_KEY_SECONDS = 24 * 60 * 60;

/**
 * The capabilities a role gets, and the b2_create_key request body.
 *
 * Pure, and separated from the HTTP for the same reason credentialPlan is
 * separated from mintFilespaceCredentials: this is the part where a mistake
 * is silent. A viewer's key that carries writeFiles is not an error anyone
 * sees — it just quietly works, with more authority than intended.
 */
export function b2KeyRequest({ accountId, bucketId, prefix, role = 'viewer', filespaceId = 'fs', durationSeconds = 3600 }) {
  if (!accountId) throw new Error('B2: no account id.');
  if (!bucketId) throw new Error('B2: no bucket id.');
  // A key with no prefix is a key to the whole bucket. Refuse rather than
  // widen — the same rule filespaceScope applies to every other rung.
  const namePrefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
  if (!namePrefix) throw new Error('B2: refusing to mint a key with no prefix.');

  // listBuckets is required for the S3-compatible API to resolve the bucket
  // at all; it does not grant access to any other bucket, because bucketId
  // restricts the key to one.
  const read = ['listBuckets', 'listFiles', 'readFiles', 'shareFiles'];
  const write = ['writeFiles', 'deleteFiles'];
  const capabilities = role === 'viewer' ? read : [...read, ...write];

  return {
    accountId,
    capabilities,
    // Letters, digits and dashes only, 100 characters max.
    keyName: `onyx-${filespaceId}-${role}-${Date.now()}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 100),
    validDurationInSeconds: Math.max(900, Math.min(B2_MAX_KEY_SECONDS, Number(durationSeconds) || 3600)),
    bucketId,
    namePrefix: `${namePrefix}/`,
  };
}

async function b2Fetch(url, { token, body } = {}) {
  const res = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: token,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep the raw text */ }
  if (!res.ok) {
    const detail = json?.message || json?.code || text.slice(0, 200) || res.statusText;
    throw new Error(`B2 ${new URL(url).pathname.split('/').pop()} failed (${res.status}): ${detail}`);
  }
  return json;
}

/** Authorize, resolve the bucket id, mint a prefix-scoped expiring key. */
export async function b2ScopedKeyForFilespace(cfg, filespace, { role = 'viewer', durationSeconds = 3600 } = {}) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  const { bucket, prefix } = filespaceScope(cfg, filespace);
  const region = b2RegionFromEndpoint(cfg.endpoint) || cfg.region || 'us-west-004';

  const basic = Buffer.from(`${cfg.accessKeyId}:${cfg.secretAccessKey}`).toString('base64');
  const auth = await b2Fetch(B2_API, { token: `Basic ${basic}` });
  const apiUrl = auth?.apiInfo?.storageApi?.apiUrl || auth?.apiUrl;
  const token = auth?.authorizationToken;
  const accountId = auth?.accountId;
  if (!apiUrl || !token) throw new Error('B2 authorize returned no API url or token.');

  const buckets = await b2Fetch(`${apiUrl}/b2api/v3/b2_list_buckets`, {
    token,
    body: { accountId, bucketName: bucket },
  });
  const bucketId = buckets?.buckets?.[0]?.bucketId;
  if (!bucketId) throw new Error(`B2: bucket "${bucket}" not found for this key.`);

  const request = b2KeyRequest({ accountId, bucketId, prefix, role, filespaceId: filespace && filespace.id, durationSeconds });
  const key = await b2Fetch(`${apiUrl}/b2api/v3/b2_create_key`, { token, body: request });
  if (!key?.applicationKeyId || !key?.applicationKey) throw new Error('B2 create_key returned no key.');

  return {
    accessKeyId: key.applicationKeyId,
    secretAccessKey: key.applicationKey,
    sessionToken: null,
    expiration: key.expirationTimestamp
      ? Number(key.expirationTimestamp)
      : Date.now() + request.validDurationInSeconds * 1000,
    bucket,
    prefix,
    region,
    remotePath: `${bucket}/${prefix}`,
    mode: 'b2-native',
  };
}

/**
 * The credential ladder for a filespace mount — uses the strongest mechanism
 * the configuration supports, so setup works with nothing but a key + secret:
 *   1. roleArn configured        → STS AssumeRole (ExternalId + session policy)
 *   2. no roleArn                → STS GetFederationToken (session policy, no role needed)
 *   3. key can't call STS at all → static key, prefix-scoped at the mount only
 *   (custom endpoint            → static; R2/MinIO/Spaces have no STS)
 */
/**
 * Which rung of the credential ladder applies, as a pure decision.
 *
 * Extracted from mintFilespaceCredentials so the rule that decides how much
 * authority to hand out can be tested without an AWS account. Returns
 * { strategy, staticAllowed }:
 *
 *   'filespace-static'  the filespace carries its own dedicated key
 *   'assume-role'       a role ARN is configured — scoped and expiring
 *   'federation'        GetFederationToken — scoped and expiring
 *   'b2-native'         Backblaze b2_create_key — scoped and expiring
 *   'static'            the deployment's own key, unscoped and non-expiring
 *
 * `staticAllowed` says whether falling back to 'static' is permitted for this
 * role. It is false for viewers, and that is the important part: a static key
 * cannot be scoped or expired by IAM, so handing one to someone granted
 * read-only access would silently give them write access to the whole bucket.
 * Refusing with an actionable error is the correct outcome, not a degraded one.
 */
export function credentialPlan(cfg, filespace, { role = 'viewer' } = {}) {
  const staticAllowed = role !== 'viewer';
  const provider = storageProvider(cfg);

  // A per-filespace key is already scoped to its bucket by provisioning, so
  // every granted role may use it — it cannot be narrowed further by STS.
  if (filespace && filespace.accessKeyId && filespace.secretAccessKey) {
    return { strategy: 'filespace-static', staticAllowed: true };
  }

  // Backblaze B2 has no STS, but it has something equivalent: b2_create_key
  // mints an application key restricted to a bucket and a name prefix, with
  // its own expiry. That is the same guarantee AssumeRole gives us, so a
  // viewer on B2 gets a real scoped credential rather than a refusal.
  //
  // `staticAllowed` still follows the viewer rule. It is the fallback when
  // minting fails — usually because the configured key lacks the writeKeys
  // capability — and an editor may degrade to the master key where a viewer
  // may not.
  if (provider === 'b2') return { strategy: 'b2-native', staticAllowed };

  // R2, MinIO, Spaces and friends: no STS and no native equivalent wired up
  // here, so static is the only rung. (R2 does have a temporary-credentials
  // API; adding it is the same shape as the B2 rung above.)
  if (cfg && cfg.endpoint) return { strategy: 'static', staticAllowed };

  const roleArn = (filespace && filespace.roleArn) || (cfg && cfg.roleArn);
  // An explicitly configured role is a deliberate choice: fail loudly rather
  // than quietly degrading to a broader credential than the admin asked for.
  if (roleArn) return { strategy: 'assume-role', staticAllowed: false };

  return { strategy: 'federation', staticAllowed };
}

/**
 * The error a viewer gets when only an unscopable credential is available.
 *
 * Provider-specific, because the fix is: on AWS it is an IAM permission, on
 * B2 it is a key capability, and elsewhere there is nothing to grant. A
 * message naming sts:GetFederationToken to a B2 admin sends them looking for
 * a setting that does not exist.
 */
export function staticRefusalMessage(cfg) {
  const provider = storageProvider(cfg);
  if (provider === 'b2') {
    return 'This deployment\u2019s B2 key can\u2019t mint read-only keys (it lacks the writeKeys capability). Ask an admin for a key with writeKeys, or for editor access.';
  }
  if (provider !== 'aws') {
    return 'This storage provider can\u2019t mint read-only credentials, so read-only mounting isn\u2019t available on it. Ask an admin for editor access, or for a filespace with its own key.';
  }
  return 'This deployment\u2019s access key can\u2019t mint read-only credentials (no STS access). Ask an admin to allow sts:GetFederationToken on the key, or grant you editor access.';
}

export async function mintFilespaceCredentials(cfg, filespace, opts = {}) {
  const role = opts.role || 'viewer';
  const { strategy, staticAllowed } = credentialPlan(cfg, filespace, { role });

  const staticOrRefuse = () => {
    if (!staticAllowed) throw new Error(staticRefusalMessage(cfg));
    return s3StaticCredsForFilespace(cfg, filespace);
  };

  if (strategy === 'filespace-static') {
    return s3StaticCredsForFilespace(cfgForFilespace(cfg, filespace), filespace);
  }
  if (strategy === 'static') return staticOrRefuse();
  if (strategy === 'assume-role') return s3AssumeRoleForFilespace(cfg, filespace, opts);

  if (strategy === 'b2-native') {
    try {
      return await b2ScopedKeyForFilespace(cfg, filespace, opts);
    } catch (e) {
      // Same shape as the federation fallback below: a key that simply is not
      // allowed to mint keys degrades (role-gated), anything else surfaces.
      // Guessing wrong here in the permissive direction would hand a viewer
      // the master key, so the match has to be narrow.
      if (/writeKeys|unauthorized|not authorized|401|403/i.test(String(e?.message || ''))) {
        console.warn('[mintFilespaceCredentials] B2 key minting denied — static fallback (role-gated):', e.message);
        return staticOrRefuse();
      }
      throw e;
    }
  }

  try {
    return await s3FederationTokenForFilespace(cfg, filespace, opts);
  } catch (e) {
    const text = `${e?.name || ''} ${e?.Code || ''} ${e?.message || ''}`;
    // The key is valid but lacks sts:GetFederationToken → degrade, role-gated.
    // Anything else (bad key, signature mismatch, network) must surface.
    if (/AccessDenied|not authorized/i.test(text)) {
      console.warn('[mintFilespaceCredentials] GetFederationToken denied \u2014 static fallback (role-gated):', e?.message);
      return staticOrRefuse();
    }
    throw e;
  }
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return '90,107,31';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}
function rcloneProvider(cfg) {
  const e = (cfg.endpoint || '').toLowerCase();
  if (!cfg.endpoint) return 'AWS';
  if (e.includes('r2.cloudflarestorage')) return 'Cloudflare';
  if (e.includes('backblazeb2')) return 'Backblaze';
  if (e.includes('digitaloceanspaces')) return 'DigitalOcean';
  if (e.includes('wasabisys')) return 'Wasabi';
  return 'Other';
}

/**
 * Generate a branded, double-clickable macOS installer (`.command`) that mounts
 * the bucket as a local drive via rclone + macFUSE, and auto-mounts on login.
 * Personalized with the deployment's brand name + accent and the bucket config.
 *
 * This is the FALLBACK path, for people who aren't running the Onyx desktop
 * app: it needs Homebrew and macFUSE, which means a kernel extension approval
 * and usually a reboot. The desktop app mounts the same bucket through
 * `rclone nfsmount` against macOS's built-in NFS client instead — no macFUSE,
 * no reboot — and should be preferred wherever it can be installed.
 */
export function buildMountInstaller(cfg, brand = {}) {
  const name = (brand.name || 'Onyx').replace(/"/g, '');
  const slug = (name.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'onyx');
  const rgb = hexToRgb(brand.accent);
  const remote = `${slug}fs`;
  const provider = rcloneProvider(cfg);
  const v = {
    BRAND: name, REMOTE: remote, BUCKET: cfg.bucket || '', PREFIX: (cfg.prefix || '').replace(/^\/+|\/+$/g, ''),
    ACCESS_KEY: cfg.accessKeyId || '', SECRET_KEY: cfg.secretAccessKey || '', ENDPOINT: cfg.endpoint || '',
    REGION: cfg.region || (provider === 'AWS' ? 'us-east-1' : 'auto'), PROVIDER: provider,
  };
  const L = [];
  const p = (s) => L.push(s);
  p('#!/bin/bash');
  p('# ' + name + ' — mount your filespace as a drive on this Mac.');
  p('# Generated by ' + name + '. Double-click to run.');
  p('set -e');
  p('');
  p('BRAND="' + v.BRAND + '"');
  p('REMOTE="' + v.REMOTE + '"');
  p('BUCKET="' + v.BUCKET + '"');
  p('PREFIX="' + v.PREFIX + '"');
  p('ACCESS_KEY="' + v.ACCESS_KEY + '"');
  p('SECRET_KEY="' + v.SECRET_KEY + '"');
  p('ENDPOINT="' + v.ENDPOINT + '"');
  p('REGION="' + v.REGION + '"');
  p('PROVIDER="' + v.PROVIDER + '"');
  p('MOUNT="$HOME/$BRAND"');
  p('C="\\033[38;2;' + rgb + 'm"; N="\\033[0m"; B="\\033[1m"');
  p('');
  p('printf "\\n${C}${B}  ◆ %s${N}\\n" "$BRAND"');
  p('printf "${C}  Mounting your shared storage…${N}\\n\\n"');
  p('');
  p('# 1) Homebrew');
  p('if ! command -v brew >/dev/null 2>&1; then');
  p('  echo "→ Installing Homebrew (you may be asked for your password)…"');
  p('  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"');
  p('  eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"');
  p('fi');
  p('');
  p('# 2) rclone (mount engine) + macFUSE (filesystem)');
  p('command -v rclone >/dev/null 2>&1 || { echo "→ Installing rclone…"; brew install rclone; }');
  p('if ! brew list --cask macfuse >/dev/null 2>&1; then');
  p('  echo "→ Installing macFUSE…"; brew install --cask macfuse || true');
  p('  echo "${C}ACTION NEEDED:${N} Open System Settings → Privacy & Security, click \\"Allow\\" for macFUSE, reboot if asked, then run this installer again."');
  p('fi');
  p('');
  p('# 3) Write the rclone remote');
  p('mkdir -p "$HOME/.config/rclone"');
  p('CONF="$HOME/.config/rclone/rclone.conf"');
  p('touch "$CONF"');
  p('if ! grep -q "^\\[$REMOTE\\]" "$CONF"; then');
  p('  {');
  p('    echo "[$REMOTE]";');
  p('    echo "type = s3";');
  p('    echo "provider = $PROVIDER";');
  p('    echo "access_key_id = $ACCESS_KEY";');
  p('    echo "secret_access_key = $SECRET_KEY";');
  p('    [ -n "$ENDPOINT" ] && echo "endpoint = $ENDPOINT";');
  p('    [ -n "$REGION" ] && echo "region = $REGION";');
  p('  } >> "$CONF"');
  p('  echo "→ Saved the $BRAND remote."');
  p('fi');
  p('');
  p('# 4) Mount point + path');
  p('mkdir -p "$MOUNT"');
  p('REMOTE_PATH="$REMOTE:$BUCKET"');
  p('[ -n "$PREFIX" ] && REMOTE_PATH="$REMOTE:$BUCKET/$PREFIX"');
  p('');
  p('# 5) Auto-mount on login via a LaunchAgent');
  p('PLIST="$HOME/Library/LaunchAgents/com.$REMOTE.mount.plist"');
  p('RCLONE_BIN="$(command -v rclone)"');
  p('cat > "$PLIST" <<PLISTEOF');
  p('<?xml version="1.0" encoding="UTF-8"?>');
  p('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">');
  p('<plist version="1.0"><dict>');
  p('  <key>Label</key><string>com.$REMOTE.mount</string>');
  p('  <key>ProgramArguments</key><array>');
  p('    <string>$RCLONE_BIN</string><string>mount</string>');
  p('    <string>$REMOTE_PATH</string><string>$MOUNT</string>');
  p('    <string>--vfs-cache-mode</string><string>full</string>');
  p('    <string>--volname</string><string>$BRAND</string>');
  p('  </array>');
  p('  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>');
  p('</dict></plist>');
  p('PLISTEOF');
  p('launchctl unload "$PLIST" 2>/dev/null || true');
  p('launchctl load "$PLIST" 2>/dev/null || true');
  p('');
  p('# 6) Mount now');
  p('if mount | grep -q "$MOUNT"; then echo "Already mounted."; else');
  p('  "$RCLONE_BIN" mount "$REMOTE_PATH" "$MOUNT" --vfs-cache-mode full --volname "$BRAND" --daemon 2>/dev/null || true');
  p('fi');
  p('sleep 2');
  p('open "$MOUNT" 2>/dev/null || true');
  p('printf "\\n${C}${B}  ✓ Done.${N} Your %s drive is at: %s\\n\\n" "$BRAND" "$MOUNT"');
  p('echo "It will re-mount automatically every time you log in."');
  return L.join('\n') + '\n';
}

// ── Multipart upload ─────────────────────────────────────────────────────────
//
// A single presigned PUT caps at 5 GB and cannot resume: a dropped connection
// at 90% loses everything. Multipart splits the object into independently
// signed, independently retryable parts, and S3 itself remembers which ones
// landed — which is what makes a resume after a page reload possible without
// us tracking part state.

// S3's own limits. These are not tunable.
const S3_MIN_PART = 5 * 1024 * 1024;          // 5 MiB, every part but the last
const S3_MAX_PART = 5 * 1024 * 1024 * 1024;   // 5 GiB
const S3_MAX_PARTS = 10000;
// The binding constraint, and NOT the same as S3_MAX_PART * S3_MAX_PARTS
// (~48 TiB). S3 refuses a single object larger than 5 TiB no matter how it is
// partitioned, so deriving the ceiling from the part limits lets files through
// that S3 will reject later, after the bytes have moved.
const S3_MAX_OBJECT = 5 * 1024 * 1024 * 1024 * 1024;  // 5 TiB

/**
 * The limits actually in force, which are the provider's, not S3's.
 *
 * Every S3-compatible service copies the part rules and then picks its own
 * single-object ceiling. Backblaze B2 allows 10 TB where AWS allows 5 TiB, so
 * a hardcoded S3 ceiling refuses a file B2 would happily take — and the
 * refusal arrives at the worst moment, when someone is trying to upload the
 * one master that is bigger than everything else they own.
 *
 * Unknown providers get the S3 numbers. They are the most conservative, and
 * being wrong in that direction costs a refusal rather than a transfer that
 * fails after the bytes have moved.
 */
export function providerLimits(cfg) {
  const provider = storageProvider(cfg);
  const base = { provider, minPart: S3_MIN_PART, maxPart: S3_MAX_PART, maxParts: S3_MAX_PARTS };
  switch (provider) {
    case 'b2':
      // B2 quotes its ceiling in decimal TB, not TiB.
      return { ...base, label: 'Backblaze B2', maxObject: 10 * 1000 * 1000 * 1000 * 1000, maxObjectLabel: '10 TB' };
    case 'r2':
      return { ...base, label: 'Cloudflare R2', maxObject: S3_MAX_OBJECT, maxObjectLabel: '5 TiB' };
    case 'spaces':
      return { ...base, label: 'DigitalOcean Spaces', maxObject: S3_MAX_OBJECT, maxObjectLabel: '5 TiB' };
    case 'wasabi':
      return { ...base, label: 'Wasabi', maxObject: S3_MAX_OBJECT, maxObjectLabel: '5 TiB' };
    case 'aws':
      return { ...base, label: 'S3', maxObject: S3_MAX_OBJECT, maxObjectLabel: '5 TiB' };
    default:
      return { ...base, label: 'this bucket', maxObject: S3_MAX_OBJECT, maxObjectLabel: '5 TiB' };
  }
}

// Our floor. Above S3's minimum on purpose: 8 MiB is a reasonable amount of
// work to lose and retry on a flaky connection, and it keeps part counts low
// enough that the completion manifest stays small.
const PART_FLOOR = 8 * 1024 * 1024;

/**
 * Part size for an object of `size` bytes. Pure, so the arithmetic that decides
 * whether an upload is even possible can be tested without touching S3.
 *
 * Grows the part size only when the floor would exceed the 10,000-part limit,
 * and targets 9,000 parts rather than 10,000 so a size estimate that is a
 * little low does not push a real upload over the edge mid-flight.
 *
 * `cfg` is optional and selects the provider's ceilings; without it the S3
 * numbers apply, which are the conservative ones.
 */
export function choosePartSize(size, cfg) {
  const { maxObject, maxObjectLabel, label, minPart, maxPart } = providerLimits(cfg);
  const n = Number(size);
  if (!Number.isFinite(n) || n <= 0) return PART_FLOOR;
  if (n > maxObject) {
    throw new Error(`That file is larger than ${label} can store in a single object (${maxObjectLabel}).`);
  }
  if (n <= PART_FLOOR * 9000) return PART_FLOOR;
  const MiB = 1024 * 1024;
  const needed = Math.ceil(n / 9000 / MiB) * MiB;   // round up to a whole MiB
  return Math.min(Math.max(needed, minPart), maxPart);
}

/** How many parts an object of `size` bytes splits into at `partSize`. */
export function partCount(size, partSize) {
  const n = Number(size) || 0;
  return n <= 0 ? 0 : Math.ceil(n / partSize);
}

async function s3(cfg) {
  const mod = await import('@aws-sdk/client-s3');
  return { mod, client: new mod.S3Client(s3ClientOpts(cfg)) };
}

/** Begin a multipart upload. Returns { uploadId, key, name, partSize, parts }. */
export async function s3CreateMultipartUpload(cfg, { filename, contentType, folder }) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  const { mod, client } = await s3(cfg);
  const key = await s3UniqueKey(cfg, buildObjectKey(cfg, filename, folder));
  const r = await client.send(new mod.CreateMultipartUploadCommand({
    Bucket: cfg.bucket,
    Key: key,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { uploadId: r.UploadId, key, name: key.slice(key.lastIndexOf('/') + 1) };
}

/**
 * Presign a batch of part URLs.
 *
 * Signed in batches rather than all at once: a 40 GB file is thousands of
 * parts, and a presigned URL starts expiring the moment it is minted. The
 * client asks for the next batch as it works through the file, so a slow
 * upload never races its own signatures.
 */
export async function s3PresignUploadParts(cfg, { key, uploadId, partNumbers, expiresIn = 3600 }) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  const { mod, client } = await s3(cfg);
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  return Promise.all(
    partNumbers.map(async (partNumber) => ({
      partNumber,
      url: await getSignedUrl(
        client,
        new mod.UploadPartCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn }
      ),
    }))
  );
}

/**
 * Which parts S3 already holds. This is what makes resume work: S3 is the
 * source of truth, so we never have to trust client-side bookkeeping that a
 * page reload would have discarded.
 */
export async function s3ListParts(cfg, { key, uploadId }) {
  if (!s3Ready(cfg)) return [];
  const { mod, client } = await s3(cfg);
  const out = [];
  let marker;
  do {
    const r = await client.send(new mod.ListPartsCommand({
      Bucket: cfg.bucket, Key: key, UploadId: uploadId, PartNumberMarker: marker,
    }));
    for (const p of r.Parts || []) {
      out.push({ partNumber: p.PartNumber, etag: p.ETag, size: Number(p.Size) || 0 });
    }
    marker = r.IsTruncated ? r.NextPartNumberMarker : undefined;
  } while (marker);
  return out.sort((a, b) => a.partNumber - b.partNumber);
}

/** Assemble the parts into the final object. */
export async function s3CompleteMultipartUpload(cfg, { key, uploadId, parts }) {
  if (!s3Ready(cfg)) throw new Error('Custom bucket isn’t fully configured.');
  const { mod, client } = await s3(cfg);
  // S3 requires the manifest in ascending part order and rejects it otherwise.
  const ordered = [...parts]
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag }));
  await client.send(new mod.CompleteMultipartUploadCommand({
    Bucket: cfg.bucket, Key: key, UploadId: uploadId,
    MultipartUpload: { Parts: ordered },
  }));
  return { key, publicUrl: publicUrlForKey(cfg, key) };
}

/**
 * Discard an upload and its parts.
 *
 * Worth doing even on a cancel the user initiated: abandoned parts are stored
 * and billed indefinitely, and they are invisible in the console's object
 * listing, so they accumulate unnoticed. A bucket lifecycle rule for
 * incomplete multipart uploads is the backstop for the ones we never reach.
 */
export async function s3AbortMultipartUpload(cfg, { key, uploadId }) {
  if (!s3Ready(cfg) || !uploadId) return false;
  try {
    const { mod, client } = await s3(cfg);
    await client.send(new mod.AbortMultipartUploadCommand({ Bucket: cfg.bucket, Key: key, UploadId: uploadId }));
    return true;
  } catch (e) {
    console.warn('[s3AbortMultipartUpload] failed:', e.message);
    return false;
  }
}

// ─── Diagnostics ────────────────────────────────────────────────────────────
//
// "Test connection" used to mean one thing: can we sign a URL. Signing is
// local arithmetic — it never touches the network, so it passed against a
// bucket that did not exist, credentials that were wrong, and a key with no
// write permission. The first real signal arrived when someone tried to
// upload.
//
// These checks each prove one thing end to end, and each failure carries the
// fix rather than the provider's error text. They run against whatever is in
// the form, so an admin can verify a config before saving it.

const pass = (id, label, detail) => ({ id, label, status: 'pass', detail: detail || '' });
const warn = (id, label, detail, fix) => ({ id, label, status: 'warn', detail, fix });
const fail = (id, label, detail, fix) => ({ id, label, status: 'fail', detail, fix });

/**
 * What the configured B2 key is actually allowed to do.
 *
 * The capability that matters is writeKeys: without it Onyx cannot mint
 * per-mount keys, so the ladder falls to the static rung and read-only
 * members are refused. That is a config mistake an admin should learn about
 * here, not from a member's error message a week later.
 */
export async function b2Capabilities(cfg) {
  const basic = Buffer.from(`${cfg.accessKeyId}:${cfg.secretAccessKey}`).toString('base64');
  const auth = await b2Fetch(B2_API, { token: `Basic ${basic}` });
  const caps = auth?.apiInfo?.storageApi?.capabilities || [];
  return {
    capabilities: caps,
    canMintKeys: caps.includes('writeKeys'),
    // B2 restricts a key to one bucket by id; a key scoped that way reports
    // it here, which is worth surfacing because it silently limits which
    // filespaces can work.
    bucketId: auth?.apiInfo?.storageApi?.bucketId || null,
    namePrefix: auth?.apiInfo?.storageApi?.namePrefix || null,
  };
}

/**
 * Run every check against a config. Never throws — a diagnostics page that
 * 500s tells you nothing.
 *
 * `origin` is this deployment's own origin, used to judge whether the
 * bucket's CORS rules actually permit uploads from it.
 */
export async function s3Diagnostics(cfg, { origin = '' } = {}) {
  const provider = storageProvider(cfg);
  const limits = providerLimits(cfg);
  const checks = [];

  // 1. Is there enough here to try anything?
  const missing = ['bucket', 'accessKeyId', 'secretAccessKey'].filter((k) => !cfg?.[k]);
  if (cfg?.provider !== 's3') {
    checks.push(warn('config', 'Configuration', 'Storage is set to Vercel Blob.',
      'Blob cannot be mounted — filespaces and the desktop app need an S3-compatible bucket.'));
    return { provider, label: limits.label, checks, mode: storageMode(cfg) };
  }
  if (missing.length) {
    checks.push(fail('config', 'Configuration', `Missing: ${missing.join(', ')}.`,
      'Fill these in above. The secret is kept when you leave the field blank on a later edit.'));
    return { provider, label: limits.label, checks, mode: storageMode(cfg) };
  }
  checks.push(pass('config', 'Configuration',
    [limits.label, `bucket "${cfg.bucket}"`, cfg.region && `region ${cfg.region}`,
     cfg.endpoint || 'no endpoint (AWS)', `objects up to ${limits.maxObjectLabel}`]
      .filter(Boolean).join(' · ')));

  // A B2 endpoint carries its region in the hostname, so a mismatch is
  // checkable here with no network at all — and it is a common one, because
  // the two fields are entered separately and only one of them is obviously
  // wrong when it fails. SigV4 signs with the region, so a mismatch reads as
  // an authentication failure rather than as a typo.
  const mismatch = b2RegionMismatch(cfg);
  if (mismatch) {
    checks.push(fail('region', 'Region', mismatch.detail, mismatch.fix));
  }

  let S3, client;
  try {
    ({ mod: S3, client } = await s3(cfg));
  } catch (e) {
    checks.push(fail('sdk', 'S3 SDK', e.message, 'Redeploy — @aws-sdk/client-s3 is in package.json.'));
    return { provider, label: limits.label, checks, mode: storageMode(cfg) };
  }

  // 2. Read. Proves the endpoint resolves, the credentials are accepted and
  //    the bucket exists — the three things signing a URL does not.
  try {
    const t0 = Date.now();
    const r = await client.send(new S3.ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
    checks.push(pass('read', 'Read access', `${Date.now() - t0}ms · ${r.KeyCount ?? 0} object(s) visible`));
  } catch (e) {
    const fix = provider === 'b2'
      ? await diagnoseB2ReadFailure(cfg, e)
      : 'Check the bucket name, region, endpoint and key. The key needs s3:ListBucket.';
    checks.push(fail('read', 'Read access', describeS3Error(e, provider), fix));
    return { provider, label: limits.label, checks, mode: storageMode(cfg) };
  }

  // 3. Write, for real. A presigned URL proves nothing about permission; an
  //    object that lands and is then removed proves both halves.
  const probeKey = `${String(cfg.prefix || 'files').replace(/^\/+|\/+$/g, '')}/.onyx-preflight-${Date.now()}`;
  try {
    await client.send(new S3.PutObjectCommand({
      Bucket: cfg.bucket, Key: probeKey, Body: 'onyx', ContentType: 'text/plain',
    }));
    try {
      await client.send(new S3.DeleteObjectCommand({ Bucket: cfg.bucket, Key: probeKey }));
      checks.push(pass('write', 'Write access', 'Wrote and removed a probe object.'));
    } catch {
      checks.push(warn('write', 'Write access', 'Wrote a probe object but could not delete it.',
        `The key lacks delete permission, so trashing a file will fail. Remove ${probeKey} by hand.`));
    }
  } catch (e) {
    checks.push(fail('write', 'Write access', describeS3Error(e, provider),
      'Uploads will fail. The key needs write (and delete, for the trash) on this bucket.'));
  }

  // 4. CORS. Browser uploads go straight from the page to the bucket, so a
  //    missing rule fails as an opaque "Failed to fetch" with nothing in any
  //    server log to explain it.
  try {
    const r = await client.send(new S3.GetBucketCorsCommand({ Bucket: cfg.bucket }));
    const rules = r.CORSRules || [];
    const allowed = rules.some((rule) => (rule.AllowedOrigins || []).some((o) => o === '*' || o === origin));
    const puts = rules.some((rule) => (rule.AllowedMethods || []).includes('PUT'));
    if (allowed && puts) {
      checks.push(pass('cors', 'Bucket CORS', `${rules.length} rule(s); this origin may PUT.`));
    } else {
      checks.push(warn('cors', 'Bucket CORS',
        allowed ? 'A rule matches this origin but does not allow PUT.' : `No rule allows ${origin || 'this origin'}.`,
        'Press "Apply CORS" below. Browser uploads fail with an opaque "Failed to fetch" without it.'));
    }
  } catch (e) {
    const none = /NoSuchCORSConfiguration|NotFound|404/i.test(`${e?.name || ''} ${e?.message || ''}`);
    checks.push(warn('cors', 'Bucket CORS',
      none ? 'No CORS rules are set on this bucket.' : describeS3Error(e, provider),
      'Press "Apply CORS" below, or add the rule by hand in the provider console.'));
  }

  // 5. Scoped credentials — whether read-only members can mount at all.
  const plan = credentialPlan(cfg, { id: 'preflight', prefix: 'preflight' }, { role: 'viewer' });
  if (plan.strategy === 'b2-native') {
    try {
      const caps = await b2Capabilities(cfg);
      if (caps.canMintKeys) {
        checks.push(pass('scoped', 'Scoped credentials', 'B2 key can mint per-mount keys (writeKeys present).'));
      } else {
        checks.push(warn('scoped', 'Scoped credentials', 'This B2 key lacks the writeKeys capability.',
          'Editors and owners can still mount with the key itself, but read-only members will be refused. Create a key with writeKeys via b2_create_key to fix it.'));
      }
      if (caps.namePrefix) {
        checks.push(warn('scoped-prefix', 'Key scope', `This key is itself restricted to the prefix "${caps.namePrefix}".`,
          'Filespaces outside that prefix will not work. Use a key without a prefix restriction for the control plane.'));
      }
    } catch (e) {
      checks.push(warn('scoped', 'Scoped credentials', `Could not check the B2 key: ${e.message}`,
        'Read-only mounting may not work. Verify the key with b2_authorize_account.'));
    }
  } else if (plan.strategy === 'assume-role') {
    checks.push(pass('scoped', 'Scoped credentials', 'A role ARN is configured — mounts use STS AssumeRole.'));
  } else if (plan.strategy === 'federation') {
    checks.push(pass('scoped', 'Scoped credentials', 'Mounts use STS GetFederationToken. The key needs sts:GetFederationToken.'));
  } else {
    checks.push(warn('scoped', 'Scoped credentials', `${limits.label} has no scoped-credential API wired up.`,
      'Read-only members cannot mount. Give them editor access, or give the filespace its own dedicated key.'));
  }

  return { provider, label: limits.label, mode: storageMode(cfg), checks };
}

/**
 * On B2 the region is part of the endpoint hostname, so the two fields can
 * contradict each other. Returns null when they agree or when the question
 * does not apply.
 *
 * Pure, so it is tested without a bucket — and worth catching early, because
 * SigV4 signs the request with the configured region and the resulting
 * failure looks like bad credentials rather than like a typo.
 */
export function b2RegionMismatch(cfg) {
  if (storageProvider(cfg) !== 'b2') return null;
  const fromEndpoint = b2RegionFromEndpoint(cfg?.endpoint);
  const configured = String(cfg?.region || '').trim().toLowerCase();
  if (!fromEndpoint) {
    return {
      detail: `The endpoint "${cfg?.endpoint}" is not a recognisable B2 endpoint.`,
      fix: 'It should look like https://s3.us-west-004.backblazeb2.com — check the region digits against your bucket in the Backblaze console.',
    };
  }
  if (!configured) {
    return {
      detail: `No region is set, but the endpoint says ${fromEndpoint}.`,
      fix: `Set the region to ${fromEndpoint}. SigV4 signs with it, so leaving it blank fails as an authentication error.`,
    };
  }
  if (configured !== fromEndpoint) {
    return {
      detail: `Region is "${configured}" but the endpoint is for "${fromEndpoint}".`,
      fix: `Set the region to ${fromEndpoint}, or change the endpoint to match the region. They must agree — the request is signed with the region and validated against the host.`,
    };
  }
  return null;
}

/**
 * Work out WHY a B2 read failed, by asking B2.
 *
 * This used to be a single sentence about the master application key,
 * attached to every B2 read failure whatever its cause — so a wrong region, a
 * typo'd bucket or a prefix-restricted key all produced a confident
 * instruction to go and make a new key, which did not help and sent people
 * looking in the wrong place. A guess dressed as a diagnosis is worse than
 * no diagnosis.
 *
 * The native API can tell us the truth, because it accepts keys the
 * S3-compatible API does not. So: authorize with the same credentials and
 * read back what B2 says about them.
 *
 *   native fails                 → the credentials themselves are wrong
 *   native works, S3 rejected    → the master-key signature. B2 accepts the
 *                                  master key on the native API and refuses
 *                                  it on S3, which is exactly this shape, and
 *                                  now it is EVIDENCE rather than a guess.
 *   key is prefix-restricted     → the S3 listing is outside its prefix
 *   key is bound to another bucket
 *   no restriction at all        → not the key; region, endpoint or name
 */
async function diagnoseB2ReadFailure(cfg, error) {
  let caps;
  try {
    caps = await b2Capabilities(cfg);
  } catch (e) {
    return 'B2 rejected these credentials on its own API too, so the key id or the '
         + `secret is wrong rather than anything about the bucket (${e.message}).`;
  }

  if (caps.namePrefix) {
    return `This key is restricted to the prefix "${caps.namePrefix}", so it cannot list `
         + 'the bucket. Use a key without a prefix restriction for the control plane.';
  }
  if (caps.bucketId) {
    return 'This key is restricted to a single bucket. Check it is the bucket named above, '
         + 'and that "Allow List All Bucket Names" was enabled when it was created — the '
         + 'S3 API needs that to resolve a bucket by name.';
  }

  const text = `${error?.name || ''} ${error?.Code || ''} ${error?.message || ''}`;
  if (/InvalidAccessKeyId|SignatureDoesNotMatch|AccessDenied|not authorized|403|401/i.test(text)) {
    return 'B2 accepts these credentials on its native API but refused them on the S3 API, '
         + 'which is what the MASTER application key does. Create a regular application key '
         + '(Backblaze → Application Keys → Add a New Application Key) with "Allow List All '
         + 'Bucket Names" enabled, and use its keyID and applicationKey here.';
  }
  return 'The key itself is fine — B2 accepted it and it carries no bucket or prefix '
       + 'restriction. So this is the bucket name, the region or the endpoint. A B2 region '
       + 'looks like us-west-004 and must match the one in the endpoint hostname.';
}

/** Provider error text is rarely actionable on its own; name the likely cause. */
function describeS3Error(e, provider) {
  const text = `${e?.name || ''} ${e?.Code || ''} ${e?.message || ''}`.trim();
  if (/NoSuchBucket/i.test(text)) return 'That bucket does not exist (or is not visible to this key).';
  if (/InvalidAccessKeyId/i.test(text)) return 'The access key id is not recognised.';
  if (/SignatureDoesNotMatch/i.test(text)) return 'The secret does not match the key id.';
  if (/AccessDenied|not authorized|403/i.test(text)) return 'The key is valid but not allowed to do this.';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) return 'The endpoint hostname does not resolve.';
  if (/ECONNREFUSED|ETIMEDOUT|ECONNRESET|socket hang up|fetch failed/i.test(text)) {
    return 'Could not reach the endpoint — connection refused or timed out.';
  }
  // A non-S3 response body. Usually the endpoint points at something that is
  // not an S3 API at all, or a proxy is answering on its behalf; the SDK's
  // own message talks about deserialization, which sends people looking in
  // the wrong place entirely.
  if (/XML parse|Deserialization|unexpected content|Unexpected token/i.test(text)) {
    return 'The endpoint answered with something that is not an S3 response. Check the endpoint hostname, and whether a proxy is intercepting it.';
  }
  if (/PermanentRedirect|AuthorizationHeaderMalformed|region/i.test(text)) {
    return `Wrong region for this bucket${provider === 'b2' ? ' — B2 regions look like us-west-004' : ''}.`;
  }
  return text || 'Unknown error.';
}
