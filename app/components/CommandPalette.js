'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { setThemePref } from '@/lib/theme';
import { fmtSize } from '@/lib/media';
import { crumbsFor } from '@/lib/folder-ops';
import { kindLabel } from '@/lib/file-info';

/**
 * ⌘K: one box for finding anything and doing anything.
 *
 *   files     the whole library, searched on the server as you type (the
 *             same /api/files the grid reads — so only what you may see)
 *   folders   the folder tree, filtered here
 *   drives    the filespaces you can open
 *   actions   everything the nav and the menus offer, by name
 *
 * ↑ ↓ move across all of them, Enter runs, Esc closes. An action that belongs
 * to the files page (New folder, Upload) is sent to it as an `onyx:command`
 * event; FilesClient listens.
 */
const MAX_FILES = 8;
const MAX_FOLDERS = 6;
const ROLE_WORDS = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' };

export function useCommandPaletteShortcut(setOpen) {
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
}

export default function CommandPalette({ open, onClose, drives = [], isAdmin = false, onShortcuts }) {
  const router = useRouter();
  const pathname = usePathname();
  const onFiles = pathname === '/files';
  const [q, setQ] = useState('');
  const [files, setFiles] = useState([]);
  const [searching, setSearching] = useState(false);
  const [folders, setFolders] = useState(null);
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const list = useRef(null);
  const dialog = useRef(null);

  // The native dialog, for the top layer, focus and the backdrop.
  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
    if (open) {
      setQ('');
      setFiles([]);
      setActive(0);
      requestAnimationFrame(() => input.current?.focus());
    }
  }, [open]);

  // The folder tree, once per opening.
  useEffect(() => {
    if (!open || folders) return;
    fetch('/api/files/folders').then((r) => (r.ok ? r.json() : { folders: [] })).then((d) => setFolders(d.folders || [])).catch(() => setFolders([]));
  }, [open, folders]);

  // Files: debounced, and only the newest answer counts.
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return undefined;
    const term = q.trim();
    if (!term) { setFiles([]); setSearching(false); return undefined; }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/files?q=${encodeURIComponent(term)}&limit=${MAX_FILES}&folders=0&sort=new`);
        const d = r.ok ? await r.json() : { files: [] };
        if (mine === seq.current) setFiles((d.files || []).slice(0, MAX_FILES));
      } finally {
        if (mine === seq.current) setSearching(false);
      }
    }, 140);
    return () => clearTimeout(t);
  }, [q, open]);

  const go = useCallback((href) => { onClose(); router.push(href); }, [onClose, router]);
  const command = useCallback((name) => {
    onClose();
    window.dispatchEvent(new CustomEvent('onyx:command', { detail: { name } }));
  }, [onClose]);

  const actions = useMemo(() => [
    { id: 'all', label: 'Go to All files', hint: 'Library', run: () => go('/files') },
    onFiles && { id: 'new-folder', label: 'New folder…', run: () => command('new-folder') },
    onFiles && { id: 'upload', label: 'Upload files…', run: () => command('upload') },
    onFiles && { id: 'info', label: 'Get info', hint: 'Open folder', run: () => command('info') },
    isAdmin && { id: 'new-drive', label: 'New drive…', run: () => (onFiles ? command('new-drive') : go('/files?new=drive')) },
    isAdmin && { id: 'storage', label: 'Storage usage', hint: 'What is using the space', run: () => go('/admin/usage') },
    isAdmin && { id: 'duplicates', label: 'Find duplicate files', hint: 'Storage', run: () => go('/admin/usage/duplicates') },
    isAdmin && { id: 'admin', label: 'Admin', run: () => go('/admin') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', hint: '?', run: () => { onClose(); onShortcuts?.(); } },
    { id: 'light', label: 'Theme: Light', run: () => { setThemePref('light'); onClose(); } },
    { id: 'dark', label: 'Theme: Dark', run: () => { setThemePref('dark'); onClose(); } },
    { id: 'system', label: 'Theme: System', run: () => { setThemePref('system'); onClose(); } },
    { id: 'signout', label: 'Sign out', run: () => { window.location.href = '/api/auth/signout'; } },
  ].filter(Boolean), [onFiles, isAdmin, go, command, onClose, onShortcuts]);

  const term = q.trim().toLowerCase();
  const match = (s) => !term || String(s).toLowerCase().includes(term);

  // Which drive a result lives in, by its place in the bucket, so its path
  // reads from the drive rather than from "All files".
  const driveOf = useCallback((f) => drives
    .filter((d) => d.prefix && String(f.storageKey || '').startsWith(`${d.prefix}/`))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0] || null, [drives]);

  const sections = useMemo(() => {
    const out = [];
    if (files.length) {
      out.push({
        title: 'Files',
        items: files.map((f) => ({
          id: `f:${f.id}`,
          label: f.name,
          hint: `${crumbsFor(f.folder || '', driveOf(f)?.name || 'All files').map((c) => c.name).join(' / ')} · ${kindLabel(f)}${f.size ? ` · ${fmtSize(f.size)}` : ''}`,
          thumb: f.thumbnailUrl || null,
          run: () => go(`/files/${f.id}`),
        })),
      });
    }
    const fl = term ? (folders || []).filter((f) => match(f.folder)).slice(0, MAX_FOLDERS) : [];
    if (fl.length) {
      out.push({
        title: 'Folders',
        items: fl.map((f) => ({
          id: `d:${f.folder}`,
          label: f.name,
          hint: f.folder.includes('/') ? f.folder.slice(0, f.folder.lastIndexOf('/')) : 'All files',
          icon: 'folder',
          run: () => go(`/files?folder=${encodeURIComponent(f.folder)}`),
        })),
      });
    }
    const dr = drives.filter((d) => match(d.name));
    if (dr.length) {
      out.push({
        title: 'Drives',
        items: dr.map((d) => ({
          id: `v:${d.id}`,
          label: d.name,
          hint: ROLE_WORDS[d.role] || '',
          icon: 'drive',
          run: () => go(`/files?filespace=${encodeURIComponent(d.id)}`),
        })),
      });
    }
    const ac = actions.filter((a) => match(a.label));
    if (ac.length) out.push({ title: 'Actions', items: ac });
    return out;
    // `match` closes over `term`, which is in the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files, folders, drives, actions, term, go, driveOf]);

  const flat = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  useEffect(() => { setActive(0); }, [q]);
  useEffect(() => {
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(flat.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); flat[active]?.run(); }
  };

  let n = -1;
  return (
    <dialog
      ref={dialog}
      className="palette"
      aria-label="Search and commands"
      onClose={onClose}
      onPointerDown={(e) => { if (e.target === dialog.current) onClose(); }}
    >
      <div className="palette-box" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden className="palette-glass">
            <circle cx="7" cy="7" r="4.75" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="m10.5 10.5 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input
            ref={input}
            className="palette-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search files, folders, drives and actions…"
            aria-label="Search"
            aria-controls="palette-list"
            aria-activedescendant={flat[active] ? `pal-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          {searching && <span className="small muted">Searching…</span>}
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {sections.map((s) => (
            <div key={s.title} role="group" aria-label={s.title}>
              <div className="palette-section">{s.title}</div>
              {s.items.map((it) => {
                n += 1;
                const i = n;
                return (
                  <div
                    key={it.id}
                    id={`pal-${i}`}
                    role="option"
                    aria-selected={i === active}
                    data-active={i === active}
                    className={`palette-item${i === active ? ' is-active' : ''}`}
                    onPointerMove={() => setActive(i)}
                    onClick={() => it.run()}
                  >
                    <span className="palette-icon" aria-hidden>
                      {it.thumb ? <img src={it.thumb} alt="" /> : it.icon === 'folder' ? <FolderGlyph /> : it.icon === 'drive' ? <DriveGlyph /> : <span className="palette-dot" />}
                    </span>
                    <span className="palette-label truncate">{it.label}</span>
                    {it.hint && <span className="palette-hint truncate">{it.hint}</span>}
                  </div>
                );
              })}
            </div>
          ))}
          {!flat.length && (
            <p className="palette-empty small muted">
              {term ? (searching ? 'Searching…' : `Nothing matches “${q.trim()}”.`) : 'Type to search the whole library.'}
            </p>
          )}
        </div>
      </div>
    </dialog>
  );
}

const FolderGlyph = () => (
  <svg viewBox="0 0 24 24" width="16" height="16"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.3l2 2h8.7A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
);
const DriveGlyph = () => (
  <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2.5 4.5h11v3h-11zM2.5 8.5h11v3h-11z" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><path d="M11 6h.5M11 10h.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
);
