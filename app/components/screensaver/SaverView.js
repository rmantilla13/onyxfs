'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import BrandLogo from '@/app/components/BrandLogo';
import Icon from '@/app/components/ui/Icon';
import { stageSources } from '@/lib/stage-sources';
import {
  SPEED_FACTOR, DEFAULT_MESSAGE, WORD_CLOCK_ROWS, WORD_CLOCK_COLS,
  saverFor, pickSaver, wordClock, clockParts, bounce, drift,
} from '@/lib/screensaver';
import './screensaver.css';

/* icons: image ban shuffle */

/**
 * One screen saver, drawn into whatever box holds it: the screen
 * (Screensaver.js), the picker's preview, or a tile in its grid. `still`
 * draws a single frame and nothing moves — a tile, and anyone who asked
 * for less motion. Each saver is bound to the box's size through
 * --saver-unit (screensaver.css), so none of them knows how big it is.
 *
 * Nothing here runs while it is not on screen: the canvas loops stop when
 * their saver unmounts, the clocks' timers go with them, and a tile's
 * canvas is drawn once. The screen itself is the only place a loop runs,
 * and it is up only while nobody is here.
 */
export default function SaverView({ saverKey, pref, still = false, preview = false, logo, brandName, cornerClock = false }) {
  const ref = useRef(null);
  const box = useBox(ref);
  const speed = SPEED_FACTOR[pref?.speed] ?? 1;
  const unit = Math.min(box.width, box.height) / 100;
  // Shuffle on the screen is one of the others, chosen as it goes up; a
  // Shuffle tile is its own glyph.
  const key = useMemo(() => (saverKey === 'shuffle' && !still ? pickSaver({ saver: 'shuffle' }) : saverKey), [saverKey, still]);
  const entry = saverFor(key);
  const reduced = useReducedMotion();
  const frozen = still || reduced;
  const common = { box, speed, still: frozen, preview, pref };
  let body = null;
  if (box.width > 0) {
    switch (key) {
      case 'photos': body = <Photos {...common} />; break;
      case 'mosaic': body = <Mosaic {...common} />; break;
      case 'clock': body = <Clock {...common} />; break;
      case 'dial': body = <Dial {...common} />; break;
      case 'words': body = <Words {...common} />; break;
      case 'aurora': body = <Aurora />; break;
      case 'orbs': body = <Canvas draw={drawOrbs} {...common} />; break;
      case 'embers': body = <Canvas draw={drawEmbers} {...common} />; break;
      case 'stars': body = <Canvas draw={drawStars} {...common} />; break;
      case 'rain': body = <Canvas draw={drawRain} {...common} />; break;
      case 'waves': body = <Canvas draw={drawWaves} {...common} />; break;
      case 'lines': body = <Canvas draw={drawLines} {...common} />; break;
      case 'wordmark': body = <Wordmark {...common} logo={logo} brandName={brandName} />; break;
      case 'message': body = <Message {...common} />; break;
      case 'shuffle': body = <Glyph name="shuffle" />; break;
      case 'off': body = <Glyph name="ban" />; break;
      default: body = null;
    }
  }
  return (
    <div
      ref={ref}
      className={`saver${frozen ? ' is-still' : ''}${preview ? ' is-preview' : ''}`}
      data-saver={key}
      style={{ '--saver-unit': `${unit}px`, '--saver-speed': speed }}
      aria-hidden={still ? true : undefined}
    >
      {body}
      {cornerClock && !entry?.clock && key !== 'off' && <CornerClock still={frozen} />}
    </div>
  );
}

// ── What they share ─────────────────────────────────────────────────────────

/** Whether the person asked the system for less motion. */
function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return undefined;
    const sync = () => setReduced(m.matches);
    sync();
    m.addEventListener('change', sync);
    return () => m.removeEventListener('change', sync);
  }, []);
  return reduced;
}

/** The size of the box `ref` holds, kept current. */
function useBox(ref) {
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    // The layout size, not the drawn one: a tile in the picker is scaled
    // down by half, and its saver should be sized for the box it fills.
    const measure = () => {
      const { offsetWidth: width, offsetHeight: height } = el;
      setBox((b) => (b.width === width && b.height === height ? b : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return box;
}

/** A clock's `now`, ticking every `every` ms while it is on screen. */
function useNow(every, still) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (still) return undefined;
    const t = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(t);
  }, [every, still]);
  return now;
}

/**
 * The brand's colours as a canvas can take them: the custom properties,
 * read off a probe inside `el` so [data-theme] and the saver's own --saver-*
 * apply, each parsed to [r, g, b] (0–255).
 */
const COLOR_VARS = { fg: '--saver-fg', bg: '--saver-bg', a: '--aura-a', b: '--aura-b', c: '--aura-c', accent: '--accent' };
function readColors(el) {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  el.appendChild(probe);
  const out = {};
  for (const [name, prop] of Object.entries(COLOR_VARS)) {
    probe.style.color = `var(${prop})`;
    out[name] = parseColor(getComputedStyle(probe).color);
  }
  out.mono = getComputedStyle(el).getPropertyValue('--font-mono').trim() || 'ui-monospace, monospace';
  probe.remove();
  return out;
}
/** 'rgb(r, g, b)', 'rgba(…)' or 'color(srgb r g b)' → [r, g, b]. */
export function parseColor(s) {
  const m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (m) return [m[1], m[2], m[3]].map((v) => Math.round(Number(v) * 255));
  const n = String(s).match(/[\d.]+/g);
  return n && n.length >= 3 ? n.slice(0, 3).map((v) => Math.round(Number(v))) : [255, 255, 255];
}
const rgba = ([r, g, b], a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;
const luminance = ([r, g, b]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * A saver drawn by script: `draw(ctx, state, dt, colors)` once a frame,
 * with `state.w` and `state.h` the box in CSS pixels, `state.init` false
 * on the first frame and after a resize (so a draw seeds itself there), and
 * `dt` the seconds since the last frame, already multiplied by the speed.
 * Still, it draws four seconds of frames into the canvas and stops, so a tile
 * shows a scene that has got going rather than its first instant.
 *
 * The backing store is capped at about 2.6 million pixels: a starfield on
 * a 5K display does not need every one of them, and the fill it does each
 * frame is paid in exactly those.
 */
function Canvas({ draw, still, speed }) {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!canvas || !parent) return undefined;
    const ctx = canvas.getContext('2d');
    const colors = readColors(parent);
    const state = { init: false, w: 0, h: 0 };
    let raf = 0;
    let last = 0;
    let running = true;
    const size = () => {
      const { offsetWidth: width, offsetHeight: height } = parent;
      const cap = Math.sqrt(2_600_000 / Math.max(1, width * height));
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2, cap));
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      state.w = width;
      state.h = height;
      state.init = false;
    };
    // Four seconds in: embers have risen, a trail has formed, stars have spread.
    const once = () => { for (let i = 0; i < 240; i++) draw(ctx, state, speed / 60, colors); };
    const frame = (now) => {
      if (!running) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      draw(ctx, state, dt * speed, colors);
      raf = requestAnimationFrame(frame);
    };
    size();
    if (still) once();
    else raf = requestAnimationFrame(frame);
    // A frame after the tab comes back would otherwise be a tenth of a
    // second of motion for minutes away; the clamp above bounds it anyway.
    const ro = new ResizeObserver(() => { size(); if (still) once(); });
    ro.observe(parent);
    return () => { running = false; cancelAnimationFrame(raf); ro.disconnect(); };
  }, [draw, still, speed]);
  return <canvas ref={ref} className="saver-canvas" aria-hidden="true" />;
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// ── Starfield ───────────────────────────────────────────────────────────────

function drawStars(ctx, s, dt, c) {
  const { w, h } = s;
  const star = (anywhere) => ({ x: rand(-1, 1), y: rand(-1, 1), z: anywhere ? rand(0.05, 1) : 1, tint: Math.random() < 0.12 ? pick([c.a, c.b, c.c]) : c.fg });
  if (!s.init) { s.init = true; s.stars = Array.from({ length: Math.round(Math.min(600, Math.max(180, (w * h) / 2600))) }, () => star(true)); }
  const cx = w / 2;
  const cy = h / 2;
  const f = Math.min(w, h) * 0.9;
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, w, h);
  ctx.lineCap = 'round';
  for (const st of s.stars) {
    const pz = st.z;
    st.z -= dt * 0.32;
    if (st.z <= 0.02) { Object.assign(st, star(false)); continue; }
    const px = cx + (st.x / pz) * f;
    const py = cy + (st.y / pz) * f;
    const x = cx + (st.x / st.z) * f;
    const y = cy + (st.y / st.z) * f;
    if (x < -12 || x > w + 12 || y < -12 || y > h + 12) { Object.assign(st, star(false)); continue; }
    const near = 1 - st.z;
    ctx.strokeStyle = rgba(st.tint, 0.12 + near * 0.88);
    ctx.lineWidth = 0.4 + near * 2.4;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(x, y);
    ctx.stroke();
  }
}

// ── Rain ────────────────────────────────────────────────────────────────────

const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホ0123456789ABCDEFXYZ<>*+=:';
function drawRain(ctx, s, dt, c) {
  const { w, h } = s;
  if (!s.init) {
    s.init = true;
    s.size = Math.max(11, Math.round(Math.min(w, h) / 38));
    s.drops = Array.from({ length: Math.ceil(w / s.size) }, () => ({ y: rand(-h / s.size, 0), v: rand(5, 14), row: -1 }));
    ctx.fillStyle = rgba(c.bg);
    ctx.fillRect(0, 0, w, h);
  }
  // What was drawn fades a little each frame: the trail.
  ctx.fillStyle = rgba(c.bg, Math.min(0.6, 0.16 * Math.max(1, dt * 60)));
  ctx.fillRect(0, 0, w, h);
  ctx.font = `${s.size}px ${c.mono}`;
  ctx.textBaseline = 'top';
  s.drops.forEach((d, i) => {
    d.y += d.v * dt;
    const row = Math.floor(d.y);
    if (row === d.row) return;
    d.row = row;
    const x = i * s.size;
    const y = row * s.size;
    // The one behind the head goes to the brand's colour; the head is bright.
    ctx.fillStyle = rgba(c.a, 0.95);
    ctx.fillText(pick(GLYPHS), x, y - s.size);
    ctx.fillStyle = rgba(c.fg);
    ctx.fillText(pick(GLYPHS), x, y);
    if (y > h && Math.random() < 0.08) { d.y = rand(-12, 0); d.v = rand(5, 14); d.row = -1; }
  });
}

// ── Waves ───────────────────────────────────────────────────────────────────

function drawWaves(ctx, s, dt, c) {
  const { w, h } = s;
  if (!s.init) { s.init = true; s.t = rand(0, 100); }
  s.t += dt;
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, w, h);
  const layers = [[c.a, 0.42, 1.0, 0.55], [c.b, 0.36, 0.7, 0.8], [c.c, 0.32, 1.4, 0.4], [c.fg, 0.14, 0.5, 1.1]];
  layers.forEach(([col, alpha, k, sp], i) => {
    const base = h * (0.42 + i * 0.13);
    const amp = h * 0.075;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w + 8; x += 8) {
      const u = (x / w) * Math.PI * 2;
      const y = base + Math.sin(u * k + s.t * sp) * amp + Math.sin(u * k * 2.3 - s.t * sp * 0.7 + i) * amp * 0.4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = rgba(col, alpha);
    ctx.fill();
  });
}

// ── Lines ───────────────────────────────────────────────────────────────────

function drawLines(ctx, s, dt, c) {
  const { w, h } = s;
  const v = Math.max(60, Math.min(w, h) * 0.22);
  if (!s.init) {
    s.init = true;
    s.shapes = [c.a, c.b].map((color) => ({
      color,
      pts: Array.from({ length: 4 }, () => ({ x: rand(0, w), y: rand(0, h), vx: rand(-v, v), vy: rand(-v, v), w: 0, h: 0 })),
      hist: [],
      acc: 1,
    }));
  }
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, w, h);
  ctx.lineWidth = 1.4;
  ctx.lineJoin = 'round';
  for (const shape of s.shapes) {
    shape.pts = shape.pts.map((p) => bounce(p, dt, { width: w, height: h }));
    shape.acc += dt;
    // A copy every twentieth of a second, fourteen deep: the trail.
    if (shape.acc >= 0.05) {
      shape.acc = 0;
      shape.hist.unshift(shape.pts.map((p) => [p.x, p.y]));
      if (shape.hist.length > 14) shape.hist.pop();
    }
    shape.hist.forEach((poly, i) => {
      ctx.strokeStyle = rgba(shape.color, (1 - i / 14) * 0.9);
      ctx.beginPath();
      poly.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.stroke();
    });
  }
}

// ── Embers ──────────────────────────────────────────────────────────────────

function drawEmbers(ctx, s, dt, c) {
  const { w, h } = s;
  if (!s.init) { s.init = true; s.p = []; s.acc = 0; }
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, w, h);
  const scale = Math.max(0.5, Math.min(w, h) / 600);
  s.acc += dt * 50;
  const cap = Math.round(Math.min(260, Math.max(60, (w * h) / 6000)));
  while (s.acc >= 1 && s.p.length < cap) {
    s.acc -= 1;
    s.p.push({ x: rand(0, w), y: h + 8, vy: -rand(40, 110) * scale, sway: rand(0, Math.PI * 2), r: rand(1.2, 3.2) * scale, life: 1, decay: rand(0.1, 0.22), col: pick([c.a, c.b, c.c, c.fg]) });
  }
  for (const p of s.p) {
    p.y += p.vy * dt;
    p.sway += dt * 2.2;
    p.x += Math.sin(p.sway) * 22 * scale * dt;
    p.life -= p.decay * dt;
  }
  s.p = s.p.filter((p) => p.life > 0 && p.y > -10);
  for (const p of s.p) {
    const r = p.r * (0.3 + p.life * 0.7);
    ctx.fillStyle = rgba(p.col, p.life * 0.18);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r * 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = rgba(p.col, p.life);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ── Orbs ────────────────────────────────────────────────────────────────────

function drawOrbs(ctx, s, dt, c) {
  const { w, h } = s;
  if (!s.init) {
    s.init = true;
    const R = Math.min(w, h) * 0.3;
    const v = Math.max(14, Math.min(w, h) * 0.05);
    s.orbs = [c.a, c.b, c.c, c.a, c.b, c.fg].map((col) => {
      const d = R * 2 * rand(0.6, 1.2);
      return { x: rand(0, Math.max(0, w - d)), y: rand(0, Math.max(0, h - d)), vx: rand(-v, v), vy: rand(-v, v), w: d, h: d, col };
    });
  }
  ctx.fillStyle = rgba(c.bg);
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = luminance(c.bg) < 0.5 ? 'lighter' : 'multiply';
  for (let i = 0; i < s.orbs.length; i++) {
    const o = (s.orbs[i] = bounce(s.orbs[i], dt, { width: w, height: h }));
    const r = o.w / 2;
    const g = ctx.createRadialGradient(o.x + r, o.y + r, 0, o.x + r, o.y + r, r);
    g.addColorStop(0, rgba(o.col, 0.6));
    g.addColorStop(0.55, rgba(o.col, 0.18));
    g.addColorStop(1, rgba(o.col, 0));
    ctx.fillStyle = g;
    ctx.fillRect(o.x, o.y, o.w, o.h);
  }
  ctx.globalCompositeOperation = 'source-over';
}

// ── Aurora ──────────────────────────────────────────────────────────────────

/** Four soft lights in the brand's colours, moved by the stylesheet alone. */
function Aurora() {
  return (
    <div className="saver-aurora" aria-hidden="true">
      <span className="saver-aurora-blob" /><span className="saver-aurora-blob" /><span className="saver-aurora-blob" /><span className="saver-aurora-blob" />
    </div>
  );
}

// ── Photos and Mosaic ───────────────────────────────────────────────────────

/** An original stands in for a missing large preview only up to this. */
const ORIGINAL_MAX_BYTES = 8 * 1024 * 1024;

/**
 * The pictures to show: the newest images in the library, or in `drive`,
 * each at its large preview — the viewer's layer — or a small original, or
 * the grid's poster. Shuffled, so the screen does not open on the same
 * picture every time. `problem` says why there are none, for the screen to
 * say.
 */
function usePictures({ drive, enabled }) {
  const [state, setState] = useState({ list: null, problem: null });
  useEffect(() => {
    if (!enabled) return undefined;
    let gone = false;
    const q = new URLSearchParams({ kind: 'image', sort: 'new', limit: '80', folders: '0' });
    if (drive) q.set('filespace', drive);
    (async () => {
      try {
        const r = await fetch(`/api/files?${q}`, { credentials: 'same-origin' });
        if (gone) return;
        if (!r.ok) { setState({ list: [], problem: r.status === 401 ? 'signin' : r.status === 403 || r.status === 409 ? 'drive' : 'error' }); return; }
        const data = await r.json();
        const list = (Array.isArray(data?.files) ? data.files : [])
          .map((f) => { const s = stageSources(f); return s.preview || (Number(f.size || 0) <= ORIGINAL_MAX_BYTES ? s.original : null) || s.thumb; })
          .filter(Boolean);
        for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
        if (!gone) setState({ list, problem: list.length ? null : 'empty' });
      } catch {
        if (!gone) setState({ list: [], problem: 'error' });
      }
    })();
    return () => { gone = true; };
  }, [drive, enabled]);
  return state;
}

const PROBLEMS = {
  signin: 'Sign in to see your pictures here.',
  drive: 'Choose a drive in the screen saver’s options.',
  empty: 'No pictures in your library yet.',
  error: 'Your pictures could not be loaded.',
};

function Placeholder({ kind, note }) {
  return (
    <div className="saver-placeholder" aria-hidden={note ? undefined : true}>
      {kind === 'mosaic'
        ? <div className="saver-placeholder-grid">{Array.from({ length: 12 }, (_, i) => <span key={i} />)}</div>
        : <Icon name="image" size={24} />}
      {note && <p className="saver-note">{note}</p>}
    </div>
  );
}

function Glyph({ name }) {
  return <div className="saver-glyph" aria-hidden="true"><Icon name={name} size={24} /></div>;
}

/** The next picture, once the browser has it, so a change never shows a blank. */
function preload(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

function Photos({ pref, still, speed }) {
  const { list, problem } = usePictures({ drive: pref?.drive, enabled: !still });
  const hold = Math.round(9000 / speed);
  const [shown, setShown] = useState([]);
  const [dead, setDead] = useState(false);
  useEffect(() => {
    if (!list?.length) return undefined;
    let i = 0;
    let fails = 0;
    let gone = false;
    let timer = 0;
    let lastKb = -1;
    const next = async () => {
      const src = list[i % list.length];
      i += 1;
      const ok = await preload(src);
      if (gone) return;
      if (!ok) {
        if (++fails >= list.length) { setDead(true); return; }
        timer = setTimeout(next, 100);
        return;
      }
      fails = 0;
      let kb = Math.floor(Math.random() * 4);
      if (kb === lastKb) kb = (kb + 1) % 4;
      lastKb = kb;
      setShown((s) => [...s.slice(-1), { src, id: i, kb }]);
      timer = setTimeout(next, hold);
    };
    next();
    return () => { gone = true; clearTimeout(timer); };
  }, [list, hold]);
  if (still) return <Placeholder kind="photos" />;
  if (problem || dead) return <Placeholder kind="photos" note={PROBLEMS[dead ? 'error' : problem]} />;
  return (
    <div className="saver-photos" style={{ '--saver-hold': hold + 2600 }}>
      {shown.map((p) => <img key={p.id} src={p.src} alt="" className={`saver-photo kb-${p.kb}`} draggable={false} />)}
    </div>
  );
}

function Mosaic({ pref, still, speed, box, preview }) {
  const { list, problem } = usePictures({ drive: pref?.drive, enabled: !still });
  const rows = preview ? 3 : 4;
  const cols = Math.max(2, Math.round(rows * (box.width / Math.max(1, box.height)) * 0.85));
  const n = rows * cols;
  const [tiles, setTiles] = useState([]);
  // Pictures that would not load, skipped from then on; and the next one to
  // hand out, shared by the timer and a tile replacing a picture that failed.
  const dead = useRef(new Set());
  const cursor = useRef({ i: 0, id: 0 });
  const take = () => {
    const c = cursor.current;
    for (let tries = 0; tries < list.length; tries++) {
      const src = list[c.i++ % list.length];
      if (!dead.current.has(src)) return { src, id: ++c.id };
    }
    return null;
  };
  const turn = (k, next) => setTiles((t) => {
    if (!next || k >= t.length) return t;
    const out = t.slice();
    out[k] = { imgs: [...t[k].imgs.slice(-1), next] };
    return out;
  });
  useEffect(() => {
    if (!list?.length) return undefined;
    setTiles(Array.from({ length: n }, () => ({ imgs: [take()].filter(Boolean) })));
    // One tile at a time turns to the next picture, every second and a half.
    const timer = setInterval(() => turn(Math.floor(Math.random() * n), take()), Math.round(1500 / speed));
    return () => clearInterval(timer);
  }, [list, n, speed]); // eslint-disable-line react-hooks/exhaustive-deps -- take and turn read refs
  if (still) return <Placeholder kind="mosaic" />;
  if (problem) return <Placeholder kind="mosaic" note={PROBLEMS[problem]} />;
  return (
    <div className="saver-mosaic" style={{ '--saver-cols': cols }}>
      {tiles.map((t, k) => (
        <div key={k} className="saver-mosaic-tile">
          {t.imgs.map((im) => (
            <img
              key={im.id}
              src={im.src}
              alt=""
              draggable={false}
              // A picture that will not load gives its tile to the next one.
              onError={() => { dead.current.add(im.src); turn(k, take()); }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ── The clocks ──────────────────────────────────────────────────────────────

function Clock({ box, speed, still }) {
  const now = useNow(1000, still);
  const ref = useRef(null);
  const size = useBox(ref);
  const t0 = useRef(null);
  if (t0.current === null) t0.current = Math.random() * 1000;
  const t = still ? t0.current : t0.current + performance.now() / 1000;
  const { x, y } = drift(t, box, { w: size.width, h: size.height }, speed);
  const parts = clockParts(now);
  return (
    <div ref={ref} className="saver-clock" style={{ transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)` }}>
      <div className="saver-clock-time">
        {parts.time}
        {parts.period && <span className="saver-clock-period">{parts.period}</span>}
      </div>
      <div className="saver-clock-date">{parts.date}</div>
    </div>
  );
}

function Dial({ still }) {
  const now = useNow(1000, still);
  // The second hand's angle only ever grows, so its one-second glide never
  // has to spin back round at the top of the minute.
  const turns = useRef({ last: null, n: 0 });
  const sec = now.getSeconds();
  if (turns.current.last !== null && sec < turns.current.last) turns.current.n += 1;
  turns.current.last = sec;
  const secAngle = (turns.current.n * 60 + sec) * 6;
  const minAngle = (now.getMinutes() + sec / 60) * 6;
  const hourAngle = ((now.getHours() % 12) + now.getMinutes() / 60) * 30;
  return (
    <svg className="saver-dial" viewBox="0 0 100 100" role="img" aria-label={clockParts(now).time}>
      <circle className="saver-dial-face" cx="50" cy="50" r="46" />
      {Array.from({ length: 60 }, (_, i) => (
        <line
          key={i}
          className={i % 5 === 0 ? 'saver-dial-tick is-hour' : 'saver-dial-tick'}
          x1="50" y1={i % 5 === 0 ? 7 : 9} x2="50" y2="11"
          transform={`rotate(${i * 6} 50 50)`}
        />
      ))}
      <line className="saver-dial-hand is-hour" x1="50" y1="54" x2="50" y2="28" style={{ transform: `rotate(${hourAngle}deg)` }} />
      <line className="saver-dial-hand is-minute" x1="50" y1="56" x2="50" y2="16" style={{ transform: `rotate(${minAngle}deg)` }} />
      <line className="saver-dial-hand is-second" x1="50" y1="60" x2="50" y2="12" style={{ transform: `rotate(${secAngle}deg)` }} />
      <circle className="saver-dial-pin" cx="50" cy="50" r="1.8" />
    </svg>
  );
}

function Words({ still }) {
  const now = useNow(10_000, still);
  const { words, cells } = wordClock(now.getHours(), now.getMinutes());
  const said = words.join(' ').toLowerCase();
  return (
    <div className="saver-words" role="img" aria-label={said[0].toUpperCase() + said.slice(1)}>
      {WORD_CLOCK_ROWS.flatMap((row, r) => [...row].map((ch, c) => {
        const i = r * WORD_CLOCK_COLS + c;
        return <span key={i} className={cells.has(i) ? 'saver-words-letter is-lit' : 'saver-words-letter'}>{ch}</span>;
      }))}
    </div>
  );
}

function CornerClock({ still }) {
  const now = useNow(1000, still);
  const parts = clockParts(now);
  return (
    <div className="saver-corner-clock">
      {parts.time}
      {parts.period && <small>{parts.period}</small>}
    </div>
  );
}

// ── Logo and Message ────────────────────────────────────────────────────────

const BOUNCE_COLORS = ['--aura-a', '--aura-b', '--aura-c', '--saver-fg'];

/**
 * Its child bouncing about the box the way a DVD player's logo did, taking
 * the next of the brand's colours each time it meets an edge. The position
 * is written straight to the element each frame; React hears only of the
 * hits.
 */
function Bouncer({ box, speed, still, children }) {
  const ref = useRef(null);
  const state = useRef(null);
  const [hits, setHits] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || !box.width || !box.height) return undefined;
    const { offsetWidth: w, offsetHeight: h } = node;
    const v = Math.max(40, Math.min(box.width, box.height) * 0.12) * speed;
    if (!state.current) {
      const a = rand(0.3, 1.2) * pick([1, -1]) + pick([0, Math.PI]);
      state.current = { x: rand(0, Math.max(0, box.width - w)), y: rand(0, Math.max(0, box.height - h)), vx: Math.cos(a) * v, vy: Math.sin(a) * v, w, h };
    } else {
      const s = state.current;
      state.current = { ...s, w, h, vx: Math.sign(s.vx || 1) * Math.abs(Math.cos(0.7)) * v, vy: Math.sign(s.vy || 1) * Math.abs(Math.sin(0.7)) * v };
    }
    const apply = () => { node.style.transform = `translate(${state.current.x}px, ${state.current.y}px)`; };
    apply();
    if (still) return undefined;
    let raf = 0;
    let last = 0;
    const frame = (now) => {
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      const s = bounce(state.current, dt, box);
      state.current = s;
      if (s.hit) setHits((n) => n + 1);
      apply();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [box, speed, still]);
  return (
    <div ref={ref} className="saver-bouncer" style={{ '--saver-bounce': `var(${BOUNCE_COLORS[hits % BOUNCE_COLORS.length]})` }}>
      {children}
    </div>
  );
}

function Wordmark({ box, speed, still, logo, brandName }) {
  const height = Math.max(14, Math.round(Math.min(box.width, box.height) * 0.09));
  return (
    <Bouncer box={box} speed={speed} still={still}>
      <BrandLogo logo={logo} name={brandName} withName height={height} markSize={Math.round(height * 1.3)} />
    </Bouncer>
  );
}

function Message({ box, speed, still, pref }) {
  const text = (pref?.message || '').trim() || DEFAULT_MESSAGE;
  return (
    <Bouncer box={box} speed={speed} still={still}>
      <div className="saver-message">{text}</div>
    </Bouncer>
  );
}
