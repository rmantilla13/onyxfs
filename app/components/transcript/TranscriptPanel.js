'use client';

import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { useConfirm } from '@/app/components/ui/Confirm';
import { useToast } from '@/app/components/ui/Toast';
import {
  TRANSCRIPT_LANGUAGES, toSRT, toVTT, toText, exportName, clockLabel, segmentAt, foldText, findMatches,
} from '@/lib/transcripts';
import './transcript.css';

/**
 * The Transcript tab of a video or audio file's page.
 *
 * Transcripts are made on a Mac running the desktop app — the server keeps
 * the job and the result, and the media never goes anywhere else
 * (lib/transcripts.js). So this panel mostly waits well: it asks for one,
 * says which Mac has it and how far along, and says why when it failed.
 *
 * Once there are segments: the one under the playhead is lit and kept in
 * view — until the reader scrolls the list themselves, when it stops
 * following and offers to again. A click (or Enter) seeks the player there.
 * Search folds case and accents, marks every match and steps through them.
 * The exports and Copy text are made here, from the segments, with no
 * round trip. Captions (a video only) are the page's: it builds a
 * <track> from the same segments (FileDetail).
 *
 * `data` is useTranscript's, `clock` the player's time (mediaClock.js),
 * `mac` useMacApp's. Buttons are words, not icons, until the icon set lands.
 */
export default function TranscriptPanel({
  file, kind, brandName, data, mac, clock, onSeek, captions = false, onCaptions,
}) {
  const t = data.transcript;
  const segments = t?.segments || [];
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const act = useCallback(async (fn, okMessage) => {
    try {
      await fn();
      if (okMessage) toast.success(okMessage);
    } catch (e) {
      toast.error(e?.message || 'Something went wrong.');
    }
  }, [toast]);

  const request = (language) => act(() => data.request(language));
  const again = () => request(t?.language || null);
  const remove = async () => {
    const ok = await confirm({
      title: 'Delete this transcript?',
      body: 'Its text and captions go for everyone who can see this file. You can transcribe it again.',
      confirmLabel: 'Delete transcript',
      destructive: true,
    });
    if (ok) act(() => data.remove(), 'Transcript deleted.');
  };

  const noun = kind === 'audio' ? 'recording' : 'video';
  const macName = `${brandName} for Mac`;

  let status = null;
  if (!data.loaded) {
    status = <p className="small muted tx-quiet">Loading the transcript…</p>;
  } else if (!t) {
    status = data.canRequest ? (
      <RequestForm noun={noun} brandName={brandName} busy={data.busy} onRequest={request} />
    ) : (
      <p className="small muted tx-quiet">No transcript yet.</p>
    );
  } else if (t.status === 'queued') {
    let hint = `A Mac signed in to ${brandName}, with transcription on, picks it up — usually within a couple of minutes.`;
    if (mac?.inApp) {
      hint = mac.transcriber?.enabled === false
        ? 'Transcription is turned off in this Mac’s settings, so another Mac will have to pick it up.'
        : 'This Mac will pick it up in a moment.';
    }
    status = (
      <div className="tx-card" role="status">
        <p className="tx-title">Waiting for {macName}…</p>
        <p className="small muted">{hint}</p>
        {data.canDelete && !segments.length && (
          <div><button type="button" className="btn btn-sm" disabled={data.busy} onClick={() => act(() => data.remove())}>Cancel</button></div>
        )}
      </div>
    );
  } else if (t.status === 'working') {
    const pct = Math.round(Math.min(1, Math.max(0, t.progress || 0)) * 100);
    status = (
      <div className="tx-card" role="status">
        <p className="tx-title">Transcribing on {t.claimedDevice || 'a Mac'}… <span className="tx-pct">{pct}%</span></p>
        <div className="tx-progress" role="progressbar" aria-label="Transcription progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
        {mac?.transcriber?.busy === file.id && <p className="small muted">This Mac is transcribing it.</p>}
      </div>
    );
  } else if (t.status === 'failed') {
    status = (
      <div className="tx-card is-failed" role="alert">
        <p className="tx-title">Transcription failed</p>
        {t.error && <p className="small tx-error-text">{t.error}</p>}
        {data.canRequest && (
          <div><button type="button" className="btn btn-sm" disabled={data.busy} onClick={again}>{data.busy ? 'Asking…' : 'Retry'}</button></div>
        )}
      </div>
    );
  }

  return (
    <div className="tx-panel">
      {data.error && <p className="small tx-error-text" role="alert">{data.error}</p>}
      {status}
      {segments.length > 0 && (
        <>
          {t.status !== 'done' && (
            <p className="small muted tx-quiet">
              {t.status === 'failed' ? 'Showing the earlier transcript.' : 'Showing the earlier transcript until the new one is ready.'}
            </p>
          )}
          {t.status === 'done' && t.stale && (
            <div className="tx-note small">
              <span>From an earlier version of this file.</span>
              {data.canRequest && <button type="button" className="btn btn-sm" disabled={data.busy} onClick={again}>Re-transcribe</button>}
            </div>
          )}
          <TranscriptView
            file={file}
            kind={kind}
            transcript={t}
            segments={segments}
            clock={clock}
            onSeek={onSeek}
            captions={captions}
            onCaptions={onCaptions}
            canRequest={data.canRequest && t.status === 'done'}
            canDelete={data.canDelete}
            onAgain={again}
            onDelete={remove}
          />
        </>
      )}
      {t?.status === 'done' && !segments.length && (
        <p className="small muted tx-quiet">No speech was found in this {noun}.</p>
      )}
      {t?.status === 'done' && !segments.length && data.canDelete && (
        <div><button type="button" className="btn btn-sm btn-ghost" onClick={remove}>Delete transcript</button></div>
      )}
      {confirmElement}
    </div>
  );
}

function RequestForm({ noun, brandName, busy, onRequest }) {
  const [language, setLanguage] = useState('');
  return (
    <div className="tx-card">
      <p className="small">Transcribed on a Mac running {brandName} — the {noun} never leaves your computers.</p>
      <div className="tx-request">
        <label className="tx-lang">
          <span className="small muted">Language</span>
          <select className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="">The Mac’s language</option>
            {TRANSCRIPT_LANGUAGES.map((l) => <option key={l.tag} value={l.tag}>{l.label}</option>)}
          </select>
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => onRequest(language || null)}>
          {busy ? 'Asking…' : 'Transcribe'}
        </button>
      </div>
    </div>
  );
}

function languageName(tag) {
  if (!tag) return null;
  const listed = TRANSCRIPT_LANGUAGES.find((l) => l.tag === tag);
  if (listed) return listed.label;
  try { return new Intl.DisplayNames(undefined, { type: 'language' }).of(tag) || tag; } catch { return tag; }
}

function download(name, body, type) {
  const url = URL.createObjectURL(new Blob([body], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const NAV_KEYS = { ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8 };

/** The segments: the toolbar, search, and the list that follows the playhead. */
function TranscriptView({
  file, kind, transcript, segments, clock, onSeek, captions, onCaptions, canRequest, canDelete, onAgain, onDelete,
}) {
  const toast = useToast();
  const list = useRef(null);
  const long = segments[segments.length - 1].e >= 3600;

  // The segment under the playhead — a number, so a time update re-renders
  // this only when the lit segment changes.
  const getActive = useCallback(() => segmentAt(segments, clock.get()), [segments, clock]);
  const active = useSyncExternalStore(clock.subscribe, getActive, () => -1);

  // ── Search ──
  const [query, setQuery] = useState('');
  const q = useDeferredValue(query.trim());
  const searching = q.length > 0;
  const folded = useMemo(() => segments.map((s) => foldText(s.t)), [segments]);
  const matches = useMemo(() => findMatches(segments, q, folded), [segments, q, folded]);
  const rangesByRow = useMemo(() => {
    const m = new Map();
    for (const x of matches) {
      if (!m.has(x.index)) m.set(x.index, []);
      m.get(x.index).push(x.range);
    }
    return m;
  }, [matches]);
  const [cursor, setCursor] = useState(0);
  useEffect(() => { setCursor(0); }, [matches]);
  const current = matches[cursor] || null;
  const step = (d) => setCursor((c) => (matches.length ? (c + d + matches.length) % matches.length : 0));

  // ── Following the playhead ──
  // Only the list scrolls, never the page (so the player stays where it is),
  // and only when the row is out of comfortable view. A scroll that is not
  // ours is the reader's: from then on the list is theirs until they ask
  // for it to follow again, or pick a line.
  const [follow, setFollow] = useState(true);
  const ours = useRef(null);
  const scrollToRow = useCallback((i) => {
    const box = list.current;
    const row = i >= 0 ? box?.querySelector(`[data-seg="${i}"]`) : null;
    if (!row) return;
    const view = box.scrollTop;
    const height = box.clientHeight;
    const pad = Math.min(40, height / 5);
    if (row.offsetTop >= view + pad && row.offsetTop + row.offsetHeight <= view + height - pad) return;
    const to = Math.max(0, Math.min(box.scrollHeight - height, Math.round(row.offsetTop - height * 0.3)));
    if (Math.abs(to - view) < 1) return;
    ours.current = to;
    box.scrollTop = to;
  }, []);
  const onScroll = () => {
    const box = list.current;
    if (!box) return;
    if (ours.current != null && Math.abs(box.scrollTop - ours.current) <= 2) return;
    ours.current = null;
    if (!searching) setFollow(false);
  };
  useEffect(() => {
    if (follow && !searching && active >= 0) scrollToRow(active);
  }, [active, follow, searching, scrollToRow]);
  useEffect(() => {
    if (current) scrollToRow(current.index);
  }, [current, scrollToRow]);

  // ── Picking a line, by click or keyboard ──
  // One row in the tab order (the lit one, or the last one moved to); the
  // arrows move between rows, Enter or Space seeks.
  const [focusIdx, setFocusIdx] = useState(null);
  const tabbable = focusIdx ?? Math.max(0, active);
  const pick = useCallback((i) => {
    setFocusIdx(i);
    setFollow(true);
    onSeek?.(segments[i].s);
  }, [onSeek, segments]);
  const onListKey = (e) => {
    const row = e.target.closest?.('[data-seg]');
    if (!row) return;
    const from = Number(row.dataset.seg);
    let next = null;
    if (e.key in NAV_KEYS) next = from + NAV_KEYS[e.key];
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = segments.length - 1;
    if (next == null) return;
    e.preventDefault();
    next = Math.max(0, Math.min(segments.length - 1, next));
    setFocusIdx(next);
    setFollow(false);
    list.current?.querySelector(`[data-seg="${next}"]`)?.focus({ preventScroll: true });
    scrollToRow(next);
  };

  const onSearchKey = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape' && query) { e.preventDefault(); e.stopPropagation(); setQuery(''); }
  };

  const exportAs = (ext) => {
    if (ext === 'srt') download(exportName(file.name, 'srt'), toSRT(segments), 'application/x-subrip');
    else if (ext === 'vtt') download(exportName(file.name, 'vtt'), toVTT(segments), 'text/vtt');
    else download(exportName(file.name, 'txt'), toText(segments), 'text/plain');
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(toText(segments));
      toast.success('Transcript copied.');
    } catch {
      toast.error('Could not copy — your browser did not allow it.');
    }
  };

  const meta = [languageName(transcript.resultLanguage || transcript.language), `${segments.length.toLocaleString()} line${segments.length === 1 ? '' : 's'}`]
    .filter(Boolean).join(' · ');

  return (
    <div className="tx-view">
      <div className="tx-toolbar">
        {kind === 'video' && onCaptions && (
          // The ghost toggle, as the review filters are: its pressed state
          // stays legible under the pointer.
          <button type="button" className="btn btn-sm btn-ghost" aria-pressed={captions} onClick={() => onCaptions(!captions)}>Captions</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" onClick={copy}>Copy text</button>
        <div className="spacer" />
        <Menu label="Export and transcript actions" trigger="Export">
          <MenuItem onClick={() => exportAs('srt')}>Subtitles (.srt)</MenuItem>
          <MenuItem onClick={() => exportAs('vtt')}>Web captions (.vtt)</MenuItem>
          <MenuItem onClick={() => exportAs('txt')}>Plain text (.txt)</MenuItem>
          {(canRequest || canDelete) && <MenuSeparator />}
          {canRequest && <MenuItem onClick={onAgain}>Transcribe again</MenuItem>}
          {canDelete && <MenuItem danger onClick={onDelete}>Delete transcript</MenuItem>}
        </Menu>
      </div>

      <div className="tx-search" role="search">
        <input
          type="search"
          className="input"
          placeholder="Search the transcript"
          aria-label="Search the transcript"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
        />
        {searching && (
          <>
            <span className="small muted tx-count" aria-live="polite">
              {matches.length ? `${cursor + 1} of ${matches.length}` : 'No matches'}
            </span>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(-1)} disabled={matches.length < 2} aria-label="Previous match">
              <span aria-hidden="true">↑</span>
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => step(1)} disabled={matches.length < 2} aria-label="Next match">
              <span aria-hidden="true">↓</span>
            </button>
          </>
        )}
      </div>

      <div className="tx-meta small muted">
        <span>{meta}</span>
        <div className="spacer" />
        {!follow && !searching && active >= 0 && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFollow(true)}>Follow playback</button>
        )}
      </div>

      <ul className="tx-list" ref={list} onScroll={onScroll} onKeyDown={onListKey} aria-label="Transcript">
        {segments.map((seg, i) => (
          <SegmentRow
            key={i}
            seg={seg}
            index={i}
            long={long}
            active={i === active}
            tabbable={i === tabbable}
            ranges={rangesByRow.get(i) || null}
            currentStart={current && current.index === i ? current.range[0] : -1}
            onPick={pick}
          />
        ))}
      </ul>
    </div>
  );
}

const SegmentRow = memo(function SegmentRow({ seg, index, long, active, tabbable, ranges, currentStart, onPick }) {
  return (
    <li>
      <button
        type="button"
        className={`tx-seg${active ? ' is-active' : ''}`}
        data-seg={index}
        tabIndex={tabbable ? 0 : -1}
        aria-current={active ? 'time' : undefined}
        onClick={() => onPick(index)}
      >
        <span className="tx-time mono">{clockLabel(seg.s, long)}</span>
        <span className="tx-text">{ranges ? marked(seg.t, ranges, currentStart) : seg.t}</span>
      </button>
    </li>
  );
});

function marked(text, ranges, currentStart) {
  const out = [];
  let at = 0;
  ranges.forEach(([a, b], k) => {
    if (a > at) out.push(text.slice(at, a));
    out.push(<mark key={k} className={`tx-mark${a === currentStart ? ' is-current' : ''}`}>{text.slice(a, b)}</mark>);
    at = b;
  });
  if (at < text.length) out.push(text.slice(at));
  return out;
}
