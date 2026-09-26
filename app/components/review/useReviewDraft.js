'use client';

import { useCallback, useMemo, useState } from 'react';

const EMPTY = { tool: null, color: 0, shapes: [], frame: null, pin: null, placing: false, anchored: true };

/**
 * The comment being written, as far as the picture is concerned: the drawing
 * tool in hand, its colour, the shapes drawn so far, a pin, and whether the
 * comment is pinned to the moment (a frame or range) or general.
 *
 * Lifted out of the composer because the overlay on the player or image
 * draws it and takes the pointer while a tool is in hand — two components
 * that must agree on one draft.
 *
 * `frame` is the frame the first shape was drawn on: a drawing belongs to
 * the picture it was drawn over, so a comment that carries one is pinned
 * there even if the playhead has moved on since.
 */
export default function useReviewDraft() {
  const [draft, setDraft] = useState(EMPTY);

  const set = useCallback((patch) => setDraft((d) => ({ ...d, ...patch })), []);
  const addShape = useCallback((shape, frame = null) => setDraft((d) => ({
    ...d,
    shapes: [...d.shapes, shape],
    frame: d.frame ?? frame,
    anchored: true,
  })), []);
  const undo = useCallback(() => setDraft((d) => {
    const shapes = d.shapes.slice(0, -1);
    return { ...d, shapes, frame: shapes.length ? d.frame : null };
  }), []);
  const clearDrawing = useCallback(() => setDraft((d) => ({ ...d, shapes: [], frame: null })), []);
  const reset = useCallback(() => setDraft((d) => ({ ...EMPTY, color: d.color })), []);

  return useMemo(() => ({ draft, set, addShape, undo, clearDrawing, reset }), [draft, set, addShape, undo, clearDrawing, reset]);
}
