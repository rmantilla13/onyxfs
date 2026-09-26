/**
 * Which item of a section rail (app/components/ui/SectionRail.js) is the page
 * being shown. Pure, so the rule is tested without a router.
 *
 * The longest href that is the path itself or a parent of it wins, so
 * /admin/usage/duplicates lights Duplicates rather than Usage, and a drive's
 * drawer at /admin/drives/<id> keeps Drives lit. An item marked `exact` —
 * an overview at the root of the section — is lit only on its own path;
 * otherwise it would claim every page under it that has no item of its own.
 *
 * `items` are hrefs, or { href, exact }. Returns the matching href, or null.
 */
export function activeHref(pathname, items = []) {
  const trim = (p) => String(p || '').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
  const path = trim(pathname);
  let best = null;
  let bestLen = -1;
  for (const item of items) {
    const href = typeof item === 'string' ? item : item?.href;
    if (!href) continue;
    const exact = typeof item === 'object' && !!item.exact;
    const h = trim(href);
    const hit = path === h || (!exact && (h === '/' || path.startsWith(`${h}/`)));
    if (hit && h.length > bestLen) { best = href; bestLen = h.length; }
  }
  return best;
}
