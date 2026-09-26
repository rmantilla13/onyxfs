'use client';

import { useRef, useState } from 'react';

// Drag payloads for moves inside the library. An OS file drag carries
// 'Files' instead, which is what tells an upload from a move.
export const DRAG_FILES = 'application/x-onyx-files';
export const DRAG_FOLDER = 'application/x-onyx-folder';

export const isMoveDrag = (e) => {
  const types = [...(e.dataTransfer?.types || [])];
  return types.includes(DRAG_FILES) || types.includes(DRAG_FOLDER) || types.includes('Files');
};

/** Start dragging a folder: it moves alone, whatever else is selected. */
export function startFolderDrag(e, path) {
  e.dataTransfer.setData(DRAG_FOLDER, path);
  e.dataTransfer.setData('text/plain', path);
  e.dataTransfer.effectAllowed = 'move';
}

/**
 * A drop target: a folder in the tree, a crumb, a folder tile or row.
 * Highlights while something droppable is over it; `onDragHold` fires after a
 * moment of hovering, which the tree uses to open a collapsed folder so a
 * drop can reach its children.
 */
export default function FolderDrop({ target, enabled, onDrop, onDragHold, className = '', style, children }) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const hold = useRef(null);
  const end = () => { depth.current = 0; setOver(false); clearTimeout(hold.current); };
  if (!enabled) return <div className={className} style={style}>{children}</div>;
  return (
    <div
      className={`${className} folder-drop${over ? ' is-over' : ''}`}
      style={style}
      onDragEnter={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        depth.current += 1;
        if (!over) {
          setOver(true);
          if (onDragHold) hold.current = setTimeout(onDragHold, 700);
        }
      }}
      onDragOver={(e) => {
        if (!isMoveDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes('Files') ? 'copy' : 'move';
      }}
      onDragLeave={(e) => {
        if (!isMoveDrag(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) end();
      }}
      onDrop={(e) => {
        if (!isMoveDrag(e)) return;
        // Handled here, not by the page's upload drop as well.
        e.preventDefault();
        e.stopPropagation();
        end();
        onDrop(target, e);
      }}
    >
      {children}
    </div>
  );
}
