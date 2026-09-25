'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { placeMenu } from '@/lib/menu-place';

/**
 * Arrow-key movement between the enabled items of a menu. Shared by the
 * context menu and the dropdown Menu so both answer the keys the same way.
 * Returns true when it handled the key.
 */
// Radio and checkbox items are menu items too — the theme choice in the
// account menu is a set of radios, and was unreachable by arrow key.
export const MENU_ITEMS = ['menuitem', 'menuitemradio', 'menuitemcheckbox']
  .map((r) => `[role="${r}"]:not(:disabled)`).join(', ');

export function menuKeyNav(e, container) {
  if (!container) return false;
  const items = [...container.querySelectorAll(MENU_ITEMS)];
  if (!items.length) return false;
  const at = items.indexOf(document.activeElement);
  let next = null;
  if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % items.length;
  else if (e.key === 'ArrowUp') next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = items.length - 1;
  if (next == null) return false;
  e.preventDefault();
  items[next].focus();
  return true;
}

/**
 * A right-click menu, as a hook:
 *
 *   const { openMenu, contextMenuElement } = useContextMenu();
 *   openMenu({ x, y } | { anchor: element }, [
 *     { heading: 'photo.jpg' },
 *     { label: 'Open', onSelect: … },
 *     '-',
 *     { label: 'Delete…', danger: true, onSelect: … },
 *   ]);
 *
 * Keyboard: the first item takes focus, ↑ ↓ Home End move, Enter/Space
 * activate, Escape closes and puts focus back where it was, Tab closes.
 * The menu is fixed-position and placed after it has been measured, so it
 * stays on screen at any width — on a phone it is simply clamped inside the
 * viewport. An outside press, a scroll, a resize or losing window focus
 * closes it.
 */
export function useContextMenu() {
  const [state, setState] = useState(null);
  const returnTo = useRef(null);

  const close = useCallback((restore = true) => {
    setState(null);
    const el = returnTo.current;
    returnTo.current = null;
    if (restore && el && typeof el.focus === 'function' && el.isConnected) el.focus({ preventScroll: true });
  }, []);

  const openMenu = useCallback((at, items) => {
    returnTo.current = at.returnFocus || (typeof document !== 'undefined' ? document.activeElement : null);
    const anchor = at.anchor ? at.anchor.getBoundingClientRect() : null;
    setState({ x: at.x ?? 0, y: at.y ?? 0, anchor, items: items.filter(Boolean), key: Date.now() });
  }, []);

  const element = state ? (
    <ContextMenuPopup
      key={state.key}
      {...state}
      onClose={close}
    />
  ) : null;

  return { openMenu, closeMenu: close, contextMenuElement: element, menuOpen: !!state };
}

function ContextMenuPopup({ x, y, anchor, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos(placeMenu({ x, y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight, anchor }));
  }, [x, y, anchor]);

  // Focus the first item once placed, so the keyboard is in the menu.
  useEffect(() => {
    if (!pos) return;
    ref.current?.querySelector(MENU_ITEMS)?.focus({ preventScroll: true });
  }, [pos]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(false); };
    const onScroll = (e) => { if (!ref.current?.contains(e.target)) onClose(false); };
    const onResize = () => onClose(false);
    const onBlur = () => onClose(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  const onKeyDown = (e) => {
    if (menuKeyNav(e, ref.current)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(true); }
    else if (e.key === 'Tab') { e.preventDefault(); onClose(true); }
  };

  const choose = (item) => {
    // Close first and hand focus back, then act: an action that opens a
    // dialog then takes focus from the element that opened the menu, and the
    // dialog returns it there when it closes.
    onClose(true);
    queueMicrotask(() => item.onSelect?.());
  };

  return createPortal(
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={items.find((i) => i?.heading)?.heading || 'Actions'}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}
    >
      {items.map((item, i) => {
        if (item === '-') return <div key={`s${i}`} className="menu-sep" role="separator" />;
        if (item.heading) return <div key={`h${i}`} className="ctx-heading small muted truncate" title={item.heading}>{item.heading}</div>;
        return (
          <button
            key={`${i}:${item.label}`}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className={`menu-item${item.danger ? ' danger' : ''}`}
            disabled={!!item.disabled}
            onClick={() => choose(item)}
          >
            <span className="ctx-label">{item.label}</span>
            {item.hint && <span className="small muted">{item.hint}</span>}
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
