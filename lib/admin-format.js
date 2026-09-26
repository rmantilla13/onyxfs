/**
 * Small wording helpers for the admin panel. Client-safe and pure.
 */

/** "1 file", "1,204 files". */
export function plural(n, one, many = `${one}s`) {
  const v = Number(n) || 0;
  return `${v.toLocaleString('en-US')} ${v === 1 ? one : many}`;
}

const UNITS = [
  ['year', 365 * 24 * 3600e3],
  ['month', 30 * 24 * 3600e3],
  ['week', 7 * 24 * 3600e3],
  ['day', 24 * 3600e3],
  ['hour', 3600e3],
  ['minute', 60e3],
];

/**
 * When something happened, the way a person says it: "just now",
 * "5 minutes ago", "yesterday", "3 weeks ago". Future times read "in 2 days".
 * `now` is a parameter so the server and a test agree on it.
 */
export function relativeTime(ms, now = Date.now()) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = t - now;
  const abs = Math.abs(diff);
  if (abs < 45e3) return 'just now';
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  for (const [unit, size] of UNITS) {
    if (abs >= size) return fmt.format(Math.round(diff / size), unit);
  }
  return fmt.format(Math.round(diff / 60e3) || (diff < 0 ? -1 : 1), 'minute');
}
