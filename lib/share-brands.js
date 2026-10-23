// lib/share-brands.js — brand kits: other looks a share link's page may wear
// in place of the workspace's. Dependency-free: the admin form, the share
// dialog (client) and the routes and pages (server) read the same rules.
// Where they are kept is lib/db.js (getShareBrands, the settings row
// 'share.brands'); what applies one to the brand is lib/brand-config.js
// withKit.
//
// A kit is an admin's, never a sharer's: a name, a logo (light, and dark
// when the light one would vanish on the dark scheme), an accent, and a
// display font if the kit has its own. Only an admin types an image or a
// font address — the same rule as the workspace brand's — so a link can
// never be made to show a logo of a sharer's choosing, which would make
// every share page a page for phishing or a pixel for tracking. A sharer
// picks a kit by its id (lib/share-kinds.js look.brand), and that is all.
//
//   { id, name, logoUrl, logoDarkUrl?, accent, displayFontFamily?, displayFontUrl? }
//
// Stored as { kits: [...] }. A kit removed leaves the links that named it on
// the workspace brand: the page looks its id up each time, and an id with no
// kit is no kit (findKit).

export const KIT_NAME_MAX = 60;
export const KIT_URL_MAX = 400;
export const KIT_FONT_MAX = 200;
/** How many kits a workspace may keep: a dialog offers every one. */
export const MAX_KITS = 40;

const HEX = /^#[0-9a-fA-F]{6}$/;
const KIT_ID = /^[A-Za-z0-9_-]{6,40}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_LINE = /[\u0000-\u001f\u007f\u2028\u2029]/g;
// What could end a declaration or the <style> a font is written into
// (lib/brand-config.js cssValue drops them; here they are refused, so an
// admin is told rather than shown a font that is not the one typed).
const CSS_BREAK = /[<>{};\\]/;

/** Whether `id` has the shape of a kit's id. Nothing is looked up. */
export const isKitId = (id) => typeof id === 'string' && KIT_ID.test(id);

/**
 * An address for a kit's logo or font → { url } ('' when blank) or
 * { error }. https, or a path on this site ("/brand/acme.svg"): an http
 * image is blocked on an https page, and anything else — javascript:,
 * data:, a protocol-relative "//host" — is not an image we serve.
 */
export function parseKitUrl(value, what = 'The logo') {
  if (value == null || value === '') return { url: '' };
  if (typeof value !== 'string') return { error: `${what} has to be an address.` };
  const url = value.trim();
  if (!url) return { url: '' };
  if (url.length > KIT_URL_MAX) return { error: `${what}’s address is too long.` };
  if (/[\s"'<>\\]/.test(url)) return { error: `${what}’s address has a space or a character an address cannot.` };
  if (url.startsWith('/')) {
    if (url.startsWith('//')) return { error: `${what} needs an address that starts https:// or /.` };
    return { url };
  }
  let parsed;
  try { parsed = new URL(url); } catch { return { error: `${what} needs an address that starts https:// or /.` }; }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return { error: `${what} needs an address that starts https:// or /.` };
  return { url };
}

/**
 * An admin's kit, as the form sends it → { kit } (without its id, which the
 * route gives it) or { error }, a sentence for the form. Refused, never
 * trimmed to fit, as a link's look is.
 */
export function parseBrandKit(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'Fill in the kit.' };
  const name = typeof value.name === 'string' ? value.name.replace(CONTROL_LINE, ' ').replace(/\s+/g, ' ').trim() : '';
  if (!name) return { error: 'Name the kit.' };
  if (name.length > KIT_NAME_MAX) return { error: `Keep the name to ${KIT_NAME_MAX} characters.` };

  const logo = parseKitUrl(value.logoUrl, 'The logo');
  if (logo.error) return { error: logo.error };
  if (!logo.url) return { error: 'Give the kit a logo: the address of its image.' };
  const dark = parseKitUrl(value.logoDarkUrl, 'The dark logo');
  if (dark.error) return { error: dark.error };

  const accent = typeof value.accent === 'string' ? value.accent.trim() : '';
  if (!HEX.test(accent)) return { error: 'Choose the kit’s accent colour as #RRGGBB.' };

  const family = typeof value.displayFontFamily === 'string' ? value.displayFontFamily.replace(CONTROL_LINE, ' ').trim() : '';
  if (family.length > KIT_FONT_MAX) return { error: 'The font’s name is too long.' };
  if (CSS_BREAK.test(family)) return { error: 'Write the font as CSS names it, such as Fraunces, serif.' };
  const fontUrl = parseKitUrl(value.displayFontUrl, 'The font');
  if (fontUrl.error) return { error: fontUrl.error };
  if (fontUrl.url && !family) return { error: 'Name the font the stylesheet loads, or leave its address blank.' };

  const kit = { name, logoUrl: logo.url, accent: accent.toUpperCase() };
  if (dark.url) kit.logoDarkUrl = dark.url;
  if (family) kit.displayFontFamily = family;
  if (fontUrl.url) kit.displayFontUrl = fontUrl.url;
  return { kit };
}

/**
 * The kits in a stored blob, each read through parseBrandKit again: one
 * written by a later version, or by hand, that this one cannot read is left
 * out, not served half-checked.
 */
export function readKits(stored) {
  const list = Array.isArray(stored?.kits) ? stored.kits : [];
  const out = [];
  for (const raw of list) {
    if (!raw || !isKitId(raw.id)) continue;
    const { kit } = parseBrandKit(raw);
    if (kit) out.push({ id: raw.id, ...kit, ...(Number.isFinite(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}) });
  }
  return out;
}

/** The kit `id` names in a stored blob, or null: no id, an unknown one, or one since removed. */
export function findKit(stored, id) {
  if (!isKitId(id)) return null;
  return readKits(stored).find((k) => k.id === id) || null;
}

/** Whether `name` is already another kit's, in any case. */
export function kitNameTaken(kits, name, exceptId = null) {
  const n = String(name || '').toLowerCase();
  return kits.some((k) => k.id !== exceptId && k.name.toLowerCase() === n);
}

/** What a sharer's dialog is shown of a kit: enough to tell kits apart, nothing about who made it. */
export const presentKit = (k) => ({
  id: k.id, name: k.name, accent: k.accent, logoUrl: k.logoUrl, logoDarkUrl: k.logoDarkUrl || null,
});
