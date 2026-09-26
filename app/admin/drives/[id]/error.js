'use client';

import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RouteDrawer from '../../_ui/RouteDrawer';
import AdminState from '../../_ui/AdminState';

/** The drive could not be loaded: say so in the drawer, with Retry. */
export default function Error({ error, reset }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const message = [
    'The database may be unreachable, or slow to answer. Try again, or open Health to see which check fails.',
    error?.digest ? `The server log has the details under ${error.digest}.` : '',
  ].filter(Boolean).join(' ');
  return (
    <RouteDrawer back="/admin/drives" title="Drive">
      <div className="drawer-pad">
        <AdminState
          kind="error"
          title="Couldn’t load this drive."
          error={{ message, status: 0, body: !error?.digest && error?.message ? error.message : null }}
          action={<Link href="/admin/health" className="btn btn-ghost">Open Health</Link>}
          onRetry={() => start(() => { router.refresh(); reset(); })}
          retrying={pending}
        />
      </div>
    </RouteDrawer>
  );
}
