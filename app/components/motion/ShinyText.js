/*
 * Adapted from ShinyText in React Bits (https://github.com/DavidHDev/react-bits).
 * Copyright (c) 2026 David Haz. MIT + Commons Clause — LICENSE-react-bits.md.
 */
import './motion.css';

/**
 * A label with a band of ink passing over it, for a wait that is real — a
 * check that has to reach the bucket — and not a click's round trip, which
 * is over before one pass is. React Bits' ShinyText in its looping mode, as
 * a gradient clipped to the text (motion.css). It loops, so it is on screen
 * only for as long as the wait; with reduced motion the label just reads.
 */
export default function ShinyText({ children, className = '' }) {
  return <span className={`shiny-text${className ? ` ${className}` : ''}`}>{children}</span>;
}
