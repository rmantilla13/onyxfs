'use client';

import { useEffect, useState } from 'react';
import { healthChecks, isHealthReport } from '@/lib/health-checks';
import AdminPage, { AdminCard } from '../_ui/AdminPage';
import AdminState from '../_ui/AdminState';
import CheckList from '../_ui/CheckList';
import RelativeTime from '../_ui/RelativeTime';
import { useAdminResource } from '../_ui/api';

const VERDICT_TAG = { ok: 'tag-accent', warn: 'tag-warning', fail: 'tag-danger' };
const VERDICT_WORD = { ok: 'Working', warn: 'Needs a look', fail: 'Failing' };

/**
 * The checks, and Refresh. A 503 from /api/health is the case this page is
 * for — its body names the failing check — so it is read like a 200, when
 * it is the report (isHealthReport). A 503 from anything in front of the
 * route is not, and is shown as the error it is.
 */
export default function HealthClient() {
  const health = useAdminResource('/api/health', { accept: [503], valid: isHealthReport });
  const [checkedAt, setCheckedAt] = useState(0);
  useEffect(() => { if (!health.loading) setCheckedAt(Date.now()); }, [health.loading]);

  const h = health.data ? healthChecks(health.data) : null;
  const refresh = (
    <button type="button" className="btn" onClick={health.reload} disabled={health.loading}>
      {health.loading && h ? 'Checking…' : 'Refresh'}
    </button>
  );

  return (
    <AdminPage
      title="Health"
      description="Whether this deployment can reach what it depends on: the database, storage, email and scheduled maintenance."
      actions={refresh}
    >
      {!h && health.loading && <AdminState kind="loading" rows={5} />}
      {!h && health.error && (
        <AdminState
          kind="error"
          title="The checks could not be run."
          error={health.error.status && !isHealthReport(health.error.body) && !(health.error.body && typeof health.error.body === 'object' && health.error.body.error)
            ? {
              ...health.error,
              message: `The health endpoint answered ${health.error.status} without its report, so something in front of this deployment answered for it, or the deployment is down. Check the hosting provider’s status and this deployment’s logs, then try again.`,
            }
            : health.error}
          onRetry={health.reload}
          retrying={health.loading}
        />
      )}
      {h && (
        <AdminCard
          title="Checks"
          id="checks"
          actions={checkedAt ? <span className="small muted">Checked <RelativeTime ms={checkedAt} /></span> : null}
        >
          <p className="admin-verdict">
            <span className={`tag ${VERDICT_TAG[h.status]}`}>{VERDICT_WORD[h.status]}</span>
            <span className="small">{h.label}</span>
            {health.status === 503 && <span className="small muted">The health endpoint answered 503, which monitors read as down.</span>}
          </p>
          <CheckList checks={h.checks} label="Health checks" />
        </AdminCard>
      )}
      <p className="small muted admin-note">
        When sign-in itself is broken, the same checks answer at <span className="admin-mono">/api/health</span> to a request carrying CRON_SECRET as a bearer token.
      </p>
    </AdminPage>
  );
}
