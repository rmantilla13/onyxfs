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
 * A toast can carry one action — `{ label, onClick }`, the Undo after a
 * delete. It stays longer (ACTION_MS), and its clock stops while the pointer
 * is on it or focus is in it, so reaching for the button never races the
 * timer; it starts again, from the top, on leaving.
 */
const ACTION_MS = 10000;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) { clearTimeout(timer); timers.current.delete(id); }
  }, []);

  const schedule = useCallback((id, ms) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    if (ms > 0) timers.current.set(id, setTimeout(() => dismiss(id), ms));
    else timers.current.delete(id);
  }, [dismiss]);

  const push = useCallback((message, { type = 'info', duration, action = null } = {}) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const act = action && typeof action.onClick === 'function' ? { label: String(action.label || 'Undo'), onClick: action.onClick } : null;
    const ms = duration ?? (type === 'error' ? 0 : act ? ACTION_MS : 4000);
    setToasts((list) => [...list, { id, message: String(message ?? ''), type, action: act, ms }]);
    schedule(id, ms);
    return id;
  }, [schedule]);

  // Held while the pointer or focus is on it; the full time again after.
  const hold = useCallback((t) => { if (t.ms > 0) schedule(t.id, 0); }, [schedule]);
  const release = useCallback((t) => { if (t.ms > 0) schedule(t.id, t.ms); }, [schedule]);

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
            onMouseEnter={t.action ? () => hold(t) : undefined}
            onMouseLeave={t.action ? () => release(t) : undefined}
            onFocus={t.action ? () => hold(t) : undefined}
            onBlur={t.action ? (e) => { if (!e.currentTarget.contains(e.relatedTarget)) release(t); } : undefined}
          >
            <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.message}</span>
            <div className="spacer" />
            {t.action && (
              <button
                type="button"
                className="toast-action"
                onClick={() => { dismiss(t.id); t.action.onClick(); }}
              >
                {t.action.label}
              </button>
            )}
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
