// Stand-ins for '@/lib/db' and '@/lib/authz', for test/views-api.test.js:
// the /api/views routes run for real, and only the session and the database
// are replaced — by an in-memory store in globalThis.__views that the test
// arranges. The principals are real ones (principalFrom), and the drive list
// follows lib/db.js listFilespacesForSpace's rule over them. The writes keep
// the SQL's owner-in-the-WHERE, as the real ones do; what that SQL does
// against a real database is test/views-db.test.js's.

import { NextResponse } from 'next/server';

const store = () => globalThis.__views;
const copy = (r) => (r ? structuredClone(r) : null);
const owner = (email) => String(email || '').trim().toLowerCase();

// ── authz ──
export async function requirePrincipal() {
  const p = store().actor;
  if (!p) return { error: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }) };
  return { user: { email: p.email }, principal: p, email: p.email };
}

// ── db: drives, by the rule lib/db.js listFilespacesForSpace applies ──
export async function listFilespacesForSpace(email, principal) {
  store().drivesAsked.push(owner(email));
  const all = store().drives;
  if (principal.isAdmin) return all.map((d) => ({ ...d, role: 'owner' }));
  const roles = principal.driveScope?.roles || {};
  return all.filter((d) => roles[d.id]).map((d) => ({ ...d, role: roles[d.id] }));
}

// ── db: saved views ──
export async function listSavedViews(email) {
  const e = owner(email);
  return [...store().rows.values()].filter((r) => r.ownerEmail === e).sort((a, b) => a.createdAt - b.createdAt).map(copy);
}

export async function createSavedView(email, { name, driveId = null, filters = {}, sort = 'new', display = {} }) {
  const s = store();
  const row = { id: `view-${++s.seq}`, ownerEmail: owner(email), name, driveId, filters, sort, display, createdAt: s.seq, updatedAt: s.seq };
  s.rows.set(row.id, row);
  return copy(row);
}

export async function updateSavedView(id, email, next) {
  const r = store().rows.get(id);
  if (!r || r.ownerEmail !== owner(email)) return null;
  Object.assign(r, next, { updatedAt: ++store().seq });
  return copy(r);
}

export async function deleteSavedView(id, email) {
  const r = store().rows.get(id);
  if (!r || r.ownerEmail !== owner(email)) return false;
  return store().rows.delete(id);
}
