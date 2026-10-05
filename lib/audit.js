// lib/audit.js — record who did what to whom. Server-only.
//
//   await audit(guard.email, 'person.suspend', { type: 'person', id: email, label: name }, { reason })
//
// NEVER THROWS. A failed audit write must not fail the action it records:
// the admin who suspended someone has suspended them whether or not the row
// landed, and an error here would tell them otherwise. Failures are logged
// and the call resolves to null.
//
// Actions are dotted, noun first, so the Activity page can filter a family
// ('person' matches 'person.role', 'person.suspend', …):
//
//   invite.add · invite.approve · invite.deny · invite.remove
//   person.role · person.limits · person.suspend · person.reactivate
//   person.signout · person.remove · person.device.revoke
//   person.password.set · person.password.remove
//   drive.create · drive.update · drive.delete · drive.grant · drive.revoke
//   drive.claim (an admin became the owner of a drive that had, or would
//     have been left with, no owner — lib/drive-access.js)
//   roles.update · policy.update
//   share.revoke · trash.restore · trash.purge · maintenance.run
//   storage.price.set · storage.price.clear
//   library.move (files outside every drive moved into one, one row a call
//     that moved any — the subject is the drive)
//
// A person's subject id is their email (lowercased): their history outlives
// the people row, which removing them deletes.

import { insertAuditEvent } from './db.js';

/** `subject` is { type, id, label } or null; `detail` a small JSON object. */
export async function audit(actor, action, subject = null, detail = null) {
  try {
    return await insertAuditEvent({
      actor: actor ? String(actor).toLowerCase() : 'system',
      action,
      subjectType: subject?.type || null,
      subjectId: subject?.id != null ? String(subject.id) : null,
      subjectLabel: subject?.label != null ? String(subject.label) : null,
      detail: detail && typeof detail === 'object' ? detail : null,
    });
  } catch (e) {
    console.warn(`[audit] could not record ${action}:`, e.message);
    return null;
  }
}

/** The subject for a person, by email. */
export const personSubject = (email, label = null) => {
  const e = String(email || '').trim().toLowerCase();
  return { type: 'person', id: e, label: label || e };
};

/**
 * `actor`, an admin, became the owner of these drives ([{ id, name }]): one
 * row per drive, so each drive's own history has it. `from` is the person
 * whose removal or change would have left them with no owner; absent for
 * drives that had none already (the fix on Admin → Overview).
 */
export async function auditDriveClaims(actor, drives = [], { from = null } = {}) {
  for (const d of Array.isArray(drives) ? drives : []) {
    await audit(actor, 'drive.claim', { type: 'drive', id: d.id, label: d.name }, from ? { from } : null);
  }
}
