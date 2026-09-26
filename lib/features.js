// Canonical registry of toggleable Onyx features.
//
// The saved state is a flat { key: boolean } map persisted in the `settings`
// table under the key 'features.flags' and merged over the defaults below —
// so adding a new flag here makes it appear without any migration, and a
// stale saved map never hides a feature that didn't exist when it was
// written. (Admin → Features, the editor for it, arrives with the admin
// overhaul; until then the defaults below are what every deployment runs.)
//
// Every flag here is read on the SERVER, by the routes that do the thing it
// names — see "Enforce feature flags on the server" in AGENTS.md. A flag the
// server did not read would be a switch that hid a button and left the
// route behind it open, which is worse than no switch: it looks like one.
// Four flags that were exactly that — mountInstaller, transferAcceleration,
// folderAcl and thumbnails — are gone. mergeFlags drops unknown keys, so a
// saved map that still has them loses them quietly.
//
// Flags are global. A role narrows what a person may do through its
// capabilities (lib/roles.js), not by turning flags off; principalFlags in
// lib/authz.js folds the two together for the UI.
//
// Onyx is a file workspace, so this list is deliberately short. Resist adding
// a flag for something that isn't genuinely optional: `files` itself has no
// flag because an Onyx with the library turned off is not Onyx.

export const FEATURE_FLAGS = [
  // ── Storage ──
  {
    key: 'filespaces',
    label: 'Drives & desktop mounts',
    category: 'Storage',
    default: true,
    enforcement: 'server',
    enforcedBy: '/api/space/* (drive listing, credentials, file downloads for the desktop apps)',
    description:
      'Named bucket+prefix scopes that people are granted access to, and the desktop app that mounts them as a local drive. Off, /api/space refuses every request, so installed desktop clients stop listing drives and minting new credentials.',
  },

  // ── Library ──
  {
    key: 'metadata',
    label: 'Metadata & facets',
    category: 'Library',
    default: true,
    enforcement: 'server',
    enforcedBy: 'PATCH /api/files/[id] (metadata), POST /api/admin/metadata',
    description:
      'The admin-defined metadata schema, the facet rail for filtering, and the per-file metadata editor. Off, files still carry tags and folders, and metadata edits are refused.',
  },
  {
    key: 'usageRights',
    label: 'Usage-rights expiry',
    category: 'Library',
    default: true,
    enforcement: 'server',
    enforcedBy: 'the daily maintenance run (expiry notices)',
    description:
      'Surface expired and soon-to-expire assets, driven by any date field in the metadata schema whose key matches /expir/. Off, the dates are still stored and editable but nothing is flagged and no notice is sent.',
  },
  {
    key: 'trash',
    label: 'Trash & restore',
    category: 'Library',
    default: true,
    enforcement: 'server',
    enforcedBy: 'DELETE /api/files/[id], DELETE /api/files/folders',
    description:
      'Soft-delete moves the object to a trash prefix and keeps the row, so a delete can be undone. Off, deleting a file is immediate and permanent.',
  },

  // ── Sharing & review ──
  {
    key: 'shares',
    label: 'Share links',
    category: 'Sharing',
    default: true,
    enforcement: 'server',
    enforcedBy: 'POST /api/files/[id]/shares, /s/<token>',
    description:
      'Revocable links to a file, optionally password-protected and expiring. Turning this off blocks /s/<token> for existing links too, not just the creation of new ones. Revoking a link always works.',
  },
  {
    key: 'review',
    label: 'Review & approval',
    category: 'Sharing',
    default: true,
    enforcement: 'server',
    enforcedBy: 'the review routes (comments, decisions, review links)',
    description:
      'Frame-accurate comments, annotations and approvals on files, and review links for people outside the workspace.',
  },

  // ── Access ──
  {
    key: 'inviteRequests',
    label: 'Request access',
    category: 'Access',
    default: true,
    enforcement: 'server',
    enforcedBy: 'the sign-in page and its request-access action',
    description:
      'Let an unknown email ask for access from the sign-in screen, landing in the admin queue. Off, only an admin can add someone.',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    category: 'Access',
    default: true,
    enforcement: 'server',
    enforcedBy: 'createNotification (lib/db.js)',
    description: 'The in-app bell — share views, access grants, and expiring usage rights. Off, nothing new is added to it.',
  },

  // ── AI ──
  {
    key: 'aiGenerate',
    label: 'AI generate & fix',
    category: 'AI',
    default: false,
    enforcement: 'server',
    enforcedBy: 'the AI routes (estimates and jobs)',
    superAdmin: true,
    description:
      'Generate and fix images and video with a paid provider, from inside the library. Off by default: turning it on needs a super-admin, the provider key, and an org AI budget above $0.',
  },
];

const BY_KEY = new Map(FEATURE_FLAGS.map((f) => [f.key, f]));

/** The feature a flag key belongs to, or undefined. */
export function getFlag(key) {
  return BY_KEY.get(key);
}

// ── Release phases ───────────────────────────────────────────────────────────
// ARMRA Quest staged its 40-odd features across phases because it launched a
// platform in slices. Onyx ships one product, so everything is GA and the
// mechanism is kept only for genuinely unfinished work: add a key to `soon` to
// hard-block it, or to `beta` to have it off for everyone but on for admins.
export const FEATURE_PHASES = {
  ga: FEATURE_FLAGS.map((f) => f.key),
  beta: [],
  soon: [],
};
const _GA = new Set(FEATURE_PHASES.ga);
const _SOON = new Set(FEATURE_PHASES.soon);

/** The release phase for a flag key: 'ga' | 'beta' | 'soon'. Unlisted → beta. */
export function flagPhase(key) {
  if (_SOON.has(key)) return 'soon';
  if (_GA.has(key)) return 'ga';
  return 'beta';
}

// Defaults as a flat map. A feature is on by default only when it is GA *and*
// its own `default` isn't false — so `aiGenerate` stays off until asked for.
export const DEFAULT_FLAGS = Object.fromEntries(
  FEATURE_FLAGS.map((f) => [f.key, flagPhase(f.key) === 'ga' && f.default !== false])
);

/**
 * Turn beta-phase features on for an admin so they can use unfinished work
 * while it stays off for everyone else. No-op for non-admins, and no-op
 * entirely while `beta` is empty — but it is the single source of truth for
 * that rule, so the nav and the route guards can never drift apart.
 */
export function applyBetaAdminFlags(flags, isAdminUser) {
  if (!isAdminUser) return flags;
  const out = { ...flags };
  for (const f of FEATURE_FLAGS) if (flagPhase(f.key) === 'beta') out[f.key] = true;
  return out;
}

/**
 * Merge a saved (possibly partial or stale) map over the defaults, keeping only
 * known boolean values. Unknown keys are dropped so a removed feature can't
 * linger; missing keys fall back to the default so a new one appears on deploy.
 */
export function mergeFlags(saved) {
  const out = { ...DEFAULT_FLAGS };
  if (saved && typeof saved === 'object') {
    for (const f of FEATURE_FLAGS) {
      if (typeof saved[f.key] === 'boolean') out[f.key] = saved[f.key];
    }
  }
  return out;
}

/**
 * Safe lookup. An unknown key reads as enabled: a typo in a guard should never
 * silently hide a working feature — it should be caught by the feature not
 * being in the registry, not by users losing access to it.
 */
export function isFeatureEnabled(flags, key) {
  if (!flags || typeof flags[key] !== 'boolean') return DEFAULT_FLAGS[key] !== false;
  return flags[key];
}
