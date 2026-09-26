// lib/authz.js — may this person do this? Server-only (it reads the database),
// and never imported by middleware or auth.config.js.
//
// Every permission question in Onyx is answered here, from one principal
// that the web, the desktop app and STS all build the same way. Before this
// the answer was spread across places that disagreed: literal
// `roleId === 'viewer'` checks, an env-only isAdmin, and a desktop-only
// isOwnerActor that let a role ADD power. Now:
//
//   getPrincipal(email)       who they are, what their role lets them do,
//                             their limits, the flags as they see them, and
//                             their drives with each role already capped
//   can(principal, action, r) the decision — pure, so it is tested as a
//                             matrix rather than trusted
//   requireCan(req, action)   the route helper: session → principal → can
//
// A permission is granted only when every layer allows it — admission (see
// lib/session.js), the platform capability, access to the resource (drive
// role, creator, a direct grant) and the org's flags and policy — and every
// layer can only take away. The one exception is an env admin, who is
// implicitly owner of everything, as ever.
//
// FAILING CLOSED. The role config, the flags and the policy are read
// strictly, and each instance keeps the last copy it read successfully. If a
// read fails and there is no copy, the principal is `degraded`: it reads with
// Viewer capabilities, and every write answers 503 ("Couldn't check your
// permissions") rather than guessing — the old behaviour was to fall back to
// defaults, which quietly re-enabled whatever an admin had turned off.

import {
  getSetting, loadDriveGrants, folderGrantsFor, getPersonByEmail, usedBytesBy, countFilesUnderPrefix,
} from './db.js';
import { isAdmin as isEnvAdmin, isSuperAdmin as isEnvSuperAdmin } from './auth-allowlist.js';
import {
  parseRolesConfig, resolveRole, roleCaps, capDriveRole, isCapability, BUILTIN_ROLES,
} from './roles.js';
import { parsePolicy, effectiveLimits } from './policy.js';
import { mergeFlags, applyBetaAdminFlags, DEFAULT_FLAGS } from './features.js';
import { drivePatterns, driveAccess, drivesHolding } from './drive-access.js';
import { fmtSize } from './media.js';

export const DEGRADED_MESSAGE = 'Couldn’t check your permissions. Try again.';

// ── Settings, read strictly, with a last-known-good copy ───────────────────
const lastGood = new Map();

async function readSetting(key) {
  try {
    const value = await getSetting(key, { strict: true });
    lastGood.set(key, value);
    return { value, ok: true };
  } catch {
    if (lastGood.has(key)) return { value: lastGood.get(key), ok: true, stale: true };
    return { value: null, ok: false };
  }
}

/**
 * The three settings every decision rests on. Read one after another on
 * purpose: getSetting fetches the whole (small) settings table on a miss and
 * caches every row, so the second and third are cache hits rather than two
 * more queries queued behind the first on the one connection.
 */
export async function loadAuthzSettings() {
  const roles = await readSetting('roles.config');
  const flags = await readSetting('features.flags');
  const policy = await readSetting('policy.limits');
  return {
    rolesConfig: parseRolesConfig(roles.value),
    globalFlags: flags.ok ? mergeFlags(flags.value) : null,
    policy: parsePolicy(policy.value),
    degraded: !(roles.ok && flags.ok && policy.ok),
  };
}

/**
 * The global flags alone, for the places that act on a flag without a
 * person — a public share link, the maintenance run. null when they could
 * not be read and no earlier copy exists: the caller refuses, rather than
 * serving on defaults an admin may have turned off.
 */
export async function readGlobalFlags() {
  const r = await readSetting('features.flags');
  return r.ok ? mergeFlags(r.value) : null;
}

// ── The principal ───────────────────────────────────────────────────────────

const SHARE_CAPS = ['shares.private', 'shares.public', 'review.links'];

/**
 * The flags as this person sees them. Flags are global; a role narrows what
 * someone may do through capabilities, never by switching a flag. But the UI
 * reads flags to decide what to show, so a flag whose every capability the
 * role lacks reads as off for them — a Viewer is not offered "Share…".
 */
export function principalFlags(globalFlags, { isAdmin = false, caps = new Set(), degraded = false } = {}) {
  const flags = applyBetaAdminFlags(globalFlags ? mergeFlags(globalFlags) : { ...DEFAULT_FLAGS }, isAdmin);
  if (!globalFlags || degraded) {
    // Unread flags: nothing that exposes files or spends money.
    flags.shares = false;
    flags.aiGenerate = false;
  }
  if (!isAdmin) {
    if (!SHARE_CAPS.some((c) => caps.has(c))) flags.shares = false;
    if (!caps.has('ai.generate')) flags.aiGenerate = false;
  }
  return flags;
}

const VIEWER = BUILTIN_ROLES.find((r) => r.id === 'viewer');

/**
 * The principal from what was read — pure, so the web/desktop parity and
 * the whole matrix are testable without a database.
 *
 * `grants` is loadDriveGrants' answer (every drive, and the GRANTED role in
 * each); the roles are capped here by the platform role's driveCeiling, and
 * everything downstream — the listing query, driveAccess, STS, the member
 * routes — reads the capped ones. A Viewer granted "editor" is an editor
 * nowhere.
 */
export function principalFrom({
  email, isAdmin = false, isSuperAdmin = false, person = null, rolesConfig = null,
  globalFlags = null, policy = null, grants = null, folderGrants = [], degraded = false, tokenId = null,
}) {
  const e = String(email || '').trim().toLowerCase();
  let role = resolveRole(e, rolesConfig, { isAdmin, roleId: person?.roleId || null });
  if (degraded && !isAdmin) role = { ...VIEWER, legacyAdmin: !!role.legacyAdmin, degradedFrom: role.id };
  const caps = roleCaps(role);
  const limits = effectiveLimits({ role, person, policy, isAdmin });
  const flags = principalFlags(globalFlags, { isAdmin, caps, degraded });

  const principal = {
    email: e,
    isAdmin: !!isAdmin,
    isSuperAdmin: !!isAdmin && !!isSuperAdmin,
    tokenId,
    person,
    role: { id: role.id, name: role.name, builtin: !!role.builtin },
    roleId: role.id,
    legacyAdmin: !!role.legacyAdmin,
    caps,
    limits,
    flags,
    policy: parsePolicy(policy),
    degraded: !!degraded,
    folderGrants: isAdmin ? [] : [...folderGrants],
  };
  if (!isAdmin) {
    const drives = grants?.drives || [];
    const roles = {};
    for (const [id, granted] of Object.entries(grants?.roles || {})) {
      const capped = capDriveRole(granted, limits.driveCeiling);
      if (capped) roles[id] = capped;
    }
    principal.driveScope = { drives, roles, isAdmin: false };
    principal.drivePatterns = {
      all: drivePatterns(drives),
      mine: drivePatterns(drives.filter((d) => roles[d.id])),
    };
  }
  return principal;
}

/**
 * THE principal builder. The web (lib/session.js via requirePrincipal), the
 * desktop (lib/desktop-guard.js) and STS all come through here, which is the
 * whole of the parity guarantee: the same email gets the same answers
 * everywhere.
 *
 * `person` may be handed in by a caller that already read it (the session
 * reads it in the same query as admission); `tokenId` is carried for the
 * audit trail and has no bearing on what is allowed.
 */
export async function getPrincipal(email, { tokenId = null, person } = {}) {
  const e = String(email || '').trim().toLowerCase();
  const admin = isEnvAdmin(e);
  const settings = await loadAuthzSettings();

  let who = person;
  let personFailed = false;
  if (who === undefined) {
    try { who = await getPersonByEmail(e); } catch { who = null; personFailed = true; }
  }

  // Not caught: a request that cannot learn the drives must fail rather than
  // see into them (loadDriveGrants).
  const grants = admin ? null : await loadDriveGrants(e);
  const principal = principalFrom({
    email: e,
    isAdmin: admin,
    isSuperAdmin: admin && isEnvSuperAdmin(e),
    person: who,
    rolesConfig: settings.rolesConfig,
    globalFlags: settings.globalFlags,
    policy: settings.policy,
    grants,
    degraded: settings.degraded || personFailed,
    tokenId,
  });
  if (!admin) {
    // Role-subject folder grants follow the resolved role, so these come
    // after it. A failure here is fewer grants, never more.
    principal.folderGrants = await folderGrantsFor(e, principal.roleId).catch(() => []);
  }
  return principal;
}

// ── The decision ────────────────────────────────────────────────────────────

const ALLOW = Object.freeze({ ok: true });
const deny = (reason, status = 403, code = undefined) => ({ ok: false, reason, status, ...(code ? { code } : {}) });

// What a degraded principal may not do. Reads carry on with Viewer
// capabilities; anything that changes something waits for a real answer.
const WRITES = new Set([
  'files.upload', 'files.edit', 'files.delete', 'folders.manage',
  'shares.private', 'shares.public', 'review.links', 'review.comment', 'review.decide',
  'ai.generate', 'drives.create',
]);

const NO_CAP = {
  'files.upload': 'Your role can view files but not add them.',
  'files.edit': 'Your role can view files but not change them.',
  'files.delete': 'Your role can view files but not delete them.',
  'folders.manage': 'Your role can view folders but not change them.',
  'shares.private': 'Your role cannot make links.',
  'shares.public': 'Your role can make private links only, not public or password ones.',
  'review.links': 'Your role cannot make review links.',
  'review.comment': 'Your role cannot comment.',
  'review.decide': 'Your role cannot approve or request changes.',
  'ai.generate': 'Your role cannot use AI tools.',
  'drives.create': 'Your role cannot create drives.',
  'desktop.mount': 'Your role cannot use the desktop app.',
};

const bytes = (n) => (Number(n) === 0 ? '0 bytes' : fmtSize(n));

const LINK_LABEL = { public: 'public', password: 'password', private: 'private', review: 'review' };

/**
 * The link kind a share request needs the capability for: public and
 * password links take a file outside the org; private links do not.
 */
export function shareCapFor(kind) {
  if (kind === 'private') return 'shares.private';
  if (kind === 'review') return 'review.links';
  return 'shares.public';
}

function uploadDecision(p, r) {
  if (r.drive?.inDrive && !r.drive.write) {
    return deny('That folder is in a drive you can view but not add to. Ask one of its owners for editor access.');
  }
  if (r.size == null) return ALLOW;
  const size = Number(r.size);
  if (!Number.isFinite(size) || size < 0) return deny('The upload needs its size in bytes.', 400);
  const L = p.limits || {};
  if (L.maxUploadBytes != null && size > L.maxUploadBytes) {
    return deny(`This file is ${bytes(size)}; the largest upload your role allows is ${bytes(L.maxUploadBytes)}.`, 413, 'max_upload');
  }
  if (L.storageQuotaBytes != null) {
    const used = Number(r.usedBytes) || 0;
    if (used + size > L.storageQuotaBytes) {
      return deny(`This would pass your storage quota of ${bytes(L.storageQuotaBytes)}: you have added ${bytes(used)}.`, 413, 'quota');
    }
  }
  if (r.driveQuotaBytes != null) {
    const held = Number(r.driveUsedBytes) || 0;
    if (held + size > r.driveQuotaBytes) {
      return deny(`This drive is limited to ${bytes(r.driveQuotaBytes)} and holds ${bytes(held)}.`, 413, 'drive_quota');
    }
  }
  return ALLOW;
}

function shareDecision(p, action, r) {
  if (!p.flags?.shares) return deny('Sharing is turned off.');
  if (action === 'review.links' && !p.flags?.review) return deny('Review is turned off.');
  if (r.canModify === false) return deny('You can view this file but not share it.');
  const kind = r.kind || (action === 'shares.private' ? 'private' : action === 'review.links' ? 'review' : 'public');
  if (Array.isArray(r.driveShareKinds) && !r.driveShareKinds.includes(kind)) {
    return deny(`This drive does not allow ${LINK_LABEL[kind] || kind} links.`);
  }
  const max = p.limits?.shareMaxExpiryDays;
  if (max != null && !p.isAdmin) {
    const days = r.expiresInDays == null ? null : Number(r.expiresInDays);
    if (days == null) return deny(`Links you make must expire within ${max} day${max === 1 ? '' : 's'}.`);
    if (days > max) return deny(`Links you make can last at most ${max} day${max === 1 ? '' : 's'}.`);
  }
  return ALLOW;
}

/**
 * May `principal` do `action` to `resource`? Pure → { ok, reason?, status? }.
 *
 * `action` is a capability id (lib/roles.js CAPABILITIES) or one of the
 * questions that are not capabilities:
 *
 *   admin, trash.manage   env admins only
 *   superAdmin            env super-admins only
 *   shares.revoke         the link's creator, or anyone who can change the
 *                         file — always, whatever their role: revoking only
 *                         narrows exposure
 *   drive.manageMembers   admins, and owners of the drive (after the ceiling)
 *
 * `resource` carries what the route looked up, never more than it needs:
 *
 *   files.upload     { drive, size, usedBytes, driveQuotaBytes, driveUsedBytes }
 *   files.edit/…     { write }  a fileWriteDecision result, and { metadata } for a metadata edit
 *   folders.manage   { folderRole }  from folderRoleFor, drive role included
 *   shares.*         { canModify, kind, driveShareKinds, expiresInDays }
 *   drives.create    { ownedCount }
 *   shares.revoke    { createdBy, canModify }
 *   drive.manageMembers { driveRole }
 *
 * An unknown action is refused: a typo in a guard must fail closed.
 */
export function can(principal, action, resource = {}) {
  if (!principal || !principal.email) return deny('Not signed in.', 401);
  const r = resource || {};
  if (principal.degraded && !principal.isAdmin && WRITES.has(action)) return deny(DEGRADED_MESSAGE, 503, 'degraded');

  switch (action) {
    case 'admin':
    case 'trash.manage':
      return principal.isAdmin ? ALLOW : deny('Only admins can do that.');
    case 'superAdmin':
      return principal.isSuperAdmin ? ALLOW : deny('Only a super-admin can do that.');
    case 'shares.revoke': {
      const mine = !!r.createdBy && String(r.createdBy).trim().toLowerCase() === principal.email;
      return principal.isAdmin || mine || r.canModify
        ? ALLOW
        : deny('Only whoever made this link, or someone who can change the file, can revoke it.');
    }
    case 'drive.manageMembers':
      return principal.isAdmin || r.driveRole === 'owner'
        ? ALLOW
        : deny('Only admins and owners of this drive can manage its members.');
    default:
      break;
  }

  if (!isCapability(action)) return deny(`Unknown action "${action}".`, 500);
  if (!principal.isAdmin && !(principal.caps instanceof Set && principal.caps.has(action))) {
    return deny(NO_CAP[action] || 'Your role does not allow that.');
  }

  switch (action) {
    case 'files.upload':
      return uploadDecision(principal, r);
    case 'files.edit':
    case 'files.delete':
      if (r.write && !r.write.allowed) {
        return deny(r.write.reason === 'drive-viewer'
          ? 'You can view this drive but not change it.'
          : 'No access');
      }
      if (action === 'files.edit' && r.metadata && !principal.flags?.metadata) return deny('Metadata is turned off.');
      return ALLOW;
    case 'folders.manage':
      if ('folderRole' in r && r.folderRole !== 'owner' && r.folderRole !== 'editor') return deny('No access to that folder.');
      return ALLOW;
    case 'shares.private':
    case 'shares.public':
    case 'review.links':
      return shareDecision(principal, action, r);
    case 'review.comment':
    case 'review.decide':
      return principal.flags?.review ? ALLOW : deny('Review is turned off.');
    case 'ai.generate':
      if (!principal.flags?.aiGenerate) return deny('AI tools are turned off.');
      if (r.driveAiAllowed === false) return deny('AI tools are not allowed on this drive.');
      return ALLOW;
    case 'drives.create': {
      if (principal.isAdmin) return ALLOW;
      const policy = principal.policy || parsePolicy(null);
      if (!policy.drivesSelfServe) return deny('Only admins can create drives here.');
      if (r.ownedCount != null && Number(r.ownedCount) >= policy.drivesPerPerson) {
        return deny(`You already own ${policy.drivesPerPerson} drive${policy.drivesPerPerson === 1 ? '' : 's'}, the most each person may create.`);
      }
      return ALLOW;
    }
    case 'desktop.mount':
      return principal.flags?.filespaces ? ALLOW : deny('Drives and desktop mounts are turned off.');
    default:
      return ALLOW;
  }
}

/**
 * The most a browser upload may be, for a Vercel Blob token: the smaller of
 * the largest upload allowed and what is left of the quota. null = no limit
 * of ours (the caller still applies its own ceiling).
 */
export function uploadAllowance(principal, { usedBytes = 0 } = {}) {
  const L = principal?.limits || {};
  const left = L.storageQuotaBytes == null ? null : Math.max(0, L.storageQuotaBytes - (Number(usedBytes) || 0));
  if (L.maxUploadBytes == null) return left;
  return left == null ? L.maxUploadBytes : Math.min(L.maxUploadBytes, left);
}

/**
 * The upload decision with its lookups done: where the object would land
 * (`key`, for the drive boundary), how big it is, and — only when a limit
 * could refuse it — what this person and that drive already hold. Used by
 * presign, multipart create, the Blob token and POST /api/files, so the four
 * ways in cannot disagree.
 */
export async function uploadCheck(principal, { key = null, size = null } = {}) {
  const drive = key ? driveAccess(key, principal.isAdmin ? { isAdmin: true } : principal.driveScope) : null;
  const resource = { drive, size };
  if (size != null && !principal.isAdmin && principal.caps?.has('files.upload')) {
    if (principal.limits?.storageQuotaBytes != null) resource.usedBytes = await usedBytesBy(principal.email);
    // A drive with a quota, of the ones this key would land in: the one with
    // the least room decides.
    let tightest = null;
    for (const d of drivesHolding(key, principal.driveScope?.drives || [])) {
      if (d.quotaBytes == null) continue;
      const { bytes: held } = await countFilesUnderPrefix(d.prefix);
      const room = d.quotaBytes - held;
      if (!tightest || room < tightest.room) tightest = { room, quota: d.quotaBytes, held };
    }
    if (tightest) { resource.driveQuotaBytes = tightest.quota; resource.driveUsedBytes = tightest.held; }
  }
  return can(principal, 'files.upload', resource);
}

/**
 * The link kinds allowed for a file by the drives it is in: null when no
 * drive restricts them, otherwise the kinds every holding drive allows (a
 * drive inside another is held to both). Applies to admins too — it is the
 * drive's policy, set on purpose.
 */
export async function shareKindsForKey(principal, key) {
  const drives = principal?.driveScope?.drives || (await loadDriveGrants(principal?.email)).drives;
  let allowed = null;
  for (const d of drivesHolding(key, drives)) {
    if (!Array.isArray(d.shareKinds)) continue;
    allowed = allowed ? allowed.filter((k) => d.shareKinds.includes(k)) : [...d.shareKinds];
  }
  return allowed;
}

/**
 * The role a desktop mount gets, as a pure decision: the drive role after
 * the platform role's ceiling (already applied in the principal), and then
 * read-only unless the person may add files and has room to. A mount is an
 * upload path like any other; handing write credentials to someone the web
 * would refuse an upload is how a quota stops meaning anything.
 */
export function mountRole({ driveRole, canUpload, overQuota = false }) {
  if (!driveRole) return null;
  if (driveRole === 'viewer' || !canUpload || overQuota) return 'viewer';
  return driveRole;
}

/**
 * A person's effective role in one drive: the granted role after the
 * ceiling (already applied in the principal), owner for an admin, null for
 * none.
 */
export function driveRoleOf(principal, filespaceId) {
  if (!principal) return null;
  if (principal.isAdmin) return 'owner';
  return principal.driveScope?.roles?.[filespaceId] || null;
}

// ── Route helpers ───────────────────────────────────────────────────────────

async function json(body, status) {
  const { NextResponse } = await import('next/server');
  return NextResponse.json(body, { status });
}

/**
 * The signed-in person and their principal, or { error } with a 401. The
 * session module is imported lazily: it pulls in Auth.js, and the pure half
 * of this file is imported by tests that have no business loading it.
 */
export async function requirePrincipal() {
  const { getSessionUser } = await import('./session.js');
  const user = await getSessionUser();
  if (!user) return { error: await json({ error: 'Not authenticated' }, 401) };
  const principal = await getPrincipal(user.email, { person: user.person, tokenId: user.deviceTokenId || null });
  return { user, principal, email: user.email };
}

/**
 * Session → principal → can, for a route:
 *
 *   const g = await requireCan(req, 'files.upload', async (principal) => ({ size }));
 *   if (g.error) return g.error;
 *
 * `resourceLoader(principal)` returns the resource `can` needs; it may
 * return { error: Response } (a 404, say) to stop there.
 */
export async function requireCan(_req, action, resourceLoader) {
  const got = await requirePrincipal();
  if (got.error) return got;
  const resource = resourceLoader ? await resourceLoader(got.principal) : {};
  if (resource && resource.error) return { error: resource.error };
  const d = can(got.principal, action, resource || {});
  if (!d.ok) return { error: await json({ error: d.reason, ...(d.code ? { code: d.code } : {}) }, d.status || 403) };
  return { ...got, resource: resource || {} };
}

/** A refusal from can(), as a route's response. */
export function refusal(decision) {
  return json({ error: decision.reason, ...(decision.code ? { code: decision.code } : {}) }, decision.status || 403);
}
