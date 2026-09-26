import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import {
  listFilespaces, createFilespace, updateFilespace, deleteFilespace, listFilespaceMembers,
  listInviteRequests, getFilespaceById, countFilesUnderPrefix, filespaceSetupProblem,
} from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';
import { getStorageConfig } from '@/lib/storage';
import { SHARE_KINDS } from '@/lib/share-kinds';
import { audit } from '@/lib/audit';

/**
 * The per-drive settings, from a request: quota (bytes, null = no limit),
 * whether AI tools may be used on it, and which link kinds its files may
 * have (null = all, [] = none). Only the keys present are returned; { error } for a bad
 * value.
 */
function driveSettings(body) {
  const out = {};
  if ('quotaBytes' in body) {
    const q = body.quotaBytes;
    if (!(q === null || (Number.isInteger(q) && q >= 0))) return { error: 'quotaBytes must be a whole number of bytes, or null for no limit.' };
    out.quotaBytes = q;
  }
  if ('aiAllowed' in body) {
    if (typeof body.aiAllowed !== 'boolean') return { error: 'aiAllowed must be true or false.' };
    out.aiAllowed = body.aiAllowed;
  }
  if ('shareKinds' in body) {
    const k = body.shareKinds;
    const known = [...SHARE_KINDS.map((x) => x.id), 'review'];
    if (!(k === null || (Array.isArray(k) && k.every((x) => known.includes(x))))) {
      return { error: `shareKinds must be null (every kind) or a list — empty for none — of: ${known.join(', ')}.` };
    }
    out.shareKinds = k === null ? null : [...new Set(k)];
  }
  return { settings: out };
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/**
 * GET → { filespaces: [{..., members:[{email,role,envAdmin}]}], users }
 * Filespaces with their members, plus the known-user list for the add-member
 * datalist (signed-in roster + approved invites, best-effort).
 */
export async function GET(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

  // ?summary=<id> → what deleting it would leave behind, for the confirm.
  const summaryId = new URL(req.url).searchParams.get('summary');
  if (summaryId) {
    const fs = await getFilespaceById(summaryId);
    if (!fs) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });
    const [counts, members] = await Promise.all([countFilesUnderPrefix(fs.prefix), listFilespaceMembers(fs.id)]);
    return NextResponse.json({
      id: fs.id, name: fs.name, bucket: fs.bucket, prefix: fs.prefix,
      ...counts, members: members.length, ownKeys: !!(fs.accessKeyId && fs.hasSecret),
    });
  }

  const spaces = await listFilespaces();
  const filespaces = await Promise.all(spaces.map(async (f) => {
    const members = (await listFilespaceMembers(f.id)).map((m) => ({ ...m, envAdmin: isAdmin(m.email) }));
    return { ...f, members };
  }));

  // Who can be granted a filespace: everyone with an approved invite.
  const byEmail = new Map();
  try {
    for (const i of await listInviteRequests({ status: 'approved' })) {
      const e = String(i.email || '').toLowerCase();
      if (e && !byEmail.has(e)) byEmail.set(e, { email: i.email, name: i.name || null });
    }
  } catch {}

  return NextResponse.json({ filespaces, users: [...byEmail.values()] });
}

/**
 * POST { name, bucket, prefix, region?, roleArn?, accessKeyId?, secretAccessKey?,
 * endpoint? } → create a filespace. Supplying accessKeyId+secretAccessKey makes
 * it a self-contained bucket with its OWN keys (independent of Storage config).
 */
export async function POST(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const name = String(body.name || '').trim();
  // A blank bucket means the configured Storage bucket, which is what the
  // form has always said. It used to be rejected instead.
  let bucket = String(body.bucket || '').trim();
  if (!bucket && !body.accessKeyId) bucket = String((await getStorageConfig())?.bucket || '').trim();
  // Normalize BEFORE validating so '/' or '///' is rejected rather than silently
  // stored as an empty (bucket-wide, unmountable) prefix.
  const prefix = String(body.prefix || '').replace(/^\/+|\/+$/g, '').trim();
  if (!bucket) {
    return NextResponse.json({ error: 'No bucket given and no Storage bucket is configured.' }, { status: 400 });
  }
  const problem = filespaceSetupProblem({ name, bucket, prefix }, await listFilespaces());
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  if (Boolean(body.accessKeyId) !== Boolean(body.secretAccessKey)) {
    return NextResponse.json({ error: 'Provide BOTH an access key and secret, or neither (to use the Storage config keys).' }, { status: 400 });
  }
  const extra = driveSettings(body);
  if (extra.error) return NextResponse.json({ error: extra.error }, { status: 400 });
  let filespace = await createFilespace({
    name, bucket, prefix,
    region: body.region ? String(body.region).trim() : null,
    roleArn: body.roleArn ? String(body.roleArn).trim() : null,
    accessKeyId: body.accessKeyId ? String(body.accessKeyId).trim() : null,
    secretAccessKey: body.secretAccessKey ? String(body.secretAccessKey) : null,
    endpoint: body.endpoint ? String(body.endpoint).trim() : null,
    createdBy: gate.email,
  });
  if (Object.keys(extra.settings).length) {
    const updated = await updateFilespace(filespace.id, extra.settings);
    if (updated) { const { secretAccessKey, ...safe } = updated; filespace = safe; }
  }
  await audit(gate.email, 'drive.create', { type: 'drive', id: filespace.id, label: filespace.name }, { bucket, prefix });
  return NextResponse.json({ filespace });
}

/**
 * PATCH { id, ...fields } → edit a filespace, incl. its own bucket keys. A blank
 * secretAccessKey keeps the stored one (so admins can edit other fields without
 * re-entering the key).
 */
export async function PATCH(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  const id = String(body.id || '').trim();
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const fields = {};
  if (body.name != null) fields.name = String(body.name).trim();
  if (body.bucket != null) fields.bucket = String(body.bucket).trim();
  if (body.prefix != null) fields.prefix = String(body.prefix).replace(/^\/+|\/+$/g, '').trim();
  if (body.region != null) fields.region = String(body.region).trim() || null;
  if (body.roleArn != null) fields.roleArn = String(body.roleArn).trim() || null;
  if (body.accessKeyId != null) fields.accessKeyId = String(body.accessKeyId).trim() || null;
  if (body.secretAccessKey != null) fields.secretAccessKey = String(body.secretAccessKey); // blank = keep existing (handled in db)
  if (body.endpoint != null) fields.endpoint = String(body.endpoint).trim() || null;
  const extra = driveSettings(body);
  if (extra.error) return NextResponse.json({ error: extra.error }, { status: 400 });
  Object.assign(fields, extra.settings);

  const existing = await getFilespaceById(id);
  if (!existing) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });
  const next = { name: existing.name, bucket: existing.bucket, prefix: existing.prefix, ...fields };
  const others = (await listFilespaces()).filter((f) => f.id !== id);
  const problem = filespaceSetupProblem(next, others);
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
  // Renaming is metadata. Re-pointing bucket or prefix is not: the catalog's
  // storage keys stay where they are, so every file would silently drop out of
  // the filespace. Refuse while there is anything to lose.
  const moved = (fields.bucket != null && fields.bucket !== existing.bucket)
    || (fields.prefix != null && fields.prefix !== existing.prefix);
  if (moved) {
    const { files } = await countFilesUnderPrefix(existing.prefix);
    if (files > 0) {
      return NextResponse.json({
        error: `${files} file${files === 1 ? ' is' : 's are'} stored under ${existing.bucket}/${existing.prefix}. Changing the bucket or prefix would strand them, so it is only allowed on an empty filespace.`,
      }, { status: 409 });
    }
  }

  const filespace = await updateFilespace(id, fields);
  if (!filespace) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });
  // Never echo the secret back — and never record it.
  const { secretAccessKey, ...safe } = filespace;
  const changed = Object.keys(fields).filter((k) => k !== 'secretAccessKey');
  await audit(gate.email, 'drive.update', { type: 'drive', id, label: safe.name }, {
    changed: [...changed, ...(fields.secretAccessKey ? ['secretAccessKey'] : [])],
  });
  return NextResponse.json({ filespace: safe });
}

/**
 * DELETE ?id= → remove a filespace and all its grants. The catalog rows and the
 * objects under its prefix are NOT touched: they stay in the bucket and in the
 * library (unscoped). Desktop mounts stop at their next STS refresh (≤1h),
 * which re-checks that the filespace exists.
 */
export async function DELETE(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const fs = await getFilespaceById(id);
  if (!fs) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });
  const { files } = await countFilesUnderPrefix(fs.prefix);
  await deleteFilespace(id);
  await audit(gate.email, 'drive.delete', { type: 'drive', id, label: fs.name }, { filesKept: files });
  return NextResponse.json({ ok: true, id, filesKept: files });
}
