import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listFilesMissingHash, setFileContentHash, duplicateSummary, listFilespaces, getFilespace } from '@/lib/db';
import { getStorageConfig, storageMode, cfgForFilespace, s3HeadObject } from '@/lib/storage';
import { mapLimit } from '@/lib/folder-ops';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Well inside maxDuration: the answer has to get back before the platform
// gives up on the request.
const BUDGET_MS = 18_000;
const BATCH = 200;
const PARALLEL = 12;

/**
 * POST { after? } → { checked, hashed, after, done, summary }
 *
 * Gives every file recorded before content hashes were taken one, from a HEAD
 * of its object, so the duplicate finder can see it. Resumable: each call
 * works for a few seconds, then returns `after` (the last id it looked at)
 * for the next call to carry on from, until `done`. One pass looks at each
 * row once, including rows whose object has gone and so never get a hash.
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch {}

  const cfg = await getStorageConfig();
  if (storageMode(cfg) !== 's3') {
    return NextResponse.json({ error: 'No bucket is configured, so there is nothing to scan.' }, { status: 400 });
  }
  const cfgFor = await drivesWithOwnKeys(cfg);

  const started = Date.now();
  let after = typeof body.after === 'string' ? body.after : '';
  let checked = 0;
  let hashed = 0;
  let done = false;
  while (Date.now() - started < BUDGET_MS) {
    const rows = await listFilesMissingHash({ after, limit: BATCH });
    if (!rows.length) { done = true; break; }
    const got = await mapLimit(rows, PARALLEL, async (r) => {
      const facts = await s3HeadObject(cfgFor(r.storage_key), r.storage_key);
      return facts?.etag ? setFileContentHash(r.id, facts.etag, facts.size) : false;
    });
    checked += rows.length;
    hashed += got.filter(Boolean).length;
    after = rows[rows.length - 1].id;
    if (rows.length < BATCH) { done = true; break; }
  }

  return NextResponse.json({ checked, hashed, after, done, summary: await duplicateSummary() });
}

/**
 * A drive (filespace) with keys of its own lives in a bucket the Storage keys
 * may not open; its files are HEADed with its keys. Longest prefix first, so
 * a drive nested in another is matched before the one around it.
 */
async function drivesWithOwnKeys(cfg) {
  const own = [];
  for (const f of await listFilespaces()) {
    if (!f.accessKeyId || !f.hasSecret) continue;
    const full = await getFilespace(f.id);
    const prefix = String(full?.prefix || '').replace(/^\/+|\/+$/g, '');
    if (full && prefix) own.push({ prefix, cfg: cfgForFilespace(cfg, full) });
  }
  own.sort((a, b) => b.prefix.length - a.prefix.length);
  return (key) => own.find((o) => String(key).startsWith(`${o.prefix}/`))?.cfg || cfg;
}
