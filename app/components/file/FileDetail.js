'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import FilePreview from './FilePreview';
import FileDetailFrame from './FileDetailFrame';
import { getHandoff, returnFor } from '@/lib/file-handoff';
import { lazyThumbnailBackfill, mergeBackfilled } from '@/lib/backfill';
import { listingCache, returnSlot } from '@/lib/listing-cache';
import Dialog from '@/app/components/ui/Dialog';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { Panel, Field } from '@/app/components/ui/Layout';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { deriveAuto } from '@/lib/dam';
import { whenCreated } from '@/lib/file-dates';
import { effectiveKind, fmtSize, coverChangeable } from '@/lib/media';
import { redrawOffered } from '@/lib/preview-jobs';
import { probedNow } from '@/lib/decode-probe';
import { toRate, rateLabel, timecode, ASSUMED_RATE } from '@/lib/video-time';
import ShareDialog from '@/app/components/ShareDialog';
import CoverDialog from '@/app/components/video/CoverDialog';
import ReviewPanel from '@/app/components/review/ReviewPanel';
import ReviewStatusTag from '@/app/components/review/ReviewStatusTag';
import useReviewFeed from '@/app/components/review/useReviewFeed';
import useReviewStage from '@/app/components/review/useReviewStage';
import Icon from '@/app/components/ui/Icon';
import TranscriptPanel from '@/app/components/transcript/TranscriptPanel';
import useTranscript from '@/app/components/transcript/useTranscript';
import useProxy from '@/app/components/video/useProxy';
import { createMediaClock } from '@/app/components/transcript/mediaClock';
import useMacApp from '@/app/components/useMacApp';
import { toVTT } from '@/lib/transcripts';

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
 * and Details. The review panel and the picture meet in useReviewStage —
 * the share page's review link uses it too: selecting a comment seeks the
 * player to its frame (or picks out its pin) and shows its drawing; a marker
 * or a pin selects its comment; the draft being drawn is shared between the
 * composer and the overlay; and C on the player starts a comment on the
 * frame on screen. `canReviewLinks` (decided on the server) offers links
 * that take comments in the Share dialog.
 *
 * TRANSCRIPT. With `transcripts` on (the flag, decided on the server, for a
 * video or an audio file) there is a Transcript tab. The transcript is
 * loaded with the page and kept here, not in the tab, so switching tabs
 * loses nothing and captions stay on: the player reports its time to a
 * small clock the panel subscribes to, a line picked in the panel seeks the
 * player, and Captions turns the segments into a subtitles track on it.
 *
 * PROXY. With `proxies` on (the flag, decided on the server, for a video) the
 * job is watched here, beside the transcript's, and handed to the player: it
 * prefers the rendition over the master, shows how a transcode is getting on,
 * and offers to have one made. No tab of its own — a proxy is not something to
 * read, it is how the file plays.
 */
export default function FileDetail({
  file: initial, canWrite = false, canShare = false, canReviewLinks = false, backHref = '/files', startAt = 0,
  review = false, me = null, focusComment = null, previewPossible = true,
  transcripts = false, proxies = false, brandName = '',
}) {
  const [file, setFile] = useState(initial);
  const [sharing, setSharing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Change cover…: the player's position when it was chosen, or null.
  const [covering, setCovering] = useState(null);
  const [name, setName] = useState(initial.name || '');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const auto = deriveAuto(file);
  const kind = effectiveKind(file);
  const md = file.metadata || {};

  // What the files view handed over when it opened this file: the picture
  // its tile was showing, so the stage starts from it (lib/file-handoff.js).
  // Only ever set in this browser, so a server render has none.
  const [handoff] = useState(() => getHandoff(initial.id));

  // An image with no large preview is shown from its original; a writer's
  // browser makes the preview from that same download (fromBlob), so the next
  // viewer gets it — no second download of the original. The drawing code is
  // loaded only then (lib/backfill.js): most files have a preview.
  const backfill = useMemo(() => (canWrite
    ? lazyThumbnailBackfill((f) => setFile((x) => mergeBackfilled(x, f)))
    : null), [canWrite]);
  const onOriginalBlob = useCallback((blob) => { backfill?.(file, { blob }); }, [backfill, file]);

  // ← Back: through history when this page was opened from the files view,
  // so the listing comes back as it was left (its rows, scroll and
  // selection); from anywhere else, the folder the file is in. A modified
  // click still opens the link as a link.
  const goBack = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    if (returnFor(file.id) && window.history.length > 1) window.history.back();
    else router.push(backHref);
  };

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

  // A sound with no waveform gets one from an editor's visit, as its tile
  // would (lib/waveform-client.js): the player shows it the moment it is
  // recorded, without stopping.
  useEffect(() => {
    if (kind === 'audio' && !md.waveform) backfill?.(file, { wave: true });
    // Asked once per file; `file` changes as the backfill merges into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backfill, kind, file.id]);

  // ── Review ──
  const tabs = useMemo(() => [review && 'comments', transcripts && 'transcript', 'details'].filter(Boolean), [review, transcripts]);
  const [tab, setTab] = useState(tabs[0]);
  const feed = useReviewFeed(file.id, { enabled: review && tab === 'comments', me });
  const player = useRef(null);
  // The comments and the picture, wired together: selection, seeking,
  // markers, pins, drawings and the C key (useReviewStage) — the same wiring
  // the share page gives a review link's guests. Whatever asks for the
  // comments (a marker, a pin, C) brings the Comments tab forward.
  const {
    draftApi, composer, frame, range, setRange, onFrameChange,
    selectedId, selectComment, pick, holdFrame, onComposerFocus, onComment, markers, overlay,
  } = useReviewStage({ enabled: review, kind, feed, model, player, focusComment, onReveal: () => setTab('comments') });
  const onError = useCallback((e) => toast.error(e?.message || 'Something went wrong.'), [toast]);

  // ── Transcript ──
  const transcript = useTranscript(file.id, { enabled: transcripts });
  // ── Proxy ── watched for as long as the page is open, since a transcode
  // finishing is what lets the player switch sources.
  const proxy = useProxy(file.id, { enabled: proxies });
  const clock = useMemo(createMediaClock, []);
  const mac = useMacApp();
  const seekTo = useCallback((seconds) => player.current?.seekTo?.(seconds), []);
  const [captionsOn, setCaptionsOn] = useState(false);
  const [captionsUrl, setCaptionsUrl] = useState(null);
  const lines = transcript.transcript?.segments;
  useEffect(() => {
    if (!captionsOn || kind !== 'video' || !lines?.length) { setCaptionsUrl(null); return undefined; }
    const url = URL.createObjectURL(new Blob([toVTT(lines)], { type: 'text/vtt' }));
    setCaptionsUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [captionsOn, kind, lines]);
  const captionLang = transcript.transcript?.resultLanguage || transcript.transcript?.language || null;
  const captions = useMemo(
    () => (captionsUrl ? { src: captionsUrl, lang: captionLang ? captionLang.split('-')[0] : undefined, label: 'Transcript' } : null),
    [captionsUrl, captionLang],
  );

  const status = feed.status !== undefined ? feed.status : file.reviewStatus;
  const openCount = feed.openComments !== undefined ? feed.openComments : (file.openComments || 0);
  const onTabKey = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const at = tabs.indexOf(tab);
    const next = tabs[(at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    setTab(next);
    e.currentTarget.parentElement.querySelector(`[data-tab="${next}"]`)?.focus();
  };
  const TAB_LABELS = { comments: 'Comments', transcript: 'Transcript', details: 'Details' };

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

  // Regenerate thumbnail: every preview drawn again from the original, in
  // this browser (lib/thumbnail-regen.js, loaded when first used). A video's
  // is its automatic frame; choosing one is Change cover's.
  const [redrawing, setRedrawing] = useState(false);
  const regenerate = async () => {
    if (redrawing) return;
    setRedrawing(true);
    const note = toast.push('Redrawing the thumbnail…', { duration: 0 });
    try {
      const { redrawThumbnail, mergeRedrawn } = await import('@/lib/thumbnail-regen');
      const row = await redrawThumbnail(file);
      setFile((x) => mergeRedrawn(x, row));
      // The old pictures are deleted: ← Back must not bring their URLs back.
      returnSlot.updateFile(row.id, (x) => mergeRedrawn(x, row));
      listingCache.clear();
      toast.success('Thumbnail redrawn.');
    } catch (e) {
      toast.error(e?.message || 'Could not redraw the thumbnail.');
    } finally {
      toast.dismiss(note);
      setRedrawing(false);
    }
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
    <FileDetailFrame
      header={(
        <>
        <a className="btn btn-ghost btn-sm" href={backHref} onClick={goBack}><Icon name="arrow-left" size={14} />Back</a>
        <h1 className="truncate" style={{ fontSize: 'var(--t-xl)', minWidth: 0 }} title={file.name}>{file.name}</h1>
        {review && <ReviewStatusTag status={status} className="review-status-head" />}
        <div className="spacer" />
        {canShare && <button type="button" className="btn" onClick={() => setSharing(true)}>Share</button>}
        <a className="btn" href={`/api/files/${file.id}/download`}>Download</a>
        {canWrite && (
          <Menu label="File actions">
            <MenuItem onClick={() => { setName(file.name); setRenaming(true); }}>Rename…</MenuItem>
            {coverChangeable(file) && (
              <MenuItem onClick={() => { player.current?.pause?.(); setCovering({ at: player.current?.time?.() ?? null }); }}>Change cover…</MenuItem>
            )}
            {redrawOffered(file, { decodes: probedNow() }) && (
              <MenuItem onClick={regenerate} disabled={redrawing}>Regenerate thumbnail</MenuItem>
            )}
            <MenuSeparator />
            <MenuItem danger onClick={trash}>Move to trash</MenuItem>
          </Menu>
        )}
        </>
      )}
      stage={(
          <FilePreview
            ref={player}
            file={file}
            startAt={startAt}
            overlay={overlay}
            markers={markers}
            onMarkerClick={pick}
            onFrameChange={review ? onFrameChange : undefined}
            onRangeChange={review ? setRange : undefined}
            onComment={review ? onComment : undefined}
            handoff={handoff}
            onOriginalBlob={backfill && previewPossible ? onOriginalBlob : undefined}
            onTime={transcripts ? clock.set : undefined}
            captions={captions}
            proxy={proxies ? proxy : null}
          />
      )}
      aside={(
        <>
          {tabs.length > 1 && (
            <div className="review-tabs" role="tablist" aria-label="Inspector">
              {tabs.map((key) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  data-tab={key}
                  className="review-tab"
                  aria-selected={tab === key}
                  tabIndex={tab === key ? 0 : -1}
                  onClick={() => setTab(key)}
                  onKeyDown={onTabKey}
                >
                  {TAB_LABELS[key]}
                  {key === 'comments' && openCount > 0 && <span className="review-count">{openCount}</span>}
                </button>
              ))}
            </div>
          )}

          {transcripts && tab === 'transcript' ? (
            <div role="tabpanel" aria-label="Transcript">
              <TranscriptPanel
                file={file}
                kind={kind}
                brandName={brandName}
                data={transcript}
                mac={mac}
                clock={clock}
                onSeek={seekTo}
                captions={captionsOn}
                onCaptions={kind === 'video' ? setCaptionsOn : undefined}
              />
            </div>
          ) : review && tab === 'comments' ? (
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
                onComposerFocus={onComposerFocus}
                onAnchor={holdFrame}
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
              <Row label="Created">{whenCreated(file) ? new Date(whenCreated(file)).toLocaleString() : '—'}</Row>
              <Row label="Created by">{file.createdBy || '—'}</Row>
              {/* When it came, where Created is the file's own date and so says otherwise. */}
              {file.fileCreatedAt && file.createdAt ? <Row label="Added">{new Date(file.createdAt).toLocaleString()}</Row> : null}
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
        </>
      )}
    >
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

      {canShare && <ShareDialog file={file} open={sharing} onClose={() => setSharing(false)} canReview={canReviewLinks} />}
      {covering && (
        <CoverDialog
          file={file}
          startAt={covering.at}
          onClose={() => setCovering(null)}
          onChanged={(row) => {
            setFile((x) => mergeBackfilled(x, row));
            // The old picture is deleted: ← Back must not bring its URL back.
            returnSlot.updateFile(row.id, (x) => mergeBackfilled(x, row));
            listingCache.clear();
            setCovering(null);
            toast.success('Cover changed.');
          }}
        />
      )}
      {confirmElement}
    </FileDetailFrame>
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
