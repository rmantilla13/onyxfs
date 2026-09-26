'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { sectionLabel } from '../nav';
import AdminPage from './AdminPage';
import AdminState from './AdminState';

/**
 * A section that failed to render on the server (each section's error.js,
 * and app/admin/error.js for the Overview and the sections' layouts).
 *
 * The section keeps its heading, so the page still says where you are,
 * and the message says what probably went wrong and what to do next: the
 * server-side data of every section comes from the database, so that is
 * the likely fault, and Health says which check fails. Retry refetches
 * the section's data and renders it again.
 *
 * In production Next.js withholds a server error's message from the page
 * and sends a digest instead, which is what the server log is searched by;
 * the message says so rather than inventing a cause. In development the
 * real message is one click away.
 */
export default function SectionError({ error, reset, section }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, start] = useTransition();
  const retry = () => start(() => { router.refresh(); reset(); });
  const name = section || sectionLabel(pathname) || 'This section';
  const message = [
    'The database may be unreachable, or slow to answer.',
    name === 'Health' ? 'Try again in a moment.' : 'Try again, or open Health to see which check fails.',
    error?.digest ? `The server log has the details under ${error.digest}.` : '',
  ].filter(Boolean).join(' ');
  return (
    <AdminPage title={name}>
      <AdminState
        kind="error"
        title={`Couldn’t load ${name === 'This section' ? 'this section' : name}.`}
        error={{ message, status: 0, body: !error?.digest && error?.message ? error.message : null }}
        onRetry={retry}
        retrying={pending}
        action={name === 'Health' ? null : <Link href="/admin/health" className="btn btn-ghost">Open Health</Link>}
      />
    </AdminPage>
  );
}
