import { isDbConfigured, listStoragePrices } from '@/lib/db';
import { storageAccountsInUse } from '@/lib/storage-accounts';
import {
  priceFor, pricesByAccount, priceSummary, priceFormValues, countsLabel, fmtPriceDate, fmtDay, parseAccount, providerName,
} from '@/lib/storage-pricing';
import { requireAdminPage } from '../../_lib/guard';
import AdminPage, { AdminCard } from '../../_ui/AdminPage';
import AdminState from '../../_ui/AdminState';
import PriceForm, { ClearPrice } from './PriceForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Prices · Admin' };

const PARENT = { href: '/admin/usage', label: 'Usage' };
const DESCRIPTION = 'What storing files costs us, account by account. The Usage estimate uses each provider’s list price, unless we set our own here: a negotiated rate, a contract, or a price for a service that has none.';

/** "the drive “A”", "the drives “A” and “B”". */
function drivesPhrase(names) {
  const q = names.map((n) => `“${n}”`);
  if (q.length === 1) return `the drive ${q[0]}`;
  return `the drives ${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

/** Where an account is, as someone setting its price would recognise it. */
function Where({ account }) {
  if (account.provider === 'aws') {
    return account.region
      ? <>Region <span className="admin-mono">{account.region}</span></>
      : <span className="muted">No region is set.</span>;
  }
  return <span className="admin-mono">{account.host}</span>;
}

/** Each bucket on the account, and what keeps files in it. */
function Buckets({ buckets }) {
  return (
    <span className="price-buckets">
      {buckets.map((b) => (
        <span key={b.bucket}>
          <span className="admin-mono">{b.bucket || '(no bucket)'}</span>
          <span className="muted">
            {' — '}
            {[b.storage ? 'the default bucket' : '', b.drives.length ? drivesPhrase(b.drives) : ''].filter(Boolean).join(', and ')}
          </span>
        </span>
      ))}
    </span>
  );
}

/** Who set a price of our own and when, and its note. */
function SetBy({ price }) {
  const day = fmtDay(price.setAt);
  return (
    <span className="muted">
      {price.setBy ? ` Set by ${price.setBy}${day ? ` on ${day}` : ''}.` : day ? ` Set on ${day}.` : ''}
      {price.note && <> “{price.note}”</>}
    </span>
  );
}

function AccountCard({ account, own, index }) {
  const list = priceFor(account.location);
  const ours = own ? priceFor(account.location, { overrides: new Map([[account.account, own]]) }) : null;
  const status = ours
    ? <span className="tag tag-accent">Our price</span>
    : list ? <span className="tag">List price</span> : <span className="tag tag-warning">No price</span>;
  return (
    <AdminCard title={account.name} id={`account-${index + 1}`} actions={status}>
      <dl className="info-list price-facts">
        <div className="info-row">
          <dt className="muted">Where</dt>
          <dd><Where account={account} /></dd>
        </div>
        <div className="info-row">
          <dt className="muted">{account.buckets.length === 1 ? 'Bucket' : 'Buckets'}</dt>
          <dd><Buckets buckets={account.buckets} /></dd>
        </div>
        <div className="info-row">
          <dt className="muted">List price</dt>
          <dd>
            {list ? (
              <>
                {priceSummary(list)}, counting {countsLabel(list.base)}.{' '}
                <span className="muted">
                  From <a href={list.source} className="info-link" target="_blank" rel="noreferrer">{list.name}’s price list</a>, as of {fmtPriceDate(list.checked)}.
                </span>
              </>
            ) : account.provider === 'aws' ? (
              <span className="muted">None here for this region, so the estimate leaves this account out until we set a price.</span>
            ) : (
              <span className="muted">None: a service like this one has no list price, so the estimate leaves the account out until we set a price.</span>
            )}
          </dd>
        </div>
        {ours && (
          <div className="info-row">
            <dt className="muted">Our price</dt>
            <dd>
              <strong>{priceSummary(ours)}</strong>, counting {countsLabel(ours.base)}.
              <SetBy price={ours} />
              <span className="price-clear">
                <ClearPrice account={account.account} name={account.name} hasList={!!list} />
              </span>
            </dd>
          </div>
        )}
      </dl>
      {/* Remounted when the price changes, so the form starts from what is stored now. */}
      <PriceForm
        key={ours ? `ours-${ours.setAt}` : 'list'}
        account={account.account}
        name={account.name}
        values={priceFormValues(ours || list)}
        hasOwn={!!ours}
      />
    </AdminCard>
  );
}

/** Prices set for accounts the library keeps nothing on now: they do nothing, and can go. */
function StaleCard({ rows }) {
  return (
    <AdminCard
      title="Prices for accounts no longer used"
      id="unused"
      hint="The library keeps no files on these accounts now, so their prices change nothing. Remove them, or keep them for when an account is used again."
    >
      <ul className="price-stale">
        {rows.map((row) => {
          const a = parseAccount(row.account);
          const location = { provider: a?.provider, bill: row.account };
          const price = priceFor(location, { overrides: new Map([[row.account, row]]) });
          const name = providerName(a?.provider);
          return (
            <li key={row.account}>
              <span>
                <strong>{name}</strong>
                {a && (a.host || a.region) && <span className="admin-mono muted"> {a.host || a.region}</span>}
                <span className="small muted"> · {priceSummary(price)}.</span>
                <span className="small"><SetBy price={row} /></span>
              </span>
              <ClearPrice account={row.account} name={name} hasList={false} unused label="Remove" />
            </li>
          );
        })}
      </ul>
    </AdminCard>
  );
}

/**
 * Admin → Storage → Prices: what storage costs us where that is not the
 * list price, one account at a time — the Storage bucket's, and each
 * drive's that keeps its files elsewhere. The Usage estimate uses what is
 * set here (lib/storage-pricing.js priceFor).
 *
 * A server component with one client part, the form. Accounts come from
 * storageAccountsInUse, which reads the drives' keys only to tell where
 * their files are: what reaches the page names services, hosts, regions
 * and buckets.
 */
export default async function PricesPage() {
  await requireAdminPage('/admin/usage/prices');
  if (!isDbConfigured()) {
    return (
      <AdminPage title="Prices" description={DESCRIPTION} parent={PARENT}>
        <AdminState kind="empty" title="Nowhere to keep a price" message="No database is connected, so a price of our own cannot be saved." />
      </AdminPage>
    );
  }
  const [{ mode, accounts }, rows] = await Promise.all([storageAccountsInUse(), listStoragePrices()]);
  const own = pricesByAccount(rows);
  const stale = rows.filter((r) => !accounts.some((a) => a.account === r.account));

  return (
    <AdminPage title="Prices" description={DESCRIPTION} parent={PARENT}>
      {mode !== 's3' && (
        <AdminState
          kind="empty"
          title="No bucket to price"
          message="Files are kept in Vercel Blob, which the estimate does not price. Once a bucket is set up for storage, its account appears here."
        />
      )}
      {accounts.map((a, i) => <AccountCard key={a.account} account={a} own={own.get(a.account)} index={i} />)}
      {stale.length > 0 && <StaleCard rows={stale} />}
    </AdminPage>
  );
}
