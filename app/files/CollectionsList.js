'use client';

import { memo } from 'react';
import Icon from '@/app/components/ui/Icon';
import { describeRule } from '@/lib/collections';

/**
 * The sidebar's Collections section: the collections of the drive on screen
 * (or of All Files), by name. Shown when there is one, or when this person
 * may make one here — the + is how a first one gets made.
 */
const CollectionsList = memo(function CollectionsList({ collections, activeId, schema, canCreate, onOpen, onNew }) {
  if (!collections.length && !canCreate) return null;
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
        {collections.map((c) => (
          <div key={c.id} className="folder-row">
            <button
              type="button"
              className={`small folder-link${c.id === activeId ? ' active' : ''}`}
              aria-current={c.id === activeId ? 'true' : undefined}
              data-collection={c.id}
              title={c.rules.map((r) => describeRule(r, schema)).join(c.match === 'any' ? ', or ' : ', and ')}
              onClick={() => onOpen(c)}
            >
              <Icon name="layers" size={13} className="collection-glyph" />
              <span className="folder-name">{c.name}</span>
            </button>
          </div>
        ))}
        {!collections.length && <p className="small muted side-empty">Files that meet rules on their tags and metadata, gathered in one place.</p>}
      </div>
    </div>
  );
});

export default CollectionsList;
