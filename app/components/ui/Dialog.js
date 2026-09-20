'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * A modal dialog built on the native <dialog> element.
 *
 * Why native rather than a div with a fixed overlay: `showModal()` puts the
 * element in the browser's top layer, so it cannot lose to TopNav's
 * z-index; it needs no portal and therefore no SSR mounted-guard; and focus
 * trapping, background inertness, escape-to-close and focus restoration to
 * the trigger all come from the platform. Each of those is a meaningful
 * amount of code to get subtly wrong.
 *
 * Three details decide whether this actually works:
 *
 *   1. showModal() throws InvalidStateError on an already-open dialog, so
 *      both directions are guarded on `el.open`.
 *   2. `cancel` fires before `close` on escape. Handling both double-fires,
 *      so only `close` is wired and `cancel` is left alone — except when the
 *      dialog is not dismissable, where cancel is the only place to stop it.
 *   3. ::backdrop is a pseudo-element, not a click target: an outside click
 *      arrives with the <dialog> itself as the target. That only holds while
 *      the element has no padding of its own, which is why the padding lives
 *      on .dialog-body and never here.
 *
 * On a phone this presents as a bottom sheet — pure CSS, same markup, see
 * the media query in globals.css.
 */
export default function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  // A destructive confirm, or one with a half-finished form in it, should
  // not be dismissable by a stray click on the backdrop.
  dismissable = true,
  labelledBy,
}) {
  const ref = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // The element closing itself (escape, form method=dialog) has to flow back
  // to the parent's state, or React still believes it is open and will not
  // reopen it.
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const handler = () => onCloseRef.current?.();
    el.addEventListener('close', handler);
    return () => el.removeEventListener('close', handler);
  }, []);

  const onCancel = useCallback((e) => {
    if (!dismissable) e.preventDefault();
  }, [dismissable]);

  const onPointerDown = useCallback((e) => {
    if (dismissable && e.target === ref.current) onClose?.();
  }, [dismissable, onClose]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      onCancel={onCancel}
      onPointerDown={onPointerDown}
      aria-labelledby={labelledBy || (title ? 'dialog-title' : undefined)}
    >
      {title && (
        <div className="dialog-head">
          <h2 id="dialog-title" className="dialog-title">{title}</h2>
          <div className="spacer" />
          {dismissable && (
            <button className="btn btn-ghost btn-sm btn-icon" onClick={() => onClose?.()} aria-label="Close">
              <span aria-hidden>✕</span>
            </button>
          )}
        </div>
      )}
      <div className="dialog-body">{children}</div>
      {footer && <div className="dialog-foot">{footer}</div>}
    </dialog>
  );
}
