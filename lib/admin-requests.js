/**
 * Admin → Access requests: which requests a filter shows, how many each
 * has, and how a request describes itself. Client-safe and pure.
 */

/**
 * The filters, in the order they are offered. Approved is here only until
 * People (Phase 1) lists everyone who can sign in; it is where access is
 * revoked meanwhile.
 */
export const REQUEST_FILTERS = [
  { key: 'pending', label: 'Waiting', empty: 'No one is waiting.' },
  { key: 'denied', label: 'Denied', empty: 'No requests have been denied.' },
  { key: 'approved', label: 'Approved', empty: 'No one has been approved yet.' },
];

/** The filter a ?status= value asks for; anything unknown is the queue. */
export function requestFilter(value) {
  const v = String(Array.isArray(value) ? value[0] : value ?? '').trim().toLowerCase();
  return REQUEST_FILTERS.some((f) => f.key === v) ? v : 'pending';
}

/** How many requests each filter holds. */
export function requestCounts(rows = []) {
  const out = Object.fromEntries(REQUEST_FILTERS.map((f) => [f.key, 0]));
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r && Object.hasOwn(out, r.status)) out[r.status] += 1;
  }
  return out;
}

/**
 * One filter's requests, newest first: the queue by when they asked, the
 * decided ones by when they were decided.
 */
export function requestsFor(rows = [], status = 'pending') {
  const at = (r) => Number(status === 'pending' ? r.requestedAt : (r.reviewedAt || r.requestedAt)) || 0;
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r?.status === status)
    .sort((a, b) => at(b) - at(a) || String(a.email).localeCompare(String(b.email)));
}

/**
 * "Asked 3 times", for someone who has asked more than once — or '' when
 * they have not, or when the row does not say. The request table keeps one
 * row per address and does not count repeats yet (Phase 1 extends it); the
 * line appears as soon as a row carries `requestCount`.
 */
export function askedLabel(row) {
  const n = Number(row?.requestCount ?? row?.timesAsked) || 0;
  return n > 1 ? `Asked ${n} times` : '';
}
