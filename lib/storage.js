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

import { getSetting, setSetting } from './db';

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

// ExternalId baked into the AssumeRole trust policy condition — a static
// shared secret-shape value that defends against the "confused deputy"
// problem. Must match the role's trust policy Condition in AWS.
export const STS_EXTERNAL_ID = 'onyxfs';

export async function getStorageConfig() {
  try {
    const saved = await getSetting(SETTING_KEY);
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
export async function presignFileUrls(files) {
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
      if (key) { try { out.url = await s3PresignGet(cfg, key, { client }); } catch {} }
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

/**
 * The credential ladder for a filespace mount — uses the strongest mechanism
 * the configuration supports, so setup works with nothing but a key + secret:
 *   1. roleArn configured        → STS AssumeRole (ExternalId + session policy)
 *   2. no roleArn                → STS GetFederationToken (session policy, no role needed)
 *   3. key can't call STS at all → static key, prefix-scoped at the mount only
 *   (custom endpoint            → static; R2/MinIO/Spaces have no STS)
 */
export async function mintFilespaceCredentials(cfg, filespace, opts = {}) {
  const role = opts.role || 'viewer';
  // Per-filespace own keys → hand them out directly (static), scoped to this
  // bucket. The admin provisioned a dedicated key for this bucket, so all
  // granted roles may use it (it can't be STS-scoped, by definition).
  if (filespace && filespace.accessKeyId && filespace.secretAccessKey) {
    return s3StaticCredsForFilespace(cfgForFilespace(cfg, filespace), filespace);
  }
  // Static mode hands out the deployment's own key (IAM can't scope or expire
  // it), so it is never given to viewers — only editors/owners, who are
  // trusted to write anyway. Viewers on a no-STS key get an actionable error.
  const staticOrRefuse = () => {
    if (role === 'viewer') {
      throw new Error('This deployment’s access key can’t mint read-only credentials (no STS access). Ask an admin to allow sts:GetFederationToken on the key, or grant you editor access.');
    }
    return s3StaticCredsForFilespace(cfg, filespace);
  };
  if (cfg.endpoint) return staticOrRefuse(); // R2/MinIO/Spaces: no STS exists
  const roleArn = (filespace && filespace.roleArn) || cfg.roleArn;
  if (roleArn) return s3AssumeRoleForFilespace(cfg, filespace, opts); // explicit config → fail loudly on error
  try {
    return await s3FederationTokenForFilespace(cfg, filespace, opts);
  } catch (e) {
    const text = `${e?.name || ''} ${e?.Code || ''} ${e?.message || ''}`;
    // Key is valid but lacks sts:GetFederationToken → degrade (role-gated).
    // Anything else (bad key, signature mismatch, network) should surface.
    if (/AccessDenied|not authorized/i.test(text)) {
      console.warn('[mintFilespaceCredentials] GetFederationToken denied — static fallback (role-gated):', e?.message);
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
