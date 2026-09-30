import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import { recordShareView, getShareTarget } from '@/lib/db';
import { resolveLinkAccess } from '@/lib/share-access';
import { isShareToken } from '@/lib/share-kinds';
import { playableProxies, withProxyKeys } from '@/lib/file-listing';
import { currentGuest } from '@/lib/share-review';
import { kindLabel } from '@/lib/file-info';
import { fmtSize, sharedFile } from '@/lib/media';
import FilePreview from '@/app/components/file/FilePreview';
import PreviewPreconnect from '@/app/components/PreviewPreconnect';
import { DownloadButtons } from '@/app/components/download/DownloadAs';
import UnlockForm from './UnlockForm';
import ShareReview from './ShareReview';
import FolderShare from './FolderShare';
import Shell from './Shell';

export const dynamic = 'force-dynamic';

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
    return <FolderShare token={token} access={access} brand={brand} path={path} />;
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
    const file = sharedFile(signed);
    const review = access.review;
    return (
      <Shell brand={brand} wide={!!review}>
        {/* Only once the link has let them in: a locked link connects to nothing. */}
        <PreviewPreconnect urls={[file.thumbnailUrl, file.posterUrl, file.proxyUrl, file.url]} />
        <div className="share-file">
          <div className="share-head">
            <div style={{ minWidth: 0 }}>
              <h1 className="share-name" title={file.name}>{file.name}</h1>
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
            <DownloadButtons file={file} base={`/s/${token}/download`} primary guest frame=".share-file video" />
          </div>
          {review
            ? <ShareReview file={file} token={token} level={review} guest={currentGuest(token)} />
            : <FilePreview file={file} />}
          <p className="small muted share-foot">
            {access.kind === 'private'
              ? `A private link: it opens only for people in ${brand.name} who can already see this file.`
              : review
                ? `Shared from ${brand.name} for review. Anyone with this link can read the comments made through it.`
                : `Shared from ${brand.name}.`}
          </p>
        </div>
      </Shell>
    );
  }

  if (access.state === 'password' || access.state === 'locked') {
    return (
      <Shell brand={brand} narrow>
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
