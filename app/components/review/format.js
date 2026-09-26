// Small presentation helpers shared by the review components.

/** What to call someone: the name they gave, else the part of the address before the @. */
export function personLabel(person) {
  if (!person) return 'Someone';
  if (person.name) return person.name;
  const email = String(person.email || '');
  return email ? email.split('@')[0] : 'Someone';
}

/** One or two letters for an avatar. */
export function initials(person) {
  const label = personLabel(person).trim();
  const parts = label.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : label.slice(0, 2);
  return letters.toUpperCase();
}

/** "just now", "5m", "3h", "2d", then a date — how long ago, at a glance. */
export function ago(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The handle a mention is written as in a comment: the address before the @. */
export const handleOf = (email) => String(email || '').split('@')[0];
