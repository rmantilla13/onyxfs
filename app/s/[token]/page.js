import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import { recordShareView } from '@/lib/db';
import { resolveShareAccess } from '@/lib/share-access';
import { kindLabel } from '@/lib/file-info';
import { fmtSize } from '@/lib/media';
import FilePreview from '@/app/components/file/FilePreview';
import UnlockForm from './UnlockForm';

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
    // resumes. Signed only now, after access was decided.
    const [file] = await presignFileUrls([access.file], { expiresIn: 21600 });
    return (
      <Shell brand={brand}>
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
            <a className="btn btn-primary" href={`/s/${token}/download`}>Download</a>
          </div>
          <FilePreview file={file} />
          <p className="small muted share-foot">
            {access.kind === 'private'
              ? `A private link: it opens only for people in ${brand.name} who can already see this file.`
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

function Shell({ brand, narrow = false, children }) {
  return (
    <main className={`share-page${narrow ? ' is-narrow' : ''}`}>
      <header className="share-brand">
        <img src={brand.visual.logo.markPath} alt="" width={24} height={24} style={{ borderRadius: 6 }} />
        <strong>{brand.name}</strong>
      </header>
      <div className={narrow ? 'card share-card' : 'share-body'}>{children}</div>
    </main>
  );
}
