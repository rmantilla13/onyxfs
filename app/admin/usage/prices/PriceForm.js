'use client';

import { useId, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useToast } from '@/app/components/ui/Toast';
import { useConfirm } from '@/app/components/ui/Confirm';
import { api } from '../../_ui/api';

const ROUTE = '/api/admin/storage-prices';

/**
 * Setting or changing an account's price of our own, on Admin → Storage →
 * Prices. The only client part of the page: it sends the form as typed, the
 * server checks every field (lib/storage-pricing.js validateStoragePrice)
 * and says what is wrong, and the page is read again once it is saved.
 *
 * `values` is priceFormValues(): our price when there is one, else the list
 * price to start from, else blanks.
 */
export default function PriceForm({ account, name, values, hasOwn }) {
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const [form, setForm] = useState(values);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => { setError(null); setForm((f) => ({ ...f, [k]: e.target.value })); };

  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(ROUTE, { method: 'PUT', json: { account, ...form, base: Number(form.base) } });
      toast.success(`Saved. The Usage estimate prices ${name} at our price now.`);
      router.refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="admin-disclosure price-edit">
      <summary>{hasOwn ? 'Change our price' : 'Set our price'}</summary>
      <form className="admin-form" onSubmit={save} noValidate>
        <div className="admin-form-grid">
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-rate`}>Price a month, in US dollars</label>
            <span className="admin-field-row">
              <input id={`${id}-rate`} className="input" inputMode="decimal" value={form.rate} onChange={set('rate')} autoComplete="off" />
              <select className="input" value={form.unit} onChange={set('unit')} aria-label="Per">
                <option value="TB">per TB</option>
                <option value="GB">per GB</option>
              </select>
            </span>
          </div>
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-base`}>How the provider counts</label>
            <select id={`${id}-base`} className="input" value={String(form.base)} onChange={set('base')}>
              <option value="1000">1,000 GB to the TB</option>
              <option value="1024">1,024 GB to the TB</option>
            </select>
            <span className="admin-field-hint">As its invoice counts. Backblaze uses 1,000; Amazon, DigitalOcean and Wasabi 1,024.</span>
          </div>
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-free`}>Free each month</label>
            <span className="admin-field-row">
              <input id={`${id}-free`} className="input" inputMode="decimal" value={form.free} onChange={set('free')} placeholder="0" autoComplete="off" />
              <select className="input" value={form.freeUnit} onChange={set('freeUnit')} aria-label="Free storage unit">
                <option value="GB">GB</option>
                <option value="TB">TB</option>
              </select>
            </span>
            <span className="admin-field-hint">Storage that costs nothing, such as the first 10 GB at Backblaze.</span>
          </div>
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-minimum`}>Billed at least</label>
            <span className="admin-field-row">
              <input id={`${id}-minimum`} className="input" inputMode="decimal" value={form.minimum} onChange={set('minimum')} placeholder="0" autoComplete="off" />
              <select className="input" value={form.minimumUnit} onChange={set('minimumUnit')} aria-label="Minimum unit">
                <option value="GB">GB</option>
                <option value="TB">TB</option>
              </select>
            </span>
            <span className="admin-field-hint">Some providers bill a minimum however little is stored.</span>
          </div>
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-fee`}>Flat fee a month, in US dollars</label>
            <input id={`${id}-fee`} className="input" inputMode="decimal" value={form.fee} onChange={set('fee')} placeholder="0" autoComplete="off" />
            <span className="admin-field-hint">A plan’s fee, on top of the price. Leave blank for none.</span>
          </div>
          <div className="admin-field">
            <label className="admin-field-label" htmlFor={`${id}-note`}>Note</label>
            <input id={`${id}-note`} className="input" value={form.note} onChange={set('note')} maxLength={200} placeholder="Contract 2026" autoComplete="off" />
            <span className="admin-field-hint">Where the price comes from, for whoever reads this next.</span>
          </div>
        </div>
        {error && <p className="small admin-inline-error" role="alert">{error}</p>}
        <div className="admin-form-actions">
          <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save our price'}</button>
        </div>
      </form>
    </details>
  );
}

/**
 * Going back to the list price — or, for a service with none, leaving the
 * account out of the estimate again; or, for an account the library no
 * longer uses (`unused`), tidying its price away. Asks first: the price
 * typed in goes.
 */
export function ClearPrice({ account, name, hasList, unused = false, label }) {
  const router = useRouter();
  const toast = useToast();
  const { confirm, confirmElement } = useConfirm();
  const [busy, setBusy] = useState(false);

  const clear = async () => {
    if (busy) return;
    const ok = await confirm({
      title: hasList && !unused ? `Go back to the list price for ${name}?` : `Remove our price for ${name}?`,
      body: unused
        ? 'The library keeps no files on this account now, so the price changes nothing. It can be set again if the account is used again.'
        : hasList
          ? 'The Usage estimate prices this account from the provider’s list price again. Our price is forgotten; it can be set again at any time.'
          : 'This service has no list price, so the Usage estimate leaves the account out again until a price is set.',
      confirmLabel: hasList && !unused ? 'Use the list price' : 'Remove our price',
      danger: false,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api(ROUTE, { method: 'DELETE', json: { account } });
      toast.success(hasList && !unused ? `${name} is priced from its list price again.` : `Removed our price for ${name}.`);
      router.refresh();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={clear} disabled={busy}>
        {busy ? 'Clearing…' : label || (hasList ? 'Go back to the list price' : 'Remove our price')}
      </button>
      {confirmElement}
    </>
  );
}
