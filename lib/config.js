// lib/config.js
// ─────────────────────────────────────────────────────────────────────────────
// Runtime config / key override layer.
//
// Keys normally come from Vercel env vars (process.env). Those can't be edited
// by the running app. This layer lets an admin SET a key value from the admin
// panel; the value is stored in the settings table under `secret.<NAME>` and
// takes precedence over the env var at runtime.
//
// How overrides take effect: hydrateConfigEnv() copies stored overrides into
// process.env (for KNOWN keys only), so the existing `process.env.X` reads
// scattered across the codebase pick them up without rewiring every consumer.
// A snapshot of the original env is kept so clearing an override restores the
// real env var (within a warm instance). It's eventually-consistent across
// serverless instances on a short TTL; admin save/clear refreshes immediately
// in the instance that handled the request.
//
// Never log or return secret VALUES to the client — list endpoints expose
// presence/source only.
// ─────────────────────────────────────────────────────────────────────────────

import { listSettings, setSetting, deleteSetting } from './db.js';
import { INTEGRATIONS } from './integrations.js';

const PREFIX = 'secret.';

// Snapshot the real env once, at module load, before anything mutates it.
const BASE_ENV = { ...process.env };

// Keys we will NEVER override from the DB (overriding the DB connection from
// the DB is circular; auth/runtime basics stay env-only).
export const LOCKED_KEYS = new Set([
  'DATABASE_URL',
  // Session signing: an override stored behind the session it signs is
  // circular, and rotating it from the panel would lock everyone out mid-request.
  'AUTH_SECRET',
  'POSTGRES_URL',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL_NON_POOLING',
  'NODE_ENV',
  'VERCEL',
  'VERCEL_ENV',
  'VERCEL_REGION',
]);

// Keys whose value is not sensitive — safe to render in the panel.
export const NON_SECRET_KEYS = new Set([
  'NOTIFY_FROM',
  'NEXT_PUBLIC_APP_URL',
  'ADMIN_EMAILS',
  'SUPER_ADMIN_EMAILS',
  'AUTH_TRUST_HOST',
  'AUTH_OKTA_ISSUER',
  'AUTH_OKTA_ID',
]);

// Extra editable keys not covered by the integrations registry.
const EXTRA_KEYS = [
  'NEXT_PUBLIC_APP_URL',
  'ADMIN_EMAILS',
  'SUPER_ADMIN_EMAILS',
];

function deriveKnownKeys() {
  const set = new Set();
  for (const i of INTEGRATIONS) for (const v of i.envVars || []) set.add(v);
  for (const k of EXTRA_KEYS) set.add(k);
  for (const k of LOCKED_KEYS) set.delete(k);
  return [...set].sort();
}

export const KNOWN_KEYS = deriveKnownKeys();
const KNOWN_SET = new Set(KNOWN_KEYS);

function groupFor(key) {
  const i = INTEGRATIONS.find((it) => (it.envVars || []).includes(key));
  return i ? i.name : 'Other';
}

// ── overlay cache ────────────────────────────────────────────────────────────
let _overlay = {}; // { KEY: value } currently-applied overrides
let _overlayAt = 0;
const TTL_MS = 30_000;

async function loadOverrides() {
  const rows = await listSettings(PREFIX).catch(() => []);
  const map = {};
  for (const r of rows) {
    const key = r.key.slice(PREFIX.length);
    if (!KNOWN_SET.has(key) || LOCKED_KEYS.has(key)) continue;
    const v = r.value;
    if (typeof v === 'string' && v.length > 0) map[key] = v;
  }
  return map;
}

/**
 * Copy stored overrides into process.env for KNOWN keys, and restore the
 * original env for any KNOWN key no longer overridden. Idempotent + TTL-cached.
 * Never throws.
 */
export async function hydrateConfigEnv(force = false) {
  if (!force && Date.now() - _overlayAt < TTL_MS) return Object.keys(_overlay).length;
  try {
    const map = await loadOverrides();
    // Apply overrides + restore baseline for cleared keys (KNOWN keys only).
    for (const key of KNOWN_KEYS) {
      if (Object.prototype.hasOwnProperty.call(map, key)) {
        process.env[key] = map[key];
      } else if (Object.prototype.hasOwnProperty.call(_overlay, key)) {
        // Was overridden before, now cleared → restore original env value.
        if (Object.prototype.hasOwnProperty.call(BASE_ENV, key)) process.env[key] = BASE_ENV[key];
        else delete process.env[key];
      }
    }
    _overlay = map;
    _overlayAt = Date.now();
    return Object.keys(map).length;
  } catch (e) {
    console.warn('[config] hydrate failed:', e.message);
    return Object.keys(_overlay).length;
  }
}

/** Resolve a single key: DB override → live process.env. */
export async function getConfig(name) {
  await hydrateConfigEnv();
  return process.env[name];
}

/** Set (or update) an override for a key. Admin-gated by the caller. */
export async function setConfigOverride(name, value, by) {
  if (!KNOWN_SET.has(name)) throw new Error(`Unknown key "${name}"`);
  if (LOCKED_KEYS.has(name)) throw new Error(`"${name}" is locked and can't be overridden here.`);
  await setSetting(`${PREFIX}${name}`, String(value ?? ''), by);
  await hydrateConfigEnv(true);
  return true;
}

/** Clear an override, reverting the key to its Vercel env value. */
export async function clearConfigOverride(name) {
  if (!KNOWN_SET.has(name)) throw new Error(`Unknown key "${name}"`);
  await deleteSetting(`${PREFIX}${name}`);
  await hydrateConfigEnv(true);
  return true;
}

/**
 * Presence/source for every editable key — NEVER includes secret values.
 * source: 'db' (overridden in app) | 'env' (from Vercel) | 'none' (unset).
 */
export async function listConfigKeys() {
  await hydrateConfigEnv(true);
  return KNOWN_KEYS.map((key) => {
    const overridden = Object.prototype.hasOwnProperty.call(_overlay, key);
    const effective = process.env[key];
    const set = typeof effective === 'string' && effective.length > 0;
    const secret = !NON_SECRET_KEYS.has(key);
    return {
      key,
      group: groupFor(key),
      set,
      secret,
      source: overridden ? 'db' : set ? 'env' : 'none',
      // Only reveal non-secret values; secrets stay masked.
      value: !secret && set ? effective : null,
    };
  });
}
