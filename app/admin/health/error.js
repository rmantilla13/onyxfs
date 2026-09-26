'use client';

import SectionError from '../_ui/SectionError';

export default function Error({ error, reset }) {
  return <SectionError error={error} reset={reset} title="Health could not be shown." />;
}
