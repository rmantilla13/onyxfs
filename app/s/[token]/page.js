import { redirect } from 'next/navigation';
import { loadBrand, loadShareKit } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import { recordShareView, getShareTarget, linkSenderName } from '@/lib/db';
import { resolveLinkAccess } from '@/lib/share-access';
import { isShareToken, resolveShareLook } from '@/lib/share-kinds';
import { playableProxies, withProxyKeys } from '@/lib/file-listing';
import { currentGuest } from '@/lib/share-review';
import { kindLabel } from '@/lib/file-info';
import { fmtSize, sharedFile, withoutOriginal } from '@/lib/media';
import FilePreview from '@/app/components/file/FilePreview';
import PreviewPreconnect from '@/app/components/PreviewPreconnect';
import { DownloadButtons } from '@/app/components/download/DownloadAs';
import UnlockForm from './UnlockForm';
import ShareReview from './ShareReview';
import FolderShare from './FolderShare';
import Shell, { introFrom } from './Shell';

export const dynamic = 'force-dynamic';

/**
 * A look's colours alone — scheme and accent — for a page the link has not
 * let anyone into yet (its password form): they say nothing about what is
 * shared, and the page would otherwise change colour once it is unlocked.
 * A brand kit's accent is a colour too, and is the one taken when the link
 * chose none of its own; the kit's logo and font wait for the password.
 */
const coloursOnly = async (row) => {
  const look = resolveShareLook(row?.look);
  const kit = await loadShareKit(look.brand);
  return { theme: look.theme, accent: look.accent || kit?.accent || null };
};

/**
 * Not for search engines, and the title says nothing about what is shared —
 * only whether it is a file or a folder: a password link must not leak a
 * name to a link preview. The row is read for its kind alone; nothing is
 * counted and nothing is checked here (the page decides who is let in).
 */
export async function generateMetadata({ params }) {
  const target = isShareToken(params?.token) ? await getShareTarget(params.token).catch(() => null) : null;
  return {
    title: target?.kind === 'folder' ? 'Shared folder' : 'Shared file',
    robots: { index: false, follow: false },
  };
}

/**
 * /s/<token> — a shared file or folder, for whoever the link lets in
 * (lib/share-access).
 *
 * Outside the middleware's sign-in wall (see the matcher): a public or
 * password link has to open for someone with no account. A private link asks
 * for sign-in itself, and comes back here afterwards.
 *
 * A link set to take comments (`access.review`) shows the file with the
 * review tools beside it (ShareReview); its routes are under this path too,
 * and decide again on every request (lib/share-review.js).
 *
 * A link to a folder shows the folder (FolderShare) — at `?path=`, a folder
 * inside it — and its files open on their own pages under this path
 * (files/[id]), each deciding again.
 *
 * How the page looks is the link's (access.look, lib/share-kinds.js): a
 * view — 'standard', or 'presentation' with the file filling the page —
 * a scheme, a brand kit, an accent, the logo or none, and the sharer's
 * words above it.
 * With its downloads off (access.downloads) the page offers no download and
 * is not handed the original where a preview shows the file
 * (withoutOriginal); the download route refuses either way.
 */
export default async function SharePage({ params, searchParams }) {
  const { token } = params;
  const access = await resolveLinkAccess(token);
  if (access.state === 'signin') {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/s/${token}`)}`);
  }
  const brand = await loadBrand();
  const folder = access.target === 'folder';

  if (access.state === 'ok' && folder) {
    const path = typeof searchParams?.path === 'string' ? searchParams.path : '';
    const kit = await loadShareKit(access.look.brand);
    return <FolderShare token={token} access={access} brand={brand} kit={kit} path={path} />;
  }

  if (access.state === 'ok') {
    await recordShareView(token);
    // Six hours, as on the file page, so a paused video still seeks when it
    // resumes. Signed only now, after access was decided — and then cut down
    // to what the viewer reads (sharedFile): the preview runs in the
    // visitor's browser, so the whole row would be in the page's source.
    // A heavy video's streamable copy is looked up first, as the file page
    // does, under the flags the link was let in by: the player prefers it to
    // streaming the master, and presignFileUrls signs it only from a key.
    const proxies = await playableProxies([access.file], access.flags);
    const [signed] = await presignFileUrls(withProxyKeys([access.file], proxies), { expiresIn: 21600 });
    const file = access.downloads ? sharedFile(signed) : withoutOriginal(sharedFile(signed));
    const review = access.review;
    const { look } = access;
    const presenting = look.view === 'presentation' && !review;
    const sender = look.sender ? await linkSenderName(access.row.created_by) : null;
    const kit = await loadShareKit(look.brand);
    const Name = look.title ? 'h2' : 'h1';
    return (
      <Shell brand={brand} kit={kit} wide={!!review || presenting} look={look} view={review ? 'review' : look.view} intro={introFrom(look, sender)}>
        {/* Only once the link has let them in: a locked link connects to nothing. */}
        <PreviewPreconnect urls={[file.thumbnailUrl, file.posterUrl, file.proxyUrl, file.url]} />
        <div className="share-file">
          <div className="share-head">
            <div style={{ minWidth: 0 }}>
              {/* Under the sharer's own heading, the name is the second one. */}
              <Name className="share-name" title={file.name}>{file.name}</Name>
              <p className="small muted" style={{ margin: 0 }}>
                {kindLabel(file)}{file.size != null ? ` · ${fmtSize(file.size)}` : ''}
              </p>
            </div>
            <div className="spacer" />
            {access.kind === 'private' && (
              <a className="btn" href={`/files/${file.id}`}>Open in {brand.name}</a>
            )}
            {/* The original, and Download as… for the same choices a member gets:
                the proxy and the cover through this link's own download route. */}
            {access.downloads && (
              <DownloadButtons file={file} base={`/s/${token}/download`} primary guest frame=".share-file video" />
            )}
          </div>
          {review
            ? <ShareReview file={file} token={token} level={review} guest={currentGuest(token)} />
            : <div className="share-stage"><FilePreview file={file} /></div>}
          <p className="small muted share-foot">
            {access.kind === 'private'
              ? `A private link: it opens only for people in ${brand.name} who can already see this file.`
              : review
                ? `Shared from ${brand.name} for review. Anyone with this link can read the comments made through it.`
                : `Shared from ${brand.name}.${access.downloads ? '' : ' Downloads are turned off for this link.'}`}
          </p>
        </div>
      </Shell>
    );
  }

  if (access.state === 'password' || access.state === 'locked') {
    return (
      <Shell brand={brand} narrow look={await coloursOnly(access.row)}>
        <h1 className="share-title">{folder ? 'This folder is password protected' : 'This file is password protected'}</h1>
        <p className="small muted" style={{ margin: '0 0 var(--s4)' }}>Enter the password you were given with the link.</p>
        <UnlockForm token={token} locked={access.state === 'locked'} />
      </Shell>
    );
  }

  const MESSAGES = {
    expired: ['This link has expired', 'Ask whoever sent it for a new one.'],
    gone: folder
      ? ['This folder is no longer available', 'It, or the drive it was in, was removed after the link was made.']
      : ['This file is no longer available', 'It was removed after the link was made.'],
    blocked: ['This link is turned off', 'The drive this folder is in no longer allows links like it. Ask whoever sent it for another way in.'],
    denied: ['You do not have access to this file', `You are signed in as ${access.email}. Ask whoever sent the link to give you access.`],
    off: ['Sharing is turned off', `Links to files in ${brand.name} are not being served right now.`],
    paused: ['This link is paused', folder
      ? 'The person who shared it can’t share folders right now. Ask them, or someone else, for another way to the folder.'
      : 'The person who shared it can’t share files right now. Ask them, or someone else, for another way to the file.'],
    unavailable: ['This link can’t be opened right now', 'Try again in a moment.'],
    missing: ['This link does not work', 'It may have been revoked, or copied incompletely.'],
  };
  const [title, body] = MESSAGES[access.state] || MESSAGES.missing;
  return (
    <Shell brand={brand} narrow>
      <h1 className="share-title">{title}</h1>
      <p className="small muted" style={{ margin: 0 }}>{body}</p>
    </Shell>
  );
}
