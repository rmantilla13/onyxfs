'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';

/**
 * A dropdown menu for row and card actions.
 *
 * Deliberately small: a button, a list, close on escape, on outside click and
 * on choosing something. It does NOT implement full APG menu semantics
 * (type-ahead, arrow-key roving inside the list) because every use here is a
 * handful of plain actions, and a half-built roving-tabindex menu behaves
 * worse for a keyboard user than plain focusable buttons in a popup do.
 */
export default function Menu({ label = 'Actions', trigger, children, align = 'right' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);
  const id = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDocDown = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();          // do not also close a dialog we sit inside
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

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className="btn btn-ghost btn-sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger || <><span aria-hidden>⋯</span><span className="sr-only">{label}</span></>}
      </button>
      {open && (
        // Clicks bubble to here rather than each item wiring its own close,
        // so an action can never leave the menu open by forgetting to.
        <div className="menu" id={id} role="menu" onClick={close} style={align === 'left' ? { right: 'auto', left: 0 } : undefined}>
          {children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ onClick, danger = false, disabled = false, children }) {
  return (
    <button
      className={`menu-item${danger ? ' danger' : ''}`}
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
