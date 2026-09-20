// lib/notify.js — outbound notifications.
//
// Two sinks, both optional and both best-effort: Slack (an incoming webhook)
// and email (Resend). Nothing here ever throws into a request path — a
// notification failing must not fail the operation that triggered it, so every
// export resolves to a boolean and logs on the way past.

import { loadBrand } from './brand-config';

const timeout = (ms) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
};

/** Post to the configured Slack incoming webhook. No-op when unset. */
export async function slack(text, blocks = null) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return false;
  const t = timeout(8000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(blocks ? { text, blocks } : { text }),
      signal: t.signal,
    });
    return r.ok;
  } catch (e) {
    console.warn('[notify] slack failed:', e.message);
    return false;
  } finally {
    t.done();
  }
}

/** Send a transactional email through Resend. No-op when unset. */
export async function email({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return false;
  const brand = await loadBrand();
  const from = process.env.NOTIFY_FROM || `${brand.name} <onboarding@resend.dev>`;
  const t = timeout(10000);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text }),
      signal: t.signal,
    });
    if (!r.ok) console.warn('[notify] resend failed:', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) {
    console.warn('[notify] email failed:', e.message);
    return false;
  } finally {
    t.done();
  }
}

/** Someone asked for access from the sign-in screen. */
export async function notifyAccessRequest({ email: who, name, reason }) {
  const brand = await loadBrand();
  const lines = [`*Access request* — ${name ? `${name} · ` : ''}${who}`];
  if (reason) lines.push(`> ${reason}`);
  lines.push(`Review at ${brand.origin}/admin`);
  return slack(lines.join('\n'));
}

/** Usage rights lapsed or are about to. */
export async function notifyExpiringRights({ expired = [], soon = [] }) {
  if (!expired.length && !soon.length) return false;
  const brand = await loadBrand();
  const parts = [];
  if (expired.length) parts.push(`*${expired.length}* asset${expired.length === 1 ? '' : 's'} with EXPIRED usage rights`);
  if (soon.length) parts.push(`*${soon.length}* expiring within 30 days`);
  return slack(`${parts.join(' · ')}\n${brand.origin}/files?expiry=1`);
}
