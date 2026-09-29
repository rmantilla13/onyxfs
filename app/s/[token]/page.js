import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import { recordShareView } from '@/lib/db';
import { resolveShareAccess } from '@/lib/share-access';
import { playableProxies, withProxyKeys } from '@/lib/file-listing';
import { currentGuest } from '@/lib/share-review';
import { kindLabel } from '@/lib/file-info';
import { fmtSize, sharedFile } from '@/lib/media';
import FilePreview from '@/app/components/file/FilePreview';
import PreviewPreconnect from '@/app/components/PreviewPreconnect';
import { DownloadButtons } from '@/app/components/download/DownloadAs';
import UnlockForm from './UnlockForm';
import ShareReview from './ShareReview';
import BrandLogo from '@/app/components/BrandLogo';

export const dynamic = 'force-dynamic';
// A shared file is not for search engines, and the title says nothing about
// it: a password or private link must not leak the file's name to a preview.
export const metadata = { title: 'Shared file', robots: { index: false, follow: false } };

/**
 * /s/<token> — a shared file, for whoever the link lets in (lib/share-access).
 *
 * Outside the middleware's sign-in wall (see the matcher): a public or
 * password link has to open for someone with no account. A private link asks
 * for sign-in itself, and comes back here afterwards.
 *
 * A link set to take comments (`access.review`) shows the file with the
 * review tools beside it (ShareReview); its routes are under this path too,
 * and decide again on every request (lib/share-review.js).
 */
export default async function SharePage({ params }) {
  const { token } = params;
  const access = await resolveShareAccess(token);
  if (access.state === 'signin') {
    redirect(`/signin?callbackUrl=${encodeURIComponent(`/s/${token}`)}`);
  }
  const brand = await loadBrand();

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
        <h1 className="share-title">This file is password protected</h1>
        <p className="small muted" style={{ margin: '0 0 var(--s4)' }}>Enter the password you were given with the link.</p>
        <UnlockForm token={token} locked={access.state === 'locked'} />
      </Shell>
    );
  }

  const MESSAGES = {
    expired: ['This link has expired', 'Ask whoever sent it for a new one.'],
    gone: ['This file is no longer available', 'It was removed after the link was made.'],
    denied: ['You do not have access to this file', `You are signed in as ${access.email}. Ask whoever sent the link to give you access.`],
    off: ['Sharing is turned off', `Links to files in ${brand.name} are not being served right now.`],
    paused: ['This link is paused', 'The person who shared it can’t share files right now. Ask them, or someone else, for another way to the file.'],
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

function Shell({ brand, narrow = false, wide = false, children }) {
  return (
    <main className={`share-page${narrow ? ' is-narrow' : ''}${wide ? ' is-wide' : ''}`}>
      <header className="share-brand">
        <BrandLogo logo={brand.visual.logo} name={brand.name} withName height={22} />
      </header>
      <div className={narrow ? 'card share-card' : 'share-body'}>{children}</div>
    </main>
  );
}
