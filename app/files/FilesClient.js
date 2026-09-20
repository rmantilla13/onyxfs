'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildFacets, fileMatchesFacets, hasAnyFacet, deriveAuto, expiryState } from '@/lib/dam';
import { uploadFileMultipart } from '@/lib/multipart-client';

// Above this, a single presigned PUT is a bad bet: S3 refuses past 5 GB, and
// well before that a dropped connection costs the whole transfer. Multipart
// parts are independently retryable and the upload survives a reload.
const MULTIPART_THRESHOLD = 32 * 1024 * 1024;

const KINDS = [
  { key: 'image', label: 'Images' },
  { key: 'video', label: 'Video' },
  { key: 'audio', label: 'Audio' },
  { key: 'doc', label: 'Documents' },
  { key: 'other', label: 'Other' },
];

const fmtSize = (n) => {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
};

export default function FilesClient({ flags, canWrite, schema, filespaceId, filespaces }) {
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cursor, setCursor] = useState(null);
  const [error, setError] = useState(null);

  const [folder, setFolder] = useState('');
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState([]);
  const [facets, setFacets] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [uploads, setUploads] = useState([]);
  // Phone only: facets live behind a toggle. On desktop the sidebar is always
  // there and this is ignored by the stylesheet.
  const [filtersOpen, setFiltersOpen] = useState(false);

  const inputRef = useRef(null);
  const sentinelRef = useRef(null);
  // Guards against a stale response from a superseded filter overwriting the
  // results of a newer one — without this, fast typing can leave the grid
  // showing the results of a query the user has already moved past.
  const requestRef = useRef(0);

  /**
   * Fetch one page. `after` is the opaque cursor from the previous page; with
   * no cursor this is a fresh query and replaces the grid rather than
   * appending to it.
   */
  const fetchPage = useCallback(async (after = null) => {
    const token = ++requestRef.current;
    after ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const p = new URLSearchParams();
      if (folder) p.set('folder', folder);
      if (query) p.set('q', query);
      if (kinds.length) p.set('kind', kinds.join(','));
      if (filespaceId) p.set('filespace', filespaceId);
      if (after) p.set('cursor', after);
      const r = await fetch(`/api/files?${p}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Request failed (${r.status})`);
      const data = await r.json();
      if (token !== requestRef.current) return; // superseded
      setFiles((prev) => (after ? [...prev, ...(data.files || [])] : data.files || []));
      setFolders(data.folders || []);
      setCursor(data.cursor || null);
    } catch (e) {
      if (token === requestRef.current) setError(e.message);
    } finally {
      if (token === requestRef.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [folder, query, kinds, filespaceId]);

  const load = useCallback(() => fetchPage(null), [fetchPage]);

  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(load, query ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, query]);

  // Infinite scroll. Observing a sentinel below the grid costs nothing while
  // it is off screen, and at 100k files a "load more" button would be a lot of
  // clicking. Re-created whenever the cursor changes so it always requests the
  // page after the one currently held.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !cursor || loading || loadingMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) fetchPage(cursor);
    }, { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, loading, loadingMore, fetchPage]);

  // Facet counts come from the loaded rows, so they always describe what is
  // actually on screen rather than the whole bucket.
  const facetDefs = useMemo(() => buildFacets(files, schema), [files, schema]);
  const visible = useMemo(
    () => (hasAnyFacet(facets) ? files.filter((f) => fileMatchesFacets(f, facets, schema)) : files),
    [files, facets, schema]
  );

  const toggleFacet = (key, value) => {
    setFacets((prev) => {
      const cur = new Set(prev[key] || []);
      cur.has(value) ? cur.delete(value) : cur.add(value);
      const next = { ...prev };
      cur.size ? (next[key] = [...cur]) : delete next[key];
      return next;
    });
  };

  const toggleKind = (k) =>
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));

  // ── Upload ────────────────────────────────────────────────────────────────
  // Two paths, chosen by what the server says is configured: a presigned PUT
  // straight to S3 (the browser never proxies bytes through the app), or a
  // Vercel Blob client upload. Both then POST the resulting URL back to record
  // the row — the catalog entry is always written by us, never by the storage.
  const upload = useCallback(
    async (fileList) => {
      const items = [...fileList];
      if (!items.length) return;
      setUploads(items.map((f) => ({ name: f.name, pct: 0 })));

      const cfg = await fetch('/api/files/config').then((r) => r.json()).catch(() => ({ mode: 'blob' }));

      for (const [i, file] of items.entries()) {
        try {
          let url;
          let storage;
          let storageKey;
          let name = file.name;

          if (cfg.mode === 's3' && file.size > MULTIPART_THRESHOLD) {
            const done = await uploadFileMultipart(file, {
              folder,
              filespaceId: filespaceId || undefined,
              onProgress: ({ pct }) =>
                setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct } : x))),
            });
            url = done.publicUrl;
            storage = 's3';
            storageKey = done.key;
            name = done.name || name;
          } else if (cfg.mode === 's3') {
            const pre = await fetch('/api/files/presign', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                filename: file.name,
                contentType: file.type || 'application/octet-stream',
                folder,
                filespaceId: filespaceId || undefined,
              }),
            }).then((r) => r.json());
            if (pre.error) throw new Error(pre.error);
            const put = await fetch(pre.putUrl, {
              method: 'PUT',
              body: file,
              headers: { 'content-type': file.type || 'application/octet-stream' },
            });
            if (!put.ok) throw new Error(`Upload failed (${put.status})`);
            url = pre.publicUrl;
            storage = 's3';
            storageKey = pre.key;
            name = pre.name || name;
          } else {
            const { upload: blobUpload } = await import('@vercel/blob/client');
            const blob = await blobUpload(file.name, file, {
              access: 'public',
              handleUploadUrl: '/api/files/upload',
            });
            url = blob.url;
            storage = 'blob';
          }

          await fetch('/api/files', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              name,
              url,
              mime: file.type,
              size: file.size,
              folder,
              storage,
              storageKey,
              filespace: filespaceId || undefined,
            }),
          });
          setUploads((u) => u.map((x, j) => (j === i ? { ...x, pct: 100 } : x)));
        } catch (e) {
          setUploads((u) => u.map((x, j) => (j === i ? { ...x, error: e.message } : x)));
        }
      }
      setTimeout(() => setUploads([]), 1500);
      load();
    },
    [folder, filespaceId, load]
  );

  const onDrop = (e) => {
    e.preventDefault();
    if (canWrite && e.dataTransfer?.files?.length) upload(e.dataTransfer.files);
  };

  const trashSelected = async () => {
    if (!selected.size) return;
    const verb = flags.trash ? 'Move to trash' : 'Permanently delete';
    if (!confirm(`${verb} ${selected.size} file${selected.size === 1 ? '' : 's'}?`)) return;
    // The server decides trash-vs-purge from its own flag state.
    await Promise.all([...selected].map((id) => fetch(`/api/files/${id}`, { method: 'DELETE' })));
    setSelected(new Set());
    load();
  };

  return (
    <main className="shell" style={{ padding: '24px 24px 64px' }} onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="row" style={{ marginBottom: 20 }}>
        <h1 className="files-title" style={{ fontSize: 24, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{folder || 'All files'}</h1>
        <span className="muted small">
          {visible.length}{visible.length !== files.length ? ` of ${files.length}` : ''}{cursor ? '+' : ''}
        </span>
        <div className="spacer" />
        {selected.size > 0 && (
          <button className="btn btn-danger" onClick={trashSelected}>
            {flags.trash ? 'Trash' : 'Delete'} {selected.size}
          </button>
        )}
        {canWrite && (
          <>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => { upload(e.target.files); e.target.value = ''; }}
            />
            <button className="btn btn-primary" onClick={() => inputRef.current?.click()}>Upload</button>
          </>
        )}
      </div>

      <div className="files-toolbar">
        <input
          className="input"
          type="search"
          placeholder="Search files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="kind-row">
        <div className="kind-strip edge-scroll">
          {KINDS.map((k) => (
            <button
              key={k.key}
              className="btn"
              onClick={() => toggleKind(k.key)}
              style={kinds.includes(k.key) ? { background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)' } : undefined}
            >
              {k.label}
            </button>
          ))}
        </div>
        {flags.metadata && facetDefs.some((d) => d.values.length > 0) && (
          <button
            className="btn only-mobile"
            onClick={() => setFiltersOpen((v) => !v)}
            aria-expanded={filtersOpen}
            style={hasAnyFacet(facets) || filtersOpen ? { borderColor: 'var(--ink)' } : undefined}
          >
            Filters{hasAnyFacet(facets) ? ` · ${Object.values(facets).reduce((n, v) => n + v.length, 0)}` : ''}
          </button>
        )}
        </div>
      </div>

      {uploads.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 16 }}>
          {uploads.map((u, i) => (
            <div key={i} className="row small">
              <span>{u.name}</span>
              <div className="spacer" />
              <span className={u.error ? '' : 'muted'} style={u.error ? { color: 'var(--danger)' } : undefined}>
                {u.error || (u.pct === 100 ? 'Done' : u.pct ? `${u.pct}%` : 'Uploading…')}
              </span>
            </div>
          ))}
        </div>
      )}

      {error && (
        <div className="card" style={{ padding: 16, marginBottom: 16, borderColor: 'var(--danger)' }}>
          <p className="small" style={{ margin: 0, color: 'var(--danger)' }}>{error}</p>
        </div>
      )}

      <div className="files-layout">
          <aside>
            <div className="side-folders">
              <Section title="Folders">
                <div className="folder-list edge-scroll">
                  <FolderLink active={!folder} onClick={() => setFolder('')}>All files</FolderLink>
                  {folders.map((f) => (
                    <FolderLink key={f.name || f} active={folder === (f.name || f)} onClick={() => setFolder(f.name || f)}>
                      {f.name || f} {f.count != null && <span className="muted">{f.count}</span>}
                    </FolderLink>
                  ))}
                </div>
              </Section>
            </div>

            <div className={`side-facets${filtersOpen ? ' open' : ''}`}>
            {flags.metadata &&
              facetDefs
                .filter((d) => d.values.length > 0)
                .map((d) => (
                  <Section key={d.key} title={d.label}>
                    {d.values.slice(0, 8).map((v) => (
                      <label key={v.value} className="row small" style={{ gap: 6, padding: '3px 0', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={(facets[d.key] || []).includes(v.value)}
                          onChange={() => toggleFacet(d.key, v.value)}
                        />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.value}</span>
                        <div className="spacer" />
                        <span className="muted">{v.count}</span>
                      </label>
                    ))}
                  </Section>
                ))}
            </div>
          </aside>

          <section>
            {loading ? (
              <div className="empty">Loading…</div>
            ) : visible.length === 0 ? (
              <div className="empty">
                {files.length === 0
                  ? canWrite ? 'Nothing here yet. Drop files anywhere on this page to upload.' : 'Nothing here yet.'
                  : 'No files match those filters.'}
              </div>
            ) : (
              <div className="files-grid">
                {visible.map((f) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    schema={schema}
                    showExpiry={flags.usageRights}
                    selected={selected.has(f.id)}
                    onToggle={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        n.has(f.id) ? n.delete(f.id) : n.add(f.id);
                        return n;
                      })
                    }
                  />
                ))}
              </div>
            )}
            {/* Sentinel for infinite scroll. Rendered only while a next page
                exists, so reaching the end is what stops the observer. */}
            {cursor && <div ref={sentinelRef} style={{ height: 1 }} />}
            {loadingMore && <div className="empty" style={{ padding: 24 }}>Loading more…</div>}
          </section>
      </div>
    </main>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <h3 className="small muted" style={{ textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 11, marginBottom: 6 }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function FolderLink({ active, onClick, children }) {
  return (
    <button onClick={onClick} className={`small folder-link${active ? ' active' : ''}`}>
      {children}
    </button>
  );
}

function FileCard({ file, schema, showExpiry, selected, onToggle }) {
  const auto = deriveAuto(file);
  const expiry = showExpiry ? expiryState(file, schema) : null;
  const preview = file.thumbnailUrl || (file.kind === 'image' ? file.url : null);

  return (
    <div
      className="card"
      onClick={onToggle}
      style={{
        overflow: 'hidden',
        cursor: 'pointer',
        outline: selected ? '2px solid var(--accent)' : 'none',
        outlineOffset: -1,
      }}
    >
      <div style={{ aspectRatio: '4/3', background: 'color-mix(in srgb, var(--ink) 4%, transparent)', display: 'grid', placeItems: 'center' }}>
        {preview ? (
          <img src={preview} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
        ) : (
          <span className="muted small mono">{auto.format || file.kind}</span>
        )}
      </div>
      <div style={{ padding: 10 }}>
        <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.name}>
          {file.name}
        </div>
        <div className="row small muted" style={{ gap: 6, marginTop: 4 }}>
          <span>{fmtSize(file.size)}</span>
          <div className="spacer" />
          {expiry === 'expired' && <span className="tag tag-danger">Expired</span>}
          {expiry === 'soon' && <span className="tag tag-warning">Expiring</span>}
        </div>
      </div>
    </div>
  );
}
