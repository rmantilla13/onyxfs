// lib/share-form.js — the share dialog's form, as plain data: what it starts
// as, what a template or an existing link fills it with, and the requests it
// sends. Dependency-free besides lib/share-kinds.js, whose parsers the
// routes run on whatever this sends; nothing here decides anything they do
// not decide again.
//
// The form, for a link to `target` ('file' | 'folder'):
//
//   kind, password      who it is for (never filled from a template or a link)
//   review              'view' | 'comment' | 'approve'
//   downloads           boolean
//   expires             an id of SHARE_EXPIRY, 'date', or — editing — 'keep'
//   expiresAt           the date, as an <input type="datetime-local"> holds it
//   view, theme, brand, accent, logo, title, message, sender   the page's
//                       look; brand '' is the workspace's own, else a kit's
//                       id (lib/share-brands.js), and accent '' is the
//                       brand's — the kit's, when there is one

import { SHARE_EXPIRY, SHARE_KINDS, defaultView, resolveShareLook } from './share-kinds.js';

const DAY_MS = 86400000;
const pad = (n) => String(n).padStart(2, '0');

/** A time as an <input type="datetime-local"> shows it, in this browser's zone. */
export function toLocalInput(ms) {
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** What an <input type="datetime-local"> holds, as a time; null when it holds none. */
export function fromLocalInput(value) {
  if (typeof value !== 'string' || !value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/**
 * Where a date starts when someone picks "On a date…": two weeks out, or the
 * longest they may if that is sooner — rounded down to the hour, so never
 * past it.
 */
export function defaultDate(maxDays = null, now = Date.now()) {
  const days = maxDays != null ? Math.min(14, Number(maxDays)) : 14;
  const d = new Date(now + days * DAY_MS);
  d.setMinutes(0, 0, 0);
  return toLocalInput(d.getTime());
}

/**
 * The expiries someone may choose (`can` as the links list has it —
 * lib/share-guard.js linkChoices): the presets it allows, and whether a date
 * may be. Without `can`, all of them: the route refuses what it must.
 */
export function expiryChoices(can) {
  const presets = can ? SHARE_EXPIRY.filter((x) => can.expires?.includes(x.id)) : SHARE_EXPIRY;
  return { presets, date: !can || (can.expires?.length ?? 0) > 0, maxDays: can?.maxExpiryDays ?? null };
}

/** The expiry a new link's form starts on: never, where that may be chosen; else the longest that may. */
export function startingExpiry(can) {
  const { presets, date } = expiryChoices(can);
  if (presets.some((x) => x.id === 'never')) return 'never';
  if (presets.length) return presets[presets.length - 1].id;
  return date ? 'date' : 'never';
}

/** A new link's form. */
export function blankForm(target = 'file', can = null) {
  const kinds = can?.kinds?.length ? can.kinds : SHARE_KINDS.map((k) => k.id);
  const firstKind = target === 'folder' ? kinds.find((k) => k !== 'private') || 'public' : kinds[0] || 'public';
  return {
    kind: kinds.includes('public') ? 'public' : firstKind,
    password: '',
    review: 'view',
    downloads: true,
    expires: startingExpiry(can),
    expiresAt: '',
    view: defaultView(target),
    theme: 'auto',
    brand: '',
    accent: '',
    logo: 'workspace',
    title: '',
    message: '',
    sender: false,
  };
}

/**
 * A template's settings laid over `form`: whatever it names, as far as this
 * link can take it — a folder takes no private link and no comments, and a
 * kind or expiry `can` does not offer is left as it was rather than chosen
 * and refused. Never the password: one is typed for each link.
 */
export function applyTemplate(form, settings = {}, { target = 'file', can = null, reviewable = false } = {}) {
  const next = { ...form };
  const s = settings || {};
  const kinds = can?.kinds?.length ? can.kinds : SHARE_KINDS.map((k) => k.id);
  if (s.kind && kinds.includes(s.kind) && !(target === 'folder' && s.kind === 'private')) next.kind = s.kind;
  if (s.expires && expiryChoices(can).presets.some((x) => x.id === s.expires)) {
    next.expires = s.expires;
    next.expiresAt = '';
  }
  next.review = target === 'file' && reviewable && s.review ? s.review : 'view';
  if (typeof s.downloads === 'boolean') next.downloads = s.downloads;
  const look = resolveShareLook({ ...(s.look || {}), view: s.views?.[target] }, target);
  Object.assign(next, {
    view: look.view, theme: look.theme, brand: look.brand || '', accent: look.accent || '', logo: look.logo,
    title: look.title, message: look.message, sender: look.sender,
  });
  return next;
}

/**
 * The form with its kit kept only if it is one of `kits` (the dialog's list,
 * lib/share-brands.js presentKit): a template or a link that names a kit
 * since removed falls back to the workspace's look here, as its page does,
 * rather than sending an id the route would refuse.
 */
export function withKnownKit(form, kits = []) {
  if (!form.brand || kits.some((k) => k.id === form.brand)) return form;
  return { ...form, brand: '' };
}

/** The form for changing an existing link (presentShare's): its own settings, and its expiry kept. */
export function formFromShare(share, target = 'file') {
  const look = resolveShareLook(share?.look, target);
  return {
    kind: share?.kind || 'public',
    password: '',
    review: share?.review || 'view',
    downloads: share?.downloads !== false,
    expires: 'keep',
    expiresAt: share?.expiresAt ? toLocalInput(share.expiresAt) : '',
    view: look.view,
    theme: look.theme,
    brand: look.brand || '',
    accent: look.accent || '',
    logo: look.logo,
    title: look.title,
    message: look.message,
    sender: look.sender,
  };
}

/** The look a form describes, as a request takes it. */
export function lookOf(form) {
  return {
    view: form.view,
    theme: form.theme,
    brand: form.brand || null,
    accent: form.accent || null,
    logo: form.logo,
    title: form.title,
    message: form.message,
    sender: !!form.sender,
  };
}

const expiryOf = (form) => (form.expires === 'date'
  ? { expires: 'date', expiresAt: fromLocalInput(form.expiresAt) }
  : { expires: form.expires });

/** A new link's request (POST …/shares), from the form. */
export function createRequest(form, { target = 'file', reviewable = false } = {}) {
  const level = form.kind === 'private' ? 'view' : form.review;
  return {
    kind: form.kind,
    password: form.kind === 'password' ? form.password : undefined,
    ...expiryOf(form),
    review: target === 'file' && reviewable && level !== 'view' ? level : undefined,
    downloads: form.kind === 'private' ? true : !!form.downloads,
    look: lookOf(form),
  };
}

/**
 * A change to `share` (PATCH …/shares/[token]), from the form: its look and
 * downloads always, its level when it differs, its expiry unless kept.
 */
export function changeRequest(form, share, { target = 'file', reviewable = false } = {}) {
  const body = { look: lookOf(form) };
  if (share?.kind !== 'private') body.downloads = !!form.downloads;
  if (form.expires !== 'keep') Object.assign(body, expiryOf(form));
  const level = share?.kind === 'private' ? 'view' : form.review;
  if (target === 'file' && reviewable && level !== (share?.review || 'view')) body.review = level;
  return body;
}

/** A template's settings (POST /api/share-templates), from the form: never the password, never a date. */
export function templateSettings(form, target = 'file') {
  const { view, ...look } = lookOf(form);
  return {
    kind: form.kind,
    ...(form.expires !== 'date' && form.expires !== 'keep' ? { expires: form.expires } : {}),
    review: target === 'file' ? form.review : 'view',
    downloads: !!form.downloads,
    views: { [target]: view },
    look,
  };
}

/** The look a form describes, said in a few words for a closed section: "Gallery · Dark · Acme · No logo". */
export function lookSummary(form, views = [], kits = []) {
  const parts = [views.find((v) => v.id === form.view)?.label || null];
  if (form.theme === 'light') parts.push('Light');
  if (form.theme === 'dark') parts.push('Dark');
  if (form.brand) parts.push(kits.find((k) => k.id === form.brand)?.name || null);
  if (form.accent) parts.push('Own accent');
  if (form.logo === 'none') parts.push('No logo');
  if (form.title || form.message) parts.push('With a note');
  if (form.sender) parts.push('Your name');
  return parts.filter(Boolean).join(' · ');
}
