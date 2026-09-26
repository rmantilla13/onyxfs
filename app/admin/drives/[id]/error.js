'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import RouteDrawer from '../../_ui/RouteDrawer';
import AdminState from '../../_ui/AdminState';

/** The drive could not be loaded: say so in the drawer, with Retry. */
export default function Error({ error, reset }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const message = error?.digest
    ? `The server could not load this drive. Its log has the details under ${error.digest}.`
    : error?.message || 'The server could not load this drive.';
  return (
    <RouteDrawer back="/admin/drives" title="Drive">
      <div className="drawer-pad">
        <AdminState
          kind="error"
          title="This drive could not be loaded."
          error={{ message, status: 0, body: null }}
          onRetry={() => start(() => { router.refresh(); reset(); })}
          retrying={pending}
        />
      </div>
    </RouteDrawer>
  );
}
