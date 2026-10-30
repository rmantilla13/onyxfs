/*
 * Adapted from BlurText in React Bits (https://github.com/DavidHDev/react-bits).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause — LICENSE-react-bits.md.
 */
import { Fragment } from 'react';
import './motion.css';

/**
 * A line that arrives a word at a time, each one settling down out of a
 * blur a beat after the one before. React Bits' BlurText, reduced to what a
 * page's arrival needs and to CSS alone (motion.css): it runs from the
 * server's HTML, with no script to load and no hydration to wait for, and
 * renders in a server component as well as a client one.
 *
 * It is bound to arriving, never to a timer, and it is short — four words
 * are in place in under 600 ms, before anyone has typed into the field the
 * page focused. Reduced motion zeroes the durations it is built from.
 *
 * A screen reader hears the line whole, from the copy only it sees; the
 * moving words are hidden from it, or it would read each word on its own.
 */
export default function BlurText({ text, className = '' }) {
  const words = String(text ?? '').split(/\s+/).filter(Boolean);
  return (
    <span className={`blur-text${className ? ` ${className}` : ''}`}>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {words.map((word, i) => (
          <Fragment key={i}>
            {i > 0 && ' '}
            <span className="blur-text-word" style={{ '--blur-i': i }}>{word}</span>
          </Fragment>
        ))}
      </span>
    </span>
  );
}
