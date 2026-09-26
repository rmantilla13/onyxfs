// lib/policy.js — the org's ceilings, and each person's effective limits.
//
// Stored under the settings key 'policy.limits'. Every number is a CEILING:
// a role or a per-person override can sit below it, never above. null means
// no limit. Pure, so the arithmetic that decides whether an upload is
// refused can be tested without a database.
//
// The defaults change nothing at deploy: storage and uploads are unlimited,
// as they were, and every AI budget is $0 — AI stays off until the owner
// sets one.

export const DEFAULT_POLICY = {
  storageQuotaBytes: null,       // bytes one person may have added
  maxUploadBytes: null,          // largest single upload (the provider's own max still applies)
  aiMonthlyBudgetCents: 0,       // the org's AI spend per month; 0 = AI off
  aiPerJobMaxCents: 200,         // no single job may cost more
  aiConcurrency: 4,              // jobs running at once, org-wide
  shareMaxExpiryDays: null,      // longest a link may last; null = may never expire
  drivesSelfServe: false,        // may people who are not admins create drives?
  drivesPerPerson: 5,            // …and how many each
  selfServeParentPrefix: 'drives/', // …under which prefix in the bucket
};

const NULLABLE = ['storageQuotaBytes', 'maxUploadBytes', 'shareMaxExpiryDays'];
const COUNTS = ['aiMonthlyBudgetCents', 'aiPerJobMaxCents', 'aiConcurrency', 'drivesPerPerson'];

// The settings only a super-admin may change: the ones that spend money.
export const SUPER_ADMIN_POLICY_KEYS = ['aiMonthlyBudgetCents', 'aiPerJobMaxCents', 'aiConcurrency'];

const isWhole = (v) => Number.isInteger(v) && v >= 0;

function cleanPrefix(p) {
  const s = String(p || '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s || s.split('/').some((seg) => !seg || seg === '.' || seg === '..')) return null;
  if (/^(_thumbs|_trash)(\/|$)/.test(s)) return null;
  return `${s}/`;
}

/** A stored policy (or nothing) → a complete one. A bad field reads as its default. */
export function parsePolicy(saved) {
  const out = { ...DEFAULT_POLICY };
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const k of NULLABLE) if (k in saved && (saved[k] === null || isWhole(saved[k]))) out[k] = saved[k];
  for (const k of COUNTS) if (isWhole(saved[k])) out[k] = saved[k];
  if (typeof saved.drivesSelfServe === 'boolean') out.drivesSelfServe = saved.drivesSelfServe;
  const prefix = cleanPrefix(saved.selfServeParentPrefix);
  if (prefix) out.selfServeParentPrefix = prefix;
  return out;
}

/**
 * A PATCH-style policy change → { policy, changed } | { error }. Strict,
 * where parsePolicy forgives: an admin who typed a negative quota should be
 * told, not have it quietly read as "no limit". The money fields need a
 * super-admin (`superAdmin`); `changed` lists the keys that moved, for the
 * audit row.
 */
export function validatePolicy(input, current, { superAdmin = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { error: 'Send an object of policy fields.' };
  const base = parsePolicy(current);
  const next = { ...base };
  for (const [k, v] of Object.entries(input)) {
    if (!(k in DEFAULT_POLICY)) return { error: `Unknown policy field "${k}".` };
    if (SUPER_ADMIN_POLICY_KEYS.includes(k) && v !== base[k] && !superAdmin) {
      return { error: `Only a super-admin can change ${k}.`, status: 403 };
    }
    if (NULLABLE.includes(k)) {
      if (!(v === null || isWhole(v))) return { error: `${k} must be a whole number of 0 or more, or null for no limit.` };
    } else if (COUNTS.includes(k)) {
      if (!isWhole(v)) return { error: `${k} must be a whole number of 0 or more.` };
    } else if (k === 'drivesSelfServe') {
      if (typeof v !== 'boolean') return { error: 'drivesSelfServe must be true or false.' };
    } else if (k === 'selfServeParentPrefix') {
      const p = cleanPrefix(v);
      if (!p) return { error: 'selfServeParentPrefix must be a folder path in the bucket, such as "drives/".' };
      next[k] = p;
      continue;
    }
    next[k] = v;
  }
  const changed = Object.keys(DEFAULT_POLICY).filter((k) => next[k] !== base[k]);
  return { policy: next, changed };
}

/** The smaller of two limits, where null is "no limit". */
export function minLimit(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.min(a, b);
}

/**
 * One person's limits: min(org ceiling, their override ?? their role's
 * value), for each. `person` carries the overrides (quotaBytes,
 * maxUploadBytes, aiMonthlyCents; null = the role's value).
 *
 * Admins: no storage quota, no upload limit beyond the provider's own, no
 * link expiry, and AI spend that counts against the org budget alone. An
 * admin held back by a ceiling they set for everyone else could not clear
 * the space the ceiling was protecting.
 */
export function effectiveLimits({ role, person = null, policy, isAdmin = false }) {
  const p = parsePolicy(policy);
  if (isAdmin) {
    return {
      storageQuotaBytes: null,
      maxUploadBytes: null,
      aiMonthlyCents: p.aiMonthlyBudgetCents,
      shareMaxExpiryDays: null,
      driveCeiling: 'owner',
    };
  }
  const r = role?.limits || {};
  const own = (override, roleValue) => (override != null ? override : (roleValue === undefined ? null : roleValue));
  return {
    storageQuotaBytes: minLimit(p.storageQuotaBytes, own(person?.quotaBytes, r.storageQuotaBytes)),
    maxUploadBytes: minLimit(p.maxUploadBytes, own(person?.maxUploadBytes, r.maxUploadBytes)),
    aiMonthlyCents: minLimit(p.aiMonthlyBudgetCents, own(person?.aiMonthlyCents, r.aiMonthlyCents ?? 0)),
    shareMaxExpiryDays: minLimit(p.shareMaxExpiryDays, r.shareMaxExpiryDays ?? null),
    driveCeiling: r.driveCeiling || 'owner',
  };
}

/**
 * Whether a per-person override is allowed: a whole number or null, and
 * never above the org's ceiling for it. Returns an error sentence or null.
 */
export function overrideProblem(key, value, policy) {
  if (value === null) return null;
  if (!isWhole(value)) return `${key} must be a whole number of 0 or more, or null for the role's value.`;
  const p = parsePolicy(policy);
  const ceiling = { quotaBytes: p.storageQuotaBytes, maxUploadBytes: p.maxUploadBytes, aiMonthlyCents: p.aiMonthlyBudgetCents }[key];
  if (ceiling != null && value > ceiling) return `${key} cannot be above the org's ceiling of ${ceiling}.`;
  return null;
}

