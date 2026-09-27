import Icon from '@/app/components/ui/Icon';

/**
 * A folder, drawn solid: the kit's folder outline filled for the back and
 * its tab, with the front panel laid over it a shade lighter — the way a
 * desktop draws a folder, so one reads as a folder at a glance beside the
 * files' pictures. Both shades are the accent mixed with the page's own
 * colours (globals.css, .folder-glyph), so a white-label palette gets its
 * own folders and the dark scheme its own shading.
 */
export default function FolderGlyph({ size = 44, className = '' }) {
  return (
    <span className={`folder-glyph${className ? ` ${className}` : ''}`} style={{ '--glyph': `${size}px` }} aria-hidden>
      <Icon name="folder" size={size} strokeWidth={1.5} fill="currentColor" className="folder-glyph-back" />
      <span className="folder-glyph-front" />
    </span>
  );
}
