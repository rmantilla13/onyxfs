// lib/share-kinds.js — the three kinds of share link, the expiry choices, and
// the rules for a create request. Dependency-free: the share dialog (client)
// and the routes (server) read the same definitions. The crypto half is
// lib/shares.js, which is server-only.
//
//   public    anyone who has the link
//   password  anyone who has the link AND the password
//   private   only signed-in members who can already open the file — a link
//             to send around inside the workspace, which grants nothing
//
// Stored in file_shares (lib/db.js) as mode 'public' | 'private' plus an
// optional password_hash: a password link is a public link with a hash.
// Private links never carry one; access there is the session and the ACL.
//
// Separately, what the people a public or password link reaches may do with
// a photo or a video besides look at it (SHARE_REVIEW): comment with the
// review tools on the share page, and — only when the sharer says so —
// approve. file_shares.review: NULL (view), 'comment' or 'approve'. A link
// that takes comments is a review link, and needs the review.links
// capability on top of the one for its kind (lib/authz.js).

export const SHARE_KINDS = [
  { id: 'public', label: 'Public', detail: 'Anyone with the link can view and download.' },
  { id: 'password', label: 'Password', detail: 'Anyone with the link and the password.' },
  { id: 'private', label: 'Private', detail: 'Only signed-in members who can already open this file.' },
];

export const MIN_PASSWORD = 6;

// Expiry choices, in days; null is "never".
export const SHARE_EXPIRY = [
  { id: 'never', label: 'Never', days: null },
  { id: '1', label: 'In 1 day', days: 1 },
  { id: '7', label: 'In 7 days', days: 7 },
  { id: '30', label: 'In 30 days', days: 30 },
];

/** How a link presents: 'public' | 'password' | 'private'. Takes a row or a listing. */
export function shareKind(row) {
  if ((row?.mode || 'public') === 'private') return 'private';
  return row?.password_hash || row?.hasPassword ? 'password' : 'public';
}

// What the people a link reaches may do. 'view' is stored as NULL, so every
// link made before this reads as what it was.
export const SHARE_REVIEW = [
  { id: 'view', label: 'View', detail: 'Open and download.' },
  { id: 'comment', label: 'Comment', detail: 'Comment on frames and spots, and draw on the picture.' },
  { id: 'approve', label: 'Comment & approve', detail: 'Comment, and approve or ask for changes.' },
];
const REVIEW_LEVELS = new Set(['comment', 'approve']);

/** What a link's recipients may do: null (view), 'comment' or 'approve'. Takes a row or a listing. */
export function shareReview(row) {
  return REVIEW_LEVELS.has(row?.review) ? row.review : null;
}

/** How a link's review level reads in a list: "Can comment", "Can approve", or null for view. */
export function reviewLabel(review) {
  if (review === 'approve') return 'Can approve';
  if (review === 'comment') return 'Can comment';
  return null;
}

/**
 * A requested review level → { review } (null for view) or { error }.
 * Absent is view. A private link takes none: it opens only for members, who
 * comment on the file itself — refused rather than dropped, so a sharer is
 * never told a link takes comments when it does not.
 */
export function parseShareReview(value, kind) {
  if (value == null || value === 'view') return { review: null };
  if (!REVIEW_LEVELS.has(value)) return { error: 'Choose what people with the link can do.' };
  if (kind === 'private') return { error: 'Private links open only for members, who already comment on the file.' };
  return { review: value };
}

/**
 * A create request, checked and turned into what the table stores. Returns
 * { mode, password, expiresInDays, review } or { error } — the error is a
 * sentence for the share dialog, not a code.
 */
export function parseShareRequest(body = {}) {
  const kind = SHARE_KINDS.some((k) => k.id === body.kind) ? body.kind : null;
  if (!kind) return { error: 'Choose who the link is for.' };
  const expiry = SHARE_EXPIRY.find((e) => e.id === String(body.expires ?? 'never'));
  if (!expiry) return { error: 'Choose when the link expires.' };
  const level = parseShareReview(body.review, kind);
  if (level.error) return { error: level.error };
  if (kind === 'password') {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) return { error: `Use a password of at least ${MIN_PASSWORD} characters.` };
    if (password.length > 200) return { error: 'That password is too long.' };
    return { mode: 'public', password, expiresInDays: expiry.days, review: level.review };
  }
  return { mode: kind, password: null, expiresInDays: expiry.days, review: level.review };
}

/** What a share token can look like, old (12 hex) or new (22 base64url). Anything else is not looked up. */
export function isShareToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(token);
}

/** "Expires in 3 days", "Expired", or null for a link that never does. */
export function expiryLabel(expiresAt, now = Date.now()) {
  if (expiresAt == null) return null;
  const ms = Number(expiresAt) - now;
  if (ms <= 0) return 'Expired';
  const hours = Math.ceil(ms / 3600000);
  if (hours < 24) return `Expires in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.ceil(ms / 86400000);
  return `Expires in ${days} day${days === 1 ? '' : 's'}`;
}
