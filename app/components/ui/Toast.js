'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '@/app/components/ui/Icon';

const ToastContext = createContext(null);

/**
 * Transient feedback, replacing the inline `Status` strings and the native
 * alert() calls scattered through the admin panel.
 *
 * The live region is the part that matters and the part usually skipped: a
 * message that only appears visually is invisible to a screen reader. Errors
 * are `assertive` because they interrupt what you were doing; successes are
 * `polite` because they do not.
 *
 * Errors do not auto-dismiss. A success can disappear — you saw the thing
 * happen — but an error that vanishes before it is read is worse than no
 * message, which is exactly what the upload list did (cleared after 1.5s
 * whether or not an item had failed).
 *
 * A dismissed toast leaves the way it came: dismiss() marks it leaving and
 * the element takes itself out of the list when its exit animation ends
 * (.toast[data-leaving], globals.css). No timer for that — animationend
 * fires under the reduced-motion clamp too, so none can stick.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const remove = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((list) => list.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const push = useCallback((message, { type = 'info', duration } = {}) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const ms = duration ?? (type === 'error' ? 0 : 4000);
    setToasts((list) => [...list, { id, message: String(message ?? ''), type }]);
    if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    return id;
  }, [dismiss]);

  useEffect(() => () => {
    for (const t of timers.current.values()) clearTimeout(t);
    timers.current.clear();
  }, []);

  const value = useMemo(() => ({
    push,
    dismiss,
    success: (m, o) => push(m, { ...o, type: 'success' }),
    error: (m, o) => push(m, { ...o, type: 'error' }),
  }), [push, dismiss]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast${t.type === 'error' ? ' toast-error' : ''}`}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            data-leaving={t.leaving ? '' : undefined}
            onAnimationEnd={t.leaving ? () => remove(t.id) : undefined}
          >
            {/* What happened, at a glance; the words carry it for a reader. */}
            <Icon name={t.type === 'error' ? 'circle-x' : 'circle-check'} size={16} className="toast-glyph" /* icons: circle-x circle-check */ />
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.message}</span>
            <div className="spacer" />
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss"><Icon name="x" size={14} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Returns a no-op shaped like the real thing when no provider is mounted, so
 * a component can call toast.error() without knowing whether it happens to be
 * rendered inside the provider — a missing provider should not be a crash on
 * the error path, which is the least convenient place to discover it.
 */
const NOOP = { push: () => null, dismiss: () => {}, success: () => null, error: () => null };

export function useToast() {
  return useContext(ToastContext) || NOOP;
}
