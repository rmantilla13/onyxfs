'use client';

import { useEffect, useState } from 'react';
import { relativeTime } from '@/lib/admin-format';

const fmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null;

/**
 * "3 hours ago", with the exact time on hover. The words depend on the
 * clock, which the server and the browser read at different moments, so the
 * text is refreshed after mount and once a minute rather than trusted from
 * the server's render.
 */
export default function RelativeTime({ ms, prefix = '' }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60e3);
    return () => clearInterval(t);
  }, []);
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return null;
  const words = relativeTime(t, now);
  return (
    <time dateTime={new Date(t).toISOString()} title={fmt ? fmt.format(new Date(t)) : undefined} suppressHydrationWarning>
      {prefix}{words}
    </time>
  );
}
