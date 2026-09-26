'use client';

import Dialog from '@/app/components/ui/Dialog';
import FilespaceMembers from '@/app/components/FilespaceMembers';
import { fmtSize } from '@/lib/media';
import Icon from '@/app/components/ui/Icon';

/**
 * Drives: the filespaces, shown the way a computer shows its disks. Each is
 * its own place in the bucket (a prefix) with its own members, so creating
 * one and deciding who may use it are separate from every other drive — and
 * the desktop app mounts each as a volume of its own.
 *
 * "All files" sits above them: the whole library, as far as the viewer may
 * see it. Usage is counted on the server (countFilesUnderPrefix); the library
 * total is only shown to admins.
 */
export function DriveList({ drives = [], usage = {}, library = null, activeId = '', pendingId = null, canCreate = false, onOpen, onNew }) {
  const sorted = [...drives].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return (
    <nav className="drives" aria-label="Drives">
      <div className="drives-head">
        <h3 className="drives-title">Drives</h3>
        {canCreate && (
          <button type="button" className="btn btn-ghost btn-sm drives-new" onClick={onNew} aria-label="New drive" title="New drive"><Icon name="plus" /></button>
        )}
      </div>
      <ul className="drives-list edge-scroll">
        <DriveRow
          name="All files"
          detail={library ? usageLine(library) : 'Everything you can open'}
          active={!activeId}
          pending={pendingId === ''}
          onClick={() => onOpen?.('')}
          library
        />
        {sorted.map((d) => (
          <DriveRow
            key={d.id}
            id={d.id}
            name={d.name}
            // Usage for the people who look after the drive; the others see
            // what they may do in it.
            detail={usage[d.id] ? usageLine(usage[d.id]) : ROLE_WORDS[d.role] || d.role}
            role={d.role}
            active={activeId === d.id}
            pending={pendingId === d.id}
            onClick={() => onOpen?.(d.id)}
          />
        ))}
      </ul>
      {!sorted.length && canCreate && (
        <p className="small muted drives-empty">No drives yet. A drive is a space of its own, with its own members.</p>
      )}
    </nav>
  );
}

const ROLE_WORDS = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };
const usageLine = (u) => `${fmtSize(u.bytes) || '0 B'} · ${Number(u.files).toLocaleString()} file${u.files === 1 ? '' : 's'}`;

// A drive opens with a server render, which takes a moment: the row it is
// going to says so (`pending`) until the page has changed.
function DriveRow({ id, name, detail, role, active, pending = false, onClick, library = false }) {
  return (
    <li>
      <button
        type="button"
        className={`drive-row${active ? ' is-active' : ''}${pending ? ' is-pending' : ''}`}
        aria-busy={pending || undefined}
        aria-current={active ? 'page' : undefined}
        data-drive={library ? '' : id}
        onClick={onClick}
        title={role && !library ? `${name} — ${ROLE_WORDS[role] || role}` : name}
      >
        <span className={`drive-icon${library ? ' is-library' : ''}`} aria-hidden>
          <Icon name={library ? 'folders' : 'hard-drive'} /* icons: folders hard-drive */ />
        </span>
        <span className="drive-text">
          <span className="drive-name truncate">{name}</span>
          {detail && <span className="drive-detail truncate">{detail}</span>}
        </span>
      </button>
    </li>
  );
}

// Making a drive: app/components/drives/NewDriveDialog.js, shared with
// Admin → Drives so both flows make drives the same way.

/** Who may use a drive, and as what. Admins, and the drive's owners. */
export function DriveMembersDialog({ drive, open, onClose }) {
  if (!drive) return null;
  return (
    <Dialog open={open} onClose={onClose} title={`Members of ${drive.name}`} wide>
      <p className="small muted" style={{ margin: '0 0 var(--s4)' }}>
        Permissions are per drive: someone can own one drive, edit another and only view a third. Admins can open every drive.
      </p>
      {open && <FilespaceMembers filespaceId={drive.id} />}
    </Dialog>
  );
}
