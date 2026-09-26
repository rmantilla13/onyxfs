'use client';

import { useEffect, useId, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { activeHref } from '@/lib/section-nav';
import './SectionRail.css';

/**
 * The left rail of a sectioned area — Admin now, Account next. Each item is
 * a link, so reload, back and deep links all work, and the page you are on is
 * marked with aria-current="page" as well as .is-active.
 *
 * At 900px and wider it is a sticky column; narrower, a strip under the nav
 * that scrolls sideways, with the current item scrolled into view.
 *
 *   groups: [{ label?, items: [{ href, label, exact?, count?, countLabel? }] }]
 *
 * `count` shows as a badge (a pending queue); `countLabel` is what a screen
 * reader hears for it ("3 waiting"). Groups with no items are not drawn.
 */
export default function SectionRail({ label, groups = [] }) {
  const pathname = usePathname();
  const nav = useRef(null);
  const base = useId();
  const shown = groups.filter((g) => g?.items?.length);
  const active = activeHref(pathname, shown.flatMap((g) => g.items));

  // In the strip, keep the current section in view. Horizontal only: the
  // page must not jump vertically because the rail moved.
  useEffect(() => {
    const el = nav.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const on = el.querySelector('[aria-current="page"]');
    if (!on) return;
    const left = on.offsetLeft - (el.clientWidth - on.offsetWidth) / 2;
    el.scrollTo({ left: Math.max(0, left) });
  }, [active]);

  return (
    <nav className="rail" aria-label={label} ref={nav}>
      {shown.map((g, gi) => {
        const headingId = g.label ? `${base}-${gi}` : undefined;
        return (
          <div key={g.label || gi} className="rail-group">
            {g.label && <p className="rail-heading" id={headingId}>{g.label}</p>}
            <ul className="rail-list" aria-labelledby={headingId}>
              {g.items.map((item) => {
                const on = item.href === active;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`rail-link${on ? ' is-active' : ''}`}
                      aria-current={on ? 'page' : undefined}
                    >
                      <span className="rail-label">{item.label}</span>
                      {item.count > 0 && (
                        <span className="count-badge rail-count">
                          <span aria-hidden>{item.count}</span>
                          <span className="sr-only">{`, ${item.countLabel || item.count}`}</span>
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
