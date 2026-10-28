'use client';

import FolderDrop from './FolderDrop';
import ActivityPopover from './ActivityPopover';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import Icon from '@/app/components/ui/Icon';
import { crumbsFor, foldCrumbs } from '@/lib/folder-ops';

/**
 * The files page's title bar: where you are, and three things to do there.
 *
 * Left, the way back and the path. In the drive's (or library's) top folder
 * that is a dot in the drive's own colour (lib/drive-color.js — the library's
 * is the accent) and its name. Below it:
 *
 *   ←            back to the folder above (`onUp`, which lands on the folder
 *                you left selected, as Back does)
 *   ⌂ Drive      the top folder, as a chip in the drive's colour — always
 *                there, a phone included, where it is the house alone
 *   … ›          the folders between, folded into a menu once there are
 *                more than two (foldCrumbs); on a phone, where the folders
 *                between are hidden, all of them
 *   Folder ›     the folder just above
 *   Open folder  the title
 *
 * Every crumb above the open folder is a way back up and a drop target, so
 * files can be dragged to a folder above without the sidebar; each carries
 * data-folder, so the page's context menu treats it as that folder. A crumb
 * held under a drag does not spring open (DragPreview): opening it would
 * take away the crumb being aimed at. The folded ones are in a menu, so they
 * take no drops; the sidebar's tree does.
 *
 * Right: Upload (files, a folder, a new folder — for someone who may add
 * here), Share (a link to the open folder, when there is one and this person
 * may make its links: `onShare`), Activity (what changed most recently), and
 * the sidebar's toggle.
 */
/* icons: upload folder-open folder-plus */
export default function FilesHeader({
  folder, rootName, color, canWrite, onOpen, onUp, onDrop, onUploadFiles, onUploadFolder, onNewFolder,
  filespaceId, onOpenFile, onShowRecent, onShare = null, sidebarOpen, onToggleSidebar,
}) {
  const crumbs = crumbsFor(folder, rootName);
  const { top, folded, between, here } = foldCrumbs(crumbs);
  const atTop = crumbs.length === 1;
  const up = atTop ? null : crumbs[crumbs.length - 2];
  // The folders between, all of them: what a phone's menu lists.
  const middle = [...folded, ...between];
  const sep = <Icon name="chevron-right" size={14} className="crumb-sep" />;
  const folderMenu = (list, className) => (
    <li className={`crumb-item crumb-more ${className}`}>
      <Menu
        ariaLabel={`${list.length} more folder${list.length === 1 ? '' : 's'} on the way here`}
        title="Folders on the way here"
        align="left"
        buttonClassName="crumb crumb-more-btn"
        trigger={<Icon name="ellipsis" size={18} />}
      >
        {list.map((c) => (
          <MenuItem key={c.path} icon="folder" onClick={() => onOpen(c.path)}>{c.name}</MenuItem>
        ))}
      </Menu>
      {sep}
    </li>
  );
  return (
    <header className="files-header">
      {up && (
        <button
          type="button"
          className="btn btn-ghost btn-icon hdr-btn files-up"
          onClick={() => (onUp ? onUp() : onOpen(up.path))}
          aria-label={`Back to ${up.name}`}
          title={`Back to ${up.name}`}
        >
          <Icon name="arrow-left" size={18} />
        </button>
      )}
      <nav className="crumbs" aria-label="Folder path" style={{ '--dot': color }}>
        {atTop && <span className="drive-dot" aria-hidden />}
        <ol>
          {!atTop && (
            <li className="crumb-item crumb-top">
              <FolderDrop target={top.path} enabled={canWrite} onDrop={onDrop} spring={false} className="crumb-drop">
                <button
                  type="button"
                  className="crumb crumb-home"
                  data-folder={top.path}
                  title={`${top.name}: the top folder`}
                  aria-label={`${top.name}, the top folder`}
                  onClick={() => onOpen(top.path)}
                >
                  <Icon name="house" size={15} className="crumb-home-icon" />
                  <span className="crumb-home-name">{top.name}</span>
                </button>
              </FolderDrop>
              {sep}
            </li>
          )}
          {folded.length > 0 && folderMenu(folded, 'is-wide')}
          {middle.length > 0 && folderMenu(middle, 'is-narrow')}
          {between.map((c) => (
            <li key={c.path} className="crumb-item crumb-between">
              <FolderDrop target={c.path} enabled={canWrite} onDrop={onDrop} spring={false} className="crumb-drop">
                <button type="button" className="crumb" data-folder={c.path} title={c.path || c.name} onClick={() => onOpen(c.path)}>
                  {c.name}
                </button>
              </FolderDrop>
              {sep}
            </li>
          ))}
          <li className="crumb-item crumb-here">
            <h1 className="files-title truncate" aria-current="page" title={here.path || here.name}>{here.name}</h1>
          </li>
        </ol>
      </nav>
      <div className="files-header-actions">
        {canWrite && (
          <Menu
            ariaLabel="Upload"
            title="Upload"
            buttonClassName="btn btn-ghost btn-icon hdr-btn"
            trigger={<Icon name="cloud-upload" size={18} />}
          >
            <MenuItem icon="upload" onClick={onUploadFiles}>Upload files…</MenuItem>
            <MenuItem icon="folder-open" onClick={onUploadFolder}>Upload folder…</MenuItem>
            <MenuSeparator />
            <MenuItem icon="folder-plus" onClick={onNewFolder}>New folder…</MenuItem>
          </Menu>
        )}
        {onShare && (
          <button
            type="button"
            className="btn btn-ghost btn-icon hdr-btn"
            onClick={onShare}
            aria-label={`Share “${here.name}”`}
            title="Share this folder"
          >
            <Icon name="link" size={18} />
          </button>
        )}
        <ActivityPopover filespaceId={filespaceId} folder={folder} rootName={rootName} onOpen={onOpenFile} onShowAll={onShowRecent} />
        <button
          type="button"
          className="btn btn-ghost btn-icon hdr-btn"
          aria-expanded={sidebarOpen}
          aria-controls="files-sidebar"
          aria-label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          onClick={onToggleSidebar}
        >
          <Icon name="panel-left" size={18} />
        </button>
      </div>
    </header>
  );
}
