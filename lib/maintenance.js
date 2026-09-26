// lib/maintenance.js — the daily housekeeping, in one place. Server-only.
//
// The cron route (/api/cron/maintenance, CRON_SECRET) and an admin's Run now
// (POST /api/admin/maintenance/run) both call runMaintenance, so the two can
// never do different things. Each run is recorded in `maintenance_runs` —
// when, who or what started it, how long it took, and what it did — which is
// what Health shows. The cron's JSON response used to be the only record,
// and nothing reads a cron's response.
//
// The jobs, in order, each in its own try so one failing does not stop the
// rest:
//
//   1. schema       run every guard (the one place DDL runs in production)
//   2. trash        purge trashed files past the retention window
//   3. uploads      abort multipart uploads nobody has touched for a week
//   4. rights       warn about usage rights that lapsed or are about to —
//                   only with the `usageRights` flag on
//   5. audit        drop audit rows older than a year

import {
  ensureSchema, listExpiredTrash, deleteFile, listAllFiles, getFileMetadataSchema, listStaleUploads,
  deleteUpload, purgeTarget, storageKeyInUse, startMaintenanceRun, finishMaintenanceRun, pruneAuditEvents,
} from './db.js';
import { getStorageConfig, s3DeleteObject, s3AbortMultipartUpload } from './storage.js';
import { normalizeSchema, expiryState } from './dam.js';
import { notifyExpiringRights } from './notify.js';
import { TRASH_RETENTION_DAYS } from './storage-report.js';
import { readGlobalFlags } from './authz.js';

const DAY = 24 * 60 * 60 * 1000;
// How long an untouched upload stays resumable before it is treated as
// abandoned. Generous on purpose — coming back to a half-finished 40 GB
// transfer the next day should still work.
export const UPLOAD_STALE_DAYS = 7;
export const AUDIT_RETENTION_DAYS = 365;

/**
 * Purge one trashed row: its object, then the row. The trashed copy, not the
 * file's old key — a newer upload may have that key now, and deleting it lost
 * that file's bytes (purgeTarget). Object first, so a failed delete leaves a
 * row to retry from rather than an orphaned object nobody can find.
 * Shared by the retention sweep and Admin → Trash → Purge now.
 */
export async function purgeTrashedFile(row, cfg) {
  const keyInUse = !row.trashKey && row.storageKey
    ? await storageKeyInUse(row.storageKey, { exceptId: row.id })
    : false;
  const target = purgeTarget(row, { keyInUse });
  if (target) await s3DeleteObject(cfg, target);
  await deleteFile(row.id);
  return { id: row.id, deleted: target };
}

async function purgeExpiredTrash(out) {
  const cutoff = Date.now() - TRASH_RETENTION_DAYS * DAY;
  const cfg = await getStorageConfig();
  for (const row of await listExpiredTrash(cutoff)) {
    try {
      await purgeTrashedFile(row, cfg);
      out.purged++;
    } catch (e) {
      out.purgeErrors++;
      console.warn('[maintenance] purge failed for', row.id, e.message);
    }
  }
}

// Abandoned multipart uploads. Their parts are stored and billed
// indefinitely and do NOT appear in the bucket's object listing, so without
// this they accumulate invisibly. A bucket lifecycle rule for incomplete
// multipart uploads is the belt-and-braces backstop.
async function abortStaleUploads(out) {
  const cfg = await getStorageConfig();
  const cutoff = Date.now() - UPLOAD_STALE_DAYS * DAY;
  for (const u of await listStaleUploads(cutoff)) {
    try {
      await s3AbortMultipartUpload(cfg, { key: u.storageKey, uploadId: u.uploadId });
      await deleteUpload(u.id);
      out.uploadsAborted++;
    } catch (e) {
      console.warn('[maintenance] abort upload failed for', u.id, e.message);
    }
  }
}

async function scanUsageRights(out) {
  // The flag is read here, and a flag that cannot be read sends nothing: a
  // notice nobody asked for is worse than one a day late.
  const flags = await readGlobalFlags();
  if (!flags?.usageRights) { out.rightsSkipped = true; return; }
  const schema = normalizeSchema(await getFileMetadataSchema());
  const files = await listAllFiles();
  const expired = [];
  const soon = [];
  for (const f of files) {
    const state = expiryState(f, schema);
    if (state === 'expired') expired.push(f);
    else if (state === 'soon') soon.push(f);
  }
  out.expired = expired.length;
  out.soon = soon.length;
  if (expired.length || soon.length) await notifyExpiringRights({ expired, soon });
}

/**
 * Run everything, record the run, and return what it did:
 * { id, ok, schema, purged, purgeErrors, uploadsAborted, expired, soon,
 *   auditPruned, errors, durationMs }. `ok` is false when a job threw or a
 * schema guard failed; the run still finishes the other jobs.
 */
export async function runMaintenance({ trigger = 'cron', by = null } = {}) {
  const started = Date.now();
  let runId = null;
  try { runId = await startMaintenanceRun({ trigger, by }); } catch (e) {
    // Recording the run is not a reason not to run it.
    console.warn('[maintenance] could not record the run:', e.message);
  }

  const out = {
    schema: [], purged: 0, purgeErrors: 0, uploadsAborted: 0, expired: 0, soon: 0, auditPruned: 0, errors: [],
  };
  const step = async (name, fn) => {
    try { await fn(); } catch (e) {
      out.errors.push({ step: name, error: e.message });
      console.warn(`[maintenance] ${name} failed:`, e.message);
    }
  };

  // Schema first. With SCHEMA_MANAGED=1 this is the one place in the app that
  // still runs DDL, so a guard that gained a column since the last init.sql
  // run is applied here rather than never.
  await step('schema', async () => { out.schema = (await ensureSchema()).filter((r) => !r.ok); });
  await step('trash', () => purgeExpiredTrash(out));
  await step('uploads', () => abortStaleUploads(out));
  await step('rights', () => scanUsageRights(out));
  await step('audit', async () => { out.auditPruned = await pruneAuditEvents(Date.now() - AUDIT_RETENTION_DAYS * DAY); });

  const result = { ...out, durationMs: Date.now() - started };
  const ok = !out.errors.length && !out.schema.length && !out.purgeErrors;
  if (runId) await finishMaintenanceRun(runId, { ok, result }).catch((e) => console.warn('[maintenance] could not finish the run record:', e.message));
  return { id: runId, ok, ...result };
}
