'use client';

import { useEffect, useState } from 'react';
import Icon from '@/app/components/ui/Icon';
import FolderMosaic from '@/app/components/ui/FolderMosaic';
import { ROLE_WORDS, usageLine } from '@/app/components/Drives';
import { useFolderPreview } from '@/app/files/useFolderPreview';
import { driveColor } from '@/lib/drive-color';

/**
 * One drive as a card: a mosaic of its newest pictures across the whole
 * drive (useFolderPreview on its top), its colour, its name, and the line
 * the sidebar gives it — usage for the people who look after it, what they
 * may do in it for everyone else. A link: it opens the drive in Files.
 */
function DriveCard({ id = '', name, detail, href, library = false }) {
  const { ref, tiles } = useFolderPreview(id, '');
  const pictures = Array.isArray(tiles) && tiles.length > 0;
  return (
    <a ref={ref} className="drive-card" href={href} style={{ '--drive': driveColor(library ? '' : id) }} title={name}>
      <span className={`drive-card-cover${pictures ? '' : ' is-empty'}`}>
        {pictures
          ? <FolderMosaic tiles={tiles} large className="drive-card-mosaic" />
          : (
            <span className="drive-card-icon" aria-hidden>
              <Icon name={library ? 'folders' : 'hard-drive'} size={30} /* icons: folders hard-drive */ />
            </span>
          )}
      </span>
      <span className="drive-card-text">
        <span className="drive-card-name truncate">
          <span className="drive-card-dot" aria-hidden />
          {name}
        </span>
        {detail && <span className="drive-card-detail truncate">{detail}</span>}
      </span>
    </a>
  );
}

/**
 * The drives page's grid (app/drives/page.js): All files first while there
 * is one, then every drive by name. Usage is /api/filespaces/usage's, as the
 * sidebar's: given only for drives this person looks after, and for All
 * files only to an admin.
 */
export default function DrivesGrid({ drives = [], library = false, failed = false }) {
  const [usage, setUsage] = useState({ usage: {}, library: null });
  useEffect(() => {
    let live = true;
    fetch('/api/filespaces/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((u) => { if (live && u) setUsage({ usage: u.usage || {}, library: u.library || null }); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const sorted = [...drives].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const count = sorted.length + (library ? 1 : 0);
  return (
    <main className="drives-page">
      <header className="drives-page-head">
        <h1 className="drives-page-title">Drives</h1>
        <p className="small muted drives-page-count">
          {failed
            ? 'Your drives can’t be listed right now. Try again in a moment.'
            : `${sorted.length.toLocaleString()} drive${sorted.length === 1 ? '' : 's'}${library ? ', and All files' : ''}`}
        </p>
      </header>
      {count === 0 && !failed ? (
        <p className="muted drives-page-empty">No drives yet. A drive is a space of its own, with its own members.</p>
      ) : (
        <div className="drive-cards">
          {library && (
            <DriveCard
              library
              name="All files"
              href="/files"
              detail={usage.library ? usageLine(usage.library) : 'Everything you can open'}
            />
          )}
          {sorted.map((d) => (
            <DriveCard
              key={d.id}
              id={d.id}
              name={d.name}
              href={`/files?filespace=${encodeURIComponent(d.id)}`}
              detail={usage.usage[d.id] ? usageLine(usage.usage[d.id]) : ROLE_WORDS[d.role] || d.role}
            />
          ))}
        </div>
      )}
    </main>
  );
}
