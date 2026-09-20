'use client';

import { useCallback, useEffect, useState } from 'react';
import { Panel } from './Layout';
import { useConfirm } from './Confirm';
import { useToast } from './Toast';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const UNITS = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
];

/**
 * "3 days ago", "in 2 months". Nobody reads a device list to learn the date a
 * laptop was paired; they read it to spot the one they do not recognise, and
 * an age answers that faster than a timestamp does.
 *
 * Every timestamp on this route is epoch MILLISECONDS (the desktop_tokens
 * columns are BIGINT ms). Feeding seconds through here dates every device to
 * 1970, which is the giveaway that a conversion went missing upstream.
 */
function relTime(ms) {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  if (abs < MINUTE) return 'just now';
  for (const [unit, size] of UNITS) {
    if (abs >= size) {
      // numeric:'auto' is what turns -1 day into "yesterday" rather than "1 day ago".
      return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(Math.round(diff / size), unit);
    }
  }
  return 'just now';
}

/** Relative text, with the exact moment on hover for when the age is not enough. */
function When({ ms, fallback = '—' }) {
  if (!ms) return <span className="muted">{fallback}</span>;
  return <span title={new Date(ms).toLocaleString()}>{relTime(ms)}</span>;
}

/**
 * The devices signed in as you — one row per paired desktop client, each with
 * a revoke.
 *
 * Reads /api/devices, which scopes to the session's own email rather than
 * taking one, so this panel is safe to show to any member and not only to an
 * admin. Revoking deletes the token row outright, so the desktop holding it
 * fails its next request; there is no window to wait out.
 */
export default function DevicesPanel() {
  const [devices, setDevices] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);

  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch('/api/devices');
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
      setDevices(body.devices || []);
    } catch (e) {
      setError(e.message);
      setDevices([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const revoke = useCallback(async (device) => {
    const name = device.label || 'Desktop';
    const ok = await confirm({
      title: `Revoke ${name}?`,
      body: 'That device stops working immediately and has to sign in again to get back in. Anything it is uploading right now will fail.',
      confirmLabel: 'Revoke',
    });
    if (!ok) return;
    setBusy(device.id);
    try {
      const r = await fetch(`/api/devices?id=${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || `Request failed (${r.status})`);
      // Drop it locally instead of re-reading: the answer is already known,
      // and a reload would blank the table for a beat to say the same thing.
      setDevices((list) => (list || []).filter((d) => d.id !== device.id));
      toast.success(`${name} revoked.`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(null);
    }
  }, [confirm, toast]);

  return (
    <Panel
      title="Devices"
      hint="Desktop clients paired with your account. Revoke anything you do not recognise."
    >
      {error && (
        <p className="small" style={{ color: 'var(--danger)', margin: '0 0 var(--s3)' }}>{error}</p>
      )}

      {devices === null ? (
        <div className="empty">Loading…</div>
      ) : devices.length === 0 ? (
        <div className="empty">No devices are paired yet.</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Added</th>
              <th>Last used</th>
              <th>Expires</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                {/* The desktop may pair without sending a label, so the column
                    would otherwise read "null" for the commonest case. */}
                <td>{d.label || 'Desktop'}</td>
                <td><When ms={d.createdAt} /></td>
                <td><When ms={d.lastUsedAt} fallback="Never" /></td>
                <td><Expiry ms={d.expiresAt} /></td>
                <td>
                  <button
                    className="btn btn-sm btn-danger"
                    disabled={busy === d.id}
                    onClick={() => revoke(d)}
                  >
                    {busy === d.id ? 'Revoking…' : 'Revoke'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {confirmElement}
    </Panel>
  );
}

/**
 * A null expiry is a token that never expires, not a missing value. An expired
 * one still appears in the listing — the row survives its own deadline — and
 * saying so is more use than "2 months ago", which reads like a last-used date.
 */
function Expiry({ ms }) {
  if (ms == null) return <span className="muted">Never</span>;
  if (ms <= Date.now()) return <span className="muted">Expired</span>;
  return <When ms={ms} />;
}
