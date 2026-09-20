import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import {
  listFilespaces, createFilespace, updateFilespace, deleteFilespace, listFilespaceMembers,
  listInviteRequests,
} from '@/lib/db';
import { isAdmin } from '@/lib/auth-allowlist';

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
export async function GET() {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;

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
  const bucket = String(body.bucket || '').trim();
  // Normalize BEFORE validating so '/' or '///' is rejected rather than silently
  // stored as an empty (bucket-wide, unmountable) prefix.
  const prefix = String(body.prefix || '').replace(/^\/+|\/+$/g, '').trim();
  if (!name || !bucket || !prefix) {
    return NextResponse.json({ error: 'name, bucket, and a non-root prefix are required' }, { status: 400 });
  }
  if (Boolean(body.accessKeyId) !== Boolean(body.secretAccessKey)) {
    return NextResponse.json({ error: 'Provide BOTH an access key and secret, or neither (to use the Storage config keys).' }, { status: 400 });
  }
  const filespace = await createFilespace({
    name, bucket, prefix,
    region: body.region ? String(body.region).trim() : null,
    roleArn: body.roleArn ? String(body.roleArn).trim() : null,
    accessKeyId: body.accessKeyId ? String(body.accessKeyId).trim() : null,
    secretAccessKey: body.secretAccessKey ? String(body.secretAccessKey) : null,
    endpoint: body.endpoint ? String(body.endpoint).trim() : null,
    createdBy: gate.email,
  });
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
  const filespace = await updateFilespace(id, fields);
  if (!filespace) return NextResponse.json({ error: 'Filespace not found' }, { status: 404 });
  // Never echo the secret back.
  const { secretAccessKey, ...safe } = filespace;
  return NextResponse.json({ filespace: safe });
}

/** DELETE ?id= → remove a filespace and all its grants. */
export async function DELETE(req) {
  const gate = await requireAdmin();
  if (gate.error) return gate.error;
  const id = new URL(req.url).searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await deleteFilespace(id);
  return NextResponse.json({ ok: true, id });
}
