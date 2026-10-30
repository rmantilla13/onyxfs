'use client';

/*
 * Adapted from DecryptedText in React Bits (https://github.com/DavidHDev/react-bits).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause — LICENSE-react-bits.md.
 */
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import './motion.css';

// Ticks every character spends in noise before the first one lands.
const LEAD = 3;
const isSpace = (c) => /\s/.test(c);
// A layout effect has nothing to run before on the server, and React 18 says so.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Text that resolves out of noise: every character cycles through the
 * text's own alphabet, then they land one at a time from the start. React
 * Bits' DecryptedText in its sequential, original-characters mode, for a
 * value that has only just been made — a pairing code, minted by the click
 * before it. Twelve characters are in place in 600 ms.
 *
 * The noise comes from the text's own characters, never punctuation: in a
 * code box `!@#` reads as something broken, a wrong letter as one about to
 * be right. It starts in a layout effect, so the finished text the first
 * render holds is never painted ahead of the noise; reduced motion leaves
 * it there.
 *
 * While it scrambles, a screen reader gets the text whole and once, from a
 * copy only it sees. At rest it is one plain text node again, so a code
 * copied out of the page to be pasted into the app is copied once.
 */
export default function DecryptedText({ text, speed = 40, className = '' }) {
  const value = String(text ?? '');
  const chars = useMemo(() => Array.from(value), [value]);
  // null: at rest, showing the text itself.
  const [frame, setFrame] = useState(null);

  useIsoLayoutEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const pool = [...new Set(chars.filter((c) => !isSpace(c)))];
    if (pool.length < 2) return undefined;
    const noise = (landed) => chars.map((c, i) => (
      i < landed || isSpace(c) ? c : pool[Math.floor(Math.random() * pool.length)]
    ));
    let tick = 0;
    setFrame({ of: value, glyphs: noise(0), landed: 0 });
    const timer = setInterval(() => {
      tick += 1;
      const landed = Math.max(0, tick - LEAD);
      if (landed < chars.length) setFrame({ of: value, glyphs: noise(landed), landed });
      else { clearInterval(timer); setFrame(null); }
    }, speed);
    return () => clearInterval(timer);
  }, [value, chars, speed]);

  // A frame left from the text before this one is never drawn under it.
  const moving = frame && frame.of === value;
  return (
    <span className={`decrypted-text${className ? ` ${className}` : ''}`}>
      {moving ? (
        <>
          <span className="sr-only">{value}</span>
          <span aria-hidden="true">
            {frame.glyphs.map((g, i) => (
              <span key={i} className={i < frame.landed || isSpace(chars[i]) ? undefined : 'decrypted-text-scrambled'}>{g}</span>
            ))}
          </span>
        </>
      ) : value}
    </span>
  );
}
