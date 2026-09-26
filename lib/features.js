// Canonical registry of toggleable Onyx features.
//
// Admins flip these in /admin → Features. The saved state is a flat
// { key: boolean } map persisted in the `settings` table under the key
// 'features.flags' and merged over the defaults below — so adding a new flag
// here makes it appear without any migration, and a stale saved map never
// hides a feature that didn't exist when it was written.
//
// `enforcement` documents what turning a flag OFF actually does:
//   'route' — the nav entry is hidden AND the page/API is blocked
//   'nav'   — the nav entry is hidden (the page still resolves by URL)
//   'ui'    — one specific control is hidden or disabled
//
// Onyx is a file workspace, so this list is deliberately short. Resist adding
// a flag for something that isn't genuinely optional: `files` itself has no
// flag because an Onyx with the library turned off is not Onyx.

export const FEATURE_FLAGS = [
  // ── Storage ──
  {
    key: 'filespaces',
    label: 'Filespaces & desktop mounts',
    category: 'Storage',
    default: true,
    enforcement: 'route',
    description:
      'Named bucket+prefix scopes that people are granted access to, and the desktop app that mounts them as a local drive. Turning this off also cuts off /api/space, so already-installed desktop clients stop minting new credentials.',
  },
  {
    key: 'mountInstaller',
    label: 'Legacy mount installer (.command)',
    category: 'Storage',
    default: false,
    enforcement: 'ui',
    description:
      'Offer the generated macFUSE installer script as a download. Off by default — it needs Homebrew, a kernel extension approval and usually a reboot. The desktop app does the same job over NFS with none of that, so this is only for machines that cannot install it.',
  },
  {
    key: 'transferAcceleration',
    label: 'S3 Transfer Acceleration control',
    category: 'Storage',
    default: true,
    enforcement: 'ui',
    description:
      'Let admins toggle Transfer Acceleration on the bucket from Admin → Storage. Requires s3:PutAccelerateConfiguration on the key, and is AWS-only (not available on R2, Spaces, or any custom endpoint).',
  },

  // ── Library ──
  {
    key: 'metadata',
    label: 'Metadata & facets',
    category: 'Library',
    default: true,
    enforcement: 'ui',
    description:
      'The admin-defined metadata schema, the facet rail for filtering, and the per-file metadata editor. Off, files still carry tags and folders.',
  },
  {
    key: 'usageRights',
    label: 'Usage-rights expiry',
    category: 'Library',
    default: true,
    enforcement: 'ui',
    description:
      'Surface expired and soon-to-expire assets, driven by any date field in the metadata schema whose key matches /expir/. Off, the dates are still stored and editable but nothing is flagged.',
  },
  {
    key: 'trash',
    label: 'Trash & restore',
    category: 'Library',
    default: true,
    enforcement: 'ui',
    description:
      'Soft-delete moves the object to a trash prefix and keeps the row, so a delete can be undone. Off, deleting a file is immediate and permanent.',
  },
  {
    key: 'thumbnails',
    label: 'Server-side thumbnails',
    category: 'Library',
    default: true,
    enforcement: 'ui',
    description:
      'Generate and cache thumbnails for images and video posters. Off, the grid falls back to presigned originals, which is slower and moves far more bytes.',
  },

  {
    key: 'review',
    label: 'Review & approval',
    category: 'Library',
    default: true,
    enforcement: 'route',
    description:
      'Comments pinned to a frame, a range or a point on a picture, drawings, @mentions, and Approve / Request changes, with the status shown in the grid. Off, the review routes refuse every request and the detail page shows no comments; what was said is kept.',
  },

  // ── Sharing ──
  {
    key: 'shares',
    label: 'Public share links',
    category: 'Sharing',
    default: true,
    enforcement: 'route',
    description:
      'Revocable public links to a file or a folder, optionally password-protected and expiring. Turning this off blocks /s/<token> for existing links too, not just the creation of new ones.',
  },
  {
    key: 'folderAcl',
    label: 'Per-folder access control',
    category: 'Sharing',
    default: true,
    enforcement: 'ui',
    description:
      'Grant folders to specific people or roles. Off, folder visibility follows the filespace grant alone.',
  },

  // ── Access ──
  {
    key: 'inviteRequests',
    label: 'Request access',
    category: 'Access',
    default: true,
    enforcement: 'ui',
    description:
      'Let an unknown email ask for access from the sign-in screen, landing in the admin queue. Off, only an admin can add someone.',
  },
  {
    key: 'notifications',
    label: 'Notifications',
    category: 'Access',
    default: true,
    enforcement: 'ui',
    description: 'The in-app bell — share views, access grants, and expiring usage rights.',
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
// its own `default` isn't false — so `mountInstaller` stays off until asked for.
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
