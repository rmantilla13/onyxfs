'use client';

import { useRef, useState } from 'react';
import { beginDrag, draggingHere, dropVerdict } from './DragPreview';

// Drag payloads for moves inside the library. An OS file drag carries
// 'Files' instead, which is what tells an upload from a move. A selection
// that holds folders carries all of it as DRAG_ITEMS ({ folders, files }),
// beside the one folder or the files it would have carried on its own.
export const DRAG_FILES = 'application/x-onyx-files';
export const DRAG_FOLDER = 'application/x-onyx-folder';
export const DRAG_ITEMS = 'application/x-onyx-items';

export const isMoveDrag = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  return types.includes(DRAG_FILES) || types.includes(DRAG_FOLDER) || types.includes(DRAG_ITEMS) || types.includes('Files');
};

/**
 * Start dragging a folder, under a picture of itself that shrinks to a chip
 * beside the pointer (DragPreview). On its own by default — the tree's
 * folders, which are not selected; with `paths` (and `ids`, files of `rows`)
 * it carries a selection it is part of, and the chip counts all of it.
 */
export function startFolderDrag(e, path, { paths = [path], ids = [], rows = [] } = {}) {
  const many = paths.length > 1 || ids.length > 0;
  e.dataTransfer.setData(DRAG_FOLDER, path);
  if (many) e.dataTransfer.setData(DRAG_ITEMS, JSON.stringify({ folders: paths, files: ids }));
  e.dataTransfer.setData('text/plain', many ? `${paths.length + ids.length} items` : path);
  e.dataTransfer.effectAllowed = 'move';
  beginDrag(e, { kind: 'folder', path, paths, ids, rows });
}

/**
 * A drop target: a folder in the tree, a crumb, a folder tile or row.
 *
 * A move begun on this page is followed by the drag layer (DragPreview),
 * which finds this by its data-drop-target, marks it (data-drop="ok" lights
 * it as .is-over does), and opens it when it is held there (`spring`: not a
 * crumb, which opening would take away). It may be refused — where the files
 * are already, a folder onto or into itself — and then the drop is not
 * offered (dropEffect none); one that comes all the same (a browser that let
 * go before a dragover here, keeping the last effect it was offered) is
 * ignored.
 *
 * Anything else droppable — files from the desktop, a move from another
 * tab — highlights it here while it is over it, and `onDragHold` fires after
 * a moment of hovering, which the tree uses to open a collapsed folder so a
 * drop can reach its children.
 */
export default function FolderDrop({ target, enabled, onDrop, onDragHold, spring = true, className = '', style, children }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hold = useRef(null);
  const end = () => { depth.current = 0; setOver(false); clearTimeout(hold.current); };
  if (!enabled) return <div className={className} style={style} data-drop-target={target} data-drop-readonly="">{children}</div>;
  return (
    <div
      className={`${className} folder-drop${over ? ' is-over' : ''}`}
      style={style}
      data-drop-target={target}
      data-drop-spring={spring ? '' : undefined}
      onDragEnter={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        if (draggingHere()) return;
        depth.current += 1;
        if (!over) {
          setOver(true);
          if (onDragHold) hold.current = setTimeout(onDragHold, 700);
        }
      }}
      onDragOver={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        const verdict = dropVerdict(target);
        e.dataTransfer.dropEffect = verdict && verdict !== 'ok' ? 'none'
          : [...e.dataTransfer.types].includes('Files') ? 'copy' : 'move';
      }}
      onDragLeave={(e) => {
        if (!isMoveDrag(e) || draggingHere()) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) end();
      }}
      onDrop={(e) => {
        if (!isMoveDrag(e)) return;
        // Handled here, not by the page's upload drop as well.
        e.preventDefault();
        e.stopPropagation();
        end();
        const verdict = dropVerdict(target);
        if (verdict && verdict !== 'ok') return;
        onDrop(target, e);
      }}
    >
      {children}
    </div>
  );
}
