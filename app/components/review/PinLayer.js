'use client';

import { useRef } from 'react';
import { pointOnPicture } from '@/lib/review';

/**
 * Numbered pins on an image, each a comment anchored to a point, over the
 * picture's own rectangle like the drawings. Stored as fractions of the
 * source image, so a pin stays on its spot at Fit and at 100%.
 *
 * While `placing`, a click anywhere on the picture drops the draft pin there
 * (onPlace); otherwise only the pins themselves take the pointer.
 */
export default function PinLayer({ pins = [], draft = null, selectedId = null, placing = false, onPlace, onSelect }) {
  const layer = useRef(null);
  return (
    <div
      ref={layer}
      className={`pin-layer${placing ? ' is-placing' : ''}`}
      onClick={placing ? (e) => onPlace?.(pointOnPicture(e.clientX, e.clientY, layer.current.getBoundingClientRect())) : undefined}
      role={placing ? 'button' : undefined}
      aria-label={placing ? 'Click the picture to place the pin' : undefined}
    >
      {pins.map((p) => (
        <button
          key={p.id}
          type="button"
          className={`review-pin${p.id === selectedId ? ' is-selected' : ''}${p.resolved ? ' is-resolved' : ''}`}
          style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}
          title={p.label}
          aria-label={`Pin ${p.n}${p.label ? `: ${p.label}` : ''}`}
          onClick={(e) => { e.stopPropagation(); onSelect?.(p.id); }}
        >
          {p.n}
        </button>
      ))}
      {draft && <span className="review-pin is-draft" style={{ left: `${draft[0] * 100}%`, top: `${draft[1] * 100}%` }} aria-hidden="true">+</span>}
    </div>
  );
}
