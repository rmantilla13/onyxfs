'use client';

import { useEffect, useState } from 'react';
import { containRect } from '@/lib/review';

/**
 * Where a picture of srcW×srcH sits inside the element `ref` points at, under
 * `object-fit: contain`, kept current as that element resizes — a window
 * resize, fullscreen, the aside stacking under the player on a phone.
 *
 * The overlays (drawings, pins) are placed on this rectangle rather than on
 * the stage, because the stage letterboxes: a point at 0.4 of the stage is not
 * 0.4 of the picture whenever the two shapes differ. The arithmetic is
 * containRect in lib/review.js, tested there.
 */
export default function useContainedRect(ref, srcW, srcH) {
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return containRect(box.w, box.h, srcW, srcH);
}
