import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { isAdmin } from '@/lib/auth-allowlist';
import { sql, hasConnectionString } from '@/lib/db';
import { getStorageConfig, storageMode, s3TestConnection } from '@/lib/storage';
import { allIntegrationStatuses } from '@/lib/integrations';
import { VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Vercel's default ceiling is 300s. Nothing here should take anywhere near
// that: every query in lib/db.js is bounded at 15s by the driver. A cap keeps
// a pathological request costing seconds instead of five minutes of a hung
// invocation — which is what the gateway timeouts on this route looked like.
export const maxDuration = 30;

/**
 * Diagnostics. Deliberately excluded from the auth middleware so it stays
 * reachable when sign-in itself is broken — which is exactly when it is most
 * needed. It therefore carries its own gate: an admin session, or the
 * CRON_SECRET as a bearer token.
 *
 * Never returns a secret value. Every check reports presence and reachability.
 */
async function authorize(req) {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.get('authorization') || '';
  if (secret && header === `Bearer ${secret}`) return true;
  try {
    const session = await auth();
    return isAdmin(session?.user?.email);
  } catch {
    // auth() itself failing is precisely the case this endpoint exists for.
    return false;
  }
}

export async function GET(req) {
  if (!(await authorize(req))) {
    return NextResponse.json({ error: 'Admin or CRON_SECRET required' }, { status: 403 });
  }

  const checks = {};

  // WHICH variable carries the connection, not just whether one does.
  // lib/db.js falls back from DATABASE_URL to POSTGRES_URL, so a deployment
  // can be running entirely on the one nobody thinks is in use — and then
  // "tidying up the redundant variable" is an outage. Until now that answer
  // was only available from a local `npm run doctor`, which cannot see
  // production, which is the only place it matters.
  const conn = hasConnectionString();
  checks.env = {
    DATABASE_URL: conn.ok,
    connectionVia: conn.which,
    bothConnectionVarsSet: !!process.env.DATABASE_URL && !!process.env.POSTGRES_URL,
    AUTH_SECRET: !!process.env.AUTH_SECRET,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    NOTIFY_FROM: !!process.env.NOTIFY_FROM,
  };

  try {
    const t0 = Date.now();
    await sql`SELECT 1`;
    checks.database = { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    checks.database = { ok: false, error: e.message };
  }

  try {
    const cfg = await getStorageConfig();
    const mode = storageMode(cfg);
    checks.storage = { ok: true, mode, bucket: mode === 's3' ? cfg.bucket : null };
    if (mode === 's3') {
      const test = await s3TestConnection(cfg).catch((e) => ({ ok: false, error: e.message }));
      checks.storage.reachable = test?.ok !== false;
      if (test?.error) checks.storage.error = test.error;
    }
  } catch (e) {
    checks.storage = { ok: false, error: e.message };
  }

  checks.integrations = allIntegrationStatuses();

  const healthy = checks.database?.ok && checks.env.DATABASE_URL && checks.env.AUTH_SECRET;
  return NextResponse.json({ ok: !!healthy, version: VERSION, checks }, { status: healthy ? 200 : 503 });
}
