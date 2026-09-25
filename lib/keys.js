// lib/keys.js — keyboard shortcuts: the platform's modifier, and whether a
// key press belongs to a text field rather than to the page.

/**
 * "⌘" on Apple platforms, "Ctrl+" elsewhere. Read at call time, in the
 * browser: the server cannot know, so anything it renders must not depend on
 * this (a menu or dialog built on interaction is fine).
 */
export function modKey() {
  if (typeof navigator === 'undefined') return '⌘';
  const p = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p) ? '⌘' : 'Ctrl+';
}

/** A key press someone is typing into a field, which a shortcut must leave alone. */
export function isTyping(e) {
  const t = e?.target;
  return !!t?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}
