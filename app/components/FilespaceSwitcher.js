'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Menu, { MenuItem, MenuSeparator } from './ui/Menu';
import Dialog from './ui/Dialog';
import FilespaceMembers from './FilespaceMembers';

/**
 * Which filespace the files UI is showing, and the way to change it. Lives at
 * the top of the files sidebar rather than in TopNav, so it is next to the
 * tree it scopes and survives on a phone, where TopNav has no room.
 *
 * "Members…" appears for admins and for owners of the active filespace — the
 * people /api/filespaces/[id]/members admits.
 */
export default function FilespaceSwitcher({ filespaces: given = [], activeId = '', isAdmin = false, onSwitch }) {
  const [membersOpen, setMembersOpen] = useState(false);
  const router = useRouter();
  // By name: the list arrives most-recently-edited first, which is no order
  // to find something in.
  const filespaces = useMemo(() => [...given].sort((a, b) => String(a.name).localeCompare(String(b.name))), [given]);
  const active = filespaces.find((f) => f.id === activeId) || null;
  const canManage = !!active && (isAdmin || active.role === 'owner');
  if (!filespaces.length && !isAdmin) return null;

  return (
    <div className="fs-switch">
      <div className="fs-switch-label small muted">Filespace</div>
      <Menu
        label="Switch filespace"
        align="left"
        trigger={(
          <>
            <span className="fs-switch-name">{active ? active.name : 'All files'}</span>
            <span aria-hidden className="muted">▾</span>
          </>
        )}
      >
        <MenuItem onClick={() => onSwitch?.('')}>
          <span className="fs-switch-check" aria-hidden>{active ? '' : '✓'}</span>
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
