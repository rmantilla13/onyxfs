'use client';

import { useEffect, useRef, useState } from 'react';
import { pointOnPicture } from '@/lib/review';

// A pen stroke keeps a point only once the pointer has moved this far (a
// fraction of the picture): enough for a smooth line, without hundreds of
// points for a twitch.
const MIN_STEP = 0.002;
// Below this extent an arrow or rectangle is a click, not a shape.
const MIN_EXTENT = 0.004;
export const DEFAULT_STROKE = 3;

/**
 * Drawings over a picture, as SVG, filling the picture's own rectangle (the
 * player and the image stage place it there). Two modes:
 *
 *   display  the shapes of the selected comment; lets every pointer event
 *            through, so the video still toggles on a click
 *   draw     captures the pointer and turns drags into shapes with the
 *            current tool and colour, handing each finished one to onShape
 *
 * Points are fractions of the picture, so what is drawn here at one size
 * lands on the same spot at any other (fullscreen, a resize, 100%). Colours
 * are palette indices styled by review.css, never colours.
 */
export default function AnnotationLayer({ shapes = [], mode = 'display', tool = 'pen', color = 0, onShape }) {
  const svg = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [live, setLive] = useState(null);

  useEffect(() => {
    const el = svg.current;
    if (!el) return undefined;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const drawing = mode === 'draw';
  const at = (e) => pointOnPicture(e.clientX, e.clientY, svg.current.getBoundingClientRect());

  const onPointerDown = (e) => {
    if (!drawing || e.button > 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = at(e);
    setLive({ t: tool, c: color, w: DEFAULT_STROKE, pts: tool === 'pen' ? [p] : [p, p] });
  };
  const onPointerMove = (e) => {
    if (!live) return;
    const p = at(e);
    setLive((s) => {
      if (!s) return s;
      if (s.t !== 'pen') return { ...s, pts: [s.pts[0], p] };
      const last = s.pts[s.pts.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP || s.pts.length >= 2000) return s;
      return { ...s, pts: [...s.pts, p] };
    });
  };
  const onPointerUp = (e) => {
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const s = live;
    setLive(null);
    if (!s) return;
    if (s.t === 'pen' ? s.pts.length < 2 : Math.hypot(s.pts[1][0] - s.pts[0][0], s.pts[1][1] - s.pts[0][1]) < MIN_EXTENT) return;
    onShape?.(s);
  };

  const all = live ? [...shapes, live] : shapes;
  return (
    <svg
      ref={svg}
      className={`annotation-layer${drawing ? ' is-draw' : ''}`}
      width="100%"
      height="100%"
      viewBox={`0 0 ${Math.max(1, size.w)} ${Math.max(1, size.h)}`}
      preserveAspectRatio="none"
      aria-hidden={!drawing}
      role={drawing ? 'application' : undefined}
      aria-label={drawing ? 'Drawing area — drag to draw on the picture' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setLive(null)}
    >
      {size.w > 0 && all.map((s, i) => <Shape key={i} shape={s} w={size.w} h={size.h} />)}
    </svg>
  );
}

function Shape({ shape, w, h }) {
  // The stroke is stored in thousandths of the picture's width, so it
  // thickens with the picture rather than staying a fixed hairline.
  const sw = Math.max(1.5, (Number(shape.w) || DEFAULT_STROKE) / 1000 * w);
  const cls = `annotation-shape annotation-c${shape.c}`;
  const pts = (shape.pts || []).map(([x, y]) => [x * w, y * h]);
  if (!pts.length) return null;

  if (shape.t === 'rect' && pts.length === 2) {
    const [[x1, y1], [x2, y2]] = pts;
    return <rect className={cls} x={Math.min(x1, x2)} y={Math.min(y1, y2)} width={Math.abs(x2 - x1)} height={Math.abs(y2 - y1)} strokeWidth={sw} />;
  }

  if (shape.t === 'arrow' && pts.length === 2) {
    const [[x1, y1], [x2, y2]] = pts;
    // The head is drawn in pixels, so it keeps its shape however the
    // picture is stretched to fit.
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const len = Math.max(10, sw * 4);
    const wing = (a) => `${x2 - len * Math.cos(angle - a)},${y2 - len * Math.sin(angle - a)}`;
    return (
      <g className={cls} strokeWidth={sw}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} />
        <polyline points={`${wing(0.45)} ${x2},${y2} ${wing(-0.45)}`} />
      </g>
    );
  }

  return <polyline className={cls} points={pts.map(([x, y]) => `${x},${y}`).join(' ')} strokeWidth={sw} />;
}
