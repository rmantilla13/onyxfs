'use client';

import { useState } from 'react';
import MentionTextarea, { mentionsIn } from './MentionTextarea';
import { timecode } from '@/lib/video-time';
import { ANNOTATION_COLORS, ANNOTATION_TOOLS } from '@/lib/review';

const TOOL_LABEL = { pen: 'Pen', arrow: 'Arrow', rect: 'Rectangle' };
const TOOL_ICON = { pen: '✎', arrow: '↗', rect: '▭' };

/**
 * Writing a comment: the words (with @mentions), what it is pinned to, who
 * sees it, and anything drawn on the picture.
 *
 * The anchor chip says what the comment will be pinned to — "01:00:12:04",
 * "In 01:00:12:04 → Out 01:00:15:10" when the player has a range, "Pin" on an
 * image, or "General"; clicking it switches a video comment between the
 * moment and the whole file (and `onAnchor` is told when it turns to the
 * moment, so the page can put that frame on the stage). A drawing always pins
 * to the frame it was drawn on. Internal comments are for signed-in people
 * only: guests on a review link never see them.
 *
 * Posting clears the composer at once — the comment appears optimistically —
 * and a failure puts everything back, with the reason.
 */
export default function Composer({
  fileId, kind, model, knownRate, frame, range, draftApi, onPost, onFocus, onAnchor, textareaRef, srcSize = { w: 0, h: 0 },
}) {
  const { draft, set, undo, clearDrawing, reset } = draftApi;
  const [body, setBody] = useState('');
  const [people, setPeople] = useState([]);
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const video = kind === 'video';
  const tc = (f) => timecode(f, model);
  const hasRange = video && range?.inFrame != null && range?.outFrame != null;
  const anchorFrame = draft.frame ?? frame ?? 0;
  const useRange = hasRange && draft.frame == null;
  const drawn = draft.shapes.length > 0;

  let chip = 'General';
  if (video && draft.anchored) chip = useRange ? `In ${tc(range.inFrame)} → Out ${tc(range.outFrame)}` : tc(anchorFrame);
  if (!video && draft.pin) chip = 'Pin';

  const submit = async () => {
    if (busy) return;
    const text = body.trim();
    if (!text && !drawn) { setError('Write a comment or draw on the picture.'); return; }
    const input = { body: text, audience: internal ? 'internal' : 'all', mentions: mentionsIn(text, people), anchor: 'general' };
    if (video && (draft.anchored || drawn)) {
      Object.assign(input, useRange
        ? { anchor: 'range', frameIn: range.inFrame, frameOut: range.outFrame, fps: model.fps }
        : { anchor: 'frame', frameIn: anchorFrame, fps: model.fps });
    } else if (!video && draft.pin) {
      Object.assign(input, { anchor: 'point', pointX: draft.pin[0], pointY: draft.pin[1] });
    }
    if (drawn) input.annotation = { v: 1, srcW: Math.max(1, Math.round(srcSize.w || 1)), srcH: Math.max(1, Math.round(srcSize.h || 1)), shapes: draft.shapes };

    const saved = { body, people, draft };
    setBusy(true);
    setError(null);
    setBody('');
    setPeople([]);
    reset();
    try {
      await onPost(input);
    } catch (e) {
      setBody(saved.body);
      setPeople(saved.people);
      set(saved.draft);
      setError(e.message || 'Could not post that comment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="review-composer">
      <MentionTextarea
        fileId={fileId}
        value={body}
        onChange={(v) => { setBody(v); if (error) setError(null); }}
        people={people}
        onPeopleChange={setPeople}
        onSubmit={submit}
        onFocus={onFocus}
        onEscape={(e) => { set({ tool: null, placing: false }); e.currentTarget.blur(); }}
        textareaRef={textareaRef}
        placeholder={video ? 'Comment on this frame…' : 'Add a comment…'}
      />

      <div className="review-composer-row">
        <button
          type="button"
          className={`review-chip${chip === 'General' ? ' is-general' : ''}`}
          onClick={() => {
            if (video) {
              set({ anchored: !draft.anchored });
              if (!draft.anchored) onAnchor?.();
            }
            else if (draft.pin) set({ pin: null });
            else set({ placing: true, tool: null });
          }}
          disabled={video && drawn}
          title={video
            ? (drawn ? 'A drawing stays on the frame it was drawn on' : draft.anchored ? 'Make this a comment on the whole file' : 'Pin this comment to the current frame')
            : (draft.pin ? 'Remove the pin' : 'Click the picture to place a pin')}
        >
          <span className="mono">{chip}</span>
          {((video && draft.anchored && !drawn) || (!video && draft.pin)) && <span aria-hidden="true"> ×</span>}
        </button>

        <label className="review-internal small" title="Only people signed in to this workspace see it — never guests on a review link.">
          <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
          Internal
        </label>

        <div className="spacer" />
        <button type="button" className="btn btn-primary btn-sm" onClick={submit} disabled={busy}>
          {busy ? 'Posting…' : 'Post'}
        </button>
      </div>

      <div className="review-tools" role="toolbar" aria-label="Draw on the picture">
        {ANNOTATION_TOOLS.map((t) => (
          <button
            key={t}
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={draft.tool === t}
            title={TOOL_LABEL[t]}
            onClick={() => set({ tool: draft.tool === t ? null : t, placing: false })}
          >
            <span aria-hidden="true">{TOOL_ICON[t]}</span>
            <span className="sr-only">{TOOL_LABEL[t]}</span>
          </button>
        ))}
        {!video && (
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-pressed={draft.placing}
            onClick={() => set({ placing: !draft.placing, tool: null })}
          >
            Pin
          </button>
        )}
        <span className="review-swatches" role="group" aria-label="Colour">
          {Array.from({ length: ANNOTATION_COLORS }, (_, c) => (
            <button
              key={c}
              type="button"
              className={`review-swatch review-fill-c${c}`}
              aria-pressed={draft.color === c}
              aria-label={`Colour ${c + 1}`}
              onClick={() => set({ color: c })}
            />
          ))}
        </span>
        {drawn && (
          <>
            <button type="button" className="btn btn-sm btn-ghost" onClick={undo}>Undo</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearDrawing}>Clear</button>
          </>
        )}
      </div>

      {video && !knownRate && <p className="small muted review-note">Frame rate unknown — timecodes are approximate.</p>}
      {error && <p className="small review-error" role="alert">{error}</p>}
    </div>
  );
}
