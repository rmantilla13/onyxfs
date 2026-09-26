'use client';

import { useState } from 'react';

/** Copy some text, and say so. Falls back to selecting nothing quietly when the clipboard is refused. */
export default function CopyButton({ text, label = 'Copy', className = 'btn btn-sm' }) {
  const [state, setState] = useState('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(text ?? ''));
      setState('done');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button type="button" className={className} onClick={copy} aria-live="polite">
      {state === 'done' ? 'Copied' : state === 'failed' ? 'Copy failed — select it by hand' : label}
    </button>
  );
}
