'use client';

import Dialog from '@/app/components/ui/Dialog';
import FilespaceMembers from '@/app/components/FilespaceMembers';
import { fmtSize } from '@/lib/media';

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
export function DriveList({ drives = [], usage = {}, library = null, activeId = '', canCreate = false, onOpen, onNew }) {
  const sorted = [...drives].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return (
    <nav className="drives" aria-label="Drives">
      <div className="drives-head">
        <h3 className="drives-title">Drives</h3>
        {canCreate && (
          <button type="button" className="btn btn-ghost btn-sm drives-new" onClick={onNew} aria-label="New drive" title="New drive">+</button>
        )}
      </div>
      <ul className="drives-list edge-scroll">
        <DriveRow
          name="All files"
          detail={library ? usageLine(library) : 'Everything you can open'}
          active={!activeId}
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

function DriveRow({ id, name, detail, role, active, onClick, library = false }) {
  return (
    <li>
      <button
        type="button"
        className={`drive-row${active ? ' is-active' : ''}`}
        aria-current={active ? 'page' : undefined}
        data-drive={library ? '' : id}
        onClick={onClick}
        title={role && !library ? `${name} — ${ROLE_WORDS[role] || role}` : name}
      >
        <span className={`drive-icon${library ? ' is-library' : ''}`} aria-hidden>
          {library ? (
            <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.5 3.5h4l1.2 1.5h5.8v7.5h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /></svg>
          ) : (
            <svg viewBox="0 0 16 16" width="16" height="16"><rect x="2" y="4" width="12" height="8" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.2" /><path d="M4.5 9.5h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><circle cx="11.3" cy="9.5" r=".9" fill="currentColor" /></svg>
          )}
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
