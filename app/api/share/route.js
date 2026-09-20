import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import {
  createShare, createFolderShare, listSharesForFile, listSharesForFolder, deleteShare, getFeatureFlags,
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

/** GET ?fileId= | ?folder= → the links that already exist for it. */
export async function GET(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const off = await requireSharesOn();
  if (off) return off;

  const url = new URL(req.url);
  const fileId = url.searchParams.get('fileId');
  const folder = url.searchParams.get('folder');
  if (fileId) return NextResponse.json({ shares: await listSharesForFile(fileId) });
  if (folder !== null) {
    return NextResponse.json({ shares: await listSharesForFolder(folder, url.searchParams.get('storagePrefix') || null) });
  }
  return NextResponse.json({ error: 'fileId or folder required' }, { status: 400 });
}

/** POST { fileId | folder, expiresInDays?, password? } → { token }. */
export async function POST(req) {
  const session = await auth();
  if (!session?.user?.email) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  const off = await requireSharesOn();
  if (off) return off;

  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }

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
  await deleteShare(token);
  return NextResponse.json({ ok: true });
}
