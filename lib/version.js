// Single source of truth for the app version. Surfaced in the UI, in the
// admin panel and in /api/health, and reported to the desktop client so it
// can tell whether the control plane it is talking to is newer than the app.
export const VERSION = '0.1.0';

/**
 * Which build is actually serving this request.
 *
 * The version alone does not answer that — it changes at release, while a
 * dozen deploys happen in between. When something looks wrong in production
 * the first question is always "is the fix even live yet", and the commit is
 * what answers it.
 *
 * Vercel injects these at build time; locally they are absent, which is the
 * signal for "dev".
 */
export function buildInfo() {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
  return {
    version: VERSION,
    sha,
    shortSha: sha ? sha.slice(0, 7) : '',
    branch: process.env.VERCEL_GIT_COMMIT_REF || '',
    env: process.env.VERCEL_ENV || 'development',
    // The message is often the fastest way to recognise a deploy.
    message: (process.env.VERCEL_GIT_COMMIT_MESSAGE || '').split('\n')[0].slice(0, 120),
  };
}

/** The longer story, for a tooltip: branch, environment, commit subject. */
export function buildDetail() {
  const b = buildInfo();
  const parts = [`v${b.version}`, b.env];
  if (b.branch) parts.push(b.branch);
  if (b.shortSha) parts.push(b.shortSha);
  const head = parts.join(' · ');
  return b.message ? `${head}\n${b.message}` : head;
}

/** One short string for a corner of the UI: "0.1.0 · a1b2c3d". */
export function buildLabel() {
  const b = buildInfo();
  if (!b.shortSha) return `${b.version} · dev`;
  return `${b.version} · ${b.shortSha}`;
}

export default VERSION;
