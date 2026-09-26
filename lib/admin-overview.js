/**
 * Admin → Overview's "Needs attention" list, from what the panel can see
 * today: people waiting for access, drives nobody owns, and whatever the
 * health checks (storage included) flag. Client-safe and pure, so the page
 * and its test agree on what makes the list.
 *
 * Each item: { id, tone: 'danger'|'warning', title, detail?, href, action }.
 * Failures come before warnings; within each, the order below.
 *
 * Still to come with Phase 1 (they need data that does not exist yet):
 * legacy Admin-role holders, a failed maintenance run or schema guard, and
 * AI jobs in an unknown state.
 */

import { plural } from './admin-format.js';

const names = (list, max = 3) => {
  const shown = list.slice(0, max).map((x) => x.name || x.email).filter(Boolean);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
};

// Health rows that are really about storage are fixed on the Backend page;
// the rest on Health.
const STORAGE_CHECKS = new Set(['storage']);

export function attentionItems({ pending = [], drivesWithoutOwner = [], health = null } = {}) {
  const items = [];

  const checks = Array.isArray(health?.checks) ? health.checks : [];
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    const storage = STORAGE_CHECKS.has(c.id);
    items.push({
      id: `health-${c.id}`,
      tone: c.status === 'fail' ? 'danger' : 'warning',
      title: c.label,
      detail: [c.detail, c.fix].filter(Boolean).join(' '),
      href: storage ? '/admin/storage' : '/admin/health',
      action: storage ? 'Open storage' : 'Open health',
    });
  }

  const waiting = Array.isArray(pending) ? pending : [];
  if (waiting.length) {
    items.push({
      id: 'requests',
      tone: 'warning',
      title: `${plural(waiting.length, 'person is', 'people are')} waiting for access`,
      detail: names(waiting),
      href: '/admin/requests',
      action: 'Review',
    });
  }

  const orphans = Array.isArray(drivesWithoutOwner) ? drivesWithoutOwner : [];
  if (orphans.length === 1) {
    items.push({
      id: `drive-${orphans[0].id}`,
      tone: 'warning',
      title: `“${orphans[0].name}” has no owner`,
      detail: 'Only admins can manage its members until someone owns it.',
      href: `/admin/drives/${encodeURIComponent(orphans[0].id)}#members`,
      action: 'Add an owner',
    });
  } else if (orphans.length > 1) {
    items.push({
      id: 'drives-no-owner',
      tone: 'warning',
      title: `${plural(orphans.length, 'drive has', 'drives have')} no owner`,
      detail: `${names(orphans)}. Only admins can manage their members until someone owns them.`,
      href: '/admin/drives',
      action: 'Open drives',
    });
  }

  const rank = { danger: 0, warning: 1 };
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => rank[a.item.tone] - rank[b.item.tone] || a.i - b.i)
    .map((x) => x.item);
}
