import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  createShare, createFolderShare, listSharesForFile, listSharesForFolder, deleteShare, getFeatureFlags,
  getFileById, buildPrincipal, canAccessFile, canModifyFile, canModifyFolder, folderRoleFor, getShareTarget,
} from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireSharesOn() {
  const flags = await getFeatureFlags();
  if (flags.shares === false) {
    return NextResponse.json({ error: 'Sharing is disabled for this workspace.' }, { status: 403 });
  }
  return null;
}

// ─── Authorization ──────────────────────────────────────────────────────────
//
// Every method here used to check only that someone was signed in, on a route
// whose entire purpose is handing out access. A viewer could mint a public
// link to any file by id — turning read access into world-readable — and
// anyone who learned a token could revoke it.
//
// Creating a link is a write, not a read: it is the same act as granting
// access, and it is exactly what a read-only member must not be able to do.
// Listing links needs only the access the link would expose.

const denied = () => NextResponse.json({ error: 'No access to that file or folder.' }, { status: 403 });

/** Can this principal see what a link to `fileId` / `folder` would expose? */
async function mayList({ fileId, folder, principal }) {
  if (fileId) {
    const file = await getFileById(fileId);
    return !!file && (await canAccessFile(file, principal));
  }
  return principal.isAdmin || (await folderRoleFor(folder, principal)) !== null;
}

/** Can this principal hand that access to someone else? */
async function mayShare({ fileId, folder, principal }) {
  if (fileId) {
    const file = await getFileById(fileId);
    return !!file && (await canModifyFile(file, principal));
  }
  return canModifyFolder(folder, principal);
}

/** GET ?fileId= | ?folder= → the links that already exist for it. */
export async function GET(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const off = await requireSharesOn();
  if (off) return off;

  const url = new URL(req.url);
  const fileId = url.searchParams.get('fileId');
  const folder = url.searchParams.get('folder');
  if (!fileId && folder === null) return NextResponse.json({ error: 'fileId or folder required' }, { status: 400 });

  const principal = await buildPrincipal(session.user.email);
  if (!(await mayList({ fileId, folder, principal }))) return denied();

  if (fileId) return NextResponse.json({ shares: await listSharesForFile(fileId) });
  return NextResponse.json({ shares: await listSharesForFolder(folder, url.searchParams.get('storagePrefix') || null) });
}

/** POST { fileId | folder, expiresInDays?, password? } → { token }. */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const off = await requireSharesOn();
  if (off) return off;

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

  const principal = await buildPrincipal(session.user.email);
  if (!(await mayShare({ fileId: body.fileId, folder: body.folder || '', principal }))) return denied();

  try {
    const common = {
      createdBy: session.user.email,
      expiresInDays: body.expiresInDays ? Number(body.expiresInDays) : undefined,
      password: body.password || undefined,
    };
    const share = body.fileId
      ? await createShare({ fileId: body.fileId, ...common })
      : await createFolderShare({ folder: body.folder || '', storagePrefix: body.storagePrefix || null, ...common });
    return NextResponse.json({ share });
  } catch (e) {
    return NextResponse.json({ error: e.message || 'Could not create the link.' }, { status: 500 });
  }
}

/** DELETE ?token= — revoke. */
export async function DELETE(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'token required' }, { status: 400 });

  // Resolve what the token points at before revoking it — otherwise anyone
  // who learns a token can revoke a link they have nothing to do with.
  // Idempotent on an unknown token: there is nothing to reveal and nothing
  // to protect.
  const target = await getShareTarget(token);
  if (!target) return NextResponse.json({ ok: true });

  const principal = await buildPrincipal(session.user.email);
  if (!(await mayShare({ fileId: target.fileId, folder: target.folder || '', principal }))) return denied();

  await deleteShare(token);
  return NextResponse.json({ ok: true });
}
