'use client';

import { useEffect } from 'react';

/**
 * What kind of pointer the person is using, decided per interaction from the
 * pointerdown that came before it — not from a media query, because an iPad
 * with a trackpad, or a laptop with a touch screen, is both kinds of device.
 * A tap on a touch screen opens a file; a click with a mouse selects it.
 *
 * One capture-phase listener on window for the whole page, however many
 * components ask. A pen counts as a fine pointer: it clicks precisely.
 */
const TOUCH_WINDOW_MS = 1000;
let last = { type: null, t: 0 };
let users = 0;
const note = (e) => { last = { type: e.pointerType, t: performance.now() }; };

/** Whether the last press, within the last second, was a finger. */
export function isTouch() {
  return last.type === 'touch' && performance.now() - last.t < TOUCH_WINDOW_MS;
}

/** The last pointerdown seen: { type, t } (performance.now() time). */
export function lastPointer() {
  return last;
}

export default function usePointerIntent() {
  useEffect(() => {
    if (users++ === 0) window.addEventListener('pointerdown', note, { capture: true, passive: true });
    return () => {
      if (--users === 0) window.removeEventListener('pointerdown', note, { capture: true });
    };
  }, []);
  return isTouch;
}
