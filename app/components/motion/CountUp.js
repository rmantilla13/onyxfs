'use client';

/*
 * Adapted from CountUp in React Bits (https://github.com/DavidHDev/react-bits).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause — LICENSE-react-bits.md.
 */
import { useEffect, useRef, useState } from 'react';
import './motion.css';

const DURATION = 900;
// React Bits' easeOut, cubic-bezier(0.33, 1, 0.68, 1): the cubic ease-out.
const easeOut = (t) => 1 - (1 - t) ** 3;

const format = (n, decimals, grouping, suffix) => `${n.toLocaleString('en-US', {
  minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping,
})}${suffix}`;

/**
 * A number that counts up to itself when it first comes into view, and
 * from where it stands to its next value when that changes. React Bits'
 * CountUp in its plain counting mode, on requestAnimationFrame instead of
 * Motion, and bound to those two events only: at rest nothing runs.
 *
 * Two copies share one box (motion.css): the number as it is — what a
 * screen reader hears, and what anyone who asked for less motion sees —
 * and a counting copy that starts at `from` in the server's HTML, so
 * hydrating never paints the real figure only to snap it back to zero and
 * count. The count writes its one text node each frame, without a render.
 * rAF waits out a hidden tab, so a count that started there lands on the
 * figure when the tab is shown.
 */
export default function CountUp({ to, from = 0, decimals = 0, grouping = true, suffix = '', className = '' }) {
  const target = Number(to) || 0;
  const runRef = useRef(null);
  const shownRef = useRef(Number(from) || 0);
  // The counting copy's first text: fixed, so React never writes over the count.
  const [start] = useState(() => format(Number(from) || 0, decimals, grouping, suffix));

  useEffect(() => {
    const el = runRef.current;
    if (!el) return undefined;
    const land = () => {
      shownRef.current = target;
      el.textContent = format(target, decimals, grouping, suffix);
    };
    if (shownRef.current === target || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      land();
      return undefined;
    }
    let raf = 0;
    let seen = null;
    const count = () => {
      const a = shownRef.current;
      const t0 = performance.now();
      const step = (now) => {
        // A busy first frame can be stamped before t0; below 0 the ease
        // dips negative and the tile reads "-0".
        const t = Math.min(1, Math.max(0, (now - t0) / DURATION));
        if (t === 1) return land();
        shownRef.current = a + (target - a) * easeOut(t);
        el.textContent = format(shownRef.current, decimals, grouping, suffix);
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    if (typeof IntersectionObserver === 'undefined') count();
    else {
      seen = new IntersectionObserver(([entry]) => {
        if (!entry.isIntersecting) return;
        seen.disconnect();
        seen = null;
        count();
      });
      seen.observe(el);
    }
    return () => {
      cancelAnimationFrame(raf);
      seen?.disconnect();
    };
  }, [target, decimals, grouping, suffix]);

  return (
    <span className={`count-up${className ? ` ${className}` : ''}`}>
      <span className="count-up-value">{format(target, decimals, grouping, suffix)}</span>
      <span className="count-up-run" aria-hidden="true" ref={runRef}>{start}</span>
    </span>
  );
}
