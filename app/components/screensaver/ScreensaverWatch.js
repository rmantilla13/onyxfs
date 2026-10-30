'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Screensaver from './Screensaver';
import {
  SCREENSAVER_KEY, SCREENSAVER_EVENT, SCREENSAVER_START_EVENT,
  readScreensaverPref, parseScreensaverPref, pickSaver, delayMs,
} from '@/lib/screensaver';

const EVENTS = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
/* How long to wait before looking again when the page was quiet but busy. */
const RETRY_MS = 30_000;

/**
 * Waits for the page to go quiet and puts the screen saver up, on every page
 * (the root layout mounts it). With nothing chosen it listens for a choice
 * and does nothing else.
 *
 * At rest it costs a timestamp per event and one timer: each thing someone
 * does writes `last`, and the timer, due when the delay has passed since
 * the last it saw, looks again then rather than on every event. A page
 * that is hidden, showing a video that is playing, or in full screen
 * (that video) is left alone, and looked at again in half a minute.
 *
 * The picker's Try it (SCREENSAVER_START_EVENT) puts it up at once.
 */
export default function ScreensaverWatch({ logo, brandName }) {
  const [pref, setPref] = useState(null);
  const [showing, setShowing] = useState(false);
  const last = useRef(0);
  const prefRef = useRef(null);
  prefRef.current = pref;

  useEffect(() => {
    setPref(readScreensaverPref());
    const onLocal = (e) => setPref(e.detail ? parseScreensaverPref(e.detail) : readScreensaverPref());
    const onStorage = (e) => { if (e.key === SCREENSAVER_KEY || e.key === null) setPref(readScreensaverPref()); };
    const onStart = () => { if (pickSaver(prefRef.current)) setShowing(true); };
    window.addEventListener(SCREENSAVER_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    window.addEventListener(SCREENSAVER_START_EVENT, onStart);
    return () => {
      window.removeEventListener(SCREENSAVER_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(SCREENSAVER_START_EVENT, onStart);
    };
  }, []);

  const dismiss = useCallback(() => { last.current = performance.now(); setShowing(false); }, []);

  useEffect(() => {
    if (!pref || pref.saver === 'off' || showing) return undefined;
    const delay = delayMs(pref);
    last.current = performance.now();
    let timer = 0;
    const schedule = (ms) => { clearTimeout(timer); timer = setTimeout(check, ms); };
    const check = () => {
      const quiet = performance.now() - last.current;
      if (quiet < delay) return schedule(delay - quiet);
      if (!canStart()) return schedule(RETRY_MS);
      return setShowing(true);
    };
    const activity = () => { last.current = performance.now(); };
    for (const t of EVENTS) window.addEventListener(t, activity, { capture: true, passive: true });
    document.addEventListener('visibilitychange', activity);
    schedule(delay);
    return () => {
      clearTimeout(timer);
      for (const t of EVENTS) window.removeEventListener(t, activity, { capture: true });
      document.removeEventListener('visibilitychange', activity);
    };
  }, [pref, showing]);

  if (!showing || !pref) return null;
  return <Screensaver pref={pref} logo={logo} brandName={brandName} onDismiss={dismiss} />;
}

/** Quiet, but not a moment for a screen saver. */
function canStart() {
  if (document.visibilityState !== 'visible') return false;
  if (document.fullscreenElement) return false;
  for (const v of document.querySelectorAll('video')) if (!v.paused && !v.ended) return false;
  return true;
}
