import { activeHref } from '../../lib/section-nav.js';

/**
 * ADMIN_NAV — the admin rail, in the groups and order of the design
 * (proposal §2.1). This is the one place a section is added to the panel.
 *
 * Sections that are not built yet are left out rather than shown as dead
 * links; each has its line below, commented, at the place it goes. Uncomment
 * it in the change that adds its page. `badge` names a count the layout
 * supplies (see app/admin/layout.js); a group with no items is not drawn.
 */
export const ADMIN_NAV = [
  {
    items: [
      { href: '/admin', label: 'Overview', exact: true },
    ],
  },
  {
    label: 'People',
    items: [
      // { href: '/admin/people', label: 'People' },                       // Phase 1: people table
      { href: '/admin/requests', label: 'Access requests', badge: 'pendingRequests' },
      // { href: '/admin/roles', label: 'Roles & limits' },                // Phase 1: roles v2, policy limits
    ],
  },
  {
    label: 'Content',
    items: [
      { href: '/admin/drives', label: 'Drives' },
      // { href: '/admin/links', label: 'Shared links' },                  // Phase 2a, part 2
      // { href: '/admin/trash', label: 'Trash' },                         // Phase 2a, part 2
    ],
  },
  {
    label: 'Storage',
    items: [
      { href: '/admin/usage', label: 'Usage' },
      { href: '/admin/usage/duplicates', label: 'Duplicates' },
      { href: '/admin/storage', label: 'Backend' },
    ],
  },
  {
    label: 'AI',
    items: [
      // { href: '/admin/ai', label: 'Generation' },                       // Phase 5
    ],
  },
  {
    label: 'System',
    items: [
      // Becomes "Health & maintenance" when the maintenance card lands (Phase 1).
      { href: '/admin/health', label: 'Health' },
      // { href: '/admin/activity', label: 'Activity' },                   // Phase 1: audit_events
      // { href: '/admin/features', label: 'Features' },                   // Phase 1: flag cleanup
    ],
  },
];

/** The rail with its badges filled in: `counts` maps a badge name to a number. */
export function railGroups(counts = {}) {
  return ADMIN_NAV.map((g) => ({
    ...g,
    items: g.items.map(({ badge, ...item }) => {
      const n = badge ? Number(counts[badge]) || 0 : 0;
      return n ? { ...item, count: n, countLabel: `${n} waiting` } : item;
    }),
  }));
}

/**
 * The name of the section a path is in, as the rail says it ("Drives" for
 * a drive's drawer too), or null outside the panel. For an error that has
 * to say which section failed without being told (app/admin/error.js
 * catches the sections' layouts as well as the Overview).
 */
export function sectionLabel(pathname) {
  const items = ADMIN_NAV.flatMap((g) => g.items);
  const href = activeHref(pathname, items);
  return href ? items.find((i) => i.href === href)?.label || null : null;
}
