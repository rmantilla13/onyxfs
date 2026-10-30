'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { measureStill } from './ContextMenu';

/**
 * A panel that opens from a button and stays open while you work in it —
 * checkboxes, reordering, a text field. Menu closes on any click inside it,
 * which is right for a list of actions and wrong for a list of settings.
 *
 * Closes on Escape and on a pointer down outside, and keeps itself inside the
 * viewport the way Menu does. `children` may be a function, handed `close`,
 * for content that ends the interaction itself.
 */
export default function Popover({
  label,
  trigger,
  children,
  align = 'right',
  buttonClassName = 'btn btn-ghost btn-sm',
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [shift, setShift] = useState({ x: 0, up: false });
  const wrap = useRef(null);
  const pop = useRef(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
      wrap.current?.querySelector('button')?.focus();
    };
    document.addEventListener('pointerdown', onDocDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, close]);

  useLayoutEffect(() => {
    if (!open) { setShift({ x: 0, up: false }); return; }
    const el = pop.current;
    if (!el) return;
    const r = measureStill(el);
    const margin = 8;
    let x = 0;
    if (r.right > window.innerWidth - margin) x = window.innerWidth - margin - r.right;
    if (r.left + x < margin) x = margin - r.left;
    const trigger = wrap.current.getBoundingClientRect();
    const up = r.bottom > window.innerHeight - margin && trigger.top - r.height - margin > 0;
    setShift({ x: Math.round(x), up });
  }, [open]);

  useEffect(() => {
    if (open) pop.current?.querySelector('input, button, select')?.focus({ preventScroll: true });
  }, [open]);

  // As Menu: the shift on `translate`, the arrival on `transform`, and the
  // corner it grows from in --from.
  const place = {
    ...(align === 'left' ? { right: 'auto', left: 0 } : null),
    ...(shift.x ? { translate: `${shift.x}px 0` } : null),
    ...(shift.up ? { top: 'auto', bottom: 'calc(100% + var(--s1))' } : null),
    '--from': `${shift.up ? 'bottom' : 'top'} ${align === 'left' ? 'left' : 'right'}`,
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={label}
        title={label}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger}
      </button>
      {open && (
        <div
          className={`menu popover ${className}`}
          id={id}
          role="dialog"
          aria-label={label}
          ref={pop}
          style={place}
        >
          {typeof children === 'function' ? children({ close }) : children}
        </div>
      )}
    </div>
  );
}
