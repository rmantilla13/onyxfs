import Menu from '@/app/components/ui/Menu';
import FolderGlyph from '@/app/components/ui/FolderGlyph';
import Icon from '@/app/components/ui/Icon';
import { foldCrumbs } from '@/lib/folder-ops';
import { linkFolderHref } from '@/lib/folder-links';

/** "…": the folders between, as links in a menu (the Files header's, with hrefs). */
function FolderMenu({ token, list, className }) {
  return (
    <li className={`crumb-item crumb-more ${className}`}>
      <Menu
        ariaLabel={`${list.length} more folder${list.length === 1 ? '' : 's'} on the way here`}
        title="Folders on the way here"
        align="left"
        buttonClassName="crumb crumb-more-btn"
        trigger={<Icon name="ellipsis" size={18} />}
      >
        {list.map((c) => (
          <a key={c.sub} className="menu-item" role="menuitem" href={linkFolderHref(token, c.sub)}>
            <Icon name="folder" size={15} className="menu-item-icon" />
            <span className="menu-item-text">{c.name}</span>
          </a>
        ))}
      </Menu>
      <Icon name="chevron-right" size={14} className="crumb-sep" />
    </li>
  );
}

/**
 * The path on a link's pages, laid out as the Files header lays out a
 * folder's (app/files/FilesHeader.js): the link's own folder as a chip with
 * a house — the way back to the top of what was shared, on every screen —
 * then the folders between, folded into "…" past two (foldCrumbs; on a
 * phone, all of them), then the folder just above. `crumbs` is
 * lib/folder-links.js linkCrumbs's, so it never reaches above the link.
 *
 * With a `title` the last crumb is the open folder, as a heading (`as`);
 * at the link's own folder that is its glyph and its name, as before.
 * Without one — a file's page — every crumb is a way back, the last its
 * folder.
 */
export default function LinkPath({ token, crumbs, title = null, as: Heading = 'h1', className = '' }) {
  const { top, folded, between, here } = foldCrumbs(crumbs);
  const atTop = crumbs.length === 1;
  const middle = [...folded, ...between];
  const sep = <Icon name="chevron-right" size={14} className="crumb-sep" />;
  const link = (c) => (
    <a className="crumb" href={linkFolderHref(token, c.sub)} title={c.name}>{c.name}</a>
  );
  return (
    <nav className={`crumbs ${className}`.trim()} aria-label="Folder path">
      {atTop && title != null && <FolderGlyph size={22} className="share-folder-glyph" />}
      <ol>
        {!(atTop && title != null) && (
          <li className="crumb-item crumb-top">
            <a className="crumb crumb-home" href={linkFolderHref(token)} title={`${top.name}: the shared folder`} aria-label={`${top.name}, the shared folder`}>
              <Icon name="house" size={15} className="crumb-home-icon" />
              <span className="crumb-home-name">{top.name}</span>
            </a>
            {!atTop && sep}
          </li>
        )}
        {folded.length > 0 && <FolderMenu token={token} list={folded} className="is-wide" />}
        {middle.length > 0 && <FolderMenu token={token} list={middle} className="is-narrow" />}
        {between.map((c) => (
          <li key={c.sub} className="crumb-item crumb-between">{link(c)}{sep}</li>
        ))}
        {!atTop && (title != null ? (
          <li className="crumb-item crumb-here">
            <Heading className="files-title truncate" aria-current="page" title={title}>{title}</Heading>
          </li>
        ) : (
          <li className="crumb-item crumb-here">{link(here)}</li>
        ))}
        {atTop && title != null && (
          <li className="crumb-item crumb-here">
            <Heading className="files-title truncate" aria-current="page" title={title}>{title}</Heading>
          </li>
        )}
      </ol>
    </nav>
  );
}
