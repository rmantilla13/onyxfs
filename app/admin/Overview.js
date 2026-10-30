'use client';

import { fmtSize } from '@/lib/media';
import { plural } from '@/lib/admin-format';
import { healthChecks, isHealthReport } from '@/lib/health-checks';
import { attentionItems } from '@/lib/admin-overview';
import CountUp from '@/app/components/motion/CountUp';
import ShinyText from '@/app/components/motion/ShinyText';
import AdminPage, { AdminCard } from './_ui/AdminPage';
import AttentionItem from './_ui/AttentionItem';
import { StatTile } from './_ui/StatTile';
import { useAdminResource } from './_ui/api';
import ClaimDrives from './drives/ClaimDrives';

const size = (n) => fmtSize(n) || '0 B';
// A size's figure and unit apart, so it counts in the unit it lands in
// instead of climbing through B, KB and MB on the way there.
const sizeCount = (n) => {
  const [figure, unit] = size(n).split(' ');
  return { to: Number(figure), decimals: figure.includes('.') ? 1 : 0, grouping: false, suffix: ` ${unit}` };
};
const HEALTH_WORD = { ok: 'Working', warn: 'Needs a look', fail: 'Failing' };
const HEALTH_TONE = { warn: 'warning', fail: 'danger' };

/**
 * The Overview's body. Everything but health comes from the server render;
 * health is asked of /api/health from here, because its storage check
 * talks to the bucket and a slow bucket should not hold the page. A 503 is
 * still an answer — it is the one that says what is wrong — when it is the
 * health report; a 503 page from a proxy is an error (isHealthReport).
 *
 * A tile's tone colours the words that say what is wrong (its sub-line),
 * never the number, and a danger tone its border too.
 *
 * Drives with no owner come with their fix beside the warning ("Make me the
 * owner…", ClaimDrives): it needs no look first, only a confirm.
 */
export default function Overview({ pending, drives, totals }) {
  const health = useAdminResource('/api/health', { accept: [503], valid: isHealthReport });
  const h = health.data ? healthChecks(health.data) : null;
  const items = attentionItems({ pending, drivesWithoutOwner: drives.withoutOwner, health: h });

  return (
    <AdminPage title="Overview" description="The state of this workspace at a glance, and anything that needs you.">
      <div className="admin-tiles">
        {/* People waiting is the queue doing its job, not an alarm: no tone. */}
        <StatTile
          label="Access requests"
          value={<CountUp to={pending.length} />}
          sub={pending.length ? 'waiting for a decision' : 'No one is waiting'}
          href="/admin/requests"
        />
        <StatTile
          label="Storage used"
          value={<CountUp {...sizeCount(totals.live.bytes)} />}
          sub={`${plural(totals.live.files, 'file')} · ${size(totals.trash.bytes)} in the trash`}
          href="/admin/usage"
        />
        <StatTile
          label="Drives"
          value={<CountUp to={drives.count} />}
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
          sub={h ? h.label : health.error ? 'The checks could not be run.' : <ShinyText>Checking…</ShinyText>}
          href="/admin/health"
          tone={h ? HEALTH_TONE[h.status] : health.error ? 'warning' : undefined}
        />
      </div>

      <AdminCard title="Needs attention" id="attention">
        {items.length === 0 ? (
          <p className="attention-clear muted">
            {health.loading && !h ? <ShinyText>Checking…</ShinyText> : 'Nothing needs attention.'}
          </p>
        ) : (
          <ul className="attention">
            {items.map((item) => (
              <AttentionItem key={item.id} item={item}>
                {item.claim && <ClaimDrives drives={item.claim} />}
              </AttentionItem>
            ))}
          </ul>
        )}
        {health.loading && !h && items.length > 0 && (
          <p className="small muted attention-foot" role="status"><ShinyText>Checking health…</ShinyText></p>
        )}
        {health.error && (
          <p className="small muted attention-foot">
            The health checks did not answer, so problems with storage or email are not listed here. {health.error.message}{' '}
            <button type="button" className="btn btn-ghost btn-sm" onClick={health.reload}>Try again</button>
          </p>
        )}
      </AdminCard>
    </AdminPage>
  );
}
