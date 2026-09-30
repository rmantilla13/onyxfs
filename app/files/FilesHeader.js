'use client';

import FolderDrop from './FolderDrop';
import ActivityPopover from './ActivityPopover';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import Icon from '@/app/components/ui/Icon';
import { crumbsFor } from '@/lib/folder-ops';

/**
 * The files page's title bar: where you are, and three things to do there.
 *
 * Left, a dot in the drive's own colour (lib/drive-color.js — the library's
 * is the accent) and the path: the drive or library, then each folder down
 * to the open one. Every crumb above the open folder is a way back up and a
 * drop target, so files can be dragged to a folder above without the
 * sidebar; each carries data-folder, so the page's context menu treats it as
 * that folder. A crumb held under a drag does not spring open (DragPreview):
 * opening it would take away the crumb being aimed at.
 *
 * Right: Upload (files, a folder, a new folder — for someone who may add
 * here), Share (a link to the open folder, when there is one and this person
 * may make its links: `onShare`), Activity (what changed most recently), and
 * the sidebar's toggle.
 */
/* icons: upload folder-open folder-plus */
export default function FilesHeader({
  folder, rootName, color, canWrite, onOpen, onDrop, onUploadFiles, onUploadFolder, onNewFolder,
  filespaceId, onOpenFile, onShowRecent, onShare = null, sidebarOpen, onToggleSidebar,
}) {
  const crumbs = crumbsFor(folder, rootName);
  const here = crumbs[crumbs.length - 1];
  const up = crumbs.length > 1 ? crumbs[crumbs.length - 2] : null;
  return (
    <header className="files-header">
      {/* A phone has room for the open folder's name and not its path: the
          way up is this, and the crumbs above it are hidden (globals.css). */}
      {up && (
        <button
          type="button"
          className="btn btn-ghost btn-icon hdr-btn files-up"
          onClick={() => onOpen(up.path)}
          aria-label={`Up to ${up.name}`}
          title={`Up to ${up.name}`}
        >
          <Icon name="chevron-left" size={18} />
        </button>
      )}
      <nav className="crumbs" aria-label="Folder path">
        <span className="drive-dot" style={{ '--dot': color }} aria-hidden />
        <ol>
          {crumbs.slice(0, -1).map((c) => (
            <li key={c.path || '/'} className="crumb-item">
              <FolderDrop target={c.path} enabled={canWrite} onDrop={onDrop} spring={false} className="crumb-drop">
                <button type="button" className="crumb" data-folder={c.path} title={c.path || c.name} onClick={() => onOpen(c.path)}>
                  {c.name}
                </button>
              </FolderDrop>
              <Icon name="chevron-right" size={14} className="crumb-sep" />
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
