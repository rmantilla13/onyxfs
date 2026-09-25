'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';

export default function TopNav({ brandName, markPath, email, isAdmin, build }) {
  const pathname = usePathname();
  const is = (href) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header style={{ borderBottom: '1px solid var(--line)', background: '#fff', position: 'sticky', top: 0, zIndex: 10 }}>
      <div className="shell row" style={{ height: 56, flexWrap: 'nowrap', minWidth: 0 }}>
        <Link href="/files" className="row" style={{ gap: 8 }}>
          <img src={markPath} alt="" width={24} height={24} style={{ borderRadius: 6 }} />
          <strong style={{ fontFamily: 'var(--font-display)', letterSpacing: '-0.02em' }}>{brandName}</strong>
        </Link>

        <nav className="row" style={{ gap: 4, marginLeft: 12 }}>
          <NavLink href="/files" active={is('/files')}>Files</NavLink>
          {isAdmin && <NavLink href="/admin" active={is('/admin')}>Admin</NavLink>}
        </nav>

        <div className="spacer" />

        {/* Which build is serving this page. The first question when
            something looks wrong in production is whether the fix is even
            live yet, and a version alone does not answer it. Hidden on a
            phone, where the space is worth more than the answer. */}
        {build && (
          <span className="small muted nav-build mono" title={build.detail || build.label}>{build.label}</span>
        )}
        <span className="small muted nav-email" title={email}>{email}</span>
        <a className="small muted" href="/api/auth/signout" style={{ whiteSpace: 'nowrap' }}>Sign out</a>
      </div>
    </header>
  );
}

function NavLink({ href, active, children }) {
  return (
    <Link
      href={href}
      style={{
        padding: '6px 10px',
        borderRadius: 'var(--radius)',
        fontSize: 14,
        fontWeight: active ? 600 : 400,
        background: active ? 'color-mix(in srgb, var(--ink) 6%, transparent)' : 'transparent',
      }}
    >
      {children}
    </Link>
  );
}
