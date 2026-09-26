'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import FilePreview from './FilePreview';
import Dialog from '@/app/components/ui/Dialog';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { Panel, Field } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { fmtSize } from '@/app/components/ui/FileCard';
import { deriveAuto } from '@/lib/dam';
import { effectiveKind } from '@/lib/media';
import { toRate, rateLabel, timecode, ASSUMED_RATE } from '@/lib/video-time';
import { anchorLabel, commentFrame, snippet } from '@/lib/review';
import ShareDialog from '@/app/components/ShareDialog';
import ReviewPanel from '@/app/components/review/ReviewPanel';
import ReviewStatusTag from '@/app/components/review/ReviewStatusTag';
import AnnotationLayer from '@/app/components/review/AnnotationLayer';
import PinLayer from '@/app/components/review/PinLayer';
import useReviewFeed from '@/app/components/review/useReviewFeed';
import useReviewDraft from '@/app/components/review/useReviewDraft';

/**
 * The file detail view: preview on the left, inspector on the right.
 *
 * Written container-agnostic — it takes a file and renders — so the same
 * component can serve the standalone /files/[id] page and, later, an
 * intercepted modal over the grid without being rewritten.
 *
 * `canWrite` comes from the server, which has already decided; the controls
 * are hidden rather than rendered into a 403. The server check is still the
 * one that counts.
 *
 * REVIEW. With `review` on (the flag as this person has it, decided on the
 * server, for a video or an image) the inspector becomes two tabs, Comments
 * and Details. This component is where the review panel and the picture
 * meet: selecting a comment seeks the player to its frame (or picks out its
 * pin) and shows its drawing; a marker or a pin selects its comment; the
 * draft being drawn is shared between the composer and the overlay; and C on
 * the player starts a comment on the frame on screen.
 */
export default function FileDetail({
  file: initial, canWrite = false, canShare = false, backHref = '/files', startAt = 0,
  review = false, me = null, focusComment = null,
}) {
  const [file, setFile] = useState(initial);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(initial.name || '');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const auto = deriveAuto(file);
  const kind = effectiveKind(file);
  const md = file.metadata || {};

  // The frame model, as the player uses it: the probed rate, or the assumed
  // one until the backfill below finds it.
  const known = toRate(md.fps);
  const fpsKey = known ? `${known.num}/${known.den}` : '';
  const model = useMemo(() => ({
    fps: toRate(fpsKey) || ASSUMED_RATE,
    tcStart: Number.isInteger(md.tcStart) ? md.tcStart : 0,
    dropFrame: md.dropFrame === true,
  }), [fpsKey, md.tcStart, md.dropFrame]);

  // A video from before uploads were probed has no frame rate; an editor's
  // visit reads it from the container once (POST …/probe) and the player
  // switches to exact frames when it arrives. A file it could not read is
  // marked, so it is not asked again.
  const probed = useRef(false);
  useEffect(() => {
    if (probed.current || !canWrite || kind !== 'video' || md.fps || md.fpsUnknown) return;
    probed.current = true;
    fetch(`/api/files/${encodeURIComponent(file.id)}/probe`, { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((out) => { if (out?.metadata) setFile((f) => ({ ...f, metadata: out.metadata })); })
      .catch(() => { /* the assumed rate stands */ });
  }, [canWrite, kind, md.fps, md.fpsUnknown, file.id]);

  // ── Review ──
  const [tab, setTab] = useState(review ? 'comments' : 'details');
  const feed = useReviewFeed(file.id, { enabled: review && tab === 'comments', me });
  const draftApi = useReviewDraft();
  const { draft } = draftApi;
  const player = useRef(null);
  const composer = useRef(null);
  const [frame, setFrame] = useState(0);
  const [range, setRange] = useState({ inFrame: null, outFrame: null });
  const [selectedId, setSelectedId] = useState(focusComment);
  const onError = useCallback((e) => toast.error(e?.message || 'Something went wrong.'), [toast]);

  const onFrameChange = useCallback((f) => setFrame(f), []);

  const selectComment = useCallback((c) => {
    setSelectedId(c.id);
    if (kind === 'video' && (c.anchor === 'frame' || c.anchor === 'range') && c.frameIn != null) {
      player.current?.seekToFrame(commentFrame(c.frameIn, c.fps, model.fps));
    }
  }, [kind, model.fps]);

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
  }, [draft.tool, kind]);

  // Escape puts the tool down wherever the focus is.
  useEffect(() => {
    if (!draft.tool && !draft.placing) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') draftApi.set({ tool: null, placing: false }); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [draft.tool, draft.placing, draftApi]);

  // C on the player: a comment on this frame.
  const onComment = useCallback(() => {
    setTab('comments');
    draftApi.set({ anchored: true });
    requestAnimationFrame(() => composer.current?.focus());
  }, [draftApi]);

  const tops = useMemo(() => [...feed.comments.values()].filter((c) => !c.parentId && !c.deletedAt), [feed.comments]);

  const markers = useMemo(() => {
    if (!review || kind !== 'video') return null;
    return tops
      .filter((c) => (c.anchor === 'frame' || c.anchor === 'range') && c.frameIn != null && !c.pending)
      .map((c) => ({
        id: c.id,
        frameIn: commentFrame(c.frameIn, c.fps, model.fps),
        frameOut: c.anchor === 'range' ? commentFrame(c.frameOut, c.fps, model.fps) : null,
        active: c.id === selectedId,
        label: `${anchorLabel(c, model)} — ${snippet(c.body, 60) || 'Drawing'}`,
      }));
  }, [review, kind, tops, model, selectedId]);

  const pins = useMemo(() => {
    if (!review || kind !== 'image') return [];
    return tops
      .filter((c) => c.anchor === 'point' && c.pointX != null)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((c, i) => ({ id: c.id, x: c.pointX, y: c.pointY, n: i + 1, resolved: !!c.resolvedAt, label: snippet(c.body, 60) }));
  }, [review, kind, tops]);

  const selected = selectedId ? feed.comments.get(selectedId) : null;
  const drawing = review && !!draft.tool;

  // What goes on the picture: the draft while one is being drawn, else the
  // selected comment's drawing — on a video, only while paused on its frame
  // (or inside its range), since it was drawn on that picture.
  const overlay = review ? ({ frame: f, playing }) => {
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
            onSelect={(id) => { setSelectedId(id); setTab('comments'); }}
          />
        )}
      </>
    );
  } : null;

  const status = feed.status !== undefined ? feed.status : file.reviewStatus;
  const openCount = feed.openComments !== undefined ? feed.openComments : (file.openComments || 0);
  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = tab === 'comments' ? 'details' : 'comments';
    setTab(next);
    e.currentTarget.parentElement.querySelector(`[data-tab="${next}"]`)?.focus();
  };

  const patch = useCallback(async (body, okMessage) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/files/${file.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(out.error || `Request failed (${r.status})`);
      // PATCH returns the row unsigned, so keep the presigned url we already
      // hold rather than replacing it with the stored one and breaking the
      // preview.
      setFile((f) => ({ ...f, ...out.file, url: f.url, thumbnailUrl: f.thumbnailUrl }));
      if (okMessage) toast.success(okMessage);
      router.refresh();
      return true;
    } catch (e) {
      toast.error(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [file.id, router, toast]);

  const rename = async () => {
    const next = name.trim();
    if (!next || next === file.name) { setRenaming(false); return; }
    if (await patch({ name: next }, 'Renamed.')) setRenaming(false);
  };

  const trash = async () => {
    const ok = await confirm({
      title: `Move “${file.name}” to trash?`,
      body: 'Trashed files are kept for 30 days before they are purged.',
      confirmLabel: 'Move to trash',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/files/${file.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not trash this file.');
      toast.success('Moved to trash.');
      router.push(backHref);
      router.refresh();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="shell file-detail" style={{ padding: 'var(--s5) var(--s5) 64px' }}>
      <div className="row" style={{ marginBottom: 'var(--s4)' }}>
        <a className="btn btn-ghost btn-sm" href={backHref}>← Back</a>
        <h1 className="truncate" style={{ fontSize: 'var(--t-xl)', minWidth: 0 }} title={file.name}>{file.name}</h1>
        {review && <ReviewStatusTag status={status} className="review-status-head" />}
        <div className="spacer" />
        {canShare && <button type="button" className="btn" onClick={() => setSharing(true)}>Share</button>}
        <a className="btn" href={`/api/files/${file.id}/download`}>Download</a>
        {canWrite && (
          <Menu label="File actions">
            <MenuItem onClick={() => { setName(file.name); setRenaming(true); }}>Rename…</MenuItem>
            <MenuSeparator />
            <MenuItem danger onClick={trash}>Move to trash</MenuItem>
          </Menu>
        )}
      </div>

      <div className="file-detail-body">
        <div style={{ minWidth: 0 }}>
          <FilePreview
            ref={player}
            file={file}
            startAt={startAt}
            overlay={overlay}
            markers={markers}
            onMarkerClick={(id) => { setSelectedId(id); setTab('comments'); }}
            onFrameChange={review ? onFrameChange : undefined}
            onRangeChange={review ? setRange : undefined}
            onComment={review ? onComment : undefined}
          />
        </div>

        <aside style={{ minWidth: 0 }}>
          {review && (
            <div className="review-tabs" role="tablist" aria-label="Inspector">
              <button
                type="button"
                role="tab"
                data-tab="comments"
                className="review-tab"
                aria-selected={tab === 'comments'}
                tabIndex={tab === 'comments' ? 0 : -1}
                onClick={() => setTab('comments')}
                onKeyDown={onTabKey}
              >
                Comments{openCount > 0 && <span className="review-count">{openCount}</span>}
              </button>
              <button
                type="button"
                role="tab"
                data-tab="details"
                className="review-tab"
                aria-selected={tab === 'details'}
                tabIndex={tab === 'details' ? 0 : -1}
                onClick={() => setTab('details')}
                onKeyDown={onTabKey}
              >
                Details
              </button>
            </div>
          )}

          {review && tab === 'comments' ? (
            <div role="tabpanel" aria-label="Comments">
              <ReviewPanel
                file={file}
                kind={kind}
                feed={feed}
                me={me}
                canModify={canWrite}
                model={model}
                knownRate={!!known}
                frame={frame}
                range={range}
                draftApi={draftApi}
                selectedId={selectedId}
                onSelect={selectComment}
                composerRef={composer}
                onComposerFocus={() => player.current?.pause()}
                srcSize={{ w: Number(md.width) || 0, h: Number(md.height) || 0 }}
                onError={onError}
              />
            </div>
          ) : (
          <Panel title="Details">
            <dl className="detail-list">
              <Row label="Kind">{auto.format || file.kind}</Row>
              <Row label="Size">{fmtSize(file.size) || '—'}</Row>
              {file.metadata?.width && file.metadata?.height && (
                <Row label="Dimensions">
                  {file.metadata.width} × {file.metadata.height}
                  {auto.aspect_ratio ? ` · ${auto.aspect_ratio}` : ''}
                </Row>
              )}
              {kind === 'video' && known && (
                <Row label="Frame rate">{rateLabel(known)} fps{model.dropFrame ? ' · drop-frame' : ''}</Row>
              )}
              {kind === 'video' && known && model.tcStart > 0 && (
                <Row label="Start"><span className="mono">{timecode(0, model)}</span></Row>
              )}
              <Row label="Folder">{file.folder || 'All files'}</Row>
              <Row label="Added">{file.createdAt ? new Date(file.createdAt).toLocaleString() : '—'}</Row>
              <Row label="Added by">{file.createdBy || '—'}</Row>
              {file.tags?.length > 0 && (
                <Row label="Tags">
                  <span className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                    {file.tags.map((t) => <span key={t} className="tag">{t}</span>)}
                  </span>
                </Row>
              )}
            </dl>
          </Panel>
          )}
        </aside>
      </div>

      <Dialog
        open={renaming}
        onClose={() => setRenaming(false)}
        title="Rename file"
        footer={(
          <>
            <button className="btn" onClick={() => setRenaming(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={rename} disabled={busy}>{busy ? 'Saving…' : 'Rename'}</button>
          </>
        )}
      >
        <Field label="Name">
          <input
            className="input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } }}
          />
        </Field>
      </Dialog>

      {canShare && <ShareDialog file={file} open={sharing} onClose={() => setSharing(false)} />}
      {confirmElement}
    </main>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt className="small muted">{label}</dt>
      <dd className="small" style={{ margin: 0, minWidth: 0, overflowWrap: 'anywhere' }}>{children}</dd>
    </>
  );
}
