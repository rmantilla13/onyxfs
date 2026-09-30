import { redirect } from 'next/navigation';
import { loadBrand } from '@/lib/brand-config';
import { presignFileUrls } from '@/lib/storage';
import { resolveFolderShareAccess, folderLinkFile } from '@/lib/share-access';
import { linkCrumbs, linkFolderHref, linkFileHref, relativeTo } from '@/lib/folder-links';
import { playableProxies, withProxyKeys } from '@/lib/file-listing';
import { kindLabel } from '@/lib/file-info';
import { fmtSize, sharedFile } from '@/lib/media';
import FilePreview from '@/app/components/file/FilePreview';
import Icon from '@/app/components/ui/Icon';
import Shell from '../../Shell';

export const dynamic = 'force-dynamic';
// As /s/<token>: nothing about the file in the title, and not for search engines.
export const metadata = { title: 'Shared file', robots: { index: false, follow: false } };

/**
 * /s/<token>/files/<id> — one file of a folder link, previewed as a file
 * link previews its file (FilePreview), with its download and the way back
 * to the folder it is in.
 *
 * Decided again here, not taken from having listed it: the link as the page
 * decides it (lib/share-access.js — anything but 'ok' goes back to
 * /s/<token>, which says why, or asks for the password), and then the file,
 * which must be one the link reaches NOW (folderLinkFile): a file moved out
 * of the folder, trashed or restricted since the listing, or an id from
 * anywhere else, is not in the link. Only then is it signed.
 */
export default async function SharedFolderFilePage({ params }) {
  const { token, id } = params;
  const access = await resolveFolderShareAccess(token);
  if (access.state !== 'ok') redirect(linkFolderHref(token));
  const brand = await loadBrand();

  let file = null;
  try {
    file = await folderLinkFile(access, id);
  } catch {
    return (
      <Shell brand={brand} narrow>
        <h1 className="share-title">This link can’t be opened right now</h1>
        <p className="small muted" style={{ margin: 0 }}>Try again in a moment.</p>
      </Shell>
    );
  }
  if (!file) {
    return (
      <Shell brand={brand} narrow>
        <h1 className="share-title">This file is not in the link</h1>
        <p className="small muted" style={{ margin: 0 }}>It may have been moved or removed since the link was made.</p>
        <p className="small" style={{ margin: 'var(--s4) 0 0' }}>
          <a className="share-back" href={linkFolderHref(token)}>Back to the shared folder</a>
        </p>
      </Shell>
    );
  }

  // Signed for six hours, as a file link's is, so a paused video still seeks
  // when it resumes; a heavy video's streamable copy first, under the flags
  // the link was let in by. Then cut down to what the viewer reads.
  const proxies = await playableProxies([file], access.flags);
  const [signed] = await presignFileUrls(withProxyKeys([file], proxies), { expiresIn: 21600 });
  const shown = sharedFile(signed);
  const sub = relativeTo(access.scope.root, file.folder) ?? '';
  const crumbs = linkCrumbs(access.scope.root, sub);
  const folder = crumbs[crumbs.length - 1];

  return (
    <Shell brand={brand}>
      <div className="share-file">
        <nav className="crumbs share-file-crumbs" aria-label="Folder path">
          <ol>
            {crumbs.map((c) => (
              <li key={c.sub || '/'} className="crumb-item">
                <a className="crumb" href={linkFolderHref(token, c.sub)} title={c.name}>{c.name}</a>
                <Icon name="chevron-right" size={14} className="crumb-sep" />
              </li>
            ))}
          </ol>
        </nav>
        <div className="share-head">
          <a className="btn btn-ghost btn-icon" href={linkFolderHref(token, folder.sub)} aria-label={`Back to ${folder.name}`} title={`Back to ${folder.name}`}>
            <Icon name="arrow-left" size={18} />
          </a>
          <div style={{ minWidth: 0 }}>
            <h1 className="share-name" title={shown.name}>{shown.name}</h1>
            <p className="small muted" style={{ margin: 0 }}>
              {kindLabel(shown)}{shown.size != null ? ` · ${fmtSize(shown.size)}` : ''}
            </p>
          </div>
          <div className="spacer" />
          <a className="btn btn-primary" href={`${linkFileHref(token, file.id)}/download`}>Download</a>
        </div>
        <FilePreview file={shown} />
        <p className="small muted share-foot">Shared from {brand.name}, in “{folder.name}”.</p>
      </div>
    </Shell>
  );
}
