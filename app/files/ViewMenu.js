'use client';

import Menu, { MenuItem, MenuSeparator, MenuLabel } from '@/app/components/ui/Menu';
import Icon from '@/app/components/ui/Icon';

/**
 * Select view: the built-in views (lib/views.js), then the person's own —
 * the ones for everywhere and for the drive on screen — then saving the
 * view on screen as a new one, and managing the ones they have.
 *
 * Its button names the view on screen, or invites a choice while it is the
 * default; a saved view with unsaved changes carries a dot, and the menu
 * offers to save or revert them. Saving and managing are dialogs of their
 * own (./ViewDialogs.js), loaded when first opened.
 */

/* icons: files clock image film audio-lines file-text file bookmark layers save undo-2 bookmark-plus square-pen */
export default function ViewMenu({
  view, builtins, mine, dirty, driveNames, onView, onSaveChanges, onRevert, onSaveAs, onManage, canManage,
}) {
  const label = view.id === 'all' && !dirty ? 'Select view' : view.name;
  return (
    <Menu
      ariaLabel={`View: ${view.name}${dirty ? ' (changed)' : ''}`}
      title={dirty ? `${view.name}: changed since it was saved` : undefined}
      buttonClassName={`btn btn-ghost tb-btn tb-view${label === 'Select view' ? ' is-default' : ''}`}
      menuClassName="view-menu"
      trigger={(
        <>
          <Icon name={view.id === 'all' ? 'layers' : view.icon || 'bookmark'} size={16} />
          <span className="tb-view-name truncate">{label}</span>
          {dirty && <span className="tb-dirty" aria-hidden />}
          <Icon name="chevron-down" size={14} className="tb-caret" />
        </>
      )}
    >
      <MenuLabel>Views</MenuLabel>
      {builtins.map((v) => (
        <MenuItem key={v.id} icon={v.icon} checked={view.id === v.id} onClick={() => onView(v.id)}>{v.name}</MenuItem>
      ))}
      <MenuSeparator />
      <MenuLabel>My views</MenuLabel>
      {mine.length ? mine.map((v) => (
        <MenuItem
          key={v.id}
          icon="bookmark"
          checked={view.id === v.id}
          hint={v.driveId ? driveNames.get(v.driveId) : undefined}
          onClick={() => onView(v.id)}
        >
          {v.name}
        </MenuItem>
      )) : <p className="menu-empty small muted">Views you save show here.</p>}
      <MenuSeparator />
      {dirty && <MenuItem icon="save" onClick={onSaveChanges}>Save changes to “{view.name}”</MenuItem>}
      {dirty && <MenuItem icon="undo-2" onClick={onRevert}>Revert changes</MenuItem>}
      <MenuItem icon="bookmark-plus" onClick={onSaveAs}>Save current view…</MenuItem>
      <MenuItem icon="square-pen" onClick={onManage} disabled={!canManage}>Manage views…</MenuItem>
    </Menu>
  );
}
