/**
 * /api/health's body as the rows Admin → Health shows (CheckList): one line
 * per thing that can be wrong, each with what was found and, when it is
 * wrong, what to do about it. Client-safe and pure.
 *
 * The body is read the same whether the route answered 200 or 503: a 503 is
 * the case this page exists for, and its body is the only place that says
 * which check failed.
 */

const row = (id, label, status, detail = '', fix = '') => ({ id, label, status, detail, fix });

/**
 * Is this body /api/health's report? A 503 is read as data only when it is:
 * a platform's own 503 (a paused deployment, a throttled function, a proxy)
 * is an HTML page or nothing, and the time this page matters most.
 */
export function isHealthReport(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && !!body.checks && typeof body.checks === 'object' && !Array.isArray(body.checks);
}

export function healthChecks(body) {
  // Not a report: never "Everything is working". Nothing was checked, and
  // whatever answered instead is itself the problem.
  if (!isHealthReport(body)) {
    return {
      status: 'fail',
      label: 'The health endpoint did not return a report.',
      checks: [row('endpoint', 'Health endpoint', 'fail',
        typeof body === 'string' && body.trim()
          ? 'It answered with a page instead of the checks, so something in front of this deployment is answering for it.'
          : 'It answered without the checks.',
        'Open /api/health directly, and check the hosting provider’s status and this deployment’s logs.')],
    };
  }
  const b = body;
  const c = b.checks;
  const env = c.env || {};
  const rows = [];

  // Database: reachable, how fast, and through which variable.
  const via = env.connectionVia
    ? `via ${env.connectionVia}${env.bothConnectionVarsSet ? ' (POSTGRES_URL is set too)' : ''}`
    : '';
  if (env.DATABASE_URL === false) {
    rows.push(row('database', 'Database', 'fail', 'No connection string is set.',
      'Set DATABASE_URL to the Postgres connection string and redeploy.'));
  } else if (c.database?.ok) {
    const ms = Number(c.database.latencyMs);
    const slow = ms > 1000;
    rows.push(row('database', 'Database', slow ? 'warn' : 'pass',
      [Number.isFinite(ms) ? `Answered in ${ms} ms` : 'Answering', via].filter(Boolean).join(' · '),
      slow ? 'Slow answers make every page slow. Check the database region and the connection pooler.' : ''));
  } else if (c.database) {
    rows.push(row('database', 'Database', 'fail', c.database.error || 'Not answering.',
      'Check DATABASE_URL, and that the database is up and reachable from this deployment.'));
  }

  if ('AUTH_SECRET' in env) {
    rows.push(env.AUTH_SECRET
      ? row('auth-secret', 'Sign-in secret', 'pass', 'AUTH_SECRET is set.')
      : row('auth-secret', 'Sign-in secret', 'fail', 'AUTH_SECRET is not set, so sessions cannot be signed.',
        'Generate one with `openssl rand -base64 32`, set AUTH_SECRET and redeploy.'));
  }

  // Storage: where files live, and whether it answers.
  const s = c.storage;
  if (s) {
    if (s.ok === false) {
      rows.push(row('storage', 'Storage', 'fail', s.error || 'Could not read the storage settings.',
        'Open Storage → Backend and run the diagnostics.'));
    } else if (s.mode === 's3') {
      rows.push(s.reachable === false
        ? row('storage', 'Storage', 'fail', `Bucket "${s.bucket}" is not answering${s.error ? `: ${s.error}` : '.'}`,
          'Open Storage → Backend and run the diagnostics: each failing check says what to change.')
        : row('storage', 'Storage', 'pass', `Bucket "${s.bucket}" is answering.`));
    } else {
      rows.push(row('storage', 'Storage', 'warn', 'Files are kept in Vercel Blob.',
        'Drives and the desktop app need an S3-compatible bucket. Set one up in Storage → Backend.'));
    }
  }

  // Email: the magic link is the only way in, so no key means no sign-in.
  if ('RESEND_API_KEY' in env) {
    if (!env.RESEND_API_KEY) {
      rows.push(row('email', 'Email', 'fail', 'RESEND_API_KEY is not set, so sign-in emails cannot be sent.',
        'Create a Resend API key, set RESEND_API_KEY and redeploy.'));
    } else if (env.NOTIFY_FROM === false) {
      rows.push(row('email', 'Email', 'warn', 'Emails are sent from Resend’s shared test address.',
        'Set NOTIFY_FROM to an address on a domain you have verified with Resend. Mail from the shared address is often filtered as spam.'));
    } else {
      rows.push(row('email', 'Email', 'pass', 'Resend is set up, with a sender of your own.'));
    }
  }

  if ('CRON_SECRET' in env) {
    rows.push(env.CRON_SECRET
      ? row('cron', 'Scheduled maintenance', 'pass', 'CRON_SECRET is set.')
      : row('cron', 'Scheduled maintenance', 'warn', 'CRON_SECRET is not set, so the daily maintenance is refused.',
        'Set CRON_SECRET. Until then the trash is never purged and stalled uploads are never cleaned up.'));
  }

  // Optional services: on or off, neither of which is a problem.
  const covered = new Set(['postgres', 'auth', 'resend', 's3', 'blob']);
  for (const i of Array.isArray(c.integrations) ? c.integrations : []) {
    if (!i || covered.has(i.key)) continue;
    rows.push(i.configured
      ? row(`int-${i.key}`, i.name || i.key, 'pass', 'Set up.')
      : i.status === 'required'
        ? row(`int-${i.key}`, i.name || i.key, 'fail', `Missing: ${(i.vars || []).filter((v) => !v.set).map((v) => v.key).join(', ')}.`)
        : row(`int-${i.key}`, i.name || i.key, 'off', 'Not set up. Optional.'));
  }

  if (b.version || b.build) {
    // The build label already starts with the version ("0.1.0 · 3f2c1ab").
    const build = String(b.build || '');
    const text = build && (!b.version || build.startsWith(String(b.version))) ? build : [b.version, build].filter(Boolean).join(' · ');
    rows.push(row('version', 'Version', 'info', text));
  }

  const failed = rows.filter((r) => r.status === 'fail').length;
  const warned = rows.filter((r) => r.status === 'warn').length;
  const status = failed || b.ok === false ? 'fail' : warned ? 'warn' : 'ok';
  const label = status === 'fail'
    ? (failed ? `${failed} ${failed === 1 ? 'problem needs' : 'problems need'} fixing.` : 'Something is wrong.')
    : status === 'warn'
      ? `Working, with ${warned} ${warned === 1 ? 'thing' : 'things'} to look at.`
      : 'Everything is working.';
  return { status, label, checks: rows };
}
