'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Dialog from '@/app/components/ui/Dialog';
import { useToast } from '@/app/components/ui/Toast';
import { fmtSize } from '@/lib/media';
import { cleanFolder } from '@/lib/folder-ops';
import { landingFolder } from '@/lib/library-move';
import { api } from '../_ui/api';

const ROUTE = '/api/admin/library/move';
const num = (n) => Number(n || 0).toLocaleString('en-US');
const files = (n) => `${num(n)} file${n === 1 ? '' : 's'}`;
const quoted = (names, more) => `${names.map((n) => `“${n}”`).join(', ')}${more ? ', …' : ''}`;

/**
 * "Move into a drive…", under "Not in a drive" on Admin → Usage. With no All
 * files (the `library` flag, `libraryOpen` here) a file outside every drive
 * is out of everyone's sight until it is in one; this puts them all in the
 * drive chosen, at a folder in it or its top.
 *
 * The dialog reads what there is to move (GET /api/admin/library/move), then
 * calls the route until it is done: each call moves what it has time for
 * and answers how many are left. Closing it, or Stop, ends the run after the
 * call under way; nothing is half-moved, and opening it again carries on
 * with what is still outside — into the same drive and folder, which the
 * route holds a run that stopped part-way to.
 *
 * Private files (seen only by their uploader, the people they were shared
 * with, or those given their folder) move only when the admin ticks for
 * them: in a drive, every member who mounts it can open them.
 */
export default function MoveIntoDrive({ libraryOpen = false }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Move into a drive…</button>
      {open && (
        <MoveDialog
          libraryOpen={libraryOpen}
          onClose={(changed) => { setOpen(false); if (changed) router.refresh(); }}
        />
      )}
    </>
  );
}

function MoveDialog({ libraryOpen, onClose }) {
  const router = useRouter();
  const toast = useToast();
  const formId = useId();
  const listId = useId();
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [driveId, setDriveId] = useState('');
  const [folder, setFolder] = useState('');
  const [withPrivate, setWithPrivate] = useState(false);
  const [folders, setFolders] = useState([]);
  // { running, stopped, done, moved, total, left, stays, missing, missingNames,
  //   blocked, failed, linksLeft, markersLeft, errors }
  const [run, setRun] = useState(null);
  const stop = useRef(false);
  const moved = useRef(0);

  // What is outside every drive, and the run that stopped part-way if there
  // is one: it carries on only where it was going, so that is chosen here.
  const read = (body) => {
    setInfo(body);
    if (body?.run) {
      setDriveId(body.run.driveId);
      setFolder(body.run.folder || '');
    }
  };
  useEffect(() => {
    let live = true;
    api(ROUTE).then((body) => { if (live) read(body); }).catch((e) => { if (live) setLoadError(e.message); });
    // Closed mid-run: the call under way finishes, and the run ends there.
    return () => { live = false; stop.current = true; };
  }, []);

  // The chosen drive's folders, to pick one from or type a new one.
  useEffect(() => {
    setFolders([]);
    if (!driveId) return undefined;
    let live = true;
    api(`/api/files/folders?filespace=${encodeURIComponent(driveId)}`)
      .then((body) => { if (live) setFolders((body?.folders || []).map((f) => f.folder).filter(Boolean)); })
      .catch(() => {});
    return () => { live = false; };
  }, [driveId]);

  const drive = info?.drives?.find((d) => d.id === driveId) || null;
  const running = !!run?.running;
  // A run stopped part-way: its drive and folder are the run's.
  const pinned = !!info?.run;
  const movable = info?.movable?.files || 0;
  const restricted = info?.private?.files || 0;
  const others = Math.max(0, (info?.files || 0) - movable - restricted);
  const toMove = movable + (withPrivate ? restricted : 0);
  const close = () => onClose(moved.current > 0);
  // What is left outside, once a run has ended: the counts above say so.
  const recount = () => api(ROUTE).then(read).catch(() => {});

  const start = async (e) => {
    e?.preventDefault();
    if (!drive || drive.problem || running) return;
    stop.current = false;
    const tally = { moved: 0, missing: 0, blocked: 0, failed: 0, names: new Set(), errors: new Set() };
    let after = '';
    let total = toMove;
    setRun({ running: true, moved: 0, total });
    try {
      for (;;) {
        const r = await api(ROUTE, { method: 'POST', json: { driveId, folder, private: withPrivate, after } });
        tally.moved += r.moved || 0;
        tally.missing += r.missing || 0;
        tally.blocked += r.blocked || 0;
        tally.failed += r.failed || 0;
        for (const n of r.missingNames || []) tally.names.add(n);
        if (r.error) tally.errors.add(r.error);
        moved.current += r.moved || 0;
        total = tally.moved + (r.left || 0);
        if (!r.more) {
          setRun({
            done: true, moved: tally.moved, total, left: r.left || 0, stays: r.stays || 0,
            missing: Math.min(tally.missing, r.left || 0), missingNames: [...tally.names],
            blocked: tally.blocked, failed: tally.failed, linksLeft: r.linksLeft || 0, markersLeft: !!r.markersLeft,
            errors: [...tally.errors],
          });
          if (tally.moved) toast.success(`Moved ${files(tally.moved)} into ${drive.name}.`);
          router.refresh();
          recount();
          return;
        }
        after = r.after || after;
        if (stop.current) { setRun({ stopped: true, moved: tally.moved, total }); recount(); return; }
        setRun({ running: true, moved: tally.moved, total });
      }
    } catch (err) {
      setRun({ stopped: true, moved: tally.moved, total, errors: [err.message] });
      recount();
    }
  };

  const total = run?.total || toMove;
  const shown = Math.min(run?.moved || 0, total);
  const example = landingFolder(folder, 'Shoot/Day 1');
  // After a run, what another could still move: not the files with nothing
  // stored, which the counts above cannot tell from the rest.
  const again = run?.done ? Math.max(0, toMove - (run.missing || 0)) : toMove;
  const blocked = !drive || !!drive.problem || !!info?.problem;

  let footer;
  if (running) {
    footer = <button type="button" className="btn" onClick={() => { stop.current = true; }}>Stop</button>;
  } else if (run?.done) {
    footer = (
      <>
        <button type="button" className={again ? 'btn' : 'btn btn-primary'} onClick={close}>{again ? 'Close' : 'Done'}</button>
        {again > 0 && (
          <button type="submit" form={formId} className="btn btn-primary" disabled={blocked}>
            {run.failed ? 'Try again' : `Move ${files(again)}`}
          </button>
        )}
      </>
    );
  } else {
    // A run stopped part-way can always be carried on, to its end, if only
    // so that the library's folders follow what it moved.
    footer = (
      <>
        <button type="button" className="btn" onClick={close}>Cancel</button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={blocked || (!toMove && !pinned)}>
          {run || pinned ? 'Carry on' : toMove ? `Move ${files(toMove)}` : 'Move'}
        </button>
      </>
    );
  }

  return (
    <Dialog
      open
      onClose={close}
      title="Move into a drive"
      // While files are moving a stray click does not end the run; Stop does.
      dismissable={!running}
      onEscape={() => { stop.current = true; }}
      footer={footer}
    >
      {!info && !loadError && <p className="small muted admin-note">Counting what is outside every drive…</p>}
      {loadError && <p className="small admin-inline-error" role="alert">{loadError}</p>}
      {info && (
        <form id={formId} className="admin-form" onSubmit={start} noValidate>
          <p className="small admin-note">
            {movable + restricted
              ? `${files(movable + restricted)} (${fmtSize(info.movable.bytes + info.private.bytes) || '0 B'}) ${movable + restricted === 1 ? 'is' : 'are'} kept outside every drive.`
              : 'There are no files outside every drive to move.'}
            {movable + restricted > 0 && !libraryOpen && ' With no All files, nobody sees them until they are in one — their uploaders included.'}
          </p>
          {others > 0 && (
            <p className="small muted admin-note">
              {`${files(others)} more stay${others === 1 ? 's' : ''} where ${others === 1 ? 'it is' : 'they are'}: kept in Vercel Blob from before there was a bucket, or previews and system files no listing shows.`}
            </p>
          )}
          {info.problem && <p className="small admin-inline-error" role="alert">{info.problem}</p>}
          {!info.problem && (movable + restricted > 0 || run || pinned) && (
            <>
              {pinned && !running && (
                <p className="small admin-note">
                  {`A move into ${drive ? `“${drive.name}”` : 'a drive'}${cleanFolder(folder) ? `, in “${cleanFolder(folder)}”,` : ''} stopped part-way. It carries on there; once it has finished, the next move can go anywhere.`}
                </p>
              )}
              <label className="admin-field">
                <span className="admin-field-label">Drive</span>
                <select className="input" value={driveId} onChange={(e) => setDriveId(e.target.value)} disabled={running || pinned}>
                  <option value="">Choose a drive…</option>
                  {info.drives.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </label>
              {drive?.problem && <p className="small admin-inline-error" role="alert">{drive.problem}</p>}
              {drive?.warning && <p className="small muted admin-note">{drive.warning}</p>}
              <label className="admin-field">
                <span className="admin-field-label">Folder in it <span className="muted">(optional)</span></span>
                <input
                  className="input"
                  list={listId}
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="Its top level"
                  autoComplete="off"
                  disabled={running || pinned}
                />
                <datalist id={listId}>
                  {folders.map((f) => <option key={f} value={f} />)}
                </datalist>
                <span className="admin-field-hint">
                  {cleanFolder(folder)
                    ? `Each file keeps its own folders inside it: “Shoot/Day 1” becomes “${example}”.`
                    : 'Each file keeps its own folders, from the top of the drive.'}
                </span>
              </label>
              {restricted > 0 && (
                <label className="admin-check">
                  <input type="checkbox" checked={withPrivate} onChange={(e) => setWithPrivate(e.target.checked)} disabled={running} />
                  <span>
                    <span className="admin-field-label">{`Also move the ${files(restricted)} only some people can see (${fmtSize(info.private.bytes) || '0 B'})`}</span>
                    <span className="admin-field-hint">
                      Each is kept to its uploader, the people it was shared with, or those given its folder. In a drive, every member who mounts it can open them.
                      Left unticked, they stay outside every drive, with their folders.
                    </span>
                  </span>
                </label>
              )}
              <p className="small muted admin-note">
                The library’s folders, their tags, collections and stars follow the files; a folder that still holds a file left outside stays too, for that file.
                Links to folders follow where the drive had no folder of that name, and a link whose maker cannot share from the drive is paused until they can.
                Anyone who saw these files through access given on a folder, rather than the drive, needs adding to the drive.
                Files in the trash stay where they are.
              </p>
            </>
          )}
          {run && (
            <div className="admin-lines" role="status">
              <span className="admin-meter" aria-hidden>
                <span className="meter-track">
                  <span className="meter-fill" style={{ width: `${total ? (shown / total) * 100 : 100}%` }} />
                </span>
              </span>
              <p className="small admin-note">
                {run.done
                  ? (run.moved ? `Moved ${files(run.moved)} into ${drive?.name || 'the drive'}.` : 'Nothing more was moved.')
                  : `Moved ${num(shown)} of ${num(total)}`}
                {run.running && '…'}
                {run.stopped && '. Stopped: the rest are still outside every drive, and Carry on moves them.'}
              </p>
              {run.done && run.stays > 0 && (
                <p className="small muted admin-note">
                  {`${files(run.stays)} only some people can see ${run.stays === 1 ? 'stays' : 'stay'} outside every drive, with ${run.stays === 1 ? 'its folder' : 'their folders'}. To move ${run.stays === 1 ? 'it' : 'them'} too, tick “Also move” and move again.`}
                </p>
              )}
              {run.done && run.missing > 0 && (
                <p className="small muted admin-note">
                  {`${files(run.missing)} ${run.missing === 1 ? 'has' : 'have'} nothing stored in the bucket to move, so ${run.missing === 1 ? 'it stays' : 'they stay'} where ${run.missing === 1 ? 'it is' : 'they are'}: ${quoted(run.missingNames, run.missing > run.missingNames.length)}.`}
                </p>
              )}
              {run.done && run.linksLeft > 0 && (
                <p className="small muted admin-note">
                  {`${num(run.linksLeft)} link${run.linksLeft === 1 ? '' : 's'} to folders ${drive?.name ? `“${drive.name}”` : 'the drive'} already had ${run.linksLeft === 1 ? 'stays' : 'stay'} with the library, and no longer ${run.linksLeft === 1 ? 'opens' : 'open'} anything: a link there would show the drive’s own files too. Make new links from the drive if they are wanted.`}
                </p>
              )}
              {run.done && run.markersLeft && (
                <p className="small muted admin-note">
                  Some empty folders were not carried across in time: they are in the drive on the web, and a mounted drive shows them once something is put in them.
                </p>
              )}
              {(run.errors || []).map((m) => <p key={m} className="small admin-inline-error" role="alert">{m}</p>)}
            </div>
          )}
        </form>
      )}
    </Dialog>
  );
}
