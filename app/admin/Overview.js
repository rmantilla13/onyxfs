'use client';

import Link from 'next/link';
import { fmtSize } from '@/lib/media';
import { plural } from '@/lib/admin-format';
import { healthChecks } from '@/lib/health-checks';
import { attentionItems } from '@/lib/admin-overview';
import AdminPage, { AdminCard } from './_ui/AdminPage';
import { StatTile } from './_ui/StatTile';
import { useAdminResource } from './_ui/api';

const size = (n) => fmtSize(n) || '0 B';
const HEALTH_WORD = { ok: 'Working', warn: 'Needs a look', fail: 'Failing' };
const HEALTH_TONE = { warn: 'warning', fail: 'danger' };

/**
 * The Overview's body. Everything but health comes from the server render;
 * health is asked of /api/health from here, because its storage check
 * talks to the bucket and a slow bucket should not hold the page. A 503 is
 * still an answer — it is the one that says what is wrong.
 */
export default function Overview({ pending, drives, totals }) {
  const health = useAdminResource('/api/health', { accept: [503] });
  const h = health.data ? healthChecks(health.data) : null;
  const items = attentionItems({ pending, drivesWithoutOwner: drives.withoutOwner, health: h });

  return (
    <AdminPage title="Overview" description="The state of this workspace at a glance, and anything that needs you.">
      <div className="admin-tiles">
        <StatTile
          label="Access requests"
          value={pending.length.toLocaleString('en-US')}
          sub={pending.length ? 'waiting for a decision' : 'No one is waiting'}
          href="/admin/requests"
          tone={pending.length ? 'warning' : undefined}
        />
        <StatTile
          label="Storage used"
          value={size(totals.live.bytes)}
          sub={`${plural(totals.live.files, 'file')} · ${size(totals.trash.bytes)} in the trash`}
          href="/admin/usage"
        />
        <StatTile
          label="Drives"
          value={drives.count.toLocaleString('en-US')}
          sub={drives.count === 0
            ? 'None yet'
            : drives.withoutOwner.length
              ? `${drives.withoutOwner.length} ${drives.withoutOwner.length === 1 ? 'has' : 'have'} no owner`
              : 'Every drive has an owner'}
          href="/admin/drives"
          tone={drives.withoutOwner.length ? 'warning' : undefined}
        />
        {/* Phase 1: People active (7 days), AI spend this month, Live public links. */}
        <StatTile
          label="Health"
          value={h ? HEALTH_WORD[h.status] : health.error ? 'Unknown' : '…'}
          sub={h ? h.label : health.error ? 'The checks could not be run.' : 'Checking…'}
          href="/admin/health"
          tone={h ? HEALTH_TONE[h.status] : health.error ? 'warning' : undefined}
        />
      </div>

      <AdminCard title="Needs attention" id="attention">
        {items.length === 0 ? (
          <p className="attention-clear muted">
            {health.loading && !h ? 'Checking…' : 'Nothing needs attention.'}
          </p>
        ) : (
          <ul className="attention">
            {items.map((item) => (
              <li key={item.id} className={`attention-item check is-${item.tone === 'danger' ? 'fail' : 'warn'}`}>
                <span className="check-glyph" aria-hidden>{item.tone === 'danger' ? '✗' : '!'}</span>
                <div className="attention-text">
                  <div className="attention-title">
                    {item.title}
                    <span className="sr-only">{item.tone === 'danger' ? ' — failing' : ' — warning'}</span>
                  </div>
                  {item.detail && <div className="attention-detail muted small">{item.detail}</div>}
                </div>
                <Link href={item.href} className="btn btn-sm">{item.action}</Link>
              </li>
            ))}
          </ul>
        )}
        {health.error && (
          <p className="small muted attention-foot">
            The health checks did not answer ({health.error.message}), so storage and email are not listed here.{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={health.reload}>Try again</button>
          </p>
        )}
      </AdminCard>
    </AdminPage>
  );
}
