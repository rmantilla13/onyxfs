'use client';

import { useEffect, useMemo, useRef } from 'react';
import SaverView from './SaverView';
import { pickSaver } from '@/lib/screensaver';

/* Longer than a pointer takes to report where it already is when the stage
   goes up over it, and farther than a desk's vibration moves a mouse. */
const GRACE_MS = 600;
const WAKE_PX = 12;

/**
 * The screen saver on screen: a modal <dialog> the size of the window, so it
 * sits in the top layer above anything else open (a dialog, the palette),
 * and the page behind it is inert until it goes.
 *
 * It goes on the first thing anyone does — a key, a click, a touch, a scroll,
 * or the pointer moving more than a little once it has settled — and that
 * one key or click is kept from the page (the page behind a modal cannot be
 * clicked anyway). Whoever had focus gets it back.
 */
export default function Screensaver({ pref, logo, brandName, onDismiss }) {
  const ref = useRef(null);
  const saverKey = useMemo(() => pickSaver(pref), [pref]);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  // Who had focus as the stage was made — read as it renders, before
  // showModal() moves focus onto it (an effect that ran twice would read
  // the stage itself the second time).
  const opener = useRef(null);
  if (opener.current === null && typeof document !== 'undefined') opener.current = document.activeElement;

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (!el.open) el.showModal();
    const t0 = performance.now();
    let origin = null;
    let done = false;
    const end = () => {
      if (done) return;
      done = true;
      onDismissRef.current?.();
    };
    const onMove = (e) => {
      if (performance.now() - t0 < GRACE_MS) return;
      if (!origin) { origin = [e.clientX, e.clientY]; return; }
      if (Math.hypot(e.clientX - origin[0], e.clientY - origin[1]) >= WAKE_PX) end();
    };
    const onKey = (e) => {
      // The waking key is spent on waking; a modifier alone is not one.
      if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return;
      e.preventDefault();
      end();
    };
    const passive = { capture: true, passive: true };
    window.addEventListener('pointermove', onMove, passive);
    window.addEventListener('pointerdown', end, { capture: true });
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('wheel', end, passive);
    window.addEventListener('touchstart', end, passive);
    return () => {
      window.removeEventListener('pointermove', onMove, passive);
      window.removeEventListener('pointerdown', end, { capture: true });
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('wheel', end, passive);
      window.removeEventListener('touchstart', end, passive);
      // Not closed here: the element leaves the top layer when it is
      // removed, and a close() would fire `close` — which dismisses — in
      // development's rehearsal of this effect, before the stage is even
      // seen. Removed open, the platform restores no focus either: hand it
      // back once the stage is out of the way, if nothing else has taken it.
      const back = opener.current;
      if (back && back !== document.body && typeof back.focus === 'function') {
        queueMicrotask(() => {
          const now = document.activeElement;
          if (back.isConnected && (!now || now === document.body)) back.focus({ preventScroll: true });
        });
      }
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="saver-stage"
      aria-label="Screen saver"
      onCancel={(e) => { e.preventDefault(); onDismissRef.current?.(); }}
      onClose={() => onDismissRef.current?.()}
    >
      {saverKey && <SaverView saverKey={saverKey} pref={pref} logo={logo} brandName={brandName} cornerClock={pref.clock} />}
    </dialog>
  );
}
