import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { listStoragePrices, setStoragePrice, removeStoragePrice } from '@/lib/db';
import { storageAccountsInUse } from '@/lib/storage-accounts';
import { validateStoragePrice, parseAccount, providerName } from '@/lib/storage-pricing';
import { readJsonBody } from '@/lib/request-body';
import { audit } from '@/lib/audit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const NO_STORE = { 'cache-control': 'no-store' };
const json = (body, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

// A small body: a price is a handful of numbers and a note.
const MAX_BODY = 4 * 1024;

/** The audit subject for an account: its service and where, as the Prices page names it. */
function accountSubject(account) {
  const a = parseAccount(account);
  const where = a ? a.host || a.region : '';
  return { type: 'storage-account', id: account, label: a ? `${providerName(a.provider)}${where ? ` · ${where}` : ''}` : account };
}

/** The fields an audit row keeps of a price: what it said, not when or by whom (the row says that). */
const priceDetail = (p) => (p ? {
  rate: p.rate, unit: p.unit, base: p.base, freeBytes: p.freeBytes, minimumBytes: p.minimumBytes, fee: p.fee, note: p.note,
} : null);

/**
 * PUT { account, rate, unit, base, free, freeUnit, minimum, minimumUnit, fee, note }
 * → { price }
 *
 * What storage on one account costs us, where it is not the list price
 * (Admin → Storage → Prices). Replaces any price the account had. Every
 * field is checked (lib/storage-pricing.js validateStoragePrice) and a bad
 * one refuses the save with a sentence saying which; the account must be
 * one the library keeps files on now, as the page lists them.
 *
 * Admins, like the Usage page it changes: a price moves an estimate, not
 * any file or any bill, so it is not the super-admins' Backend.
 */
export async function PUT(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readJsonBody(req, { max: MAX_BODY });
  if (read.error) return json({ error: read.error }, read.status);

  const checked = validateStoragePrice(read.body);
  if (checked.error) return json({ error: checked.error }, 400);
  const { account, price } = checked;

  let inUse;
  try {
    inUse = await storageAccountsInUse();
  } catch {
    return json({ error: 'Could not read where files are kept, so nothing was saved. Try again.' }, 503);
  }
  if (!inUse.accounts.some((a) => a.account === account)) {
    return json({ error: 'The library does not keep files on that account now. Reload the page to see the ones it does.' }, 404);
  }

  const before = (await listStoragePrices()).find((p) => p.account === account) || null;
  const saved = await setStoragePrice(account, price, { by: guard.email });
  await audit(guard.email, 'storage.price.set', accountSubject(account), { from: priceDetail(before), to: priceDetail(saved) });
  return json({ price: saved });
}

/**
 * DELETE { account } → { ok, removed } — go back to the list price for an
 * account (or to no price, for a service that has none). Any account with a
 * price of our own may be cleared, including one the library no longer
 * keeps files on, which the Prices page lists apart for exactly this.
 */
export async function DELETE(req) {
  const guard = await requireAdmin();
  if (guard.error) return guard.error;
  const read = await readJsonBody(req, { max: MAX_BODY });
  if (read.error) return json({ error: read.error }, read.status);
  const account = read.body?.account;
  if (!parseAccount(account)) return json({ error: 'Say which account to clear the price of.' }, 400);

  const removed = await removeStoragePrice(account);
  if (removed) await audit(guard.email, 'storage.price.clear', accountSubject(account), { from: priceDetail(removed) });
  return json({ ok: true, removed: !!removed });
}
