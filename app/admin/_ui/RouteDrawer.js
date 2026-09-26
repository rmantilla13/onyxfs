'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Drawer from './Drawer';

/**
 * A Drawer that is a page: it is open because its route is, and closing it
 * is going back to the list at `back`. Used by the drawer routes and their
 * loading and error states, which are server files and cannot hand a
 * function to Drawer themselves.
 */
export default function RouteDrawer({ back, children, ...props }) {
  const router = useRouter();
  const close = useCallback(() => router.push(back, { scroll: false }), [router, back]);
  return <Drawer {...props} onClose={close}>{children}</Drawer>;
}
