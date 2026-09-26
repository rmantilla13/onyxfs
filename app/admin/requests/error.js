'use client';

import SectionError from '../_ui/SectionError';

export default function Error({ error, reset }) {
  return <SectionError error={error} reset={reset} title="The requests could not be loaded." />;
}
