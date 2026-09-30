'use client';

import { memo } from 'react';
import Icon from '@/app/components/ui/Icon';
import FolderDrop from './FolderDrop';

const baseName = (path) => path.slice(path.lastIndexOf('/') + 1);

/**
 * The sidebar's Starred section: a person's starred folders, in any drive,
 * oldest first (GET /api/stars). A row in the drive on screen is a tree row
 * like any other — a drop target, and `data-folder` for the folder's own
 * menu; one in another drive says which, and opens it there.
 *
 * Nothing shows until something is starred: the folder menu's "Add to
 * Starred" is how a first one gets here.
 */
const StarredFolders = memo(function StarredFolders({
  stars, drives, driveId, folder, canWrite, onOpen, onUnstar, onDrop,
}) {
  if (!stars.length) return null;
  const names = new Map(drives.map((d) => [d.id, d.name]));
  return (
    <div className="side-section side-starred">
      <h3 className="side-title">Starred</h3>
      <div className="folder-list starred-list">
        {stars.map((s) => {
          const here = s.driveId === driveId;
          const where = here ? null : (s.driveId ? names.get(s.driveId) : 'All files');
          const active = here && s.folder === folder;
          const link = (
            <button
              type="button"
              className={`small folder-link${active ? ' active' : ''}`}
              aria-current={active ? 'true' : undefined}
              onClick={() => onOpen(s)}
              title={where ? `${s.folder} — ${where}` : s.folder}
              data-folder={here ? s.folder : undefined}
              data-star-drive={here ? undefined : s.driveId}
              data-star-folder={here ? undefined : s.folder}
            >
              <Icon name="star" size={13} className="starred-glyph" />
              <span className="folder-name">{baseName(s.folder)}</span>
              {where && <span className="muted folder-count starred-where">{where}</span>}
            </button>
          );
          return (
            <FolderDrop
              key={`${s.driveId}\n${s.folder}`}
              target={s.folder}
              enabled={here && canWrite}
              onDrop={onDrop}
              className="folder-row starred-row"
            >
              {link}
              <button
                type="button"
                className="starred-remove"
                onClick={() => onUnstar(s)}
                aria-label={`Remove ${baseName(s.folder)} from Starred`}
                title="Remove from Starred"
              >
                <Icon name="x" size={12} />
              </button>
            </FolderDrop>
          );
        })}
      </div>
    </div>
  );
});

export default StarredFolders;
