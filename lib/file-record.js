// lib/file-record.js — what POST /api/files takes from a client, and nothing
// else. Pure, so the rule can be tested without a database.
//
// The route used to spread the whole request body into createFile, which
// honours createdAt, updatedAt and contentHash when it is handed them: a
// client could backdate a file, or claim a hash it does not have and be
// counted as a duplicate of something it is not. Now the body is read field
// by field, and anything not named here never reaches the row.

// Who may see a new file. 'custom' (a named list of people) is set through
// the file's ACL afterwards, never at upload, where there is no list to go
// with it.
export const FILE_VISIBILITIES = ['org', 'owner'];

const STORAGES = new Set(['s3', 'blob']);
const MAX_NAME = 1024;

const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : undefined);

/**
 * A registration body → { record } | { error }. `record` holds only the
 * fields a client is allowed to state; the server adds who and when, and
 * lib/media.js uploadFields decides kind, thumbnail and filmstrip.
 */
export function parseFileRecord(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Bad request' };
  const url = str(body.url, 8192);
  if (!url) return { error: 'A file URL is required.' };

  const storage = body.storage == null ? 'blob' : String(body.storage);
  if (!STORAGES.has(storage)) return { error: 'Unknown storage.' };

  // For an S3 row the listing signs storageKey, and only storageKey is
  // checked against the drives. A row with a url alone could name any object
  // in the bucket — another drive's, a preview, the trash — so the key is
  // required, and never read back out of the url.
  // A Blob upload has no key of ours: it is its URL. One sent anyway would
  // be checked against the drives and counted by storageKeyInUse as if it
  // named a bucket object — so it is dropped, not stored.
  const storageKey = storage === 's3' ? (str(body.storageKey, 2048) || null) : null;
  if (storage === 's3' && !storageKey) return { error: 'A storage key is required.' };
  if (storageKey && /^(_thumbs|_trash)\//.test(storageKey)) return { error: 'Not a file key.' };

  const visibility = body.visibility == null ? 'org' : String(body.visibility);
  if (!FILE_VISIBILITIES.includes(visibility)) {
    return { error: `Visibility must be ${FILE_VISIBILITIES.join(' or ')}.` };
  }

  let size = null;
  if (body.size != null && body.size !== '') {
    size = Number(body.size);
    if (!Number.isFinite(size) || size < 0) return { error: 'Size must be a number of bytes.' };
    size = Math.floor(size);
  }

  const name = str(body.name, MAX_NAME);
  const record = {
    url,
    storage,
    storageKey,
    visibility,
    size,
    name: name && name.trim() ? name : undefined,
    mime: str(body.mime, 255) || null,
    kind: str(body.kind, 16),
    folder: str(body.folder, 2048) || '',
    notes: str(body.notes, 10000) || null,
    tags: Array.isArray(body.tags) ? body.tags.filter((t) => typeof t === 'string').slice(0, 200) : [],
    // Checked by uploadFields: a thumbnail or strip key the presign route
    // named, media facts that are sane numbers, a strip geometry a browser
    // can decode.
    thumbnailKey: str(body.thumbnailKey, 2048),
    filmstripKey: str(body.filmstripKey, 2048),
    filmstrip: body.filmstrip && typeof body.filmstrip === 'object' ? body.filmstrip : undefined,
    media: body.media && typeof body.media === 'object' ? body.media : undefined,
    metadata: body.metadata && typeof body.metadata === 'object' && !Array.isArray(body.metadata) ? body.metadata : undefined,
    // Which drive the upload went to, so the HEAD that confirms it uses that
    // drive's bucket and keys. Not stored.
    filespace: str(body.filespace, 128) || null,
  };
  return { record };
}
