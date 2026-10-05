'use client';

import { memo } from 'react';
import Icon from '@/app/components/ui/Icon';
import { describeRule } from '@/lib/collections';

/**
 * The sidebar's Collections section: every collection this person can see,
 * by `groups` — the drive on screen's first, untitled; then each other
 * drive's under its name, opened in that drive; then, to whoever may tidy
 * them, the ones in no drive (`stranded`), which `onStranded` offers to move
 * or delete. Shown when there is one, or when this person may make one here
 * — the + is how a first one gets made.
 */
const CollectionsList = memo(function CollectionsList({ groups, activeId, schema, canCreate, onOpen, onStranded, onNew }) {
  const any = groups.some((g) => g.collections.length);
  if (!any && !canCreate) return null;
  return (
    <div className="side-section side-collections">
      <div className="side-title-row">
        <h3 className="side-title">Collections</h3>
        {canCreate && (
          <button type="button" className="btn btn-ghost btn-sm side-add" onClick={onNew} aria-label="New collection" title="New collection">
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <div className="folder-list collection-list">
        {groups.filter((g) => g.collections.length).map((g) => (
          <div key={g.key} className="collection-group" role="group" aria-label={g.title || undefined}>
            {g.title && <div className="small muted collection-group-title">{g.title}</div>}
            {g.collections.map((c) => (
              <div key={c.id} className="folder-row">
                <button
                  type="button"
                  className={`small folder-link${c.id === activeId ? ' active' : ''}${g.stranded ? ' is-stranded' : ''}`}
                  aria-current={c.id === activeId ? 'true' : undefined}
                  data-collection={c.id}
                  title={g.stranded
                    ? 'In no drive: move it into one, or delete it'
                    : c.rules.map((r) => describeRule(r, schema)).join(c.match === 'any' ? ', or ' : ', and ')}
                  onClick={() => (g.stranded ? onStranded?.(c) : onOpen(c))}
                >
                  <Icon name="layers" size={13} className="collection-glyph" />
                  <span className="folder-name">{c.name}</span>
                </button>
              </div>
            ))}
          </div>
        ))}
        {!any && <p className="small muted side-empty">Files that meet rules on their tags and metadata, gathered in one place.</p>}
      </div>
    </div>
  );
});

export default CollectionsList;
