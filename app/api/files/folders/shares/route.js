import { NextResponse } from 'next/server';
import { createFolderShare, listSharesForFolder, folderPathInUse } from '@/lib/db';
import { requirePrincipal, can, refusal, shareCapFor, shareKindsForKey } from '@/lib/authz';
import { parseShareRequest } from '@/lib/share-kinds';
import { presentShare, folderLinkGate, folderLinkSubject } from '@/lib/share-guard';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Links to a folder: the folder and everything in it, now and later, for
 * whoever holds the link (lib/folder-links.js decides what that is, on every
 * request to /s/<token>). The folder is named as the Files view names it —
 * `folder`, a path in the drive `filespace` (or `filespaceId`), or in the
 * library without one.
 *
 * Who may: lib/share-guard.js folderLinkGate — write access where the folder
 * lives (a drive's editors and owners; in the library, an editor or owner
 * folder grant), as for a file's links. Listing and revoking stop there:
 * they only narrow exposure, so they are not gated on the role's link
 * capabilities or the `shares` flag. Making one takes those too (POST).
 */

/** GET /api/files/folders/shares?folder=&filespace= → { shares } — the folder's links, newest first. */
export async function GET(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  const url = new URL(req.url);
  const gate = await folderLinkGate(g.principal, {
    filespaceId: url.searchParams.get('filespace') || null,
    folder: url.searchParams.get('folder') ?? '',
  });
  if (gate.error) return gate.error;
  return NextResponse.json({ shares: (await listSharesForFolder(gate.name, gate.storagePrefix)).map(presentShare) });
}

/**
 * POST /api/files/folders/shares { folder, filespaceId?, kind: 'public'|'password',
 * password?, expires: 'never'|'1'|'7'|'30' } → { share }.
 *
 * A folder's link is public or password-protected. Not private: that would
 * open only for people who can already open the folder, which a link adds
 * nothing to. Nor a review link — comments are on files, and a folder link
 * does not take them in this version. Both are refused, never quietly
 * dropped, so a sharer is never told a link is what it is not.
 *
 * The kind's capability (shares.public — a folder link goes outside the
 * workspace either way), the `shares` flag (read here, never taken from the
 * client), the link kinds the folder's drive allows, and the longest expiry
 * the role allows (can(), lib/authz.js), as for a file. Then the folder has
 * to be there: a link to nothing is not made.
 */
export async function POST(req) {
  const g = await requirePrincipal();
  if (g.error) return g.error;
  let body = {};
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'Bad request' }, { status: 400 }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ error: 'Bad request' }, { status: 400 });

  const parsed = parseShareRequest(body);
  if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (parsed.mode === 'private') {
    return NextResponse.json({ error: 'A folder link is public or password-protected. People who can already open the folder need no link to it.' }, { status: 400 });
  }
  if (parsed.review) return NextResponse.json({ error: 'Links to folders cannot take comments. Share a photo or a video for review.' }, { status: 400 });

  const gate = await folderLinkGate(g.principal, { filespaceId: body.filespaceId || body.filespace || null, folder: body.folder });
  if (gate.error) return gate.error;

  const kind = parsed.password ? 'password' : 'public';
  const allowed = can(g.principal, shareCapFor(kind), {
    canModify: true,
    kind,
    // The drives the folder is in — a drive inside another is held to both.
    // The library's folders are in none: its links never reach into a drive.
    driveShareKinds: gate.storagePrefix ? await shareKindsForKey(g.principal, `${gate.storagePrefix}/${gate.name}/`) : null,
    expiresInDays: parsed.expiresInDays,
  });
  if (!allowed.ok) return refusal(allowed);

  if (!(await folderPathInUse(gate.name, { tag: gate.tag, prefix: gate.storagePrefix }))) {
    return NextResponse.json({ error: `There is no folder “${gate.name}” here.` }, { status: 404 });
  }

  const { token, reused } = await createFolderShare({
    folder: gate.name,
    storagePrefix: gate.storagePrefix,
    createdBy: g.email,
    mode: 'public',
    password: parsed.password,
    expiresInDays: parsed.expiresInDays,
  });
  if (!reused) {
    await audit(g.email, 'share.create', folderLinkSubject({ storagePrefix: gate.storagePrefix, folder: gate.name, driveName: gate.driveName }), {
      kind, expiresInDays: parsed.expiresInDays, token: token.slice(0, 6),
    });
  }
  const share = (await listSharesForFolder(gate.name, gate.storagePrefix)).find((s) => s.token === token);
  if (!share) return NextResponse.json({ error: 'The link was made, but could not be read back. Open the dialog again.' }, { status: 500 });
  return NextResponse.json({ share: presentShare(share) });
}
