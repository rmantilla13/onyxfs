// Stand-ins for '@/lib/db', '@/lib/desktop-guard' and '@/lib/storage', for
// test/transcripts-api.test.js: the transcript routes run for real, and only
// the database, the session and the bucket are replaced — by an in-memory
// store in globalThis.__tx that the test arranges. The claim and the
// claimer-only writes keep the SQL's WHERE clauses (lib/db.js), so a route's
// answer to "not yours any more" is exercised, not assumed. What the SQL
// itself does is test/transcripts-db.test.js's, against a real database.

import { NextResponse } from 'next/server';

const store = () => globalThis.__tx;
const now = () => store().now ?? Date.now();
const copy = (r) => (r ? structuredClone(r) : null);

// ── desktop-guard ──
export async function resolveActor() {
  const a = store().actor;
  if (!a) return { error: NextResponse.json({ error: 'Missing bearer token' }, { status: 401 }) };
  return { email: a.email, isAdmin: a.isAdmin, via: 'bearer', principal: a };
}

// ── storage ──
export async function presignFileUrls(files) {
  store().presigned.push(...files.map((f) => f.id));
  return files.map((f) => ({ ...f, url: `https://signed.test/${f.storageKey}?sig=1` }));
}

// ── db: files and access ──
export async function getFileById(id) { return copy(store().files.get(id)); }
export async function canAccessFile(file, p) { return p.isAdmin || store().read.has(`${p.email}|${file.id}`); }
export async function canModifyFile(file, p) { return p.isAdmin || store().write.has(`${p.email}|${file.id}`); }

// ── db: transcripts ──
const rows = () => store().rows;
export async function getTranscript(id) { return copy(rows().get(id)); }

export async function requestTranscript(fileId, { language = null, requestedBy = null } = {}) {
  const old = rows().get(fileId) || { fileId, segments: [], text: '', resultLanguage: null, engine: null, sourceKey: null, finishedAt: null };
  const row = {
    ...old, status: 'queued', language, error: null, progress: null, claimedBy: null, claimedDevice: null,
    leaseUntil: null, requestedBy, requestedAt: new Date(now()), updatedAt: new Date(now()),
  };
  rows().set(fileId, row);
  return copy(row);
}

export async function deleteTranscript(fileId) { return rows().delete(fileId); }

export async function claimTranscript(fileId, { email, device = null, sourceKey = null } = {}) {
  const r = rows().get(fileId);
  const expired = r && r.status === 'working' && (!r.leaseUntil || r.leaseUntil.getTime() < now());
  const file = store().files.get(fileId);
  if (r && (r.status === 'queued' || expired) && file && !file.deletedAt) {
    Object.assign(r, {
      status: 'working', claimedBy: email, claimedDevice: device, leaseUntil: new Date(now() + 600_000),
      progress: 0, error: null, sourceKey, updatedAt: new Date(now()),
    });
    return { row: copy(r) };
  }
  return r?.status === 'working' ? { taken: true } : { missing: true };
}

const mine = (fileId, email) => {
  const r = rows().get(fileId);
  return r && r.status === 'working' && r.claimedBy === email ? r : null;
};

export async function reportTranscriptProgress(fileId, { email, progress }) {
  const r = mine(fileId, email);
  if (!r) return null;
  Object.assign(r, { progress, leaseUntil: new Date(now() + 600_000), updatedAt: new Date(now()) });
  return copy(r);
}

export async function failTranscript(fileId, { email, error }) {
  const r = mine(fileId, email);
  if (!r) return null;
  Object.assign(r, { status: 'failed', error, progress: null, leaseUntil: null, updatedAt: new Date(now()) });
  return copy(r);
}

export async function submitTranscript(fileId, { email, segments, text, resultLanguage, engine, sourceKey }) {
  const r = mine(fileId, email);
  if (!r) return null;
  Object.assign(r, {
    status: 'done', segments, text, resultLanguage, engine, sourceKey: sourceKey ?? r.sourceKey,
    progress: 1, error: null, leaseUntil: null, finishedAt: new Date(now()), updatedAt: new Date(now()),
  });
  return copy(r);
}

export async function listTranscriptJobs(principal, { limit }) {
  store().queueAsked.push({ email: principal.email, limit });
  return store().jobs || [];
}
