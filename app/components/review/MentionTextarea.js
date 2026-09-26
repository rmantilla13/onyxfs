'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { handleOf, personLabel } from './format';

/**
 * A textarea that knows about @mentions. Typing "@" and a few letters asks
 * the server who could be named (GET …/mentionable — only people who can
 * read the file); picking one writes "@handle" into the text and remembers
 * the address. What is sent is the addresses whose handle is still in the
 * text when the comment is posted (mentionsIn), so deleting "@mo" un-mentions
 * Mo.
 *
 * Enter sends and Shift+Enter is a new line, as in every chat box — except
 * while the suggestions are open, when Enter picks one.
 */
export default function MentionTextarea({
  fileId, value, onChange, people, onPeopleChange, onSubmit, onEscape, onFocus,
  textareaRef, placeholder = 'Add a comment…', rows = 3, disabled = false, label = 'Comment',
}) {
  const own = useRef(null);
  const ref = textareaRef || own;
  const [query, setQuery] = useState(null);
  const [options, setOptions] = useState([]);
  const [index, setIndex] = useState(0);
  const listId = useId();

  // The "@token" just before the caret, if there is one.
  const detect = (el) => {
    const upto = el.value.slice(0, el.selectionStart ?? el.value.length);
    const m = /(^|\s)@([^\s@]{0,40})$/.exec(upto);
    setQuery(m ? { text: m[2], start: upto.length - m[2].length - 1 } : null);
  };

  const term = query ? query.text : null;
  useEffect(() => {
    if (term == null || !fileId) { setOptions([]); return undefined; }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/files/${encodeURIComponent(fileId)}/mentionable?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const out = await r.json().catch(() => ({}));
        setOptions(r.ok && Array.isArray(out.people) ? out.people : []);
        setIndex(0);
      } catch { /* a stale or failed lookup shows nothing */ }
    }, 180);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [term, fileId]);

  const pick = (p) => {
    const el = ref.current;
    if (!el || !query) return;
    const handle = handleOf(p.email);
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, query.start);
    const next = `${before}@${handle} ${value.slice(caret)}`;
    onChange(next);
    if (!people.some((x) => x.email === p.email)) onPeopleChange([...people, p]);
    setQuery(null);
    setOptions([]);
    requestAnimationFrame(() => {
      el.focus();
      const pos = before.length + handle.length + 2;
      el.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e) => {
    if (e.nativeEvent.isComposing) return;
    if (query && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[index]); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setQuery(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSubmit?.(); return; }
    if (e.key === 'Escape') onEscape?.(e);
  };

  const open = !!query && options.length > 0;
  return (
    <div className="review-textarea">
      <textarea
        ref={ref}
        className="input"
        rows={rows}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        disabled={disabled}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        onChange={(e) => { onChange(e.target.value); detect(e.target); }}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') detect(e.currentTarget); }}
        onClick={(e) => detect(e.currentTarget)}
        onFocus={onFocus}
        onBlur={() => setTimeout(() => setQuery(null), 150)}
      />
      {open && (
        <ul className="review-mentions" id={listId} role="listbox" aria-label="People who can see this file">
          {options.map((p, i) => (
            <li
              key={p.email}
              role="option"
              aria-selected={i === index}
              className="review-mention-option"
              onMouseDown={(e) => { e.preventDefault(); pick(p); }}
              onMouseEnter={() => setIndex(i)}
            >
              <span>{personLabel(p)}</span>
              <span className="small muted truncate">{p.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The addresses of `people` still named ("@handle") in `text`. */
export function mentionsIn(text, people = []) {
  const handles = new Set((String(text || '').match(/@[^\s@]+/g) || []).map((h) => h.slice(1).replace(/[.,;:!?)]+$/, '').toLowerCase()));
  return people.filter((p) => handles.has(handleOf(p.email).toLowerCase())).map((p) => p.email);
}
