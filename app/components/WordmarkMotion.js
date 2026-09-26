'use client';

import { useEffect } from 'react';

/**
 * The wordmark's light (OnyxWordmark) holds still while someone is working —
 * pointing, pressing, typing, scrolling — and moves again two seconds after
 * they stop.
 * A running animation keeps the compositor producing a frame every vsync,
 * and a click's own frame then lands one later: input to next paint measured
 * 32 ms with it running and 16 ms without, on a page that does nothing else.
 * Decoration should not cost the interaction a frame.
 *
 * One set of listeners for the page however many wordmarks it shows; the
 * pause is written on the sweep elements themselves, so no other style is
 * recalculated for it.
 */
const IDLE_MS = 2000;
const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
let users = 0;
let timer = null;
let paused = false;

function setPaused(on) {
  if (on === paused) return;
  paused = on;
  for (const el of document.querySelectorAll('.onyx-fs-sweep')) el.style.animationPlayState = on ? 'paused' : '';
}
function activity() {
  if (paused) { clearTimeout(timer); timer = setTimeout(() => setPaused(false), IDLE_MS); return; }
  setPaused(true);
  clearTimeout(timer);
  timer = setTimeout(() => setPaused(false), IDLE_MS);
}

export default function WordmarkMotion() {
  useEffect(() => {
    if (users++ === 0) for (const t of EVENTS) window.addEventListener(t, activity, { capture: true, passive: true });
    return () => {
      if (--users > 0) return;
      for (const t of EVENTS) window.removeEventListener(t, activity, { capture: true });
      clearTimeout(timer);
      setPaused(false);
    };
  }, []);
  return null;
}
