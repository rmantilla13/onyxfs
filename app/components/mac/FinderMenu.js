'use client';

import Popover from '@/app/components/ui/Popover';
import Icon from '@/app/components/ui/Icon';

const ROLE_WORDS = { owner: 'owner', editor: 'can edit', viewer: 'can view' };

/**
 * The bar's Finder menu, inside Onyx for Mac: each drive Finder can show,
 * with a switch that puts it there or takes it away, and a way to it once
 * it is there — the menu bar item's list, drawn by the page so it sits in
 * the bar with everything else. The app does the work (useMacApp); this only
 * asks and shows what it answers.
 */
export default function FinderMenu({ mac }) {
  const { drives, states, busy } = mac.finder;
  const rows = [
    ...drives.map((d) => ({ id: d.id, scope: mac.scopeOf(d.id), name: d.name, detail: ROLE_WORDS[d.role] || null })),
    { id: null, scope: 'library', name: 'Library', detail: 'files in no drive' },
  ];
  const inFinder = rows.filter((r) => states[r.scope]?.state === 'mounted').length;

  return (
    <Popover
      label="Drives in Finder"
      buttonClassName="btn btn-ghost btn-sm topnav-finder"
      className="finder-menu"
      trigger={(
        <>
          <Icon name="hard-drive" size={15} />
          Finder
          {inFinder > 0 && <span className="finder-dot" aria-hidden />}
          {inFinder > 0 && <span className="sr-only">{`, ${inFinder} in Finder`}</span>}
        </>
      )}
    >
      <p className="menu-label small muted">Show in Finder</p>
      <ul className="finder-rows">
        {rows.map((r) => {
          const s = states[r.scope];
          const on = mac.mounted.has(r.scope);
          const pending = busy.includes(r.scope) || s?.state === 'mounting';
          return (
            <li key={r.scope} className="finder-row">
              <label className="finder-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={on}
                  disabled={pending}
                  onChange={(e) => mac.setMounted(r.id, e.target.checked, r.name)}
                />
                <span className="finder-name truncate">{r.name}</span>
                {r.detail && <span className="small muted truncate">{r.detail}</span>}
              </label>
              {pending && <Icon name="loader-circle" size={14} className="finder-busy" label="Connecting" />}
              {s?.state === 'failed' && <Icon name="triangle-alert" size={14} className="finder-failed" label={s.message || 'Could not show it in Finder'} />}
              {s?.state === 'mounted' && (
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => mac.reveal(r.id)} title={`Open ${r.name} in Finder`}>
                  Open
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="menu-sep" role="separator" />
      <button type="button" className="menu-item" onClick={() => mac.syncNow()}>
        <Icon name="refresh-cw" size={14} />
        Sync now
      </button>
    </Popover>
  );
}
