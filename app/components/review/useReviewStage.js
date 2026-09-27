'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AnnotationLayer from './AnnotationLayer';
import PinLayer from './PinLayer';
import useReviewDraft from './useReviewDraft';
import { anchorLabel, commentFrame, snippet } from '@/lib/review';

/**
 * Where the review panel and the picture meet — the file page's and the
 * share page's alike, so a guest on a review link gets exactly the tools a
 * member does:
 *
 *   selecting a comment seeks the player to its frame (or picks out its
 *   pin) and shows its drawing; a marker or a pin selects its comment; the
 *   draft being drawn is shared between the composer and the overlay; C on
 *   the player starts a comment on the frame on screen; picking up a tool
 *   pauses the player on the frame it is showing; Escape puts the tool down.
 *
 * `player` is the page's ref to the preview (FilePreview), which it may use
 * for more than review. `onReveal` is called when something asks for the
 * comments to be in view — a marker, a pin, C — for a page that keeps them
 * behind a tab. `enabled` false (review off, or a file it does not handle)
 * puts nothing on the picture.
 *
 * Returns what FilePreview (overlay, markers, the frame and range handlers)
 * and ReviewPanel (the draft, selection, the composer's ref and focus) need.
 */
export default function useReviewStage({ enabled = true, kind, feed, model, player, focusComment = null, onReveal }) {
  const draftApi = useReviewDraft();
  const { draft } = draftApi;
  const composer = useRef(null);
  const [frame, setFrame] = useState(0);
  const [range, setRange] = useState({ inFrame: null, outFrame: null });
  const [selectedId, setSelectedId] = useState(focusComment);
  const reveal = useRef(onReveal);
  reveal.current = onReveal;

  const onFrameChange = useCallback((f) => setFrame(f), []);

  const selectComment = useCallback((c) => {
    setSelectedId(c.id);
    if (kind === 'video' && (c.anchor === 'frame' || c.anchor === 'range') && c.frameIn != null) {
      player.current?.seekToFrame(commentFrame(c.frameIn, c.fps, model.fps));
    }
  }, [kind, model.fps, player]);

  // A marker or a pin: its comment, in view.
  const pick = useCallback((id) => {
    setSelectedId(id);
    reveal.current?.();
  }, []);

  // ?c= — a notification's link — opens on that comment once it has loaded.
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || !focusComment || !feed.loaded) return;
    focused.current = true;
    const c = feed.comments.get(focusComment);
    if (c) selectComment(c.parentId ? feed.comments.get(c.parentId) || c : c);
  }, [focusComment, feed.loaded, feed.comments, selectComment]);

  // Drawing on a video is drawing on a frame: picking up a tool pauses the
  // player on the frame it is showing (and loads it, if it has not yet).
  useEffect(() => {
    if (kind === 'video' && draft.tool) player.current?.seekToFrame(player.current.frame());
  }, [draft.tool, kind, player]);

  // Escape puts the tool down wherever the focus is.
  useEffect(() => {
    if (!draft.tool && !draft.placing) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') draftApi.set({ tool: null, placing: false }); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [draft.tool, draft.placing, draftApi]);

  // A comment about to be pinned to "this frame" needs this frame on the
  // stage: before the first seek or play it shows the poster, a frame from
  // mid-clip, while the label (and so the comment) reads another. hold()
  // pauses there and, if need be, loads the frame. The player's C key does
  // the same; a general comment only pauses.
  const holdFrame = useCallback(() => player.current?.hold?.(), [player]);
  const onComposerFocus = useCallback(() => {
    if (draft.anchored) holdFrame();
    else player.current?.pause();
  }, [draft.anchored, holdFrame, player]);

  // C on the player: a comment on this frame.
  const onComment = useCallback(() => {
    reveal.current?.();
    draftApi.set({ anchored: true });
    requestAnimationFrame(() => composer.current?.focus());
  }, [draftApi]);

  const tops = useMemo(() => [...feed.comments.values()].filter((c) => !c.parentId && !c.deletedAt), [feed.comments]);

  const markers = useMemo(() => {
    if (!enabled || kind !== 'video') return null;
    return tops
      .filter((c) => (c.anchor === 'frame' || c.anchor === 'range') && c.frameIn != null && !c.pending)
      .map((c) => ({
        id: c.id,
        frameIn: commentFrame(c.frameIn, c.fps, model.fps),
        frameOut: c.anchor === 'range' ? commentFrame(c.frameOut, c.fps, model.fps) : null,
        active: c.id === selectedId,
        label: `${anchorLabel(c, model)} — ${snippet(c.body, 60) || 'Drawing'}`,
      }));
  }, [enabled, kind, tops, model, selectedId]);

  const pins = useMemo(() => {
    if (!enabled || kind !== 'image') return [];
    return tops
      .filter((c) => c.anchor === 'point' && c.pointX != null)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((c, i) => ({ id: c.id, x: c.pointX, y: c.pointY, n: i + 1, resolved: !!c.resolvedAt, label: snippet(c.body, 60) }));
  }, [enabled, kind, tops]);

  const selected = selectedId ? feed.comments.get(selectedId) : null;
  const drawing = enabled && !!draft.tool;

  // What goes on the picture: the draft while one is being drawn, else the
  // selected comment's drawing — on a video, only while paused on its frame
  // (or inside its range), since it was drawn on that picture.
  const overlay = enabled ? ({ frame: f, playing }) => {
    let shapes = [];
    if (draft.shapes.length || drawing) {
      if (kind !== 'video' || draft.frame == null || f === draft.frame) shapes = draft.shapes;
    } else if (selected?.annotation && !selected.deletedAt) {
      if (kind === 'video') {
        const a = commentFrame(selected.frameIn, selected.fps, model.fps);
        const b = selected.anchor === 'range' ? commentFrame(selected.frameOut, selected.fps, model.fps) : a;
        if (!playing && f >= a && f <= b) shapes = selected.annotation.shapes || [];
      } else {
        shapes = selected.annotation.shapes || [];
      }
    }
    return (
      <>
        <AnnotationLayer
          shapes={shapes}
          mode={drawing ? 'draw' : 'display'}
          tool={draft.tool}
          color={draft.color}
          onShape={(shape) => draftApi.addShape(shape, kind === 'video' ? (player.current?.frame() ?? f) : null)}
        />
        {kind === 'image' && (
          <PinLayer
            pins={pins}
            draft={draft.pin}
            selectedId={selectedId}
            placing={draft.placing}
            onPlace={(p) => draftApi.set({ pin: p, placing: false })}
            onSelect={pick}
          />
        )}
      </>
    );
  } : null;

  return {
    draftApi, composer, frame, range, setRange, onFrameChange,
    selectedId, selectComment, pick, holdFrame, onComposerFocus, onComment,
    markers, overlay,
  };
}
