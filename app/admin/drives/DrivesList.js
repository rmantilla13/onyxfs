'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { fmtSize } from '@/lib/media';
import { plural } from '@/lib/admin-format';
import NewDriveDialog from '@/app/components/drives/NewDriveDialog';
import { useDeleteDrive } from '@/app/components/drives/DeleteDriveConfirm';
import Menu, { MenuItem, MenuSeparator } from '@/app/components/ui/Menu';
import { useToast } from '@/app/components/ui/Toast';
import AdminPage from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import DataTable from '../_ui/DataTable';

const size = (n) => fmtSize(n) || '0 B';
const driveHref = (d, hash = '') => `/admin/drives/${encodeURIComponent(d.id)}${hash}`;

/** Every drive, one row each; a row opens the drive's drawer. */
export default function DrivesList({ rows }) {
  const router = useRouter();
  const toast = useToast();
  const [making, setMaking] = useState(false);
  const { deleteDrive, deleteElement } = useDeleteDrive();

  const remove = async (d) => {
    const done = await deleteDrive(d);
    if (!done) return;
    toast.success(`Deleted the drive “${d.name}”.`);
    router.refresh();
  };

  const columns = [
    { key: 'name', label: 'Name', primary: true, truncate: true },
    {
      key: 'location', label: 'Location', truncate: true,
      render: (d) => <span className="admin-mono" title={`${d.bucket} / ${d.prefix}`}>{d.location}</span>,
    },
    { key: 'members', label: 'Members', num: true, render: (d) => d.members.toLocaleString('en-US') },
    {
      key: 'bytes', label: 'Size', num: true,
      render: (d) => <span title={plural(d.files, 'file')}>{size(d.bytes)}</span>,
    },
    { key: 'files', label: 'Files', num: true, render: (d) => d.files.toLocaleString('en-US') },
    {
      key: 'tags', label: 'Tags', sortable: false,
      render: (d) => (d.tags.length ? (
        <span className="dt-tags">
          {d.tags.map((t) => <span key={t.key} className={`tag tag-${t.tone}`}>{t.label}</span>)}
        </span>
      ) : null),
    },
    {
      key: 'menu', label: `Actions`, actions: true, shrink: true,
      render: (d) => (
        <Menu label={`Actions for ${d.name}`}>
          <MenuItem onClick={() => router.push(driveHref(d), { scroll: false })}>Open</MenuItem>
          <MenuItem onClick={() => router.push(driveHref(d, '#members'), { scroll: false })}>Members…</MenuItem>
          <MenuItem onClick={() => router.push(driveHref(d, '#settings'), { scroll: false })}>Bucket and keys…</MenuItem>
          <MenuItem onClick={() => router.push(`/files?filespace=${encodeURIComponent(d.id)}`)}>Open in Files</MenuItem>
          <MenuSeparator />
          <MenuItem danger onClick={() => remove(d)}>Delete drive…</MenuItem>
        </Menu>
      ),
    },
  ];

  return (
    <AdminPage
      title="Drives"
      description="Each drive is a folder in a bucket with its own members — a disk of its own on the desktop."
      actions={<button type="button" className="btn btn-primary" onClick={() => setMaking(true)}>New drive…</button>}
    >
      <DataTable
        label="Drives"
        columns={columns}
        rows={rows}
        rowHref={(d) => driveHref(d)}
        initialSort={{ key: 'name', dir: 'asc' }}
        empty={(
          <AdminState
            kind="empty"
            title="No drives yet"
            message="A drive gives a team a space of its own: its own folders, its own members, its own volume in the desktop app."
            action={<button type="button" className="btn btn-primary" onClick={() => setMaking(true)}>Make the first drive</button>}
          />
        )}
      />
      {rows.length > 0 && (
        <p className="small muted admin-note">
          {plural(rows.length, 'drive')} · {size(rows.reduce((n, d) => n + d.bytes, 0))} stored in them.
          {rows.length > 1 ? ' A drive inside another counts toward both.' : ''}
          {' '}Admins reach every drive without being members. <Link href="/admin/usage" className="info-link">See usage</Link>
        </p>
      )}
      <NewDriveDialog
        open={making}
        onClose={() => setMaking(false)}
        onCreated={(d) => {
          setMaking(false);
          toast.success(`Made the drive “${d.name}”. Add its members next.`);
          router.push(driveHref(d, '#members'), { scroll: false });
          router.refresh();
        }}
      />
      {deleteElement}
    </AdminPage>
  );
}
