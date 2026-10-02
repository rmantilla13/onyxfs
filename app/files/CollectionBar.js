'use client';

import Icon from '@/app/components/ui/Icon';
import { describeRule } from '@/lib/collections';

/**
 * Above a collection's files: what it gathers, in words, and a way to change
 * it or go back to the folders. `collection` is null while the list of them
 * is still on its way, or when the one in the URL is not one this person
 * can see — then the listing says so too (a 404).
 */
export default function CollectionBar({ collection, schema, onEdit, onClose }) {
  return (
    <div className="collection-bar">
      <Icon name="layers" size={15} className="collection-glyph" />
      <div className="collection-bar-rules small">
        {collection ? (
          <>
            <span className="muted">{collection.match === 'any' ? 'Files that meet any of:' : 'Files that meet all of:'}</span>
            {collection.rules.map((r, i) => <span key={i} className="collection-rule-chip">{describeRule(r, schema)}</span>)}
          </>
        ) : (
          <span className="muted">This collection is not one you can see.</span>
        )}
      </div>
      {onEdit && <button type="button" className="btn btn-sm" onClick={onEdit}>Edit</button>}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close collection" title="Back to folders">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}
