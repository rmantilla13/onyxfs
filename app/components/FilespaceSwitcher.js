'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Menu, { MenuItem, MenuSeparator } from './ui/Menu';
import Dialog from './ui/Dialog';
import FilespaceMembers from './FilespaceMembers';

/**
 * Which filespace the files UI is showing, and the way to change it.
 *
 * `compact` is the TopNav form: no label, just the name, so it fits the bar
 * on a phone too. `activeId` null means the page is not showing any one
 * filespace (a file's page, Admin): the trigger reads "Filespaces" and
 * nothing is ticked, rather than claiming "All files" is open.
 *
 * "Members…" appears for admins and for owners of the active filespace — the
 * people /api/filespaces/[id]/members admits.
 */
export default function FilespaceSwitcher({ filespaces: given = [], activeId = '', isAdmin = false, onSwitch, compact = false }) {
  const [membersOpen, setMembersOpen] = useState(false);
  const router = useRouter();
  // By name: the list arrives most-recently-edited first, which is no order
  // to find something in.
  const filespaces = useMemo(() => [...given].sort((a, b) => String(a.name).localeCompare(String(b.name))), [given]);
  const active = filespaces.find((f) => f.id === activeId) || null;
  const nowhere = activeId == null;
  const canManage = !!active && (isAdmin || active.role === 'owner');
  if (!filespaces.length && !isAdmin) return null;

  return (
    <div className={`fs-switch${compact ? ' fs-switch-nav' : ''}`}>
      {!compact && <div className="fs-switch-label small muted">Filespace</div>}
      <Menu
        label="Switch filespace"
        align="left"
        trigger={(
          <>
            {compact && (
              <svg className="fs-switch-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden>
                <path d="M2.5 4.5h11v3h-11zM2.5 8.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                <path d="M11 6h.5M11 10h.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            )}
            <span className="fs-switch-name">{active ? active.name : nowhere ? 'Filespaces' : 'All files'}</span>
            <span aria-hidden className="muted">▾</span>
          </>
        )}
      >
        <MenuItem onClick={() => onSwitch?.('')}>
          <span className="fs-switch-check" aria-hidden>{active || nowhere ? '' : '✓'}</span>
          All files
        </MenuItem>
        {filespaces.map((f) => (
          <MenuItem key={f.id} onClick={() => onSwitch?.(f.id)}>
            <span className="fs-switch-check" aria-hidden>{f.id === activeId ? '✓' : ''}</span>
            <span className="fs-switch-item">{f.name}</span>
            {f.role && f.role !== 'owner' && <span className="small muted">{f.role}</span>}
          </MenuItem>
        ))}
        {(canManage || isAdmin) && <MenuSeparator />}
        {canManage && <MenuItem onClick={() => setMembersOpen(true)}>Members of {active.name}…</MenuItem>}
        {isAdmin && (
          <MenuItem onClick={() => router.push('/admin?tab=filespaces')}>Manage filespaces…</MenuItem>
        )}
      </Menu>

      {canManage && (
        <Dialog open={membersOpen} onClose={() => setMembersOpen(false)} title={`Members of ${active.name}`} wide>
          {membersOpen && <FilespaceMembers filespaceId={active.id} />}
        </Dialog>
      )}
    </div>
  );
}
