'use client';

import { memo, useId, useMemo } from 'react';
import { decodeWaveform, waveformBars } from '@/lib/waveform';

// The quietest bar still drawn as a sliver, so silence reads as a line
// rather than a gap in the picture.
const FLOOR = 0.06;

/**
 * The bars of a sound's waveform (lib/waveform.js) as one SVG path, mirrored
 * about the middle. It fills its box — the box's CSS gives the size; `count`
 * is how many bars (fewer than stored are the loudest of those they cover;
 * more are the stored ones, wider).
 *
 * `tone` 'plain' draws in `currentColor`, so whatever holds it decides the
 * colour; 'aura' in the brand's gradient (--aura-a into --aura-b), the one
 * the primary buttons wear. Both come from the theme's properties, so a
 * brand or the dark scheme repaints it.
 *
 * Null when `waveform` is not one this reads — the caller shows what it
 * showed before there were waveforms.
 */
function Waveform({ waveform, count = 48, gap = 0.3, tone = 'plain', className }) {
  const gradient = `wave${useId().replace(/[^\w-]/g, '')}`;
  const d = useMemo(() => {
    const bars = waveformBars(decodeWaveform(waveform), count);
    if (!bars.length) return null;
    const w = (1 - gap).toFixed(3);
    let path = '';
    for (let i = 0; i < bars.length; i++) {
      const h = Math.max(FLOOR, bars[i]) * 100;
      path += `M${(i + gap / 2).toFixed(3)} ${(50 - h / 2).toFixed(2)}h${w}v${h.toFixed(2)}h-${w}z`;
    }
    return { path, width: bars.length };
  }, [waveform, count, gap]);
  if (!d) return null;
  return (
    <svg className={className} viewBox={`0 0 ${d.width} 100`} preserveAspectRatio="none" aria-hidden focusable="false">
      {tone === 'aura' && (
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" style={{ stopColor: 'var(--aura-a, var(--accent))' }} />
            <stop offset="1" style={{ stopColor: 'var(--aura-b, var(--accent))' }} />
          </linearGradient>
        </defs>
      )}
      <path d={d.path} fill={tone === 'aura' ? `url(#${gradient})` : 'currentColor'} />
    </svg>
  );
}

export default memo(Waveform);
