/**
 * Profile pictures: the parts both sides agree on. Client-safe.
 *
 * A picture is stored in the database (lib/db.js, user_avatars), not the
 * bucket: it is a few kilobytes once re-encoded, it works on every storage
 * mode (Blob as well as S3), and it never needs a presigned URL that
 * expires under a page someone left open.
 */

/**
 * What the server takes before re-encoding; larger is refused unread. Under
 * Vercel's 4.5 MB request-body limit, which would otherwise refuse it first
 * with a bare 413 of its own.
 */
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;
/**
 * What may be chosen in the browser. A picture over AVATAR_MAX_BYTES, or
 * larger than AVATAR_UPLOAD_EDGE on a side, is shrunk there before it is sent
 * (AvatarDialog), so a full-size phone photo still works.
 */
export const AVATAR_PICK_MAX_BYTES = 40 * 1024 * 1024;
export const AVATAR_UPLOAD_EDGE = 1024;
/** The stored picture: a square this many pixels a side, WebP. */
export const AVATAR_SIZE = 256;
export const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * What an uploaded file really is, from its first bytes — never from its
 * name or the type the browser claims. Null for anything that is not one
 * of AVATAR_TYPES.
 */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (b.length >= 6 && (at(0, 0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || at(0, 0x47, 0x49, 0x46, 0x38, 0x39, 0x61))) return 'image/gif';
  return null;
}

/**
 * Where a picture is served. `id` is a hash of the address, never the
 * address itself; `version` changes with every new picture, so the browser
 * may keep each one for ever.
 */
export const avatarPath = (id, version) => `/api/avatars/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`;

/** Why a chosen file cannot be a profile picture, or null — checked in the browser before uploading. */
export function avatarFileProblem(file) {
  if (!file) return 'Choose a picture.';
  if (file.size > AVATAR_PICK_MAX_BYTES) return 'That picture is over 40 MB. Choose a smaller one.';
  if (file.type && !AVATAR_TYPES.includes(file.type)) return 'Use a JPEG, PNG, WebP or GIF picture.';
  return null;
}
