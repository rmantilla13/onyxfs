'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { menuKeyNav, MENU_ITEMS } from './ContextMenu';
import Icon from '@/app/components/ui/Icon';

/**
 * A dropdown menu for row and card actions.
 *
 * Deliberately small: a button, a list, close on escape, on outside click and
 * on choosing something. Opening focuses the first item and ↑ ↓ Home End move
 * between items (shared with the context menu); there is no type-ahead.
 *
 * The button is a small ghost one unless `buttonClassName` says otherwise —
 * the files toolbar's are its own height. A `trigger` that is only an icon
 * needs `ariaLabel` for its name; `label` names the default "…" trigger.
 * `menuClassName` sizes the list.
 */
export default function Menu({
  label = 'Actions', trigger, children, align = 'right',
  buttonClassName = 'btn btn-ghost btn-sm', ariaLabel, title, disabled = false, menuClassName = '',
}) {
  const [open, setOpen] = useState(false);
  // How far the popup has to move to stay inside the viewport. It is placed
  // relative to its trigger, so near an edge (a phone, a trigger at the far
  // right) it used to run off screen.
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

  useLayoutEffect(() => {
    if (!open) { setShift({ x: 0, up: false }); return; }
    const el = pop.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const margin = 8;
    let x = 0;
    if (r.right > window.innerWidth - margin) x = window.innerWidth - margin - r.right;
    if (r.left + x < margin) x = margin - r.left;
    const trigger = wrap.current.getBoundingClientRect();
    // The floor is the viewport's, or the nearest scrolling box's when the
    // menu sits inside one (a list of comments, say): past its bottom the
    // popup is clipped, not merely off screen.
    const box = clippingBox(wrap.current);
    const bottom = Math.min(window.innerHeight, box ? box.bottom : Infinity);
    const top = box ? Math.max(0, box.top) : 0;
    const up = r.bottom > bottom - margin && trigger.top - r.height - margin > top;
    setShift({ x: Math.round(x), up });
  }, [open]);

  // Opening focuses the first item, so the arrow keys work straight away.
  useEffect(() => {
    if (open) pop.current?.querySelector(MENU_ITEMS)?.focus({ preventScroll: true });
  }, [open]);

  const place = {
    ...(align === 'left' ? { right: 'auto', left: 0 } : null),
    ...(shift.x ? { transform: `translateX(${shift.x}px)` } : null),
    ...(shift.up ? { top: 'auto', bottom: 'calc(100% + var(--s1))' } : null),
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {trigger || <><Icon name="ellipsis" /><span className="sr-only">{label}</span></>}
      </button>
      {open && (
        // Clicks bubble to here rather than each item wiring its own close,
        // so an action can never leave the menu open by forgetting to.
        <div
          className={`menu${menuClassName ? ` ${menuClassName}` : ''}`}
          id={id}
          role="menu"
          ref={pop}
          onClick={close}
          onKeyDown={(e) => menuKeyNav(e, pop.current)}
          style={Object.keys(place).length ? place : undefined}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** The rectangle of the nearest ancestor that clips what overflows it, or null. */
function clippingBox(el) {
  for (let n = el?.parentElement; n && n !== document.body; n = n.parentElement) {
    const { overflowY } = getComputedStyle(n);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'hidden') return n.getBoundingClientRect();
  }
  return null;
}

/**
 * One item. `checked` (true or false, not absent) makes it one of a set of
 * choices — a menuitemradio with a tick on the chosen one. `icon` is a Lucide
 * name drawn before the words, `hint` a shortcut or a note after them.
 */
export function MenuItem({ onClick, danger = false, disabled = false, checked, icon, hint, children }) {
  const choice = typeof checked === 'boolean';
  return (
    <button
      type="button"
      className={`menu-item${danger ? ' danger' : ''}${choice ? ' is-choice' : ''}`}
      role={choice ? 'menuitemradio' : 'menuitem'}
      aria-checked={choice ? checked : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <Icon name={icon} size={15} className="menu-item-icon" />}
      <span className="menu-item-text">{children}</span>
      {hint && <span className="menu-item-hint">{hint}</span>}
      {choice && <span className="menu-item-check" aria-hidden>{checked && <Icon name="check" size={15} />}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}

/** A group's name inside a menu: not an item, never focused. */
export function MenuLabel({ children }) {
  return <div className="menu-label small muted" role="presentation">{children}</div>;
}
