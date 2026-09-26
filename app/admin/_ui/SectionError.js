'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import AdminState from './AdminState';

/**
 * A section that failed to render on the server (each section's error.js).
 * Retry refetches the section's data and renders it again.
 *
 * In production Next.js withholds a server error's message from the page
 * and sends a digest instead, which is what the server log is searched by;
 * the message here says so rather than inventing a cause.
 */
export default function SectionError({ error, reset, title }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const retry = () => start(() => { router.refresh(); reset(); });
  const message = error?.digest
    ? `The server could not load this section. Its log has the details under ${error.digest}.`
    : error?.message || 'The server could not load this section.';
  return (
    <div className="admin-page">
      <AdminState
        kind="error"
        title={title || 'This section could not be loaded.'}
        error={{ message, status: 0, body: null }}
        onRetry={retry}
        retrying={pending}
      />
    </div>
  );
}
