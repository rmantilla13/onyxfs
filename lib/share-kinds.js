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

// Expiry choices, in days; null is "never". Besides these, a link can end on
// a date and time of the sharer's choosing (SHARE_EXPIRY_DATE), which the
// role's longest expiry holds to the same limit.
export const SHARE_EXPIRY = [
  { id: 'never', label: 'Never', days: null },
  { id: '1', label: 'In 1 day', days: 1 },
  { id: '7', label: 'In 7 days', days: 7 },
  { id: '30', label: 'In 30 days', days: 30 },
  { id: '90', label: 'In 90 days', days: 90 },
];
export const SHARE_EXPIRY_DATE = { id: 'date', label: 'On a date…' };
const DAY_MS = 86400000;
/** The furthest a chosen date may be: past this, "never" is what was meant. */
export const MAX_EXPIRY_DAYS = 5 * 365;

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
 * When a link stops working, from a request's `expires` (an id of
 * SHARE_EXPIRY, or 'date' with `expiresAt`, epoch milliseconds) →
 * { expiresAt, expiresInDays } (both null for never; the days fractional for
 * a date, which is what the role's longest expiry is checked against), or
 * { error }.
 */
export function parseShareExpiry(body = {}, now = Date.now()) {
  const id = String(body.expires ?? 'never');
  if (id === SHARE_EXPIRY_DATE.id) {
    const at = Number(body.expiresAt);
    if (!Number.isFinite(at)) return { error: 'Choose the date the link expires.' };
    if (at <= now + 60000) return { error: 'Choose a time in the future for the link to expire.' };
    if (at > now + MAX_EXPIRY_DAYS * DAY_MS) return { error: 'Choose a date within five years, or Never.' };
    return { expiresAt: Math.round(at), expiresInDays: (at - now) / DAY_MS };
  }
  const expiry = SHARE_EXPIRY.find((e) => e.id === id);
  if (!expiry) return { error: 'Choose when the link expires.' };
  return { expiresAt: expiry.days == null ? null : now + expiry.days * DAY_MS, expiresInDays: expiry.days };
}

/**
 * Whether the people a link reaches may download what it shows: a request's
 * `downloads`. Absent is yes, which every link made before was.
 */
export function parseShareDownloads(value) {
  if (value == null) return { downloads: true };
  if (typeof value !== 'boolean') return { error: 'Choose whether people can download.' };
  return { downloads: value };
}

/**
 * What a change to an existing link asks for besides its level → { changes },
 * holding only what the body names — `expires` (with `expiresAt`, as a create
 * request takes them: expiresAt null for never), `downloads`, `look` (the
 * whole look, replacing the old one) — or { error }.
 */
export function parseShareChanges(body = {}, { target = 'file', now = Date.now() } = {}) {
  const changes = {};
  if (body.expires !== undefined) {
    const expiry = parseShareExpiry(body, now);
    if (expiry.error) return { error: expiry.error };
    changes.expiresAt = expiry.expiresAt;
  }
  if (body.downloads !== undefined) {
    const dl = parseShareDownloads(body.downloads);
    if (dl.error) return { error: dl.error };
    changes.downloads = dl.downloads;
  }
  if (body.look !== undefined) {
    const look = parseShareLook(body.look, target);
    if (look.error) return { error: look.error };
    changes.look = look.look;
  }
  return { changes };
}

/**
 * A create request, checked and turned into what the table stores. Returns
 * { mode, password, expiresInDays, expiresAt, review, downloads, look } or
 * { error } — the error is a sentence for the share dialog, not a code.
 * `target` ('file' | 'folder') is what the link opens, which decides the
 * views its page may take (SHARE_VIEWS).
 */
export function parseShareRequest(body = {}, { target = 'file', now = Date.now() } = {}) {
  const kind = SHARE_KINDS.some((k) => k.id === body.kind) ? body.kind : null;
  if (!kind) return { error: 'Choose who the link is for.' };
  const expiry = parseShareExpiry(body, now);
  if (expiry.error) return { error: expiry.error };
  const level = parseShareReview(body.review, kind);
  if (level.error) return { error: level.error };
  const dl = parseShareDownloads(body.downloads);
  if (dl.error) return { error: dl.error };
  // Refused rather than dropped, as comments are: a private link opens only
  // for members, who can download the file in the workspace anyway.
  if (kind === 'private' && !dl.downloads) return { error: 'Private links open only for members, who can already download the file.' };
  const look = parseShareLook(body.look, target);
  if (look.error) return { error: look.error };
  const rest = { expiresInDays: expiry.expiresInDays, expiresAt: expiry.expiresAt, review: level.review, downloads: dl.downloads, look: look.look };
  if (kind === 'password') {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < MIN_PASSWORD) return { error: `Use a password of at least ${MIN_PASSWORD} characters.` };
    if (password.length > 200) return { error: 'That password is too long.' };
    return { mode: 'public', password, ...rest };
  }
  return { mode: kind, password: null, ...rest };
}

// ── How a link's page looks ─────────────────────────────────────────────────
// file_shares.look, JSONB: what the sharer chose for the page the link opens
// on — its layout, its scheme and accent, and a few words from them. Stored
// with only what differs from the defaults, and NULL when nothing does, which
// is every link made before. Pure presentation: none of it lets anyone see or
// do more, and the page shows any of it only once the link has let someone in
// (app/s/[token]/page.js) — a password page must not leak a title.
//
//   view     how the page lays out what it shares (SHARE_VIEWS, by target)
//   theme    'light' or 'dark' to hold the page to one; absent follows the
//            visitor's own setting
//   accent   '#rrggbb' in place of the workspace's accent; absent keeps it
//   logo     'none' to leave the workspace's logo off; absent shows it
//   title    a heading over what is shared, in place of its name
//   message  a note from the sharer, shown under the heading
//   sender   true to say who shared it, by their display name

export const SHARE_VIEWS = {
  file: [
    { id: 'standard', label: 'Standard', detail: 'The file under its name, with its details.' },
    { id: 'presentation', label: 'Presentation', detail: 'The file fills the page, with little around it.' },
  ],
  folder: [
    { id: 'grid', label: 'Grid', detail: 'Cards with names, as Files shows them.' },
    { id: 'list', label: 'List', detail: 'Rows with each file’s kind and size.' },
    { id: 'gallery', label: 'Gallery', detail: 'Pictures large and edge to edge, names on hover.' },
  ],
};

export const SHARE_THEMES = [
  { id: 'auto', label: 'Match viewer' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

export const SHARE_LOGOS = [
  { id: 'workspace', label: 'Workspace logo' },
  { id: 'none', label: 'No logo' },
];

// Accents to pick from besides the workspace's own (absent) and any colour
// typed in. A choice the sharer makes, never the brand's: the page they are
// used on still takes its type, radius and everything else from the brand.
// Each already as dark as lib/brand-config.js withAccent would make it to
// read as text on white, so the swatch is the colour the page shows.
export const SHARE_ACCENTS = ['#1D4ED8', '#7638E2', '#BE185D', '#B91C1C', '#B03C0C', '#A34C0A', '#147538', '#0E6F8A'];

export const LOOK_TITLE_MAX = 120;
export const LOOK_MESSAGE_MAX = 1000;

const HEX = /^#[0-9a-fA-F]{6}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/g;
// eslint-disable-next-line no-control-regex
const CONTROL_TEXT = /[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g;

/** The view a link to `target` opens in when it names none. */
export const defaultView = (target) => (target === 'folder' ? 'grid' : 'standard');

/**
 * A requested look → { look } (only what differs from the defaults, or null
 * when nothing does) or { error }. Absent is the default look. Refused, not
 * trimmed, when a value is not one of the choices or text is too long, so a
 * sharer never sends a page that says less than they wrote.
 */
export function parseShareLook(value, target = 'file') {
  if (value == null) return { look: null };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: 'Choose how the page looks.' };
  const out = {};
  const views = SHARE_VIEWS[target === 'folder' ? 'folder' : 'file'];
  if (value.view != null && value.view !== defaultView(target)) {
    if (!views.some((v) => v.id === value.view)) return { error: 'Choose how the page lays out what it shares.' };
    out.view = value.view;
  }
  if (value.theme != null && value.theme !== 'auto') {
    if (value.theme !== 'light' && value.theme !== 'dark') return { error: 'Choose light, dark, or the viewer’s own setting.' };
    out.theme = value.theme;
  }
  if (value.accent != null && value.accent !== '') {
    if (typeof value.accent !== 'string' || !HEX.test(value.accent.trim())) return { error: 'Choose an accent colour as #RRGGBB.' };
    out.accent = value.accent.trim().toUpperCase();
  }
  if (value.logo != null && value.logo !== 'workspace') {
    if (value.logo !== 'none') return { error: 'Choose whether the page shows the logo.' };
    out.logo = 'none';
  }
  if (value.title != null) {
    if (typeof value.title !== 'string') return { error: 'The title has to be text.' };
    const title = value.title.replace(CONTROL_LINE, ' ').replace(/\s+/g, ' ').trim();
    if (title.length > LOOK_TITLE_MAX) return { error: `Keep the title to ${LOOK_TITLE_MAX} characters.` };
    if (title) out.title = title;
  }
  if (value.message != null) {
    if (typeof value.message !== 'string') return { error: 'The message has to be text.' };
    const message = value.message.replace(/\r\n?/g, '\n').replace(CONTROL_TEXT, '').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    if (message.length > LOOK_MESSAGE_MAX) return { error: `Keep the message to ${LOOK_MESSAGE_MAX} characters.` };
    if (message) out.message = message;
  }
  if (value.sender != null) {
    if (typeof value.sender !== 'boolean') return { error: 'Choose whether the page says who shared it.' };
    if (value.sender) out.sender = true;
  }
  return { look: Object.keys(out).length ? out : null };
}

/**
 * A stored look, whole: every field, the defaults filled in, for the page
 * and the dialog. Read through parseShareLook again, so a row written by a
 * later version — or by hand — with something this one does not know is
 * the default look rather than a page that breaks; one bad field is dropped
 * on its own.
 */
export function resolveShareLook(stored, target = 'file') {
  const base = { view: defaultView(target), theme: 'auto', accent: null, logo: 'workspace', title: '', message: '', sender: false };
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return base;
  const out = { ...base };
  for (const key of Object.keys(base)) {
    if (stored[key] === undefined) continue;
    const one = parseShareLook({ [key]: stored[key] }, target);
    if (!one.error && one.look && one.look[key] !== undefined) out[key] = one.look[key];
  }
  return out;
}

// ── Templates ───────────────────────────────────────────────────────────────
// A template is a starting point for the share dialog's form: who the link
// is for, when it expires, what its people may do, and how its page looks.
// Never a password, and never anything granted: every value goes through the
// same parsing and the same checks as one chosen by hand, and one the person
// may not make is refused when the link is made, as it would be otherwise.
// Built in (SHARE_TEMPLATES), or saved by someone for themselves
// (share_templates, lib/db.js).
//
// `views` holds a view for each target, since one template serves a file's
// dialog and a folder's.

export const SHARE_TEMPLATES = [
  {
    id: 'quick',
    name: 'Quick share',
    detail: 'Anyone with the link can view and download.',
    settings: { kind: 'public', expires: 'never', review: 'view', downloads: true, views: {}, look: {} },
  },
  {
    id: 'review',
    name: 'Client review',
    detail: 'Password, comments and approvals, for 30 days.',
    settings: { kind: 'password', expires: '30', review: 'approve', downloads: true, views: {}, look: { theme: 'light', sender: true } },
  },
  {
    id: 'portfolio',
    name: 'Portfolio',
    detail: 'A dark gallery to look at, without downloads.',
    settings: { kind: 'public', expires: 'never', review: 'view', downloads: false, views: { file: 'presentation', folder: 'gallery' }, look: { theme: 'dark' } },
  },
  {
    id: 'screening',
    name: 'Screening room',
    detail: 'Password, a dark stage, no downloads, for 7 days.',
    settings: { kind: 'password', expires: '7', review: 'view', downloads: false, views: { file: 'presentation', folder: 'gallery' }, look: { theme: 'dark', logo: 'none' } },
  },
  {
    id: 'presskit',
    name: 'Press kit',
    detail: 'A list to download from, for 90 days.',
    settings: { kind: 'public', expires: '90', review: 'view', downloads: true, views: { folder: 'list' }, look: { theme: 'light' } },
  },
];

export const TEMPLATE_NAME_MAX = 60;
/** How many templates one person may keep. */
export const MAX_TEMPLATES = 30;

/**
 * Settings to keep as a template → { settings } or { error }. The same
 * choices a link takes, each optional, checked as a link's are — and a
 * custom date is not kept (a template outlives any one date), nor a
 * password, ever.
 */
export function parseTemplateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Choose what the template sets.' };
  const out = { views: {}, look: {} };
  if (value.kind != null) {
    if (!SHARE_KINDS.some((k) => k.id === value.kind)) return { error: 'Choose who the link is for.' };
    out.kind = value.kind;
  }
  if (value.expires != null) {
    if (!SHARE_EXPIRY.some((e) => e.id === String(value.expires))) return { error: 'A template can expire links after a number of days, or never.' };
    out.expires = String(value.expires);
  }
  if (value.review != null) {
    if (!['view', ...REVIEW_LEVELS].includes(value.review)) return { error: 'Choose what people with the link can do.' };
    out.review = value.review;
  }
  if (value.downloads != null) {
    if (typeof value.downloads !== 'boolean') return { error: 'Choose whether people can download.' };
    out.downloads = value.downloads;
  }
  const views = value.views && typeof value.views === 'object' ? value.views : {};
  for (const target of ['file', 'folder']) {
    if (views[target] == null) continue;
    if (!SHARE_VIEWS[target].some((v) => v.id === views[target])) return { error: 'Choose how the page lays out what it shares.' };
    out.views[target] = views[target];
  }
  const { view: _ignored, ...lookOnly } = value.look && typeof value.look === 'object' ? value.look : {};
  const look = parseShareLook(lookOnly);
  if (look.error) return { error: look.error };
  out.look = look.look || {};
  return { settings: out };
}

/** A template's name, trimmed → { name } or { error }. */
export function parseTemplateName(value) {
  const name = typeof value === 'string' ? value.replace(CONTROL_LINE, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Name the template.' };
  if (name.length > TEMPLATE_NAME_MAX) return { error: `Keep the name to ${TEMPLATE_NAME_MAX} characters.` };
  return { name };
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
