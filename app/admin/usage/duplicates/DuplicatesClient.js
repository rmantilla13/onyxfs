'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Thumb } from '@/app/components/ui/FileCard';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { fmtSize } from '@/lib/media';
import { crumbsFor, mapLimit } from '@/lib/folder-ops';
import { kindLabel } from '@/lib/file-info';
import { copiesToRemove, bytesOf } from '@/lib/storage-report';

const size = (n) => fmtSize(n) || '0 B';
const plural = (n, one, many = `${one}s`) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }) : null;

/**
 * Sets of the same bytes stored more than once (groupDuplicates), and the
 * clean-up: one copy of each set is kept — the oldest unless someone picks
 * another — and the rest are removed through DELETE /api/files/[id], the
 * same trash as removing them from the library by hand. A set can be left
 * out of the clean-up altogether.
 *
 * Files from before hashes were taken are invisible here until checked:
 * "Check them" runs the scan route (a HEAD per file, a few seconds a call)
 * until it has seen them all, then reloads.
 */
export default function DuplicatesClient({ groups, summary, drives, trash, retentionDays, canScan }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [keep, setKeep] = useState({});
  const [skip, setSkip] = useState(() => new Set());
  const [busy, setBusy] = useState(null);
  const [scan, setScan] = useState(null);

  const included = useMemo(() => groups.filter((g) => !skip.has(g.key)), [groups, skip]);
  const doomed = useMemo(() => copiesToRemove(included, keep), [included, keep]);

  // The drive a copy is in, by its place in the bucket: the innermost one.
  const driveOf = (f) => drives
    .filter((d) => d.prefix && String(f.storageKey || '').startsWith(`${d.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0] || null;

  const remove = async (list) => {
    if (!list.length || busy) return;
    const bytes = size(bytesOf(list));
    const one = list.length === 1;
    const them = one ? `The extra copy (${bytes})` : `The other ${list.length.toLocaleString()} copies (${bytes})`;
    const ok = await confirm({
      title: `Remove ${plural(list.length, 'extra copy', 'extra copies')}?`,
      body: trash
        ? `One copy of each file stays where it is. ${them} ${one ? 'goes' : 'go'} to the trash and ${one ? 'is' : 'are'} purged ${retentionDays} days from now.`
        : `One copy of each file stays where it is. ${them} ${one ? 'is' : 'are'} deleted permanently. This cannot be undone.`,
      confirmLabel: trash ? 'Move to trash' : 'Delete copies',
    });
    if (!ok) return;
    setBusy({ done: 0, total: list.length });
    let failed = 0;
    await mapLimit(list, 4, async (f) => {
      const r = await fetch(`/api/files/${encodeURIComponent(f.id)}`, { method: 'DELETE' }).catch(() => null);
      if (!r?.ok) failed += 1;
      setBusy((b) => b && { ...b, done: b.done + 1 });
    });
    setBusy(null);
    const done = list.length - failed;
    if (failed) toast.error(`${plural(failed, 'copy', 'copies')} could not be removed${done ? `; ${done} were` : ''}.`);
    else toast.success(`${plural(done, 'extra copy', 'extra copies')} ${trash ? 'moved to the trash' : 'deleted'}.`);
    setKeep({});
    setSkip(new Set());
    router.refresh();
  };

  const runScan = async () => {
    let after = '';
    let checked = 0;
    let hashed = 0;
    setScan({ running: true, checked, hashed });
    try {
      for (;;) {
        const r = await fetch('/api/admin/storage/scan', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ after }),
        });
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || `The check stopped (HTTP ${r.status}).`);
        checked += body.checked || 0;
        hashed += body.hashed || 0;
        after = body.after || after;
        setScan({ running: true, checked, hashed });
        if (body.done) break;
      }
      setScan({ running: false, checked, hashed });
      toast.success(`Checked ${plural(checked, 'file')}.`);
      router.refresh();
    } catch (e) {
      setScan({ running: false, checked, hashed, error: e.message });
    }
  };

  const toggleSet = (key) => setSkip((s) => {
    const next = new Set(s);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  return (
    <main className="shell storage-page">
      <header className="storage-head">
        <div style={{ minWidth: 0 }}>
          <nav className="crumbs" aria-label="Storage">
            <ol>
              <li className="crumb-item">
                <Link href="/storage" className="crumb">Storage</Link>
                <span className="crumb-sep" aria-hidden>/</span>
              </li>
              <li className="crumb-item crumb-here"><h1 className="files-title">Duplicates</h1></li>
            </ol>
          </nav>
          <p className="muted storage-sub">
            {summary.groups
              ? <>{plural(summary.groups, 'file')} stored more than once: <strong className="storage-total">{size(summary.bytes)}</strong> in extra copies</>
              : 'No file is stored more than once.'}
          </p>
        </div>
      </header>

      {summary.unhashed > 0 && canScan && (
        <div className="card dup-scan" role="status">
          <div style={{ minWidth: 0 }}>
            <strong>{plural(summary.unhashed, 'file')} not checked yet</strong>
            <p className="small muted" style={{ margin: 'var(--s1) 0 0' }}>
              Files uploaded before duplicate detection have no fingerprint yet. Checking asks the bucket for each one&rsquo;s checksum; nothing is downloaded or changed.
            </p>
            {scan?.error && <p className="small" role="alert" style={{ margin: 'var(--s2) 0 0', color: 'var(--danger)' }}>{scan.error}</p>}
          </div>
          <button type="button" className="btn" onClick={runScan} disabled={scan?.running}>
            {scan?.running ? `Checking… ${scan.checked.toLocaleString()}` : scan?.error ? 'Try again' : 'Check them'}
          </button>
        </div>
      )}

      {groups.length > 0 && (
        <div className="dup-bar" role="toolbar" aria-label="Clean up">
          <span className="small">
            <strong>{plural(doomed.length, 'extra copy', 'extra copies')}</strong>
            <span className="muted"> in {plural(included.length, 'set')} · frees {size(bytesOf(doomed))}</span>
          </span>
          <span className="spacer" />
          <button type="button" className="btn btn-danger" disabled={!doomed.length || !!busy} onClick={() => remove(doomed)}>
            {busy ? `Removing ${busy.done} of ${busy.total}…` : trash ? 'Move extra copies to trash' : 'Delete extra copies'}
          </button>
        </div>
      )}

      {groups.length === 0 && summary.unhashed === 0 && (
        <div className="empty">Nothing to clean up. New uploads are checked as they arrive.</div>
      )}

      <ol className="dup-groups">
        {groups.map((g) => {
          const kept = g.files.some((f) => f.id === keep[g.key]) ? keep[g.key] : g.keep;
          const off = skip.has(g.key);
          const first = g.files[0];
          return (
            <li key={g.key} className={`card dup-group${off ? ' is-off' : ''}`}>
              <div className="dup-group-head">
                <label className="dup-include">
                  <input type="checkbox" checked={!off} onChange={() => toggleSet(g.key)} aria-label={`Include ${first.name} in the clean-up`} />
                  <span className="truncate"><strong>{plural(g.files.length, 'copy', 'copies')}</strong> of {size(g.size)}</span>
                </label>
                <span className="small muted">frees {size(g.reclaim)}</span>
                <span className="spacer" />
                <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => remove(g.files.filter((f) => f.id !== kept))}>
                  Remove extras
                </button>
              </div>
              <ul className="dup-files" role="radiogroup" aria-label={`Copy of ${first.name} to keep`}>
                {g.files.map((f) => {
                  const isKept = f.id === kept;
                  const drive = driveOf(f);
                  return (
                    <li key={f.id} className={`dup-file${isKept ? ' is-kept' : ''}`}>
                      <input
                        type="radio"
                        className="dup-radio"
                        name={`keep-${g.key}`}
                        checked={isKept}
                        onChange={() => setKeep((k) => ({ ...k, [g.key]: f.id }))}
                        aria-label={`Keep the copy in ${crumbsFor(f.folder || '', drive?.name || 'All files').map((c) => c.name).join(' / ')}`}
                      />
                      <span className="dup-thumb"><Thumb file={f} label={kindLabel(f)} /></span>
                      <span className="dup-text">
                        <Link href={`/files/${f.id}`} className="truncate dup-name" title={f.name}>{f.name}</Link>
                        <span className="truncate small muted">{crumbsFor(f.folder || '', drive?.name || 'All files').map((c) => c.name).join(' / ')}</span>
                      </span>
                      <span className="small muted dup-when" suppressHydrationWarning>
                        {f.createdAt && dateFmt ? dateFmt.format(new Date(Number(f.createdAt))) : ''}
                        {f.createdBy ? ` · ${f.createdBy}` : ''}
                      </span>
                      <span className={`tag dup-tag${isKept ? ' is-kept' : off ? '' : ' tag-danger'}`}>
                        {isKept ? 'Keep' : off ? 'Left alone' : 'Remove'}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
      {confirmElement}
    </main>
  );
}
