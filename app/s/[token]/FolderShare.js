import { recordShareView, folderLinkRootExists, linkSenderName } from '@/lib/db';
import { folderLinkListing } from '@/lib/share-access';
import { linkSubpath, linkCrumbs, linkFolderHref as folderHref } from '@/lib/folder-links';
import { describeFolder } from '@/lib/folder-ops';
import FolderGlyph from '@/app/components/ui/FolderGlyph';
import Icon from '@/app/components/ui/Icon';
import FolderFiles from './FolderFiles';
import Shell, { introFrom } from './Shell';

function Message({ brand, title, body, token, look = null }) {
  return (
    <Shell brand={brand} narrow look={look}>
      <h1 className="share-title">{title}</h1>
      <p className="small muted" style={{ margin: 0 }}>{body}</p>
      {token && (
        <p className="small" style={{ margin: 'var(--s4) 0 0' }}>
          <a className="share-back" href={folderHref(token)}>Back to the shared folder</a>
        </p>
      )}
    </Shell>
  );
}

/**
 * A folder link, open (lib/share-access.js said 'ok'): the folder at `path`
 * within it — `?path=`, relative to the link's folder, never above it — with
 * its subfolders and the first page of its files, as the Files view shows a
 * folder, for someone with no account: no selection, no menus, nothing that
 * edits. A file opens on its own page under the link, and downloads from
 * there or from its card.
 *
 * What is shown is the folder now (lib/folder-links.js): a file moved out,
 * trashed, or restricted to certain people is not here on the next request,
 * and one added is. A view is counted when the link's own folder is opened,
 * not each subfolder.
 *
 * In the link's view (access.look.view: grid, list or gallery) and look,
 * with the sharer's words over the link's own folder — not repeated in each
 * folder inside it. Its files download only when the link allows it.
 */
export default async function FolderShare({ token, access, brand, path }) {
  const { look, downloads } = access;
  const sub = linkSubpath(path);
  if (sub == null) {
    return <Message brand={brand} look={look} token={token} title="This folder is not in the link" body="The link opens one folder and what is inside it." />;
  }
  const listing = await folderLinkListing(access, { sub });
  if (listing.state) {
    return <Message brand={brand} look={look} title="This link can’t be opened right now" body="Try again in a moment." />;
  }
  const { files, cursor, folders, count } = listing;
  const empty = !files.length && !folders.length;
  if (empty && sub) {
    return <Message brand={brand} look={look} token={token} title="This folder is not in the link" body="It may have been moved, removed or emptied since the link was made." />;
  }
  if (empty && !(await folderLinkRootExists(access.scope).catch(() => true))) {
    return <Message brand={brand} look={look} title="This folder is no longer available" body="It was removed after the link was made." />;
  }
  if (!sub) await recordShareView(token);
  const sender = !sub && look.sender ? await linkSenderName(access.row.created_by) : null;
  const intro = sub ? null : introFrom(look, sender);

  const crumbs = linkCrumbs(access.scope.root, sub);
  const here = crumbs[crumbs.length - 1];
  const up = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  const total = count + folders.reduce((n, f) => n + f.count, 0);
  const summary = describeFolder({ total, subfolders: folders.length });

  return (
    <Shell brand={brand} wide look={look} view={look.view} intro={intro}>
      <div className="files-pane share-folder" data-card-size="m">
        <header className="files-header share-folder-head">
          {up && (
            <a className="btn btn-ghost btn-icon hdr-btn files-up" href={folderHref(token, up.sub)} aria-label={`Up to ${up.name}`} title={`Up to ${up.name}`}>
              <Icon name="chevron-left" size={18} />
            </a>
          )}
          <nav className="crumbs" aria-label="Folder path">
            <FolderGlyph size={22} className="share-folder-glyph" />
            <ol>
              {crumbs.slice(0, -1).map((c) => (
                <li key={c.sub || '/'} className="crumb-item">
                  <a className="crumb" href={folderHref(token, c.sub)} title={c.name}>{c.name}</a>
                  <Icon name="chevron-right" size={14} className="crumb-sep" />
                </li>
              ))}
              <li className="crumb-item crumb-here">
                {intro?.title
                  ? <h2 className="files-title truncate" aria-current="page" title={here.name}>{here.name}</h2>
                  : <h1 className="files-title truncate" aria-current="page" title={here.name}>{here.name}</h1>}
              </li>
            </ol>
          </nav>
        </header>
        <p className="small muted share-folder-summary">{summary === 'Empty' ? 'This folder is empty.' : summary}</p>

        {folders.length > 0 && (
          <section className="files-section" aria-label="Folders">
            <h2 className="files-section-label">Folders <span className="files-section-count">· {folders.length.toLocaleString()}</span></h2>
            <div className="folder-tiles">
              {folders.map((f) => {
                const childSub = sub ? `${sub}/${f.name}` : f.name;
                return (
                  <a key={f.name} className="folder-tile" href={folderHref(token, childSub)} title={f.name}>
                    <FolderGlyph size={58} className="folder-tile-icon" />
                    <span className="folder-tile-text">
                      <span className="folder-tile-title">
                        <span className="folder-tile-name truncate">{f.name}</span>
                      </span>
                      <span className="folder-tile-meta truncate">{describeFolder({ total: f.count, subfolders: 0 })}</span>
                    </span>
                  </a>
                );
              })}
            </div>
          </section>
        )}

        {files.length > 0 && (
          <section className="files-section" aria-label="Files">
            <h2 className="files-section-label">Files <span className="files-section-count">· {count.toLocaleString()}</span></h2>
            <FolderFiles token={token} sub={sub} initial={files} cursor={cursor} view={look.view} downloads={downloads} />
          </section>
        )}

        <p className="small muted share-foot">
          Shared from {brand.name}. {access.kind === 'password' ? 'Anyone with this link and its password' : 'Anyone with this link'} sees this folder as it is when they open it.
          {downloads ? '' : ' Downloads are turned off for this link.'}
        </p>
      </div>
    </Shell>
  );
}
