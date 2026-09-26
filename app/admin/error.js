'use client';

import SectionError from './_ui/SectionError';

/** A section that failed on the server, inside the panel's frame. */
export default function Error({ error, reset }) {
  return <SectionError error={error} reset={reset} />;
}
