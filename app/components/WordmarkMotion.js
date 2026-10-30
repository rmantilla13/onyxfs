'use client';

import { useEffect } from 'react';

/**
 * The wordmark's light (OnyxWordmark) sweeps once, as the page arrives
 * (globals.css); during that sweep it holds still while someone is working —
 * pointing, pressing, typing, scrolling — and moves again two seconds after
 * they stop.
 * A running animation keeps the compositor producing a frame every vsync,
 * and a click's own frame then lands one later: input to next paint measured
 * 32 ms with it running and 16 ms without, on a page that does nothing else.
 * Decoration should not cost the interaction a frame.
 *
 * The sweep is also the only time its element is worth a layer of its own:
 * globals.css promotes it (will-change) only under `is-sweeping`, which goes
 * on as the sweep starts and comes off as it ends, so no promoted layer
 * outlives it in a window that stays open all day. The first wordmark starts
 * before any script runs, so the ones already moving are marked on mount;
 * one drawn later announces itself with animationstart.
 *
 * One set of listeners for the page however many wordmarks it shows; the
 * pause and the class are written on the sweep elements themselves, so no
 * other style is recalculated for them.
 */
const IDLE_MS = 2000;
const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'touchstart'];
const SWEEP = 'onyx-fs-sweep'; // the element's class and its keyframes' name
const SWEEPING = 'is-sweeping';
let users = 0;
let timer = null;
let paused = false;

const sweeps = () => document.querySelectorAll(`.${SWEEP}`);

function setPaused(on) {
  if (on === paused) return;
  paused = on;
  for (const el of sweeps()) el.style.animationPlayState = on ? 'paused' : '';
}
function activity() {
  if (paused) { clearTimeout(timer); timer = setTimeout(() => setPaused(false), IDLE_MS); return; }
  setPaused(true);
  clearTimeout(timer);
  timer = setTimeout(() => setPaused(false), IDLE_MS);
}
function sweeping(e, on) {
  if (e.animationName === SWEEP && e.target?.classList) e.target.classList.toggle(SWEEPING, on);
}
const sweepStart = (e) => sweeping(e, true);
const sweepEnd = (e) => sweeping(e, false);

export default function WordmarkMotion() {
  useEffect(() => {
    if (users++ === 0) {
      for (const t of EVENTS) window.addEventListener(t, activity, { capture: true, passive: true });
      window.addEventListener('animationstart', sweepStart, true);
      window.addEventListener('animationend', sweepEnd, true);
      window.addEventListener('animationcancel', sweepEnd, true);
      // A sweep that has finished is no longer among its element's
      // animations, so this marks only the ones still moving.
      for (const el of sweeps()) if (el.getAnimations?.().length) el.classList.add(SWEEPING);
    }
    return () => {
      if (--users > 0) return;
      for (const t of EVENTS) window.removeEventListener(t, activity, { capture: true });
      window.removeEventListener('animationstart', sweepStart, true);
      window.removeEventListener('animationend', sweepEnd, true);
      window.removeEventListener('animationcancel', sweepEnd, true);
      clearTimeout(timer);
      setPaused(false);
      for (const el of sweeps()) el.classList.remove(SWEEPING);
    };
  }, []);
  return null;
}
