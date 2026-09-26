'use client';

import { useCallback, useEffect, useId, useLayoutEffect, useRef } from 'react';

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
 *      dialog is not dismissable, where cancel is the only place to stop it,
 *      and where `onEscape` (its Cancel) is answered from. Answering there
 *      rather than from a window keydown listener matters when one dialog
 *      sits over another: the cancel event consumes the Escape, where a
 *      keydown handler would unmount the top dialog first and let the same
 *      Escape close the one beneath it too.
 *   3. ::backdrop is a pseudo-element, not a click target: an outside click
 *      arrives with the <dialog> itself as the target. That only holds while
 *      the element has no padding of its own, which is why the padding lives
 *      on .dialog-body and never here.
 *
 * Focus goes back where it came from even when the dialog is not closed
 * but removed — a confirm its owner unmounts on an answer, a drawer whose
 * route went away. The platform restores focus only on close(), so that
 * case is handled here (see the layout effect).
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
  // Escape on a dialog that is not dismissable: its answer, usually Cancel.
  // Without it Escape does nothing there.
  onEscape,
  labelledBy,
  // Extra classes on the <dialog>: 'dialog-sheet' makes it a side sheet
  // (the admin drawer, app/admin/admin.css).
  className = '',
}) {
  const ref = useRef(null);
  // One id per dialog: a confirm opened over another dialog must not point
  // its aria-labelledby at the first one's title.
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  // What had focus when the dialog opened, to hand it back to.
  const opener = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      el.showModal();
    }
    if (!open && el.open) el.close();
  }, [open]);

  // Removed while still open. A layout effect's cleanup runs before React
  // takes the element out of the page, while focus is still inside it; the
  // focus itself has to wait until it is gone, since everything behind a
  // modal dialog is inert. Only when focus would otherwise be lost: the
  // opener must still be on the page and nothing else must have taken it.
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (!el?.open || !el.contains(document.activeElement)) return;
      const back = opener.current;
      if (!back || back === document.body || typeof back.focus !== 'function') return;
      queueMicrotask(() => {
        const now = document.activeElement;
        if (back.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
      });
    };
  }, []);

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
    if (dismissable) return;
    e.preventDefault();
    onEscapeRef.current?.();
  }, [dismissable]);

  const onPointerDown = useCallback((e) => {
    if (dismissable && e.target === ref.current) onClose?.();
  }, [dismissable, onClose]);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}${className ? ` ${className}` : ''}`}
      onCancel={onCancel}
      onPointerDown={onPointerDown}
      aria-labelledby={labelledBy || (title ? titleId : undefined)}
    >
      {title && (
        <div className="dialog-head">
          <h2 id={titleId} className="dialog-title">{title}</h2>
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
